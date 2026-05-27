import * as vscode from 'vscode';
import { ParserManager } from './parser-manager';
import { HoverDecorator } from './hover-decorator';
import { registerCommands } from './commands';

export async function activate(context: vscode.ExtensionContext) {
  const parserManager = new ParserManager(context.extensionUri);

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(loading~spin) Code Block Selector: loading parsers...';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  parserManager.ensureInitialized().then(() => {
    statusBarItem.text = '$(check) Code Block Selector: ready';
    setTimeout(() => statusBarItem.hide(), 3000);
  }).catch((e) => {
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
