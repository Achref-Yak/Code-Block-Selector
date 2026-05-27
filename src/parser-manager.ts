import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import Parser, { SyntaxNode } from 'web-tree-sitter';

const PARSER_CONFIG: Record<string, { grammar: string; wasm: string }> = {
  javascript: { grammar: 'javascript', wasm: 'tree-sitter-javascript.wasm' },
  typescript: { grammar: 'typescript', wasm: 'tree-sitter-typescript.wasm' },
  javascriptreact: { grammar: 'javascript', wasm: 'tree-sitter-javascript.wasm' },
  typescriptreact: { grammar: 'typescript', wasm: 'tree-sitter-typescript.wasm' },
  python: { grammar: 'python', wasm: 'tree-sitter-python.wasm' },
  go: { grammar: 'go', wasm: 'tree-sitter-go.wasm' },
};

interface CachedTree {
  tree: Parser.Tree;
  version: number;
}

export class ParserManager {
  private parser: Parser | null = null;
  private parsers = new Map<string, Parser.Language>();
  private wasmBuffers = new Map<string, Buffer>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private wasmPaths = new Map<string, string>();
  private treeCache = new Map<string, CachedTree>();
  private closeListener: vscode.Disposable | undefined;
  private onReparseCallbacks: Array<() => void> = [];

  constructor(private extensionUri: vscode.Uri) {
    for (const [langId, config] of Object.entries(PARSER_CONFIG)) {
      if (!this.wasmPaths.has(config.grammar)) {
        this.wasmPaths.set(
          config.grammar,
          vscode.Uri.joinPath(this.extensionUri, 'parsers', config.wasm).fsPath
        );
      }
    }

    this.closeListener = vscode.workspace.onDidCloseTextDocument((doc) => {
      this.purgeTreeCache(doc.uri.toString());
    });
  }

  get isReady(): boolean {
    return this.initialized;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize() {
    await Parser.init();
    this.parser = new Parser();

    const uniqueGrammars = new Map<string, string>();
    for (const [langId, config] of Object.entries(PARSER_CONFIG)) {
      if (!uniqueGrammars.has(config.grammar)) {
        uniqueGrammars.set(config.grammar, langId);
      }
    }

    const loadPromises = Array.from(uniqueGrammars.entries()).map(
      async ([grammar, representativeLangId]) => {
        try {
          const wasmPath = this.wasmPaths.get(grammar);
          if (!wasmPath) return;

          let buffer = this.wasmBuffers.get(grammar);
          if (!buffer) {
            buffer = await fs.readFile(wasmPath);
            this.wasmBuffers.set(grammar, buffer);
          }

          const lang = await Parser.Language.load(buffer);
          this.parsers.set(representativeLangId, lang);

          for (const [langId, cfg] of Object.entries(PARSER_CONFIG)) {
            if (cfg.grammar === grammar && langId !== representativeLangId) {
              this.parsers.set(langId, lang);
            }
          }
        } catch (e) {
          console.error(`[code-block-selector] Failed to load parser for ${grammar}:`, e);
        }
      }
    );

    await Promise.all(loadPromises);
    this.initialized = this.parsers.size > 0;
  }

  async ensureLanguageLoaded(languageId: string): Promise<void> {
    if (this.parsers.has(languageId)) return;
    await this.ensureInitialized();
  }

  getParser(languageId: string): Parser.Language | undefined {
    return this.parsers.get(languageId);
  }

  parseDocument(document: vscode.TextDocument): Parser.Tree | undefined {
    const lang = this.getParser(document.languageId);
    if (!lang || !this.parser) return undefined;

    const uri = document.uri.toString();
    const cached = this.treeCache.get(uri);
    if (cached && cached.version === document.version) {
      return cached.tree;
    }

    this.parser.setLanguage(lang);
    const oldTree = cached?.tree;
    const tree = this.parser.parse(document.getText(), oldTree);
    this.treeCache.set(uri, { tree, version: document.version });

    for (const cb of this.onReparseCallbacks) {
      cb();
    }

    return tree;
  }

  onReparse(callback: () => void): vscode.Disposable {
    this.onReparseCallbacks.push(callback);
    return new vscode.Disposable(() => {
      const idx = this.onReparseCallbacks.indexOf(callback);
      if (idx >= 0) this.onReparseCallbacks.splice(idx, 1);
    });
  }

  purgeTreeCache(uri: string): void {
    const cached = this.treeCache.get(uri);
    if (cached) {
      cached.tree.delete();
    }
    this.treeCache.delete(uri);
  }

  dispose(): void {
    for (const cached of this.treeCache.values()) {
      cached.tree.delete();
    }
    this.treeCache.clear();
    this.closeListener?.dispose();
  }

  getNodeAtPosition(document: vscode.TextDocument, position: vscode.Position): SyntaxNode | undefined {
    const tree = this.parseDocument(document);
    if (!tree) return undefined;

    const point = { row: position.line, column: position.character };
    return tree.rootNode.descendantForPosition(point);
  }
}
