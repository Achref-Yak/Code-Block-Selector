import { parentPort } from 'worker_threads';
import { readFile } from 'fs/promises';
import Parser, { SyntaxNode } from 'web-tree-sitter';

interface Point {
  row: number;
  column: number;
}

interface SerializedSelection {
  type: string;
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  key: string;
}

interface CachedTree {
  tree: Parser.Tree;
  version: number;
  nodeMap: Map<string, SyntaxNode>;
}

interface InitMessage {
  id: number;
  type: 'init';
  wasmRoot: string;
}

interface ParseMessage {
  id: number;
  type: 'parse';
  uri: string;
  version: number;
  text: string;
  languageId: string;
}

interface SelectMessage {
  id: number;
  type: 'select';
  uri: string;
  line: number;
  character: number;
}

interface ExpandMessage {
  id: number;
  type: 'expand';
  uri: string;
  key: string;
  line: number;
  character: number;
}

interface ShrinkMessage {
  id: number;
  type: 'shrink';
  uri: string;
  key: string;
  line: number;
  character: number;
}

interface ClearMessage {
  id: number;
  type: 'clear';
  uri?: string;
}

type WorkerMessage = InitMessage | ParseMessage | SelectMessage | ExpandMessage | ShrinkMessage | ClearMessage;

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

function findMeaningfulBlock(node: SyntaxNode): SyntaxNode {
  let current: SyntaxNode | null = node;

  while (current && current.parent) {
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
      (node.endPosition.row === point.row && node.endPosition.column > point.column))
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

async function initialize(wasmRoot: string): Promise<boolean> {
  try {
    await Parser.init();
    parser = new Parser();

    const uniqueGrammars = new Map<string, string>();
    for (const [langId, config] of Object.entries(PARSER_CONFIG)) {
      if (!uniqueGrammars.has(config.grammar)) {
        uniqueGrammars.set(config.grammar, langId);
      }
    }

    const loadPromises = Array.from(uniqueGrammars.entries()).map(
      async ([grammar, representativeLangId]) => {
        try {
          const wasmPath = wasmRoot + '/' + PARSER_CONFIG[representativeLangId].wasm;
          const buffer = await readFile(wasmPath);
          const lang = await Parser.Language.load(buffer);
          parsers.set(representativeLangId, lang);

          for (const [langId, cfg] of Object.entries(PARSER_CONFIG)) {
            if (cfg.grammar === grammar && langId !== representativeLangId) {
              parsers.set(langId, lang);
            }
          }
        } catch (e) {
          console.error(`[code-block-selector worker] Failed to load ${grammar}:`, e);
        }
      }
    );

    await Promise.all(loadPromises);
    initialized = parsers.size > 0;
    return initialized;
  } catch (e) {
    console.error('[code-block-selector worker] Init failed:', e);
    return false;
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

  treeCache.set(uri, { tree, version, nodeMap });
  return true;
}

function selectAtPosition(uri: string, line: number, character: number): SerializedSelection | null {
  const cached = treeCache.get(uri);
  if (!cached) return null;

  const point: Point = { row: line, column: character };
  const deepestNode = cached.tree.rootNode.descendantForPosition(point);
  if (!deepestNode) return null;

  const meaningfulNode = findMeaningfulBlock(deepestNode);
  return serializeNode(meaningfulNode);
}

function expandSelection(uri: string, key: string): SerializedSelection | null {
  const cached = treeCache.get(uri);
  if (!cached) return null;

  const node = cached.nodeMap.get(key);
  if (!node || !node.parent) return null;

  return serializeNode(node.parent);
}

function shrinkSelection(uri: string, key: string, line: number, character: number): SerializedSelection | null {
  const cached = treeCache.get(uri);
  if (!cached) return null;

  const node = cached.nodeMap.get(key);
  if (!node) return null;

  const point: Point = { row: line, column: character };
  const childNode = findDeepestChildContainingPoint(node, point);
  if (!childNode) return null;

  const meaningfulChild = findMeaningfulBlock(childNode);
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

function post(id: number, payload: Record<string, unknown>): void {
  parentPort?.postMessage({ id, ...payload });
}

if (!parentPort) {
  throw new Error('parser-worker must be run as a Worker');
}

parentPort.on('message', async (msg: WorkerMessage) => {
  switch (msg.type) {
    case 'init': {
      try {
        const success = await initialize(msg.wasmRoot);
        post(msg.id, { type: 'init', success });
      } catch (e) {
        post(msg.id, { type: 'init', success: false, error: String(e) });
      }
      break;
    }

    case 'parse': {
      const success = parseDocument(msg.uri, msg.version, msg.text, msg.languageId);
      post(msg.id, { type: 'parse', success });
      break;
    }

    case 'select': {
      const selection = selectAtPosition(msg.uri, msg.line, msg.character);
      post(msg.id, { type: 'select', selection });
      break;
    }

    case 'expand': {
      const selection = expandSelection(msg.uri, msg.key);
      post(msg.id, { type: 'expand', selection });
      break;
    }

    case 'shrink': {
      const selection = shrinkSelection(msg.uri, msg.key, msg.line, msg.character);
      post(msg.id, { type: 'shrink', selection });
      break;
    }

    case 'clear': {
      clearCache(msg.uri);
      post(msg.id, { type: 'clear' });
      break;
    }
  }
});
