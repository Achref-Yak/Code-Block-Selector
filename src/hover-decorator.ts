import * as vscode from 'vscode';
import { ParserManager } from './parser-manager';
import { AstSelector, AstSelection } from './ast-selector';

export class HoverDecorator {
  private decorationType: vscode.TextEditorDecorationType;
  private hoverProvider: vscode.Disposable | undefined;
  private mouseMoveHandler: vscode.Disposable | undefined;
  private statusBarItem: vscode.StatusBarItem;
  private currentSelection: AstSelection | undefined;
  private currentEditor: vscode.TextEditor | undefined;
  private astSelector: AstSelector;
  private lastProcessedKey: string | undefined;
  private isEnabled = true;
  private selectionHistory: AstSelection[] = [];
  private isUpdatingSelection = false;
  private lastDecoratedKey: string | undefined;
  private lastStatusBarText: string | undefined;
  private throttleTimer: ReturnType<typeof setTimeout> | undefined;
  private debounceDelay: number;
  private highlightReqId = 0;

  constructor(
    private parserManager: ParserManager,
    private context: vscode.ExtensionContext
  ) {
    const highlightColor = vscode.workspace
      .getConfiguration('code-block-selector')
      .get<string>('highlightColor', 'rgba(100,150,255,0.15)');

    this.debounceDelay = vscode.workspace
      .getConfiguration('code-block-selector')
      .get<number>('debounceDelay', 50);

    this.decorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: highlightColor,
      isWholeLine: false,
      borderRadius: '3px',
    });

    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'code-block-selector.selectBlock';
    this.statusBarItem.text = '$(eye) Code Block Selector: on';
    this.statusBarItem.tooltip = 'AST highlighting is enabled. Hover over code to see highlights.';
    this.statusBarItem.show();
    this.context.subscriptions.push(this.statusBarItem);

    this.astSelector = new AstSelector(parserManager);

    const cacheInvalidator = this.parserManager.onReparse(() => {
      this.astSelector.invalidateCache();
    });
    this.context.subscriptions.push(cacheInvalidator);
  }

  activate(enabledLanguages: string[]): vscode.Disposable {
    const supportedSchemes = ['file', 'untitled'];
    const documents = enabledLanguages.flatMap((lang) =>
      supportedSchemes.map((scheme) => ({ language: lang, scheme }))
    );
    this.hoverProvider = vscode.languages.registerHoverProvider(
      documents,
      {
        provideHover: async (document, position) => {
          this.updateHighlightFromPosition(document, position);
          return null;
        },
      }
    );

    this.mouseMoveHandler = vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.selections.length > 0) {
        if (this.throttleTimer) {
          clearTimeout(this.throttleTimer);
        }
        const document = e.textEditor.document;
        const position = e.selections[0].active;
        this.throttleTimer = setTimeout(() => {
          this.throttleTimer = undefined;
          this.updateHighlightFromPosition(document, position);
        }, this.debounceDelay);
      }
    });

    const disposables = [this.hoverProvider, this.mouseMoveHandler];
    return new vscode.Disposable(() => {
      disposables.forEach((d) => d?.dispose());
    });
  }

  private async updateHighlightFromPosition(document: vscode.TextDocument, position: vscode.Position) {
    if (!this.isEnabled || this.isUpdatingSelection) return;

    const key = `${document.uri.toString()}:${position.line}:${position.character}`;
    if (this.lastProcessedKey === key) return;

    this.lastProcessedKey = key;

    if (!this.parserManager.isReady) {
      const showStatusBar = vscode.workspace
        .getConfiguration('code-block-selector')
        .get<boolean>('showStatusBar', true);
      if (showStatusBar) {
        this.statusBarItem.text = '$(warning) Code Block Selector: parsers loading...';
        this.statusBarItem.tooltip = 'Parser initialization in progress.';
        this.statusBarItem.show();
      }
      return;
    }

    const reqId = ++this.highlightReqId;
    const selection = await this.astSelector.getSelectionAtPosition(document, position);

    if (reqId !== this.highlightReqId) return;

    if (!selection) {
      this.clearHighlight();
      return;
    }

    if (!this.currentSelection || this.currentSelection.key !== selection.key) {
      this.selectionHistory = [];
    }

    this.currentSelection = selection;
    this.currentEditor = vscode.window.activeTextEditor;

    if (this.currentEditor && this.lastDecoratedKey !== selection.key) {
      this.currentEditor.setDecorations(this.decorationType, [selection.range]);
      this.lastDecoratedKey = selection.key;
    }

    this.updateStatusBar();
  }

  async selectCurrentBlock() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    if (editor.selections.length > 1) {
      this.isUpdatingSelection = true;
      const results = await Promise.all(
        editor.selections.map((sel) =>
          this.astSelector.getSelectionAtPosition(editor.document, sel.active)
        )
      );
      const newSelections = editor.selections.map((sel, i) => {
        const result = results[i];
        if (result) {
          return new vscode.Selection(result.range.start, result.range.end);
        }
        return sel;
      });
      editor.selections = newSelections;
      editor.revealRange(newSelections[0]);
      this.isUpdatingSelection = false;
    } else {
      if (!this.currentSelection || !this.currentEditor) return;
      this.currentEditor.selection = new vscode.Selection(
        this.currentSelection.range.start,
        this.currentSelection.range.end
      );
      this.currentEditor.revealRange(this.currentSelection.range);
    }
  }

  async expandSelection() {
    if (!this.currentEditor || !this.currentSelection) return;

    this.selectionHistory.push(this.currentSelection);
    const expanded = await this.astSelector.expandSelection(
      this.currentEditor.document,
      this.currentSelection
    );
    if (expanded) {
      this.isUpdatingSelection = true;
      this.currentSelection = expanded;
      this.currentEditor.selection = new vscode.Selection(
        expanded.range.end,
        expanded.range.start
      );
      this.currentEditor.setDecorations(this.decorationType, [expanded.range]);
      this.lastDecoratedKey = expanded.key;
      this.currentEditor.revealRange(expanded.range);
      this.updateStatusBar();
      this.isUpdatingSelection = false;
    } else {
      this.selectionHistory.pop();
    }
  }

  async shrinkSelection() {
    if (!this.currentEditor) return;

    if (this.selectionHistory.length > 0) {
      const previous = this.selectionHistory.pop()!;
      this.isUpdatingSelection = true;
      this.currentSelection = previous;
      this.currentEditor.selection = new vscode.Selection(
        previous.range.end,
        previous.range.start
      );
      this.currentEditor.setDecorations(this.decorationType, [previous.range]);
      this.lastDecoratedKey = previous.key;
      this.currentEditor.revealRange(previous.range);
      this.updateStatusBar();
      this.isUpdatingSelection = false;
      return;
    }

    if (this.currentSelection) {
      const midLine = Math.floor((this.currentSelection.range.start.line + this.currentSelection.range.end.line) / 2);
      const midCol = Math.floor((this.currentSelection.range.start.character + this.currentSelection.range.end.character) / 2);
      this.astSelector.setCursorPoint({ row: midLine, column: midCol });
      const shrunk = await this.astSelector.shrinkSelection(
        this.currentEditor.document,
        this.currentSelection
      );
      if (shrunk) {
        this.isUpdatingSelection = true;
        this.currentSelection = shrunk;
        this.currentEditor.selection = new vscode.Selection(
          shrunk.range.end,
          shrunk.range.start
        );
        this.currentEditor.setDecorations(this.decorationType, [shrunk.range]);
        this.lastDecoratedKey = shrunk.key;
        this.currentEditor.revealRange(shrunk.range);
        this.updateStatusBar();
        this.isUpdatingSelection = false;
      }
    }
  }

  clearHighlight() {
    if (this.currentEditor) {
      this.currentEditor.setDecorations(this.decorationType, []);
    }
    this.statusBarItem.hide();
    this.currentSelection = undefined;
    this.selectionHistory = [];
    this.lastDecoratedKey = undefined;
    this.lastStatusBarText = undefined;
    this.astSelector.invalidateCache();
  }

  toggleHighlighting() {
    this.isEnabled = !this.isEnabled;
    if (!this.isEnabled) {
      this.clearHighlight();
      this.updateStatusBar();
    } else {
      this.updateStatusBar();
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        this.updateHighlightFromPosition(editor.document, editor.selection.active);
      }
    }
  }

  private updateStatusBar() {
    const showStatusBar = vscode.workspace
      .getConfiguration('code-block-selector')
      .get<boolean>('showStatusBar', true);

    if (!showStatusBar) {
      this.statusBarItem.hide();
      this.lastStatusBarText = undefined;
      return;
    }

    if (!this.isEnabled) {
      this.statusBarItem.text = '$(eye-closed) Code Block Selector: off';
      this.statusBarItem.tooltip = 'Code block highlighting is disabled. Click to enable.';
      this.statusBarItem.command = 'code-block-selector.toggleHighlight';
    } else if (this.currentSelection) {
      const text = `$(symbol-method) ${this.currentSelection.type}`;
      if (text === this.lastStatusBarText) return;
      this.lastStatusBarText = text;
      this.statusBarItem.text = text;
      this.statusBarItem.tooltip = `AST Node: ${this.currentSelection.type}\nClick to select this block`;
      this.statusBarItem.command = 'code-block-selector.selectBlock';
    } else {
      const text = '$(eye) Code Block Selector: on';
      if (text === this.lastStatusBarText) return;
      this.lastStatusBarText = text;
      this.statusBarItem.text = text;
      this.statusBarItem.tooltip = 'Code block highlighting is enabled. Hover over code to see highlights.';
      this.statusBarItem.command = 'code-block-selector.toggleHighlight';
    }

    this.statusBarItem.show();
  }

  updateSettings() {
    const config = vscode.workspace.getConfiguration('code-block-selector');
    const highlightColor = config.get<string>('highlightColor', 'rgba(100,150,255,0.15)');
    this.debounceDelay = config.get<number>('debounceDelay', 50);

    this.decorationType.dispose();
    this.decorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: highlightColor,
      isWholeLine: false,
      borderRadius: '3px',
    });
  }

  getCurrentSelection(): AstSelection | undefined {
    return this.currentSelection;
  }
}
