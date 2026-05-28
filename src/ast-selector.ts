import * as vscode from 'vscode';
import { ParserManager, SerializedSelection } from './parser-manager';

export interface AstSelection {
  range: vscode.Range;
  type: string;
  key: string;
}

export class AstSelector {
  private cursorPoint: { row: number; column: number } | undefined;

  constructor(private parserManager: ParserManager) {}

  setCursorPoint(point: { row: number; column: number }): void {
    this.cursorPoint = point;
  }

  invalidateCache(): void {
  }

  async getSelectionAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<AstSelection | undefined> {
    this.cursorPoint = { row: position.line, column: position.character };

    const sel = await this.parserManager.selectAtPosition(document, position);
    if (!sel) return undefined;

    return this.toAstSelection(sel);
  }

  async expandSelection(
    document: vscode.TextDocument,
    current: AstSelection
  ): Promise<AstSelection | undefined> {
    const sel = await this.parserManager.expandSelection(
      document.uri.toString(),
      current.key
    );
    return sel ? this.toAstSelection(sel) : undefined;
  }

  async shrinkSelection(
    document: vscode.TextDocument,
    current: AstSelection
  ): Promise<AstSelection | undefined> {
    if (!this.cursorPoint) return undefined;

    const sel = await this.parserManager.shrinkSelection(
      document.uri.toString(),
      current.key,
      this.cursorPoint.row,
      this.cursorPoint.column
    );
    return sel ? this.toAstSelection(sel) : undefined;
  }

  private toAstSelection(sel: SerializedSelection): AstSelection {
    return {
      range: new vscode.Range(
        new vscode.Position(sel.startLine, sel.startChar),
        new vscode.Position(sel.endLine, sel.endChar)
      ),
      type: sel.type,
      key: sel.key,
    };
  }
}
