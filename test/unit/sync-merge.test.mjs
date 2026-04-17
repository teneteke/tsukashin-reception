/**
 * Unit tests for the Phase 14 reservation merge classifier in `js/sync.js`.
 *
 * Covers `classifyReservationsForMerge` — a pure function that takes incoming
 * CSV rows, existing protection-flagged transactions, and a member lookup map,
 * and returns five disjoint buckets: toInsert, alreadyExists, toAutoDelete,
 * toProtect, notInMaster.
 *
 * The classifier is exposed as a global via the classic-script test harness.
 */

import { describe, it, expect } from 'vitest';

/** Build the columnMap shape the classifier expects. */
const columnMap = { member_id: 0, date: 1 };

describe('classifyReservationsForMerge — toInsert bucket', () => {
  it('inserts CSV rows whose member_id is new on the target date', () => {
    const csvRows = [['T-0001', '2026-04-16']];
    const memberMap = new Map([['T-0001', { id: 'T-0001', name: '山田' }]]);
    const existing = [];

    const result = globalThis.classifyReservationsForMerge(
      csvRows, columnMap, '2026-04-16', existing, memberMap
    );

    expect(result.toInsert.length).toBe(1);
    expect(result.toInsert[0]).toEqual({ date: '2026-04-16', member_id: 'T-0001', member_name: '山田' });
    expect(result.alreadyExists).toEqual([]);
    expect(result.toAutoDelete).toEqual([]);
    expect(result.toProtect).toEqual([]);
    expect(result.notInMaster).toEqual([]);
  });

  it('preserves CSV row order in toInsert', () => {
    const csvRows = [
      ['T-0003', '2026-04-16'],
      ['T-0001', '2026-04-16'],
      ['T-0002', '2026-04-16'],
    ];
    const memberMap = new Map([
      ['T-0001', { id: 'T-0001', name: 'A' }],
      ['T-0002', { id: 'T-0002', name: 'B' }],
      ['T-0003', { id: 'T-0003', name: 'C' }],
    ]);
    const result = globalThis.classifyReservationsForMerge(
      csvRows, columnMap, '2026-04-16', [], memberMap
    );
    expect(result.toInsert.map((r) => r.member_id)).toEqual(['T-0003', 'T-0001', 'T-0002']);
  });
});

describe('classifyReservationsForMerge — alreadyExists bucket', () => {
  it('counts CSV rows whose member_id matches an existing transaction on the date', () => {
    const csvRows = [['T-0001', '2026-04-16']];
    const memberMap = new Map([['T-0001', { id: 'T-0001', name: '山田' }]]);
    const existing = [
      { id: 1, member_id: 'T-0001', member_name_snapshot: '山田', is_attended: 0, is_received: 0, is_temporary: 0 },
    ];

    const result = globalThis.classifyReservationsForMerge(
      csvRows, columnMap, '2026-04-16', existing, memberMap
    );

    expect(result.toInsert).toEqual([]);
    expect(result.alreadyExists.length).toBe(1);
    expect(result.alreadyExists[0].member_id).toBe('T-0001');
    expect(result.toAutoDelete).toEqual([]);
    expect(result.toProtect).toEqual([]);
  });
});

describe('classifyReservationsForMerge — CSV dedup (T14.7)', () => {
  it('dedupes duplicate CSV member_ids so alreadyExists counts only once per member', () => {
    const csvRows = [
      ['T-0001', '2026-04-16'],
      ['T-0001', '2026-04-16'],
    ];
    const memberMap = new Map([['T-0001', { id: 'T-0001', name: '山田' }]]);
    const existing = [
      { id: 1, member_id: 'T-0001', member_name_snapshot: '山田', is_attended: 0, is_received: 0, is_temporary: 0 },
    ];

    const result = globalThis.classifyReservationsForMerge(
      csvRows, columnMap, '2026-04-16', existing, memberMap
    );

    expect(result.alreadyExists.length).toBe(1);
    expect(result.toInsert.length).toBe(0);
  });

  it('dedupes duplicate CSV member_ids so toInsert contains only one entry per member', () => {
    const csvRows = [
      ['T-0004', '2026-04-16'],
      ['T-0004', '2026-04-16'],
    ];
    const memberMap = new Map([['T-0004', { id: 'T-0004', name: '田中' }]]);

    const result = globalThis.classifyReservationsForMerge(
      csvRows, columnMap, '2026-04-16', [], memberMap
    );

    expect(result.toInsert.length).toBe(1);
    expect(result.toInsert[0].member_id).toBe('T-0004');
  });
});

describe('classifyReservationsForMerge — toAutoDelete bucket', () => {
  it('flags existing unprotected rows missing from CSV for deletion', () => {
    const csvRows = [['T-0002', '2026-04-16']];
    const memberMap = new Map([['T-0002', { id: 'T-0002', name: 'B' }]]);
    const existing = [
      { id: 1, member_id: 'T-0001', member_name_snapshot: '山田', is_attended: 0, is_received: 0, is_temporary: 0 },
      { id: 2, member_id: 'T-0002', member_name_snapshot: 'B', is_attended: 0, is_received: 0, is_temporary: 0 },
    ];

    const result = globalThis.classifyReservationsForMerge(
      csvRows, columnMap, '2026-04-16', existing, memberMap
    );

    expect(result.toAutoDelete.length).toBe(1);
    expect(result.toAutoDelete[0]).toEqual({ id: 1, member_id: 'T-0001', member_name: '山田' });
    expect(result.alreadyExists.length).toBe(1);
  });
});

describe('classifyReservationsForMerge — toProtect bucket', () => {
  it('protects is_attended=1 rows with reason "attended"', () => {
    const csvRows = [];
    const memberMap = new Map();
    const existing = [
      { id: 5, member_id: 'T-0001', member_name_snapshot: '山田', is_attended: 1, is_received: 0, is_temporary: 0 },
    ];

    const result = globalThis.classifyReservationsForMerge(
      csvRows, columnMap, '2026-04-16', existing, memberMap
    );

    expect(result.toProtect.length).toBe(1);
    expect(result.toProtect[0].reason).toBe('attended');
    expect(result.toAutoDelete).toEqual([]);
  });

  it('protects is_received=1 rows with reason "received"', () => {
    const existing = [
      { id: 5, member_id: 'T-0001', member_name_snapshot: '山田', is_attended: 0, is_received: 1, is_temporary: 0 },
    ];
    const result = globalThis.classifyReservationsForMerge(
      [], columnMap, '2026-04-16', existing, new Map()
    );
    expect(result.toProtect[0].reason).toBe('received');
  });

  it('protects is_temporary=1 walk-ins with reason "walk-in"', () => {
    const existing = [
      { id: 5, member_id: 'W-0001', member_name_snapshot: 'ウォークイン', is_attended: 0, is_received: 0, is_temporary: 1 },
    ];
    const result = globalThis.classifyReservationsForMerge(
      [], columnMap, '2026-04-16', existing, new Map()
    );
    expect(result.toProtect[0].reason).toBe('walk-in');
  });

  it('prioritises received over attended when both are set', () => {
    const existing = [
      { id: 5, member_id: 'T-0001', member_name_snapshot: '山田', is_attended: 1, is_received: 1, is_temporary: 0 },
    ];
    const result = globalThis.classifyReservationsForMerge(
      [], columnMap, '2026-04-16', existing, new Map()
    );
    expect(result.toProtect[0].reason).toBe('received');
  });

  it('prioritises attended over walk-in when both are set', () => {
    const existing = [
      { id: 5, member_id: 'W-0001', member_name_snapshot: 'ウォークイン', is_attended: 1, is_received: 0, is_temporary: 1 },
    ];
    const result = globalThis.classifyReservationsForMerge(
      [], columnMap, '2026-04-16', existing, new Map()
    );
    expect(result.toProtect[0].reason).toBe('attended');
  });
});

describe('classifyReservationsForMerge — notInMaster bucket', () => {
  it('reports CSV member_ids missing from the member master', () => {
    const csvRows = [['X-9999', '2026-04-16']];
    const memberMap = new Map();
    const result = globalThis.classifyReservationsForMerge(
      csvRows, columnMap, '2026-04-16', [], memberMap
    );
    expect(result.notInMaster).toEqual(['X-9999']);
    expect(result.toInsert).toEqual([]);
  });

  it('dedupes duplicate notInMaster ids to unique values', () => {
    const csvRows = [
      ['X-9999', '2026-04-16'],
      ['X-9999', '2026-04-16'],
      ['X-8888', '2026-04-16'],
    ];
    const result = globalThis.classifyReservationsForMerge(
      csvRows, columnMap, '2026-04-16', [], new Map()
    );
    expect(result.notInMaster.sort()).toEqual(['X-8888', 'X-9999']);
  });
});

describe('classifyReservationsForMerge — date scoping', () => {
  it('ignores CSV rows whose explicit date differs from targetDate', () => {
    const csvRows = [
      ['T-0001', '2026-04-15'],
      ['T-0002', '2026-04-16'],
    ];
    const memberMap = new Map([
      ['T-0001', { id: 'T-0001', name: 'A' }],
      ['T-0002', { id: 'T-0002', name: 'B' }],
    ]);
    const result = globalThis.classifyReservationsForMerge(
      csvRows, columnMap, '2026-04-16', [], memberMap
    );
    expect(result.toInsert.length).toBe(1);
    expect(result.toInsert[0].member_id).toBe('T-0002');
  });

  it('uses targetDate as fallback when the date column is empty', () => {
    const csvRows = [['T-0001', '']];
    const memberMap = new Map([['T-0001', { id: 'T-0001', name: 'A' }]]);
    const result = globalThis.classifyReservationsForMerge(
      csvRows, columnMap, '2026-04-16', [], memberMap
    );
    expect(result.toInsert.length).toBe(1);
    expect(result.toInsert[0].date).toBe('2026-04-16');
  });

  it('skips CSV rows with malformed date strings', () => {
    const csvRows = [['T-0001', 'not-a-date']];
    const memberMap = new Map([['T-0001', { id: 'T-0001', name: 'A' }]]);
    const result = globalThis.classifyReservationsForMerge(
      csvRows, columnMap, '2026-04-16', [], memberMap
    );
    expect(result.toInsert).toEqual([]);
  });
});

describe('classifyReservationsForMerge — mixed end-to-end scenario', () => {
  it('correctly classifies a mix of added, kept, auto-deleted, protected, and not-in-master rows', () => {
    const csvRows = [
      ['T-0001', '2026-04-16'], // alreadyExists
      ['T-0004', '2026-04-16'], // toInsert
      ['X-9999', '2026-04-16'], // notInMaster
    ];
    const memberMap = new Map([
      ['T-0001', { id: 'T-0001', name: 'A' }],
      ['T-0004', { id: 'T-0004', name: 'D' }],
    ]);
    const existing = [
      { id: 1, member_id: 'T-0001', member_name_snapshot: 'A', is_attended: 0, is_received: 0, is_temporary: 0 }, // alreadyExists
      { id: 2, member_id: 'T-0002', member_name_snapshot: 'B', is_attended: 0, is_received: 0, is_temporary: 0 }, // toAutoDelete (unprotected, missing from CSV)
      { id: 3, member_id: 'T-0003', member_name_snapshot: 'C', is_attended: 1, is_received: 0, is_temporary: 0 }, // toProtect (attended)
    ];

    const result = globalThis.classifyReservationsForMerge(
      csvRows, columnMap, '2026-04-16', existing, memberMap
    );

    expect(result.toInsert.map((r) => r.member_id)).toEqual(['T-0004']);
    expect(result.alreadyExists.map((r) => r.member_id)).toEqual(['T-0001']);
    expect(result.toAutoDelete.map((r) => r.member_id)).toEqual(['T-0002']);
    expect(result.toProtect.map((r) => r.member_id)).toEqual(['T-0003']);
    expect(result.toProtect[0].reason).toBe('attended');
    expect(result.notInMaster).toEqual(['X-9999']);
  });

  it('returns empty buckets when CSV and existing are both empty', () => {
    const result = globalThis.classifyReservationsForMerge(
      [], columnMap, '2026-04-16', [], new Map()
    );
    expect(result.toInsert).toEqual([]);
    expect(result.alreadyExists).toEqual([]);
    expect(result.toAutoDelete).toEqual([]);
    expect(result.toProtect).toEqual([]);
    expect(result.notInMaster).toEqual([]);
  });
});
