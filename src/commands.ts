import * as vscode from 'vscode';
import { HoverDecorator } from './hover-decorator';

export function registerCommands(
  context: vscode.ExtensionContext,
  decorator: HoverDecorator
) {
  const selectBlock = vscode.commands.registerCommand(
    'code-block-selector.selectBlock',
    () => {
      decorator.selectCurrentBlock();
    }
  );

  const expandSelection = vscode.commands.registerCommand(
    'code-block-selector.expandSelection',
    () => {
      decorator.expandSelection();
    }
  );

  const shrinkSelection = vscode.commands.registerCommand(
    'code-block-selector.shrinkSelection',
    () => {
      decorator.shrinkSelection();
    }
  );

  const toggleHighlight = vscode.commands.registerCommand(
    'code-block-selector.toggleHighlight',
    () => {
      decorator.toggleHighlighting();
    }
  );

  context.subscriptions.push(selectBlock, expandSelection, shrinkSelection, toggleHighlight);
}
