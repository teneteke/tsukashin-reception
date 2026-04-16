/**
 * Phase 9 transaction-batching benchmark.
 *
 * Verifies that the withTransaction API from T9.1 collapses N dbRun calls
 * into exactly one saveToOPFS invocation, that per-dbRun calls outside of
 * withTransaction still fire saveToOPFS per write (as expected), and that
 * a thrown exception inside the callback triggers rollback with zero OPFS
 * writes and no surviving rows in the target table.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs from 'sql.js';

let SQL;
let saveToOPFSSpy;

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  globalThis.db = new SQL.Database();
  globalThis.db.run('PRAGMA foreign_keys = ON');
  globalThis.isInTransaction = false;

  /** Spy must be in place BEFORE createSchemaV1 / seedData so seeding is
   *  counted as part of the baseline and not left over into test assertions. */
  saveToOPFSSpy = vi.fn(async () => {});
  globalThis.saveToOPFS = saveToOPFSSpy;

  globalThis.createSchemaV1();
  globalThis.seedData();

  /** Reset counter after seeding so tests measure only the operation under test. */
  saveToOPFSSpy.mockClear();
});

afterEach(() => {
  try {
    globalThis.db.close();
  } catch (_) {
    /* ignore */
  }
});

describe('withTransaction: OPFS write collapse', () => {
  it('100 dbRun calls inside one withTransaction produce exactly one saveToOPFS call', async () => {
    await globalThis.withTransaction(async () => {
      for (let i = 0; i < 100; i++) {
        await globalThis.dbRun(
          'INSERT INTO members (id, name, is_temporary, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
          [`T-${String(i).padStart(4, '0')}`, `会員${i}`, '2026-04-16T00:00:00', '2026-04-16T00:00:00']
        );
      }
    });

    expect(saveToOPFSSpy).toHaveBeenCalledTimes(1);

    /** Confirm all 100 rows were committed. */
    const row = globalThis.dbGetOne('SELECT COUNT(*) AS c FROM members WHERE is_temporary = 0');
    expect(row.c).toBe(100);
  });

  it('baseline: 10 dbRun calls outside withTransaction produce 10 saveToOPFS calls', async () => {
    for (let i = 0; i < 10; i++) {
      await globalThis.dbRun(
        'INSERT INTO members (id, name, is_temporary, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
        [`T-${String(i).padStart(4, '0')}`, `会員${i}`, '2026-04-16T00:00:00', '2026-04-16T00:00:00']
      );
    }
    expect(saveToOPFSSpy).toHaveBeenCalledTimes(10);
  });

  it('exception inside withTransaction rolls back and skips saveToOPFS entirely', async () => {
    await expect(
      globalThis.withTransaction(async () => {
        await globalThis.dbRun(
          'INSERT INTO members (id, name, is_temporary, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
          ['T-0001', '会員', '2026-04-16T00:00:00', '2026-04-16T00:00:00']
        );
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(saveToOPFSSpy).toHaveBeenCalledTimes(0);

    /** Rollback preserves the pre-transaction state. */
    const row = globalThis.dbGetOne('SELECT COUNT(*) AS c FROM members WHERE id = ?', ['T-0001']);
    expect(row.c).toBe(0);
  });

  it('nested withTransaction is rejected with a clear error', async () => {
    await expect(
      globalThis.withTransaction(async () => {
        await globalThis.withTransaction(async () => {
          /* unreachable */
        });
      })
    ).rejects.toThrow(/ネスト/);
  });

  it('isInTransaction flag is released even on exception', async () => {
    await expect(
      globalThis.withTransaction(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(globalThis.isInTransaction).toBe(false);
  });
});

describe('syncMembersFromCsv: OPFS write batching', () => {
  it('500-row member CSV import produces exactly one saveToOPFS call', async () => {
    const headers = ['会員ID', '氏名', 'カナ', '電話番号', 'クラス', '時間枠'];
    const rows = [];
    for (let i = 0; i < 500; i++) {
      rows.push([
        `T-${String(i).padStart(4, '0')}`,
        `会員${i}`,
        `カイイン${i}`,
        '090-0000-0000',
        '初級',
        'A',
      ]);
    }

    const result = await globalThis.syncMembersFromCsv(headers, rows);

    expect(saveToOPFSSpy).toHaveBeenCalledTimes(1);
    expect(result.updated).toBe(500);

    /** Verify last_member_sync was updated atomically inside the same transaction. */
    const setting = globalThis.getSetting('last_member_sync');
    expect(setting).not.toBe('');
  });

  it('mid-row INSERT failure (duplicate id) stays atomic: other rows still commit', async () => {
    const headers = ['会員ID', '氏名'];
    const rows = [
      ['T-0001', '会員1'],
      ['T-0002', '会員2'],
      ['T-0001', '会員1-重複'],
      ['T-0003', '会員3'],
    ];

    const result = await globalThis.syncMembersFromCsv(headers, rows);

    /** 1 duplicate skipped, 3 inserted. Still one OPFS write at commit. */
    expect(saveToOPFSSpy).toHaveBeenCalledTimes(1);
    expect(result.updated).toBe(3);
    expect(result.skipped).toBe(1);
  });
});

describe('syncReservationsFromCsv: OPFS write batching', () => {
  beforeEach(async () => {
    /** Seed members so reservations can link to them. */
    const headers = ['会員ID', '氏名'];
    const memberRows = [];
    for (let i = 0; i < 50; i++) {
      memberRows.push([`T-${String(i).padStart(4, '0')}`, `会員${i}`]);
    }
    await globalThis.syncMembersFromCsv(headers, memberRows);
    saveToOPFSSpy.mockClear();
  });

  it('50-row reservation CSV import produces exactly one saveToOPFS call after confirmation', async () => {
    /** Stub the in-app confirm to auto-accept. */
    const originalConfirm = globalThis.window.confirmAction;
    globalThis.window.confirmAction = async () => true;

    const headers = ['会員ID', '日付'];
    const rows = [];
    for (let i = 0; i < 50; i++) {
      rows.push([`T-${String(i).padStart(4, '0')}`, '2026-04-16']);
    }

    const result = await globalThis.syncReservationsFromCsv(headers, rows, '2026-04-16');

    expect(result.confirmed).toBe(true);
    expect(result.added).toBe(50);
    expect(saveToOPFSSpy).toHaveBeenCalledTimes(1);

    /** Cleanup: restore stub. */
    globalThis.window.confirmAction = originalConfirm;
  });

  it('cancelled confirmation results in zero saveToOPFS calls', async () => {
    const originalConfirm = globalThis.window.confirmAction;
    globalThis.window.confirmAction = async () => false;

    const headers = ['会員ID', '日付'];
    const rows = [
      ['T-0001', '2026-04-16'],
      ['T-0002', '2026-04-16'],
    ];

    const result = await globalThis.syncReservationsFromCsv(headers, rows, '2026-04-16');

    expect(result.confirmed).toBe(false);
    expect(result.added).toBe(0);
    expect(saveToOPFSSpy).toHaveBeenCalledTimes(0);

    globalThis.window.confirmAction = originalConfirm;
  });
});

describe('addItemToMemberToday: OPFS write batching', () => {
  it('add-to-nonexistent transaction path produces exactly one saveToOPFS call', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T06:00:00Z'));

    /** Seed one member. Reset spy after seed path writes. */
    await globalThis.syncMembersFromCsv(['会員ID', '氏名'], [['T-0001', '会員']]);
    saveToOPFSSpy.mockClear();

    /** This path creates a transaction AND inserts an item — multiple dbRun
     *  calls that would produce 2 or 3 OPFS writes without withTransaction. */
    await globalThis.addItemToMemberToday('T-0001', { code: '001', name: '体験', price: 1100 });

    expect(saveToOPFSSpy).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('repeat add (quantity increment path) produces one saveToOPFS call', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T06:00:00Z'));

    await globalThis.syncMembersFromCsv(['会員ID', '氏名'], [['T-0001', '会員']]);
    await globalThis.addItemToMemberToday('T-0001', { code: '001', name: '体験', price: 1100 });
    saveToOPFSSpy.mockClear();

    await globalThis.addItemToMemberToday('T-0001', { code: '001', name: '体験', price: 1100 });

    expect(saveToOPFSSpy).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
