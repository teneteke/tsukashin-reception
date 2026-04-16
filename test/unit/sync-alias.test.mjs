/**
 * Unit tests for the CSV alias helpers and kind-detection in `js/sync.js`.
 *
 * Covers:
 *   - findColumnIndex: trim and case-insensitive lookup
 *   - buildColumnMap: all fields resolved, unmapped fields receive -1
 *   - headersMatchAliasTable: required-field presence check
 *   - detectCsvKind: the public router used by the sync pipeline
 *
 * The sync.js module exposes these helpers as globals (classic script),
 * so tests reference them through globalThis which is set up in
 * test/setup.mjs.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '..', 'fixtures');

/** Helper: read and parse a fixture CSV, returning the header row. */
function headersFromFixture(name) {
  const csv = fs.readFileSync(path.join(fixturesDir, name), 'utf-8');
  const parsed = globalThis.parseCsv(csv);
  return parsed.headers;
}

describe('findColumnIndex', () => {
  it('returns the index for an exact match', () => {
    const idx = globalThis.findColumnIndex(['id', 'name'], ['id']);
    expect(idx).toBe(0);
  });

  it('matches case-insensitively', () => {
    const idx = globalThis.findColumnIndex(['ID', 'Name'], ['id']);
    expect(idx).toBe(0);
  });

  it('trims surrounding whitespace before matching', () => {
    const idx = globalThis.findColumnIndex(['  id  ', 'name'], ['id']);
    expect(idx).toBe(0);
  });

  it('returns -1 when no alias matches', () => {
    const idx = globalThis.findColumnIndex(['foo', 'bar'], ['id', 'member_id']);
    expect(idx).toBe(-1);
  });

  it('tries aliases in order and returns the first hit', () => {
    const idx = globalThis.findColumnIndex(['会員番号', '氏名'], ['会員ID', '会員番号']);
    expect(idx).toBe(0);
  });
});

describe('buildColumnMap — members', () => {
  it('maps every member field from a Japanese-header CSV', () => {
    const headers = headersFromFixture('members-sample.csv');
    const map = globalThis.buildColumnMap(headers, globalThis.MEMBER_COLUMN_ALIASES);
    expect(map.id).toBe(0);
    expect(map.name).toBe(1);
    expect(map.name_kana).toBe(2);
    expect(map.phone).toBe(3);
    expect(map.class).toBe(4);
    expect(map.timeslot).toBe(5);
  });

  it('sets -1 for fields that are not present in the header', () => {
    const map = globalThis.buildColumnMap(['id', 'name'], globalThis.MEMBER_COLUMN_ALIASES);
    expect(map.id).toBe(0);
    expect(map.name).toBe(1);
    expect(map.name_kana).toBe(-1);
    expect(map.phone).toBe(-1);
    expect(map.class).toBe(-1);
    expect(map.timeslot).toBe(-1);
  });
});

describe('headersMatchAliasTable', () => {
  it('returns true when every required field has at least one alias match', () => {
    const headers = ['会員ID', '氏名'];
    expect(
      globalThis.headersMatchAliasTable(headers, globalThis.MEMBER_COLUMN_ALIASES, ['id', 'name'])
    ).toBe(true);
  });

  it('returns false when a required field has no match', () => {
    const headers = ['会員ID'];
    expect(
      globalThis.headersMatchAliasTable(headers, globalThis.MEMBER_COLUMN_ALIASES, ['id', 'name'])
    ).toBe(false);
  });

  it('returns false when the required field name is not in the alias table', () => {
    const headers = ['id', 'name'];
    expect(
      globalThis.headersMatchAliasTable(headers, globalThis.MEMBER_COLUMN_ALIASES, ['unknown'])
    ).toBe(false);
  });
});

describe('detectCsvKind', () => {
  it('routes the member sample to "member"', () => {
    const headers = headersFromFixture('members-sample.csv');
    expect(globalThis.detectCsvKind(headers)).toBe('member');
  });

  it('routes the payment-method sample to "payment"', () => {
    const headers = headersFromFixture('payment-methods-sample.csv');
    expect(globalThis.detectCsvKind(headers)).toBe('payment');
  });

  it('routes the reservation sample to "reservation"', () => {
    const headers = headersFromFixture('reservations-sample.csv');
    expect(globalThis.detectCsvKind(headers)).toBe('reservation');
  });

  it('returns "unknown" for a header with no known aliases', () => {
    expect(globalThis.detectCsvKind(['foo', 'bar'])).toBe('unknown');
  });

  it('returns "unknown" for an empty header list', () => {
    expect(globalThis.detectCsvKind([])).toBe('unknown');
  });

  it('prefers member over reservation when the header has both id and name', () => {
    /** member_id alias includes id, so a header with both id and name could
     *  theoretically look like a reservation; detectCsvKind checks member
     *  first to avoid that misclassification. */
    const headers = ['id', 'name'];
    expect(globalThis.detectCsvKind(headers)).toBe('member');
  });

  it('supports the English aliases for members', () => {
    const headers = ['id', 'name', 'name_kana', 'phone', 'class', 'timeslot'];
    expect(globalThis.detectCsvKind(headers)).toBe('member');
  });

  it('supports the English aliases for reservations', () => {
    const headers = ['member_id', 'date'];
    expect(globalThis.detectCsvKind(headers)).toBe('reservation');
  });
});
