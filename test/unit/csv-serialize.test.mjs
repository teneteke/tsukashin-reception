/**
 * Unit tests for the RFC4180 serializer in `js/csv.js` and the
 * `escapeCsvField` helper. Also asserts the round-trip property:
 * parse(serialize(input)) equals input.
 */

import { describe, it, expect } from 'vitest';

describe('escapeCsvField', () => {
  it('leaves plain text unchanged', () => {
    expect(globalThis.escapeCsvField('alice')).toBe('alice');
  });

  it('quotes fields containing a comma', () => {
    expect(globalThis.escapeCsvField('a,b')).toBe('"a,b"');
  });

  it('quotes fields containing a newline', () => {
    expect(globalThis.escapeCsvField('a\nb')).toBe('"a\nb"');
  });

  it('quotes and doubles the quote inside a field containing a quote', () => {
    expect(globalThis.escapeCsvField('he said "hi"')).toBe('"he said ""hi"""');
  });

  it('renders null as an empty string', () => {
    expect(globalThis.escapeCsvField(null)).toBe('');
  });

  it('renders undefined as an empty string', () => {
    expect(globalThis.escapeCsvField(undefined)).toBe('');
  });

  it('coerces numbers to their string form', () => {
    expect(globalThis.escapeCsvField(1234)).toBe('1234');
  });
});

describe('serializeCsv', () => {
  it('joins header and rows with commas and CRLF line endings', () => {
    const output = globalThis.serializeCsv(['a', 'b'], [['1', '2']]);
    expect(output).toBe('a,b\r\n1,2\r\n');
  });

  it('quotes fields containing commas', () => {
    const output = globalThis.serializeCsv(['a'], [['one,two']]);
    expect(output).toBe('a\r\n"one,two"\r\n');
  });

  it('serializes zero rows with just the header line', () => {
    const output = globalThis.serializeCsv(['id', 'name'], []);
    expect(output).toBe('id,name\r\n');
  });
});

describe('serialize then parse round trip', () => {
  it('recovers the original table through serialize then parse', () => {
    const headers = ['id', 'name', 'note'];
    const rows = [
      ['1', 'alice', 'plain'],
      ['2', 'bob', 'has, comma'],
      ['3', 'carol', 'has\nnewline'],
      ['4', 'dave', 'has "quote"'],
    ];
    const csv = globalThis.serializeCsv(headers, rows);
    const parsed = globalThis.parseCsv(csv);
    expect(parsed.headers).toEqual(headers);
    expect(parsed.rows).toEqual(rows);
  });

  it('round-trips Japanese member names and kana', () => {
    const headers = ['会員ID', '氏名', 'カナ'];
    const rows = [
      ['T-0001', '山田太郎', 'ヤマダタロウ'],
      ['T-0002', '佐藤, 花子', 'サトウ ハナコ'],
    ];
    const csv = globalThis.serializeCsv(headers, rows);
    const parsed = globalThis.parseCsv(csv);
    expect(parsed.headers).toEqual(headers);
    expect(parsed.rows).toEqual(rows);
  });
});
