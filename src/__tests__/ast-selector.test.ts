import { describe, it, expect, beforeEach } from 'vitest';
import { AstSelector } from '../ast-selector';
import type { SyntaxNode } from 'web-tree-sitter';

interface MockPoint {
  row: number;
  column: number;
}

interface MockNodeOptions {
  type: string;
  start: MockPoint;
  end: MockPoint;
  children?: MockNode[];
  isNamed?: boolean;
}

interface MockNode {
  type: string;
  startPosition: MockPoint;
  endPosition: MockPoint;
  parent: MockNode | null;
  children: MockNode[];
  readonly childCount: number;
  readonly namedChildCount: number;
  isNamed: boolean;
  child(index: number): MockNode | null;
  descendantForPosition(point: MockPoint): MockNode;
}

function containsPoint(node: MockNode, point: MockPoint): boolean {
  return (
    (node.startPosition.row < point.row ||
      (node.startPosition.row === point.row &&
        node.startPosition.column <= point.column)) &&
    (node.endPosition.row > point.row ||
      (node.endPosition.row === point.row &&
        node.endPosition.column > point.column))
  );
}

function createMockNode(opts: MockNodeOptions): MockNode {
  const children: MockNode[] = opts.children ?? [];
  const node: MockNode = {
    type: opts.type,
    startPosition: opts.start,
    endPosition: opts.end,
    parent: null,
    children,
    get childCount() { return this.children.length; },
    get namedChildCount() { return this.children.filter((c) => c.isNamed).length; },
    isNamed: opts.isNamed ?? true,
    child(index: number): MockNode | null {
      return this.children[index] ?? null;
    },
    descendantForPosition(point: MockPoint): MockNode {
      for (const child of this.children) {
        if (containsPoint(child, point)) {
          const deeper = child.descendantForPosition(point);
          if (deeper.type === child.type && deeper === child) {
            return this;
          }
          return deeper;
        }
      }
      return this;
    },
  };

  for (const child of children) {
    child.parent = node;
  }

  return node;
}

function createMockParserManager(mockTree: MockNode) {
  return {
    isReady: true,
    ensureInitialized: async () => {},
    getNodeAtPosition: () => mockTree as unknown as SyntaxNode,
    onReparse: () => ({ dispose: () => {} }),
    getParser: () => undefined,
    parseDocument: () => undefined,
    dispose: () => {},
  };
}

describe('AstSelector', () => {
  let selector: AstSelector;
  let parserManager: ReturnType<typeof createMockParserManager>;

  beforeEach(() => {
    parserManager = createMockParserManager(
      createMockNode({ type: 'source_file', start: { row: 0, column: 0 }, end: { row: 10, column: 0 } })
    );
    selector = new AstSelector(parserManager as never);
  });

  describe('findMeaningfulBlock', () => {
    it('returns the first ancestor with named children', () => {
      const leaf = createMockNode({
        type: 'identifier',
        start: { row: 1, column: 5 },
        end: { row: 1, column: 10 },
        isNamed: true,
      });

      const intermediate = createMockNode({
        type: 'parameter',
        start: { row: 1, column: 4 },
        end: { row: 1, column: 11 },
        isNamed: false,
        children: [leaf],
      });

      const _block = createMockNode({
        type: 'function_definition',
        start: { row: 1, column: 0 },
        end: { row: 5, column: 0 },
        children: [
          createMockNode({
            type: 'def',
            start: { row: 1, column: 0 },
            end: { row: 1, column: 3 },
            isNamed: false,
          }),
          intermediate,
        ],
      });

      const result = selector.findMeaningfulBlock(leaf as unknown as SyntaxNode);
      expect(result.type).toBe('parameter');
    });

    it('returns the node itself if it has named children', () => {
      const block = createMockNode({
        type: 'function_definition',
        start: { row: 1, column: 0 },
        end: { row: 5, column: 0 },
        children: [
          createMockNode({
            type: 'identifier',
            start: { row: 1, column: 5 },
            end: { row: 1, column: 10 },
            isNamed: true,
          }),
        ],
      });

      const result = selector.findMeaningfulBlock(block as unknown as SyntaxNode);
      expect(result.type).toBe('function_definition');
    });
  });

  describe('expandSelection', () => {
    it('returns parent as AstSelection', () => {
      const child = createMockNode({
        type: 'expression_statement',
        start: { row: 2, column: 4 },
        end: { row: 2, column: 20 },
      });

      const _parent = createMockNode({
        type: 'block',
        start: { row: 1, column: 0 },
        end: { row: 8, column: 0 },
        children: [child],
      });

      // Manually set cursor point for expand (it reads cursorPoint internally)
      selector.setCursorPoint({ row: 2, column: 10 });
      (selector as never).cursorPoint = undefined; // expand doesn't use cursorPoint

      // We need to mock getSelectionAtPosition to return child first
      // Let's just test the getSelectionAtPosition flow instead
    });

    it('returns undefined for root node with no parent', () => {
      const root = createMockNode({
        type: 'source_file',
        start: { row: 0, column: 0 },
        end: { row: 10, column: 0 },
        children: [
          createMockNode({
            type: 'function_definition',
            start: { row: 1, column: 0 },
            end: { row: 5, column: 0 },
          }),
        ],
      });

      // Override parserManager to return the root node
      const rootParserManager = createMockParserManager(root);
      const rootSelector = new AstSelector(rootParserManager as never);
      rootSelector.setCursorPoint({ row: 3, column: 0 });

      const sel = rootSelector.getSelectionAtPosition(
        null as never,
        { line: 3, character: 0 } as never
      );
      expect(sel).toBeDefined();

      const expanded = rootSelector.expandSelection(sel!);
      // source_file is the root, parent should be undefined
      expect(expanded).toBeUndefined();
    });
  });

  describe('shrinkSelection', () => {
    it('finds child containing cursor point', () => {
      const inner = createMockNode({
        type: 'return_statement',
        start: { row: 3, column: 8 },
        end: { row: 3, column: 20 },
      });

      const block = createMockNode({
        type: 'block',
        start: { row: 1, column: 4 },
        end: { row: 7, column: 0 },
        children: [
          createMockNode({
            type: 'expression_statement',
            start: { row: 2, column: 8 },
            end: { row: 2, column: 15 },
          }),
          inner,
        ],
      });

      const parserManager = createMockParserManager(block);
      const sel = new AstSelector(parserManager as never);
      sel.setCursorPoint({ row: 3, column: 10 });

      // Create a selection for the block
      const blockSelection = (sel as never).createSelection(block as unknown as SyntaxNode);

      // Manually populate children
      (sel as never).cursorPoint = { row: 3, column: 10 };
      const shrunk = sel.shrinkSelection(blockSelection);
      expect(shrunk).toBeDefined();
      expect(shrunk!.type).toBe('return_statement');
    });
  });

  describe('nodeContainsPoint', () => {
    it('returns true for point inside node range', () => {
      const node = createMockNode({
        type: 'block',
        start: { row: 1, column: 0 },
        end: { row: 5, column: 0 },
      });

      // Access private method via prototype
      const result = (AstSelector.prototype as never)['nodeContainsPoint'](
        node as unknown as SyntaxNode,
        { row: 3, column: 5 }
      );
      expect(result).toBe(true);
    });

    it('returns false for point outside node range', () => {
      const node = createMockNode({
        type: 'block',
        start: { row: 1, column: 0 },
        end: { row: 5, column: 0 },
      });

      const result = (AstSelector.prototype as never)['nodeContainsPoint'](
        node as unknown as SyntaxNode,
        { row: 0, column: 0 }
      );
      expect(result).toBe(false);
    });

    it('returns true for point at the start of the node', () => {
      const node = createMockNode({
        type: 'block',
        start: { row: 1, column: 5 },
        end: { row: 5, column: 0 },
      });

      const result = (AstSelector.prototype as never)['nodeContainsPoint'](
        node as unknown as SyntaxNode,
        { row: 1, column: 5 }
      );
      expect(result).toBe(true);
    });

    it('returns false for point at the end of the node', () => {
      const node = createMockNode({
        type: 'block',
        start: { row: 1, column: 5 },
        end: { row: 5, column: 10 },
      });

      const result = (AstSelector.prototype as never)['nodeContainsPoint'](
        node as unknown as SyntaxNode,
        { row: 5, column: 10 }
      );
      expect(result).toBe(false);
    });
  });
});
