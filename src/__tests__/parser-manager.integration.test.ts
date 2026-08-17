import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import Parser from 'web-tree-sitter';
import {
  createCachedTree,
  selectInTree,
  expandInTree,
  shrinkInTree,
} from '../parser-manager';
import type { SerializedSelection } from '../parser-manager';

const parsersDir = join(__dirname, '..', '..', 'parsers');

async function parsePython(src: string) {
  await Parser.init({
    locateFile: (name: string) => join(parsersDir, name),
  });
  const parser = new Parser();
  parser.setLanguage(
    await Parser.Language.load(
      readFileSync(join(parsersDir, 'tree-sitter-python.wasm'))
    )
  );
  const tree = parser.parse(src);
  return createCachedTree(tree, src);
}

type Cached = Awaited<ReturnType<typeof parsePython>>;

describe('parser-manager integration (tree-sitter-python)', () => {
  let cached: Cached;

  beforeAll(async () => {
    cached = await parsePython('def foo(a, b):\n    x = a + b\n    return x\n');
  }, 20_000);

  function selectionAt(row: number, col: number): SerializedSelection {
    const sel = selectInTree(cached, { row, column: col });
    expect(sel).not.toBeNull();
    return sel!;
  }

  it('selects an enclosing block when hovering an identifier', () => {
    const sel = selectionAt(1, 4); // over `x` in `x = a + b`
    expect(sel.type).toBe('assignment');
    expect(sel.startLine).toBe(1);
    expect(sel.startChar).toBe(4);
    expect(sel.endChar).toBe(13);
  });

  it('resolves a cursor on an identifier end column consistently', () => {
    const atStart = selectionAt(1, 4); // start of `x`
    const atEnd = selectionAt(1, 5); // last column of `x`
    expect(atStart.type).toBe('assignment');
    expect(atEnd.type).toBe('assignment');
    expect(atEnd.key).toBe(atStart.key);
  });

  it('keeps hover on the containing block, not a bare operand', () => {
    const sel = selectionAt(1, 8); // over operand `a`
    expect(sel.type).toBe('binary_operator');
    expect(sel.key).toBe('binary_operator:1:8:1:13');
  });

  it('shrinks down to a bare identifier (operand) at the cursor', () => {
    const assignment = selectionAt(1, 4); // block = assignment
    const shrunk = shrinkInTree(cached, assignment.key, { row: 1, column: 5 });
    expect(shrunk).not.toBeNull();
    expect(shrunk!.type).toBe('identifier');
    expect(shrunk!.startChar).toBe(4);
    expect(shrunk!.endChar).toBe(5);
  });

  it('expands back up to the enclosing statement', () => {
    const assignment = selectionAt(1, 4);
    const expanded = expandInTree(cached, assignment.key);
    expect(expanded).not.toBeNull();
    expect(expanded!.type).toBe('expression_statement');
  });
});

describe('parser-manager integration (utf-16 columns)', () => {
  let cached: Cached;

  beforeAll(async () => {
    // The astral char (surrogate pair) must not shift UTF-16 columns.
    cached = await parsePython('s = "\u{1F600}"; a = b\n');
  }, 20_000);

  function selectionAt(row: number, col: number): SerializedSelection {
    const sel = selectInTree(cached, { row, column: col });
    expect(sel).not.toBeNull();
    return sel!;
  }

  it('reports UTF-16 columns matching tree-sitter node positions', () => {
    // `a` in the second assignment is at UTF-16 column 10.
    const sel = selectInTree(cached, { row: 0, column: 10 });
    expect(sel).not.toBeNull();
    expect(sel!.type).toBe('assignment');
    expect(sel!.startChar).toBe(10);
  });

  it('shrinks to the identifier after a surrogate-pair char', () => {
    const assignment = selectionAt(0, 10);
    const shrunk = shrinkInTree(cached, assignment.key, { row: 0, column: 10 });
    expect(shrunk).not.toBeNull();
    expect(shrunk!.type).toBe('identifier');
    expect(shrunk!.endChar).toBe(11);
  });
});