import * as vscode from 'vscode';
import { Worker } from 'worker_threads';

export interface SerializedSelection {
  type: string;
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  key: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ParserManager {
  private worker: Worker | null = null;
  private initialized = false;
  private initPromise: Promise<boolean> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private closeListener: vscode.Disposable | undefined;
  private onReparseCallbacks: Array<() => void> = [];

  constructor(private extensionUri: vscode.Uri) {
    this.closeListener = vscode.workspace.onDidCloseTextDocument((doc) => {
      this.clearCache(doc.uri.toString());
    });
  }

  get isReady(): boolean {
    return this.initialized;
  }

  async ensureInitialized(): Promise<boolean> {
    if (this.initialized) return true;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<boolean> {
    try {
      const workerPath = vscode.Uri.joinPath(
        this.extensionUri, 'dist', 'parser-worker.js'
      ).fsPath;

      const wasmRoot = vscode.Uri.joinPath(
        this.extensionUri, 'parsers'
      ).fsPath;

      this.worker = new Worker(workerPath);
      this.worker.on('message', (msg: { id: number; type: string } & Record<string, unknown>) => {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        pending.resolve(msg);
      });

      this.worker.on('error', (err) => {
        console.error('[code-block-selector] Worker error:', err);
        for (const [id, { reject, timer }] of this.pending) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });

      this.worker.on('exit', (code) => {
        if (code !== 0) {
          console.error(`[code-block-selector] Worker exited with code ${code}`);
        }
        this.initialized = false;
        this.worker = null;
      });

      const result = await this.sendRequest('init', { wasmRoot });
      this.initialized = (result as { success: boolean }).success;
      return this.initialized;
    } catch (e) {
      console.error('[code-block-selector] Worker initialization failed:', e);
      return false;
    }
  }

  private sendRequest(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.worker) {
      return Promise.reject(new Error('Worker not initialized'));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Worker request ${type}:${id} timed out`));
      }, 10000);

      this.pending.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ id, type, ...payload });
    });
  }

  async parseDocument(document: vscode.TextDocument): Promise<boolean> {
    if (!this.initialized) {
      await this.ensureInitialized();
    }
    if (!this.initialized || !this.worker) return false;

    try {
      const result = await this.sendRequest('parse', {
        uri: document.uri.toString(),
        version: document.version,
        text: document.getText(),
        languageId: document.languageId,
      });

      if ((result as { success: boolean }).success) {
        for (const cb of this.onReparseCallbacks) {
          cb();
        }
        return true;
      }
      return false;
    } catch (_e) {
      console.error('[code-block-selector] Parse failed');
      return false;
    }
  }

  async selectAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<SerializedSelection | null> {
    if (!this.initialized) {
      await this.ensureInitialized();
    }
    if (!this.initialized || !this.worker) return null;

    await this.parseDocument(document);

    try {
      const result = await this.sendRequest('select', {
        uri: document.uri.toString(),
        line: position.line,
        character: position.character,
      });
      const sel = (result as { selection: SerializedSelection | null }).selection;
      return sel;
    } catch (_e) {
      return null;
    }
  }

  async expandSelection(
    uri: string,
    key: string
  ): Promise<SerializedSelection | null> {
    if (!this.worker) return null;

    try {
      const result = await this.sendRequest('expand', { uri, key });
      return (result as { selection: SerializedSelection | null }).selection;
    } catch (_e) {
      return null;
    }
  }

  async shrinkSelection(
    uri: string,
    key: string,
    line: number,
    character: number
  ): Promise<SerializedSelection | null> {
    if (!this.worker) return null;

    try {
      const result = await this.sendRequest('shrink', { uri, key, line, character });
      return (result as { selection: SerializedSelection | null }).selection;
    } catch (_e) {
      return null;
    }
  }

  private clearCache(uri: string): void {
    if (!this.worker) return;
    this.sendRequest('clear', { uri }).catch(() => {});
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
    if (this.worker) {
      this.sendRequest('clear').catch(() => {});
      for (const [, { reject, timer }] of this.pending) {
        clearTimeout(timer);
        reject(new Error('ParserManager disposed'));
      }
      this.pending.clear();
      this.worker.terminate();
      this.worker = null;
    }
  }
}
