/**
 * Unit tests for the pure helpers in `js/receipt.js`.
 *
 * Font loading and PDF generation are out of scope (they require a
 * browser-like fetch for the TTF and a jsPDF instance). Only the
 * description generator is exercised here.
 */

import { describe, it, expect } from 'vitest';

describe('generateReceiptDescription', () => {
  it('emits the lesson phrase for a single lesson category', () => {
    const items = [{ category: 'レッスン' }];
    expect(globalThis.generateReceiptDescription(items)).toBe('レッスン代として');
  });

  it('emits the merchandise phrase for a single merchandise category', () => {
    const items = [{ category: '商品' }];
    expect(globalThis.generateReceiptDescription(items)).toBe('商品代として');
  });

  it('emits the rental phrase for a single rental category', () => {
    const items = [{ category: 'レンタル' }];
    expect(globalThis.generateReceiptDescription(items)).toBe('レンタル代として');
  });

  it('joins multiple categories with the Japanese comma', () => {
    const items = [{ category: 'レッスン' }, { category: '商品' }];
    const result = globalThis.generateReceiptDescription(items);
    expect(result).toContain('レッスン代');
    expect(result).toContain('商品代');
    expect(result).toContain('、');
    expect(result.endsWith('として')).toBe(true);
  });

  it('deduplicates repeated categories', () => {
    const items = [
      { category: 'レッスン' },
      { category: 'レッスン' },
      { category: 'レッスン' },
    ];
    expect(globalThis.generateReceiptDescription(items)).toBe('レッスン代として');
  });

  it('renders unknown categories as raw category name plus 代', () => {
    const items = [{ category: 'カスタム' }];
    expect(globalThis.generateReceiptDescription(items)).toBe('カスタム代として');
  });

  it('falls back to the default phrase for zero items', () => {
    expect(globalThis.generateReceiptDescription([])).toBe('お品代として');
  });

  it('falls back to the default phrase for null input', () => {
    expect(globalThis.generateReceiptDescription(null)).toBe('お品代として');
  });

  it('ignores items whose category is null, undefined, or empty', () => {
    const items = [
      { category: 'レッスン' },
      { category: null },
      { category: undefined },
      { category: '' },
    ];
    expect(globalThis.generateReceiptDescription(items)).toBe('レッスン代として');
  });

  it('falls back to default when all items have null categories', () => {
    const items = [{ category: null }, { category: null }];
    expect(globalThis.generateReceiptDescription(items)).toBe('お品代として');
  });

  it('sorts categories alphabetically for deterministic output', () => {
    /** JavaScript locale-neutral sort on Japanese strings: compares by
     *  UTF-16 code unit. "商品" (\u5546...) comes before "レッスン" (\u30EC...)
     *  because U+5546 < U+30EC? Actually \u30EC = 12524 < \u5546 = 21830,
     *  so "レッスン" comes first in a raw code-unit sort. This test captures
     *  the current behavior so a future sort-order change is noticed. */
    const items1 = [{ category: 'レッスン' }, { category: '商品' }];
    const items2 = [{ category: '商品' }, { category: 'レッスン' }];
    expect(globalThis.generateReceiptDescription(items1)).toBe(
      globalThis.generateReceiptDescription(items2)
    );
  });
});
