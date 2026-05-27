import * as vscode from 'vscode';
import { ParserManager } from './parser-manager';
import type { SyntaxNode } from 'web-tree-sitter';

export interface AstSelection {
  node: SyntaxNode;
  range: vscode.Range;
  type: string;
  parent: AstSelection | undefined;
  children: AstSelection[];
  key: string;
}

export class AstSelector {
  private cursorPoint: { row: number; column: number } | undefined;
  private selectionCache = new Map<string, AstSelection>();

  constructor(private parserManager: ParserManager) {}

  setCursorPoint(point: { row: number; column: number }): void {
    this.cursorPoint = point;
  }

  invalidateCache(): void {
    this.selectionCache.clear();
  }

  getSelectionAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): AstSelection | undefined {
    this.cursorPoint = { row: position.line, column: position.character };

    const deepestNode = this.parserManager.getNodeAtPosition(document, position);
    if (!deepestNode) return undefined;

    const meaningfulNode = this.findMeaningfulBlock(deepestNode);
    return this.createSelection(meaningfulNode);
  }

  findMeaningfulBlock(node: SyntaxNode): SyntaxNode {
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

  expandSelection(current: AstSelection): AstSelection | undefined {
    const parentNode = current.node.parent;
    if (!parentNode) return undefined;

    const parentSelection = this.createSelection(parentNode);
    current.parent = parentSelection;

    this.populateChildren(parentSelection);

    return parentSelection;
  }

  shrinkSelection(current: AstSelection): AstSelection | undefined {
    if (!this.cursorPoint) return undefined;

    this.populateChildren(current);

    const childAtCursor = current.children.find(c => this.nodeContainsPoint(c.node, this.cursorPoint!));
    if (childAtCursor) return childAtCursor;

    return undefined;
  }

  private createSelection(node: SyntaxNode): AstSelection {
    const nodeKey = this.getNodeKey(node);
    const cached = this.selectionCache.get(nodeKey);
    if (cached) return cached;

    const selection: AstSelection = {
      node,
      range: this.nodeToRange(node),
      type: node.type,
      parent: undefined,
      children: [],
      key: nodeKey,
    };

    this.selectionCache.set(nodeKey, selection);
    return selection;
  }

  private populateChildren(selection: AstSelection): void {
    if (selection.children.length > 0) return;
    if (!this.cursorPoint) return;

    const childNode = this.findDeepestChildContainingPoint(selection.node, this.cursorPoint);
    if (childNode && childNode !== selection.node) {
      const meaningfulNode = this.findMeaningfulBlock(childNode);
      if (meaningfulNode !== selection.node) {
        const childSelection = this.createSelection(meaningfulNode);
        selection.children = [childSelection];
        childSelection.parent = selection;
      }
    }
  }

  private findDeepestChildContainingPoint(
    node: SyntaxNode,
    point: { row: number; column: number }
  ): SyntaxNode | undefined {
    let current = node;
    let found = true;

    while (found) {
      found = false;
      for (let i = 0; i < current.childCount; i++) {
        const child = current.child(i);
        if (!child) continue;

        if (this.nodeContainsPoint(child, point)) {
          current = child;
          found = true;
          break;
        }
      }
    }

    return current !== node ? current : undefined;
  }

  private nodeContainsPoint(
    node: SyntaxNode,
    point: { row: number; column: number }
  ): boolean {
    return (
      (node.startPosition.row < point.row ||
        (node.startPosition.row === point.row && node.startPosition.column <= point.column)) &&
      (node.endPosition.row > point.row ||
        (node.endPosition.row === point.row && node.endPosition.column > point.column))
    );
  }

  private getNodeKey(node: SyntaxNode): string {
    return `${node.type}:${node.startPosition.row}:${node.startPosition.column}:${node.endPosition.row}:${node.endPosition.column}`;
  }

  private nodeToRange(node: SyntaxNode): vscode.Range {
    const start = new vscode.Position(node.startPosition.row, node.startPosition.column);
    const end = new vscode.Position(node.endPosition.row, node.endPosition.column);
    return new vscode.Range(start, end);
  }
}
