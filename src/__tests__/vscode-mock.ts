import { vi } from 'vitest';

vi.mock('vscode', () => {
  class Position {
    constructor(public line: number, public character: number) {}
  }

  class Range {
    constructor(public start: Position, public end: Position) {}
  }

  return {
    Position,
    Range,
    window: {
      createStatusBarItem: () => ({
        text: '',
        show: () => {},
        hide: () => {},
        dispose: () => {},
      }),
      createTextEditorDecorationType: () => ({
        dispose: () => {},
      }),
      activeTextEditor: undefined,
      onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
    },
    languages: {
      registerHoverProvider: () => ({ dispose: () => {} }),
    },
    workspace: {
      onDidCloseTextDocument: () => ({ dispose: () => {} }),
      onDidChangeConfiguration: () => ({ dispose: () => {} }),
      getConfiguration: () => ({
        get: (key: string, defaultValue: unknown) => defaultValue,
      }),
    },
    commands: {
      registerCommand: () => ({ dispose: () => {} }),
    },
    StatusBarAlignment: { Right: 1 },
    Uri: {
      joinPath: () => ({ fsPath: '/mock/path' }),
    },
    Disposable: {
      from: (...disposables: { dispose: () => void }[]) => ({
        dispose: () => disposables.forEach((d) => d.dispose()),
      }),
    },
    Selection: class {
      constructor(public anchor: Position, public active: Position) {}
    },
  };
});
