import * as vscode from 'vscode';
import { ParserManager } from './parser-manager';
import { HoverDecorator } from './hover-decorator';
import { registerCommands } from './commands';

const INIT_TIMEOUT_MS = 15_000;

export async function activate(context: vscode.ExtensionContext) {
  const parserManager = new ParserManager(context.extensionUri);

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(loading~spin) Code Block Selector: loading parsers...';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const initTimeout = setTimeout(() => {
    statusBarItem.text = '$(warning) Code Block Selector: init timed out';
    statusBarItem.tooltip = 'Parser initialization is taking longer than expected. Reload window to retry.';
  }, INIT_TIMEOUT_MS);

  parserManager.ensureInitialized().then((success) => {
    clearTimeout(initTimeout);
    if (success) {
      statusBarItem.text = '$(check) Code Block Selector: ready';
      setTimeout(() => statusBarItem.hide(), 3000);
    } else {
      statusBarItem.text = '$(error) Code Block Selector: init failed';
      statusBarItem.tooltip = 'Parser initialization failed. Check console for details.';
    }
  }).catch((e) => {
    clearTimeout(initTimeout);
    console.error('[code-block-selector] Parser initialization failed:', e);
    statusBarItem.text = '$(error) Code Block Selector: init failed';
    statusBarItem.tooltip = 'Parser initialization failed. Check console for details.';
  });

  const hoverDecorator = new HoverDecorator(parserManager, context);

  const enabledLanguages = vscode.workspace.getConfiguration('code-block-selector').get<string[]>('enabledLanguages', []);

  try {
    const disposable = hoverDecorator.activate(enabledLanguages.length > 0 ? enabledLanguages : ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'python', 'go']);
    context.subscriptions.push(disposable);
  } catch (e) {
    console.error('[code-block-selector] Hover decorator activation failed:', e);
  }

  registerCommands(context, hoverDecorator);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('code-block-selector')) {
        hoverDecorator.updateSettings();
      }
    }),
    new vscode.Disposable(() => {
      parserManager.dispose();
    })
  );
}

export function deactivate() {}
