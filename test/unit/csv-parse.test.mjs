/**
 * Unit tests for the RFC4180 parser in `js/csv.js`.
 *
 * Covers quoted fields, embedded commas, embedded newlines, doubled-quote
 * escape, line terminator variants, BOM stripping, and empty / header-only
 * inputs. The serialize-then-parse round-trip property is exercised in
 * `csv-serialize.test.mjs`.
 */

import { describe, it, expect } from 'vitest';

describe('parseCsv — basic rows', () => {
  it('parses a simple header plus one data row', () => {
    const result = globalThis.parseCsv('a,b,c\n1,2,3');
    expect(result.headers).toEqual(['a', 'b', 'c']);
    expect(result.rows).toEqual([['1', '2', '3']]);
  });

  it('parses multiple data rows', () => {
    const result = globalThis.parseCsv('id,name\n1,alice\n2,bob\n3,carol');
    expect(result.headers).toEqual(['id', 'name']);
    expect(result.rows).toEqual([['1', 'alice'], ['2', 'bob'], ['3', 'carol']]);
  });
});

describe('parseCsv — quoted fields', () => {
  it('keeps embedded commas inside quoted fields', () => {
    const result = globalThis.parseCsv('a,b\n"one,two",three');
    expect(result.rows).toEqual([['one,two', 'three']]);
  });

  it('keeps embedded newlines inside quoted fields', () => {
    const result = globalThis.parseCsv('a,b\n"line1\nline2",x');
    expect(result.rows).toEqual([['line1\nline2', 'x']]);
  });

  it('unescapes doubled double-quotes inside quoted fields', () => {
    const result = globalThis.parseCsv('a,b\n"he said ""hello""",x');
    expect(result.rows).toEqual([['he said "hello"', 'x']]);
  });

  it('handles quoted fields adjacent to unquoted ones', () => {
    const result = globalThis.parseCsv('a,b,c\n"qv",plain,"another"');
    expect(result.rows).toEqual([['qv', 'plain', 'another']]);
  });
});

describe('parseCsv — line terminators', () => {
  it('accepts LF terminators', () => {
    const result = globalThis.parseCsv('a,b\n1,2\n3,4');
    expect(result.rows).toEqual([['1', '2'], ['3', '4']]);
  });

  it('accepts CRLF terminators', () => {
    const result = globalThis.parseCsv('a,b\r\n1,2\r\n3,4');
    expect(result.rows).toEqual([['1', '2'], ['3', '4']]);
  });

  it('accepts bare CR terminators', () => {
    const result = globalThis.parseCsv('a,b\r1,2\r3,4');
    expect(result.rows).toEqual([['1', '2'], ['3', '4']]);
  });

  it('accepts mixed CRLF and LF in the same document', () => {
    const result = globalThis.parseCsv('a,b\r\n1,2\n3,4');
    expect(result.rows).toEqual([['1', '2'], ['3', '4']]);
  });
});

describe('parseCsv — BOM and whitespace', () => {
  it('strips a leading UTF-8 BOM before parsing the header', () => {
    const bom = '\uFEFF';
    const result = globalThis.parseCsv(bom + 'id,name\n1,alice');
    expect(result.headers).toEqual(['id', 'name']);
    expect(result.rows).toEqual([['1', 'alice']]);
  });

  it('trims whitespace around header names', () => {
    const result = globalThis.parseCsv('  id  , name \n1,alice');
    expect(result.headers).toEqual(['id', 'name']);
  });
});

describe('parseCsv — edge cases', () => {
  it('returns empty headers and rows for empty input', () => {
    const result = globalThis.parseCsv('');
    expect(result.headers).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it('returns headers and empty rows when only the header is present', () => {
    const result = globalThis.parseCsv('id,name\n');
    expect(result.headers).toEqual(['id', 'name']);
    expect(result.rows).toEqual([]);
  });

  it('skips blank lines produced by the final newline', () => {
    const result = globalThis.parseCsv('id,name\n1,alice\n');
    expect(result.rows).toEqual([['1', 'alice']]);
  });

  it('preserves empty trailing fields', () => {
    const result = globalThis.parseCsv('a,b,c\n1,,3');
    expect(result.rows).toEqual([['1', '', '3']]);
  });
});
