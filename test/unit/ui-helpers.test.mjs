/**
 * Unit tests for pure formatters in `js/ui-helpers.js`.
 *
 * Covers formatCurrency and escapeHtml.
 * formatCurrency uses toLocaleString('ja-JP') so the output is yen with
 * comma grouping. escapeHtml uses the textContent-to-innerHTML roundtrip
 * trick provided by jsdom which matches browser behavior: &, <, > become
 * HTML entities, while double quotes are left alone because they are valid
 * inside a text node.
 */

import { describe, it, expect } from 'vitest';

describe('formatCurrency', () => {
  it('formats a positive integer with yen sign and comma groups', () => {
    expect(globalThis.formatCurrency(1000)).toBe('¥1,000');
    expect(globalThis.formatCurrency(1234567)).toBe('¥1,234,567');
  });

  it('formats zero as ¥0', () => {
    expect(globalThis.formatCurrency(0)).toBe('¥0');
  });

  it('formats small values without comma grouping', () => {
    expect(globalThis.formatCurrency(99)).toBe('¥99');
    expect(globalThis.formatCurrency(999)).toBe('¥999');
  });

  it('formats negative values with a minus sign', () => {
    expect(globalThis.formatCurrency(-500)).toBe('¥-500');
  });

  it('coerces numeric strings via Number()', () => {
    expect(globalThis.formatCurrency('1234')).toBe('¥1,234');
  });

  it('formats large values typical of receipt totals', () => {
    expect(globalThis.formatCurrency(100000)).toBe('¥100,000');
  });
});

describe('escapeHtml', () => {
  it('escapes less-than and greater-than as HTML entities', () => {
    expect(globalThis.escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes ampersand as an HTML entity', () => {
    expect(globalThis.escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('blocks a classic XSS payload', () => {
    /** The critical property: < and > are escaped so the string cannot
     *  activate as an element when inserted with innerHTML. */
    const malicious = '<img src=x onerror="alert(1)">';
    const escaped = globalThis.escapeHtml(malicious);
    expect(escaped).not.toContain('<img');
    expect(escaped).toContain('&lt;img');
  });

  it('preserves plain text unchanged', () => {
    expect(globalThis.escapeHtml('hello world')).toBe('hello world');
  });

  it('preserves Japanese characters unchanged', () => {
    expect(globalThis.escapeHtml('山田太郎')).toBe('山田太郎');
  });

  it('returns empty string for null', () => {
    expect(globalThis.escapeHtml(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(globalThis.escapeHtml(undefined)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(globalThis.escapeHtml('')).toBe('');
  });
});

describe('normalizeKanaQuery', () => {
  it('folds a hiragana string to the matching full-width katakana', () => {
    /** U+3041 through U+3096 shift up by 0x60 to reach U+30A1 through U+30F6.
     *  One multi-character example is enough to prove the range shift works. */
    expect(globalThis.normalizeKanaQuery('かいいん')).toBe('カイイン');
  });

  it('passes already-full-width katakana through unchanged', () => {
    expect(globalThis.normalizeKanaQuery('カイイン')).toBe('カイイン');
  });

  it('folds half-width katakana to full-width katakana via NFKC', () => {
    /** Half-width ｶｲｲﾝ (U+FF76 U+FF72 U+FF72 U+FF9D) composes through NFKC
     *  into the full-width form members.name_kana stores. */
    expect(globalThis.normalizeKanaQuery('ｶｲｲﾝ')).toBe('カイイン');
  });

  it('resolves a mixed hiragana plus katakana input to all katakana', () => {
    expect(globalThis.normalizeKanaQuery('かイいン')).toBe('カイイン');
  });

  it('preserves ASCII member identifiers unchanged', () => {
    /** The id branch of searchMembers uses prefix LIKE on ascii; the
     *  normalizer must not corrupt strings like T-0001. */
    expect(globalThis.normalizeKanaQuery('T-0001')).toBe('T-0001');
  });

  it('preserves ASCII phone numbers unchanged', () => {
    /** The phone branch must likewise pass through; NFKC on plain ascii
     *  digits and hyphens is a no-op. */
    expect(globalThis.normalizeKanaQuery('090-0000')).toBe('090-0000');
  });

  it('preserves kanji characters unchanged', () => {
    /** name_kana is katakana but display names in the id branch etc. may
     *  include kanji; the normalizer must not rewrite kanji code points. */
    expect(globalThis.normalizeKanaQuery('山田太郎')).toBe('山田太郎');
  });

  it('returns empty string for null', () => {
    expect(globalThis.normalizeKanaQuery(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(globalThis.normalizeKanaQuery(undefined)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(globalThis.normalizeKanaQuery('')).toBe('');
  });

  it('passes whitespace-only input through unchanged', () => {
    /** Trimming is the caller's responsibility; the normalizer only
     *  concerns itself with kana folding, so spaces are preserved. */
    expect(globalThis.normalizeKanaQuery('  ')).toBe('  ');
  });
});
