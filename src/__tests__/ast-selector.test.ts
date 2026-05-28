import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AstSelector } from '../ast-selector';
import type { SerializedSelection } from '../parser-manager';

function createMockParserManager() {
  const selections = new Map<string, SerializedSelection | null>();
  const expandResults = new Map<string, SerializedSelection | null>();
  const shrinkResults = new Map<string, SerializedSelection | null>();

  return {
    isReady: true,
    ensureInitialized: vi.fn().mockResolvedValue(true),
    selectAtPosition: vi.fn().mockImplementation(
      async (_doc: unknown, _pos: unknown) => {
        return null;
      }
    ),
    expandSelection: vi.fn().mockImplementation(
      async (uri: string, key: string) => {
        const resultKey = `${uri}:expand:${key}`;
        return expandResults.get(resultKey) ?? null;
      }
    ),
    shrinkSelection: vi.fn().mockImplementation(
      async (uri: string, key: string, _line: number, _char: number) => {
        const resultKey = `${uri}:shrink:${key}`;
        return shrinkResults.get(resultKey) ?? null;
      }
    ),
    onReparse: () => ({ dispose: () => {} }),
    dispose: () => {},
    _setSelectResult: (uri: string, sel: SerializedSelection | null) => {
      (selections as never)[`${uri}:select`] = sel;
    },
    _setExpandResult: (uri: string, key: string, sel: SerializedSelection | null) => {
      expandResults.set(`${uri}:expand:${key}`, sel);
    },
    _setShrinkResult: (uri: string, key: string, sel: SerializedSelection | null) => {
      shrinkResults.set(`${uri}:shrink:${key}`, sel);
    },
  };
}

function createSel(type: string, sLine: number, sChar: number, eLine: number, eChar: number): SerializedSelection {
  return {
    type,
    startLine: sLine,
    startChar: sChar,
    endLine: eLine,
    endChar: eChar,
    key: `${type}:${sLine}:${sChar}:${eLine}:${eChar}`,
  };
}

const MOCK_DOC = { uri: { toString: () => 'doc://test' }, version: 1 } as never;
const MOCK_POS = { line: 2, character: 5 } as never;

describe('AstSelector (async API)', () => {
  let selector: AstSelector;
  let mockManager: ReturnType<typeof createMockParserManager>;

  beforeEach(() => {
    mockManager = createMockParserManager();
    selector = new AstSelector(mockManager as never);
  });

  describe('getSelectionAtPosition', () => {
    it('returns undefined when parser returns null', async () => {
      mockManager.selectAtPosition.mockResolvedValue(null);
      const result = await selector.getSelectionAtPosition(MOCK_DOC, MOCK_POS);
      expect(result).toBeUndefined();
    });

    it('converts SerializedSelection to AstSelection', async () => {
      const sel = createSel('function_definition', 0, 0, 5, 0);
      mockManager.selectAtPosition.mockResolvedValue(sel);

      const result = await selector.getSelectionAtPosition(MOCK_DOC, MOCK_POS);
      expect(result).toBeDefined();
      expect(result!.type).toBe('function_definition');
      expect(result!.key).toBe(sel.key);
    });
  });

  describe('expandSelection', () => {
    it('returns undefined when no parent', async () => {
      mockManager.expandSelection.mockResolvedValue(null);
      const current = { range: null as never, type: 'block', key: 'block:0:0:5:0' };
      const result = await selector.expandSelection(MOCK_DOC, current);
      expect(result).toBeUndefined();
    });

    it('returns parent selection', async () => {
      const parentSel = createSel('function_definition', 0, 0, 10, 0);
      mockManager.expandSelection.mockResolvedValue(parentSel);
      const current = { range: null as never, type: 'block', key: 'block:1:4:5:0' };

      const result = await selector.expandSelection(MOCK_DOC, current);
      expect(result).toBeDefined();
      expect(result!.type).toBe('function_definition');
    });
  });

  describe('shrinkSelection', () => {
    it('returns undefined when cursorPoint not set', async () => {
      const current = { range: null as never, type: 'block', key: 'block:0:0:5:0' };
      const result = await selector.shrinkSelection(MOCK_DOC, current);
      expect(result).toBeUndefined();
    });

    it('returns child selection at cursor', async () => {
      selector.setCursorPoint({ row: 2, column: 10 });
      const childSel = createSel('return_statement', 2, 8, 2, 20);
      mockManager.shrinkSelection.mockResolvedValue(childSel);
      const current = { range: null as never, type: 'block', key: 'block:0:0:5:0' };

      const result = await selector.shrinkSelection(MOCK_DOC, current);
      expect(result).toBeDefined();
      expect(result!.type).toBe('return_statement');
    });

    it('returns undefined when no child contains cursor', async () => {
      selector.setCursorPoint({ row: 10, column: 0 });
      mockManager.shrinkSelection.mockResolvedValue(null);
      const current = { range: null as never, type: 'block', key: 'block:0:0:5:0' };

      const result = await selector.shrinkSelection(MOCK_DOC, current);
      expect(result).toBeUndefined();
    });
  });

  describe('invalidateCache', () => {
    it('does not throw', () => {
      expect(() => selector.invalidateCache()).not.toThrow();
    });
  });
});
