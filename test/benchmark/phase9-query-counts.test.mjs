/**
 * Phase 9 query-count benchmark.
 *
 * Verifies that the N-plus-one elimination in T9.5 and T9.6 holds: the
 * number of DB round trips in classifyReservationRows does not scale with
 * CSV row count, and renderVisitorTable issues a fixed number of queries
 * regardless of visitor count.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs from 'sql.js';

let SQL;
let originalDbQuery;
let queryCount;

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  globalThis.db = new SQL.Database();
  globalThis.db.run('PRAGMA foreign_keys = ON');
  globalThis.isInTransaction = false;
  globalThis.saveToOPFS = async () => {};

  globalThis.createSchemaV1();
  globalThis.seedData();

  /** Install the dbQuery spy after schema creation so it measures only the
   *  operation under test. dbGetOne calls dbQuery internally, so this catches
   *  every SELECT round trip in the repository layer. */
  queryCount = 0;
  originalDbQuery = globalThis.dbQuery;
  globalThis.dbQuery = function (...args) {
    queryCount++;
    return originalDbQuery.apply(this, args);
  };
});

afterEach(() => {
  globalThis.dbQuery = originalDbQuery;
  try {
    globalThis.db.close();
  } catch (_) {
    /* ignore */
  }
});

describe('classifyReservationRows: query count does not scale with rows', () => {
  it('issues exactly 2 SELECTs for 50 reservation rows against 100 seeded members', async () => {
    /** Seed 100 members through a direct insertion path that runs outside
     *  our dbQuery counter by using db.run directly. */
    globalThis.db.run('BEGIN TRANSACTION');
    for (let i = 0; i < 100; i++) {
      globalThis.db.run(
        'INSERT INTO members (id, name, is_temporary, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
        [`T-${String(i).padStart(4, '0')}`, `会員${i}`, '2026-04-16T00:00:00', '2026-04-16T00:00:00']
      );
    }
    globalThis.db.run('COMMIT');

    /** Reset counter so only classifyReservationRows queries are measured. */
    queryCount = 0;

    const headers = ['会員ID', '日付'];
    const rows = [];
    for (let i = 0; i < 50; i++) {
      rows.push([`T-${String(i).padStart(4, '0')}`, '2026-04-16']);
    }

    const columnMap = globalThis.buildColumnMap(headers, globalThis.RESERVATION_COLUMN_ALIASES);
    const result = globalThis.classifyReservationRows(rows, columnMap, '2026-04-16');

    expect(queryCount).toBe(2);
    expect(result.toAdd.length).toBe(50);
  });

  it('still issues exactly 2 SELECTs for 500 reservation rows (size-independent)', async () => {
    globalThis.db.run('BEGIN TRANSACTION');
    for (let i = 0; i < 500; i++) {
      globalThis.db.run(
        'INSERT INTO members (id, name, is_temporary, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
        [`T-${String(i).padStart(4, '0')}`, `会員${i}`, '2026-04-16T00:00:00', '2026-04-16T00:00:00']
      );
    }
    globalThis.db.run('COMMIT');

    queryCount = 0;

    const headers = ['会員ID', '日付'];
    const rows = [];
    for (let i = 0; i < 500; i++) {
      rows.push([`T-${String(i).padStart(4, '0')}`, '2026-04-16']);
    }

    const columnMap = globalThis.buildColumnMap(headers, globalThis.RESERVATION_COLUMN_ALIASES);
    const result = globalThis.classifyReservationRows(rows, columnMap, '2026-04-16');

    /** Critical property: count did not grow from 50 rows to 500 rows. */
    expect(queryCount).toBe(2);
    expect(result.toAdd.length).toBe(500);
  });

  it('handles the zero-valid-row case without issuing any SELECTs', () => {
    queryCount = 0;
    const headers = ['会員ID', '日付'];
    const columnMap = globalThis.buildColumnMap(headers, globalThis.RESERVATION_COLUMN_ALIASES);
    const result = globalThis.classifyReservationRows([], columnMap, '2026-04-16');

    expect(queryCount).toBe(0);
    expect(result.toAdd.length).toBe(0);
  });
});

describe('renderVisitorTable: fixed query count', () => {
  function setupTableDom() {
    document.body.innerHTML = `
      <table>
        <tbody id="visitor-table-body"></tbody>
      </table>
      <span id="visitor-count"></span>
      <span id="header-total"></span>
    `;
  }

  it('issues exactly 3 queries for 20 seeded transactions (visitor list plus two DISTINCTs)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T06:00:00Z'));
    setupTableDom();

    /** Seed 20 members with mixed class / timeslot values to exercise the DISTINCTs. */
    globalThis.db.run('BEGIN TRANSACTION');
    for (let i = 0; i < 20; i++) {
      const cls = i % 2 === 0 ? '初級' : '中級';
      const slot = i % 3 === 0 ? 'A' : i % 3 === 1 ? 'B' : 'C';
      globalThis.db.run(
        'INSERT INTO members (id, name, class, timeslot, is_temporary, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
        [`T-${String(i).padStart(4, '0')}`, `会員${i}`, cls, slot, '2026-04-16T00:00:00', '2026-04-16T00:00:00']
      );
      globalThis.db.run(
        'INSERT INTO transactions (date, member_id, member_name_snapshot, is_attended, is_received, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?)',
        ['2026-04-16', `T-${String(i).padStart(4, '0')}`, `会員${i}`, '2026-04-16T00:00:00', '2026-04-16T00:00:00']
      );
    }
    globalThis.db.run('COMMIT');

    queryCount = 0;
    globalThis.renderVisitorTable();

    /** 1 getTodayVisitorList + 1 getDistinctClasses + 1 getDistinctTimeslots = 3. */
    expect(queryCount).toBe(3);

    /** Sanity: all 20 rows rendered. */
    const rows = document.getElementById('visitor-table-body').querySelectorAll('tr');
    expect(rows.length).toBe(20);

    vi.useRealTimers();
  });

  it('still issues exactly 3 queries for 5 visitors (count-independent)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T06:00:00Z'));
    setupTableDom();

    globalThis.db.run('BEGIN TRANSACTION');
    for (let i = 0; i < 5; i++) {
      globalThis.db.run(
        'INSERT INTO members (id, name, is_temporary, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
        [`T-${String(i).padStart(4, '0')}`, `会員${i}`, '2026-04-16T00:00:00', '2026-04-16T00:00:00']
      );
      globalThis.db.run(
        'INSERT INTO transactions (date, member_id, member_name_snapshot, is_attended, is_received, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?)',
        ['2026-04-16', `T-${String(i).padStart(4, '0')}`, `会員${i}`, '2026-04-16T00:00:00', '2026-04-16T00:00:00']
      );
    }
    globalThis.db.run('COMMIT');

    queryCount = 0;
    globalThis.renderVisitorTable();

    expect(queryCount).toBe(3);

    vi.useRealTimers();
  });
});
