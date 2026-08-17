import * as vscode from 'vscode';
import { readFile } from 'fs/promises';
import Parser, { SyntaxNode } from 'web-tree-sitter';

export interface SerializedSelection {
  type: string;
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  key: string;
}

interface Point {
  row: number;
  column: number;
}

interface CachedTree {
  tree: Parser.Tree;
  version: number;
  nodeMap: Map<string, SyntaxNode>;
}

const PARSER_CONFIG: Record<string, { grammar: string; wasm: string }> = {
  javascript: { grammar: 'javascript', wasm: 'tree-sitter-javascript.wasm' },
  typescript: { grammar: 'typescript', wasm: 'tree-sitter-typescript.wasm' },
  javascriptreact: { grammar: 'javascript', wasm: 'tree-sitter-javascript.wasm' },
  typescriptreact: { grammar: 'typescript', wasm: 'tree-sitter-typescript.wasm' },
  python: { grammar: 'python', wasm: 'tree-sitter-python.wasm' },
  go: { grammar: 'go', wasm: 'tree-sitter-go.wasm' },
};

let parser: Parser | null = null;
let initialized = false;
const parsers = new Map<string, Parser.Language>();
const treeCache = new Map<string, CachedTree>();
let lastLanguageId: string | undefined;

function serializeNode(node: SyntaxNode): SerializedSelection {
  return {
    type: node.type,
    startLine: node.startPosition.row,
    startChar: node.startPosition.column,
    endLine: node.endPosition.row,
    endChar: node.endPosition.column,
    key: `${node.type}:${node.startPosition.row}:${node.startPosition.column}:${node.endPosition.row}:${node.endPosition.column}`,
  };
}

function findMeaningfulBlock(node: SyntaxNode, allowLeaf = false): SyntaxNode {
  let current: SyntaxNode | null = node;

  while (current && current.parent) {
    if (allowLeaf && current.isNamed && current.childCount === 0) {
      return current;
    }

    if (current.namedChildCount > 0) {
      return current;
    }

    if (current.isNamed && current.childCount > 0) {
      return current;
    }

    current = current.parent;
  }

  return node;
}

function nodeContainsPoint(node: SyntaxNode, point: Point): boolean {
  return (
    (node.startPosition.row < point.row ||
      (node.startPosition.row === point.row && node.startPosition.column <= point.column)) &&
    (node.endPosition.row > point.row ||
      (node.endPosition.row === point.row && node.endPosition.column >= point.column))
  );
}

function findDeepestChildContainingPoint(node: SyntaxNode, point: Point): SyntaxNode | undefined {
  let current = node;
  let found = true;

  while (found) {
    found = false;
    for (let i = 0; i < current.childCount; i++) {
      const child = current.child(i);
      if (!child) continue;

      if (nodeContainsPoint(child, point)) {
        current = child;
        found = true;
        break;
      }
    }
  }

  return current !== node ? current : undefined;
}

function buildNodeMap(node: SyntaxNode, map: Map<string, SyntaxNode>): void {
  const key = `${node.type}:${node.startPosition.row}:${node.startPosition.column}:${node.endPosition.row}:${node.endPosition.column}`;
  map.set(key, node);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      buildNodeMap(child, map);
    }
  }
}

function parseDocument(uri: string, version: number, text: string, languageId: string): boolean {
  const lang = parsers.get(languageId);
  if (!lang || !parser) return false;

  const cached = treeCache.get(uri);
  if (cached && cached.version === version) return true;

  if (lastLanguageId !== languageId) {
    parser.setLanguage(lang);
    lastLanguageId = languageId;
  }

  const oldTree = cached?.tree;
  const tree = parser.parse(text, oldTree);

  const nodeMap = new Map<string, SyntaxNode>();
  buildNodeMap(tree.rootNode, nodeMap);

  treeCache.set(uri, {
    tree,
    version,
    nodeMap,
  });
  return true;
}

function selectAtPosition(uri: string, line: number, character: number): SerializedSelection | null {
  const cached = treeCache.get(uri);
  if (!cached) return null;
  return selectInTree(cached, { row: line, column: character });
}

function expandSelection(uri: string, key: string): SerializedSelection | null {
  const cached = treeCache.get(uri);
  if (!cached) return null;
  return expandInTree(cached, key);
}

function shrinkSelection(uri: string, key: string, line: number, character: number): SerializedSelection | null {
  const cached = treeCache.get(uri);
  if (!cached) return null;
  return shrinkInTree(cached, key, { row: line, column: character });
}

export function createCachedTree(tree: Parser.Tree, text: string): CachedTree {
  const nodeMap = new Map<string, SyntaxNode>();
  buildNodeMap(tree.rootNode, nodeMap);
  return {
    tree,
    version: text.length,
    nodeMap,
  };
}

export function selectInTree(cached: CachedTree, point: Point): SerializedSelection | null {
  const deepestNode =
    findDeepestChildContainingPoint(cached.tree.rootNode, point) ?? cached.tree.rootNode;

  const meaningfulNode = findMeaningfulBlock(deepestNode);
  return serializeNode(meaningfulNode);
}

export function expandInTree(cached: CachedTree, key: string): SerializedSelection | null {
  const node = cached.nodeMap.get(key);
  if (!node || !node.parent) return null;

  return serializeNode(node.parent);
}

export function shrinkInTree(cached: CachedTree, key: string, point: Point): SerializedSelection | null {
  const node = cached.nodeMap.get(key);
  if (!node) return null;

  const childNode = findDeepestChildContainingPoint(node, point);
  if (!childNode) return null;

  const meaningfulChild = findMeaningfulBlock(childNode, true);
  if (meaningfulChild === node) return null;

  return serializeNode(meaningfulChild);
}

function clearCache(uri?: string): void {
  if (uri) {
    treeCache.delete(uri);
  } else {
    treeCache.clear();
  }
}

const INIT_TIMEOUT_MS = 15_000;

export class ParserManager {
  private initPromise: Promise<boolean> | null = null;
  private closeListener: vscode.Disposable | undefined;
  private onReparseCallbacks: Array<() => void> = [];

  constructor(private extensionUri: vscode.Uri) {
    this.closeListener = vscode.workspace.onDidCloseTextDocument((doc) => {
      clearCache(doc.uri.toString());
    });
  }

  get isReady(): boolean {
    return initialized;
  }

  async ensureInitialized(): Promise<boolean> {
    if (initialized) return true;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize().then((success) => {
      if (!success) {
        this.initPromise = null;
      }
      return success;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<boolean> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Initialization timed out')), INIT_TIMEOUT_MS)
    );

    try {
      const wasmRootUrl = vscode.Uri.joinPath(
        this.extensionUri, 'parsers'
      ).toString(true);

      const wasmRootPath = vscode.Uri.joinPath(
        this.extensionUri, 'parsers'
      ).fsPath;

      await Promise.race([
        Parser.init({
          locateFile: (scriptName: string) =>
            wasmRootUrl + '/' + scriptName,
        }),
        timeout,
      ]);

      parser = new Parser();

      const uniqueGrammars = new Map<string, string>();
      for (const [langId, config] of Object.entries(PARSER_CONFIG)) {
        if (!uniqueGrammars.has(config.grammar)) {
          uniqueGrammars.set(config.grammar, langId);
        }
      }

      const grammarTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Grammar loading timed out')), INIT_TIMEOUT_MS)
      );

      const loadPromises = Array.from(uniqueGrammars.entries()).map(
        async ([grammar, representativeLangId]) => {
          try {
            const wasmPath = wasmRootPath + '/' + PARSER_CONFIG[representativeLangId].wasm;
            const buffer = await readFile(wasmPath);
            const lang = await Parser.Language.load(buffer);
            parsers.set(representativeLangId, lang);

            for (const [langId, cfg] of Object.entries(PARSER_CONFIG)) {
              if (cfg.grammar === grammar && langId !== representativeLangId) {
                parsers.set(langId, lang);
              }
            }
          } catch (e) {
            console.error(`[code-block-selector] Failed to load ${grammar}:`, e);
          }
        }
      );

      await Promise.race([Promise.all(loadPromises), grammarTimeout]);
      initialized = parsers.size > 0;
      return initialized;
    } catch (e) {
      console.error('[code-block-selector] Init failed:', e);
      return false;
    }
  }

  async parseDocument(document: vscode.TextDocument): Promise<boolean> {
    if (!initialized) {
      await this.ensureInitialized();
    }
    if (!initialized || !parser) return false;

    const success = parseDocument(
      document.uri.toString(),
      document.version,
      document.getText(),
      document.languageId
    );

    if (success) {
      for (const cb of this.onReparseCallbacks) {
        cb();
      }
      return true;
    }
    return false;
  }

  async selectAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<SerializedSelection | null> {
    if (!initialized) {
      await this.ensureInitialized();
    }
    if (!initialized || !parser) return null;

    await this.parseDocument(document);

    return selectAtPosition(
      document.uri.toString(),
      position.line,
      position.character
    );
  }

  async expandSelection(
    uri: string,
    key: string
  ): Promise<SerializedSelection | null> {
    if (!parser) return null;
    return expandSelection(uri, key);
  }

  async shrinkSelection(
    uri: string,
    key: string,
    line: number,
    character: number
  ): Promise<SerializedSelection | null> {
    if (!parser) return null;
    return shrinkSelection(uri, key, line, character);
  }

  onReparse(callback: () => void): vscode.Disposable {
    this.onReparseCallbacks.push(callback);
    return new vscode.Disposable(() => {
      const idx = this.onReparseCallbacks.indexOf(callback);
      if (idx >= 0) this.onReparseCallbacks.splice(idx, 1);
    });
  }

  dispose(): void {
    this.closeListener?.dispose();
    parser = null;
    initialized = false;
    parsers.clear();
    treeCache.clear();
    lastLanguageId = undefined;
  }
}
