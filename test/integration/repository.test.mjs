/**
 * Integration tests for `js/repository.js` against an in-memory sql.js database.
 *
 * The test harness stands up a fresh SQLite database in memory before every
 * test, runs `createSchemaV1` and `seedData` to populate the schema, then
 * exercises every exported repository function through the real query path.
 *
 * `saveToOPFS` is stubbed to a no-op so writes do not attempt OPFS access
 * in Node. `isInTransaction` is reset before each test so withTransaction
 * state cannot leak between cases.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs from 'sql.js';

/** sql.js module-level handle, populated once across all tests. */
let SQL;

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  globalThis.db = new SQL.Database();
  globalThis.db.run('PRAGMA foreign_keys = ON');
  globalThis.saveToOPFS = async () => {};
  globalThis.isInTransaction = false;
  globalThis.createSchemaV1();
  globalThis.seedData();
});

afterEach(() => {
  try {
    globalThis.db.close();
  } catch (_) {
    /* ignore */
  }
  globalThis.db = null;
  vi.useRealTimers();
});

/** Helper: insert one member directly so tests can set arbitrary fields. */
function insertMember(row) {
  const now = globalThis.getNowISO();
  globalThis.db.run(
    `INSERT INTO members (id, name, name_kana, phone, class, timeslot, is_temporary, memo, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.name,
      row.name_kana ?? null,
      row.phone ?? null,
      row.class ?? null,
      row.timeslot ?? null,
      row.is_temporary ?? 0,
      row.memo ?? null,
      now,
      now,
    ]
  );
}

/** Helper: insert one transaction directly. */
function insertTransaction(row) {
  const now = globalThis.getNowISO();
  globalThis.db.run(
    `INSERT INTO transactions (date, member_id, member_name_snapshot, class_override, timeslot_override, payment_method_id, is_attended, is_received, memo, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.date,
      row.member_id,
      row.member_name_snapshot,
      row.class_override ?? null,
      row.timeslot_override ?? null,
      row.payment_method_id ?? null,
      row.is_attended ?? 0,
      row.is_received ?? 0,
      row.memo ?? null,
      now,
      now,
    ]
  );
  const idRow = globalThis.db.exec('SELECT last_insert_rowid() AS id')[0];
  return idRow.values[0][0];
}

// ==========================================================================
// Schema and seed
// ==========================================================================

describe('schema and seed', () => {
  it('creates all seven required tables', () => {
    const rows = globalThis.dbQuery(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    );
    const names = rows.map((r) => r.name);
    for (const t of ['members', 'payment_methods', 'products', 'receipt_log', 'settings', 'transaction_items', 'transactions']) {
      expect(names).toContain(t);
    }
  });

  it('seeds the three initial payment methods', () => {
    const rows = globalThis.getActivePaymentMethods();
    const names = rows.map((r) => r.name);
    expect(names).toContain('現金');
    expect(names).toContain('PayPay');
    expect(names).toContain('カード');
  });

  it('seeds the nine initial products', () => {
    const products = globalThis.getAllProducts();
    expect(products.length).toBe(9);
    const codes = products.map((p) => p.code);
    expect(codes).toContain('001');
    expect(codes).toContain('031');
  });
});

// ==========================================================================
// Members
// ==========================================================================

describe('getMemberById / getMemberName', () => {
  it('returns member data when the id exists', () => {
    insertMember({ id: 'T-0001', name: '山田太郎', phone: '090-1111-2222', class: '初中級', timeslot: 'A' });
    const m = globalThis.getMemberById('T-0001');
    expect(m).not.toBeNull();
    expect(m.name).toBe('山田太郎');
    expect(m.phone).toBe('090-1111-2222');
  });

  it('returns null for an unknown id', () => {
    expect(globalThis.getMemberById('X-9999')).toBeNull();
  });

  it('getMemberName returns just the name', () => {
    insertMember({ id: 'T-0001', name: '山田太郎' });
    expect(globalThis.getMemberName('T-0001')).toBe('山田太郎');
    expect(globalThis.getMemberName('X-9999')).toBeNull();
  });
});

describe('searchMembers', () => {
  beforeEach(() => {
    insertMember({ id: 'T-0001', name: '山田太郎', name_kana: 'ヤマダタロウ', phone: '090-1111-1111' });
    insertMember({ id: 'T-0002', name: '山田花子', name_kana: 'ヤマダハナコ', phone: '090-2222-2222' });
    insertMember({ id: 'T-0010', name: '佐藤一郎', name_kana: 'サトウイチロウ', phone: '090-3333-3333' });
    insertMember({ id: 'W-0001', name: 'walk-in', name_kana: 'ウォークイン', phone: null });
  });

  it('finds by id prefix', () => {
    const results = globalThis.searchMembers('T-00', 10);
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual(['T-0001', 'T-0002', 'T-0010']);
  });

  it('finds by phone prefix after id branch', () => {
    const results = globalThis.searchMembers('090-22', 10);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('T-0002');
  });

  it('finds by kana prefix (post-T9.7 behavior)', () => {
    const results = globalThis.searchMembers('ヤマダ', 10);
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual(['T-0001', 'T-0002']);
  });

  it('does not match kana substring mid-string (prefix-only semantics)', () => {
    /** "タロウ" appears as a suffix of "ヤマダタロウ"; under the old leading-wildcard
     *  behavior this would match. After T9.7 it must not. */
    const results = globalThis.searchMembers('タロウ', 10);
    expect(results.length).toBe(0);
  });

  it('respects the limit parameter across all three branches', () => {
    insertMember({ id: 'T-0003', name: '山田三郎', name_kana: 'ヤマダサブロウ' });
    const results = globalThis.searchMembers('T-', 2);
    expect(results.length).toBe(2);
  });

  it('deduplicates: same member surfacing through multiple branches appears only once', () => {
    /** T-0001 would match id prefix "T-" and kana prefix "ヤマ" — invoking
     *  separate queries must not return two copies. */
    const results = globalThis.searchMembers('T-0001', 10);
    const count = results.filter((r) => r.id === 'T-0001').length;
    expect(count).toBe(1);
  });
});

describe('getDistinctClasses / getDistinctTimeslots', () => {
  it('returns unique non-empty class values sorted', () => {
    insertMember({ id: 'a', name: 'a', class: '初級' });
    insertMember({ id: 'b', name: 'b', class: '中級' });
    insertMember({ id: 'c', name: 'c', class: '初級' });
    insertMember({ id: 'd', name: 'd', class: null });
    const classes = globalThis.getDistinctClasses();
    expect(classes).toEqual(['中級', '初級']);
  });

  it('returns unique non-empty timeslot values sorted', () => {
    insertMember({ id: 'a', name: 'a', timeslot: 'A' });
    insertMember({ id: 'b', name: 'b', timeslot: 'B' });
    insertMember({ id: 'c', name: 'c', timeslot: 'A' });
    const slots = globalThis.getDistinctTimeslots();
    expect(slots).toEqual(['A', 'B']);
  });
});

describe('updateMemberMemo / createWalkInWithTransaction', () => {
  it('updates member memo', async () => {
    insertMember({ id: 'T-0001', name: '山田' });
    await globalThis.updateMemberMemo('T-0001', '要注意');
    const m = globalThis.getMemberById('T-0001');
    expect(m.memo).toBe('要注意');
  });

  it('clears memo when passed null', async () => {
    insertMember({ id: 'T-0001', name: '山田', memo: '旧メモ' });
    await globalThis.updateMemberMemo('T-0001', null);
    const m = globalThis.getMemberById('T-0001');
    expect(m.memo).toBeNull();
  });

  it('createWalkInWithTransaction creates member and today transaction together', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T06:00:00Z'));

    const walkInId = await globalThis.createWalkInWithTransaction('一見さん');
    expect(walkInId).toMatch(/^W-20260416-\d{3}$/);

    const member = globalThis.getMemberById(walkInId);
    expect(member).not.toBeNull();
    expect(member.name).toBe('一見さん');

    const txnRow = globalThis.dbGetOne(
      'SELECT COUNT(*) AS c FROM transactions WHERE member_id = ? AND date = ?',
      [walkInId, '2026-04-16']
    );
    expect(txnRow.c).toBe(1);
  });

  it('createWalkInWithTransaction increments the per-day counter', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T06:00:00Z'));
    const a = await globalThis.createWalkInWithTransaction('Aさん');
    const b = await globalThis.createWalkInWithTransaction('Bさん');
    expect(a).toBe('W-20260416-001');
    expect(b).toBe('W-20260416-002');
  });
});

// ==========================================================================
// Transactions and visitor list
// ==========================================================================

describe('getTodayVisitorList', () => {
  it('returns empty list when no transactions exist today', () => {
    expect(globalThis.getTodayVisitorList()).toEqual([]);
  });

  it('returns one row per transaction with items grouped and lineTotal computed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T06:00:00Z'));

    insertMember({ id: 'T-0001', name: '山田', class: '初中級', timeslot: 'A' });
    const txnId = insertTransaction({ date: '2026-04-16', member_id: 'T-0001', member_name_snapshot: '山田' });

    globalThis.db.run(
      `INSERT INTO transaction_items (transaction_id, product_code, product_name_snapshot, price_snapshot, quantity)
       VALUES (?, ?, ?, ?, ?)`,
      [txnId, '001', '体験レッスン', 1100, 2]
    );
    globalThis.db.run(
      `INSERT INTO transaction_items (transaction_id, product_code, product_name_snapshot, price_snapshot, quantity)
       VALUES (?, ?, ?, ?, ?)`,
      [txnId, '020', 'グリップテープ', 1000, 1]
    );

    const list = globalThis.getTodayVisitorList();
    expect(list.length).toBe(1);
    expect(list[0].member_id).toBe('T-0001');
    expect(list[0].items.length).toBe(2);
    expect(list[0].lineTotal).toBe(1100 * 2 + 1000);
  });

  it('includes transactions with no items (lineTotal = 0, items = [])', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T06:00:00Z'));
    insertMember({ id: 'T-0001', name: '山田' });
    insertTransaction({ date: '2026-04-16', member_id: 'T-0001', member_name_snapshot: '山田' });

    const list = globalThis.getTodayVisitorList();
    expect(list.length).toBe(1);
    expect(list[0].items).toEqual([]);
    expect(list[0].lineTotal).toBe(0);
  });
});

describe('attendance / received toggles', () => {
  let txnId;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T06:00:00Z'));
    insertMember({ id: 'T-0001', name: '山田' });
    txnId = insertTransaction({ date: '2026-04-16', member_id: 'T-0001', member_name_snapshot: '山田' });
  });

  it('updateAttendance flips is_attended', async () => {
    await globalThis.updateAttendance(txnId, 1);
    expect(globalThis.getTransactionAttendance(txnId).is_attended).toBe(1);
  });

  it('setReceivedWithPayment sets both received flag and payment id', async () => {
    const paymentRow = globalThis.dbGetOne('SELECT id FROM payment_methods WHERE name = ?', ['現金']);
    await globalThis.setReceivedWithPayment(txnId, paymentRow.id);
    const state = globalThis.getTransactionReceived(txnId);
    expect(state.is_received).toBe(1);
    expect(state.payment_method_id).toBe(paymentRow.id);
  });

  it('clearReceived resets both flags to zero / null', async () => {
    const paymentRow = globalThis.dbGetOne('SELECT id FROM payment_methods WHERE name = ?', ['現金']);
    await globalThis.setReceivedWithPayment(txnId, paymentRow.id);
    await globalThis.clearReceived(txnId);
    const state = globalThis.getTransactionReceived(txnId);
    expect(state.is_received).toBe(0);
    expect(state.payment_method_id).toBeNull();
  });
});

describe('deleteTransaction cascades to transaction_items', () => {
  it('removes both the transaction and its items', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T06:00:00Z'));
    insertMember({ id: 'T-0001', name: '山田' });
    const txnId = insertTransaction({ date: '2026-04-16', member_id: 'T-0001', member_name_snapshot: '山田' });
    globalThis.db.run(
      'INSERT INTO transaction_items (transaction_id, product_code, product_name_snapshot, price_snapshot, quantity) VALUES (?, ?, ?, ?, ?)',
      [txnId, '001', '体験レッスン', 1100, 1]
    );

    await globalThis.deleteTransaction(txnId);

    const t = globalThis.dbGetOne('SELECT COUNT(*) AS c FROM transactions WHERE id = ?', [txnId]);
    const i = globalThis.dbGetOne('SELECT COUNT(*) AS c FROM transaction_items WHERE transaction_id = ?', [txnId]);
    expect(t.c).toBe(0);
    expect(i.c).toBe(0);
  });
});

// ==========================================================================
// addItemToMemberToday (both paths)
// ==========================================================================

describe('addItemToMemberToday', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T06:00:00Z'));
    insertMember({ id: 'T-0001', name: '山田' });
  });

  it('auto-creates the transaction when the member has none for today', async () => {
    expect(globalThis.hasTransactionForDate('2026-04-16', 'T-0001')).toBe(false);
    await globalThis.addItemToMemberToday('T-0001', { code: '001', name: '体験レッスン', price: 1100 });
    expect(globalThis.hasTransactionForDate('2026-04-16', 'T-0001')).toBe(true);
  });

  it('inserts a new transaction_item when none exists for the product', async () => {
    await globalThis.addItemToMemberToday('T-0001', { code: '001', name: '体験レッスン', price: 1100 });
    const items = globalThis.getTodaySettlementItems('T-0001');
    const rowWithProduct = items.find((i) => i.product_code === '001');
    expect(rowWithProduct.quantity).toBe(1);
  });

  it('increments quantity when the same product is added twice', async () => {
    await globalThis.addItemToMemberToday('T-0001', { code: '001', name: '体験レッスン', price: 1100 });
    await globalThis.addItemToMemberToday('T-0001', { code: '001', name: '体験レッスン', price: 1100 });
    const items = globalThis.getTodaySettlementItems('T-0001');
    const rowWithProduct = items.find((i) => i.product_code === '001');
    expect(rowWithProduct.quantity).toBe(2);
  });

  it('keeps separate rows for different product codes', async () => {
    await globalThis.addItemToMemberToday('T-0001', { code: '001', name: '体験', price: 1100 });
    await globalThis.addItemToMemberToday('T-0001', { code: '020', name: 'グリップテープ', price: 1000 });
    const items = globalThis.getTodaySettlementItems('T-0001').filter((i) => i.item_id != null);
    expect(items.length).toBe(2);
  });
});

// ==========================================================================
// Settlement queries
// ==========================================================================

describe('getSettlementTotal', () => {
  it('sums price times quantity across the range', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T06:00:00Z'));
    insertMember({ id: 'T-0001', name: '山田' });
    const txn1 = insertTransaction({ date: '2026-04-14', member_id: 'T-0001', member_name_snapshot: '山田' });
    const txn2 = insertTransaction({ date: '2026-04-16', member_id: 'T-0001', member_name_snapshot: '山田' });
    globalThis.db.run(
      'INSERT INTO transaction_items (transaction_id, product_code, product_name_snapshot, price_snapshot, quantity) VALUES (?, ?, ?, ?, ?)',
      [txn1, '001', '体験', 1100, 1]
    );
    globalThis.db.run(
      'INSERT INTO transaction_items (transaction_id, product_code, product_name_snapshot, price_snapshot, quantity) VALUES (?, ?, ?, ?, ?)',
      [txn2, '020', 'グリップテープ', 1000, 2]
    );

    expect(globalThis.getSettlementTotal('T-0001', '2026-04-14', '2026-04-16')).toBe(1100 + 2000);
    expect(globalThis.getSettlementTotal('T-0001', '2026-04-16', '2026-04-16')).toBe(2000);
    expect(globalThis.getSettlementTotal('T-0001', '2026-04-15', '2026-04-15')).toBe(0);
  });

  it('returns 0 for a member with no settlements', () => {
    expect(globalThis.getSettlementTotal('unknown', '2026-01-01', '2026-12-31')).toBe(0);
  });
});

// ==========================================================================
// Products
// ==========================================================================

describe('lookupProduct', () => {
  it('finds by exact 3-digit code', () => {
    const p = globalThis.lookupProduct('001');
    expect(p.code).toBe('001');
    expect(p.name).toBe('体験レッスン');
  });

  it('zero-pads short numeric codes to 3 digits', () => {
    const p = globalThis.lookupProduct('1');
    expect(p.code).toBe('001');
  });

  it('falls back to prefix match when the padded exact is absent (lowest code wins)', async () => {
    /** Deactivate 001 so "01".padStart(3, '0') = "001" no longer matches with
     *  is_active = 1. The fallback runs `WHERE code LIKE '01%'` → 010, 011, 012
     *  all match; ORDER BY code ASC LIMIT 1 yields 010. */
    await globalThis.setProductActive('001', 0);
    const p = globalThis.lookupProduct('01');
    expect(p.code).toBe('010');
  });

  it('returns null for unknown codes', () => {
    expect(globalThis.lookupProduct('999')).toBeNull();
    expect(globalThis.lookupProduct('nonexistent')).toBeNull();
  });
});

describe('product CRUD', () => {
  it('createProduct inserts a provisional product', async () => {
    await globalThis.createProduct({ code: '100', name: 'テスト商品', category: '商品', price: 500 });
    expect(globalThis.productCodeExists('100')).toBe(true);
    const p = globalThis.getProductStatus('100');
    expect(p.is_active).toBe(1);
    expect(p.name).toBe('テスト商品');
  });

  it('updateProductField changes name, category, or price but rejects other fields', async () => {
    await globalThis.updateProductField('001', 'name', '改名');
    const row = globalThis.dbGetOne('SELECT name FROM products WHERE code = ?', ['001']);
    expect(row.name).toBe('改名');

    await expect(globalThis.updateProductField('001', 'created_at', '2026-04-16')).rejects.toThrow();
  });

  it('setProductActive soft-toggles is_active', async () => {
    await globalThis.setProductActive('001', 0);
    expect(globalThis.getProductStatus('001').is_active).toBe(0);
    await globalThis.setProductActive('001', 1);
    expect(globalThis.getProductStatus('001').is_active).toBe(1);
  });
});

// ==========================================================================
// Receipt numbering
// ==========================================================================

describe('getNextReceiptNumber', () => {
  it('returns FY-0001 when receipt_log is empty', () => {
    vi.useFakeTimers();
    /** 2026-04-01 JST → fiscal year 2026 */
    vi.setSystemTime(new Date('2026-03-31T15:00:00Z'));
    expect(globalThis.getNextReceiptNumber()).toBe('2026-0001');
  });

  it('returns MAX+1 for the current fiscal year', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T15:00:00Z'));
    await globalThis.insertReceiptLog({
      receiptNumber: '2026-0005',
      memberId: 'T-0001',
      recipientName: '山田',
      dateFrom: '2026-04-01',
      dateTo: '2026-04-01',
      totalAmount: 1000,
      description: 'レッスン代として',
      issuerName: 'つかしん',
      issuedAt: '2026-04-01T10:00:00',
    });
    expect(globalThis.getNextReceiptNumber()).toBe('2026-0006');
  });

  it('isolates numbering across fiscal years', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T15:00:00Z'));

    /** Seed a prior fiscal year row */
    await globalThis.insertReceiptLog({
      receiptNumber: '2025-0100',
      memberId: 'T-0001',
      recipientName: '山田',
      dateFrom: '2025-04-01',
      dateTo: '2025-04-01',
      totalAmount: 1000,
      description: 'レッスン代として',
      issuerName: 'つかしん',
      issuedAt: '2025-04-01T10:00:00',
    });

    /** Current fiscal year (2026) should still start at 0001 */
    expect(globalThis.getNextReceiptNumber()).toBe('2026-0001');
  });
});

describe('receipt log', () => {
  it('getLastReceipt returns the most recent issue for a member', async () => {
    await globalThis.insertReceiptLog({
      receiptNumber: '2026-0001',
      memberId: 'T-0001',
      recipientName: '山田',
      dateFrom: '2026-04-01',
      dateTo: '2026-04-01',
      totalAmount: 1000,
      description: 'レッスン代として',
      issuerName: 'つかしん',
      issuedAt: '2026-04-01T10:00:00',
    });
    await globalThis.insertReceiptLog({
      receiptNumber: '2026-0002',
      memberId: 'T-0001',
      recipientName: '山田',
      dateFrom: '2026-04-05',
      dateTo: '2026-04-05',
      totalAmount: 2000,
      description: 'レッスン代として',
      issuerName: 'つかしん',
      issuedAt: '2026-04-05T10:00:00',
    });

    const last = globalThis.getLastReceipt('T-0001');
    expect(last.receipt_number).toBe('2026-0002');
    expect(last.total_amount).toBe(2000);
  });

  it('getLastReceipt returns null for a member with no receipts', () => {
    expect(globalThis.getLastReceipt('nobody')).toBeNull();
  });
});

// ==========================================================================
// CSV export data
// ==========================================================================

describe('getSettlementExportData', () => {
  it('returns one row per transaction_item across the date range', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T06:00:00Z'));
    insertMember({ id: 'T-0001', name: '山田' });
    const txnId = insertTransaction({ date: '2026-04-16', member_id: 'T-0001', member_name_snapshot: '山田' });
    globalThis.db.run(
      'INSERT INTO transaction_items (transaction_id, product_code, product_name_snapshot, price_snapshot, quantity) VALUES (?, ?, ?, ?, ?)',
      [txnId, '001', '体験', 1100, 2]
    );

    const rows = globalThis.getSettlementExportData('2026-04-16', '2026-04-16');
    expect(rows.length).toBe(1);
    expect(rows[0].product_code).toBe('001');
    expect(rows[0].quantity).toBe(2);
    expect(rows[0].line_total).toBe(2200);
  });

  it('includes transactions with no items via LEFT JOIN', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T06:00:00Z'));
    insertMember({ id: 'T-0001', name: '山田' });
    insertTransaction({ date: '2026-04-16', member_id: 'T-0001', member_name_snapshot: '山田' });

    const rows = globalThis.getSettlementExportData('2026-04-16', '2026-04-16');
    expect(rows.length).toBe(1);
    expect(rows[0].product_code).toBeNull();
  });
});

// ==========================================================================
// Phase 14: getDateReservationsWithProtectionFlags
// ==========================================================================

describe('getDateReservationsWithProtectionFlags', () => {
  it('returns plain unprotected rows for ordinary reservations', () => {
    insertMember({ id: 'T-0001', name: '山田' });
    insertTransaction({ date: '2026-04-16', member_id: 'T-0001', member_name_snapshot: '山田' });

    const rows = globalThis.getDateReservationsWithProtectionFlags('2026-04-16');
    expect(rows.length).toBe(1);
    expect(rows[0].member_id).toBe('T-0001');
    expect(rows[0].is_attended).toBe(0);
    expect(rows[0].is_received).toBe(0);
    expect(rows[0].is_temporary).toBe(0);
  });

  it('surfaces is_attended=1 for attended rows', () => {
    insertMember({ id: 'T-0001', name: '山田' });
    insertTransaction({ date: '2026-04-16', member_id: 'T-0001', member_name_snapshot: '山田', is_attended: 1 });

    const rows = globalThis.getDateReservationsWithProtectionFlags('2026-04-16');
    expect(rows[0].is_attended).toBe(1);
    expect(rows[0].is_received).toBe(0);
    expect(rows[0].is_temporary).toBe(0);
  });

  it('surfaces is_received=1 for received rows', () => {
    insertMember({ id: 'T-0001', name: '山田' });
    insertTransaction({ date: '2026-04-16', member_id: 'T-0001', member_name_snapshot: '山田', is_received: 1 });

    const rows = globalThis.getDateReservationsWithProtectionFlags('2026-04-16');
    expect(rows[0].is_attended).toBe(0);
    expect(rows[0].is_received).toBe(1);
    expect(rows[0].is_temporary).toBe(0);
  });

  it('surfaces is_temporary=1 for walk-in members', () => {
    insertMember({ id: 'W-0001', name: 'ウォークイン', is_temporary: 1 });
    insertTransaction({ date: '2026-04-16', member_id: 'W-0001', member_name_snapshot: 'ウォークイン' });

    const rows = globalThis.getDateReservationsWithProtectionFlags('2026-04-16');
    expect(rows[0].member_id).toBe('W-0001');
    expect(rows[0].is_temporary).toBe(1);
  });

  it('treats orphan transactions (member deleted) as is_temporary=0 via COALESCE', () => {
    insertTransaction({ date: '2026-04-16', member_id: 'X-9999', member_name_snapshot: 'ghost' });

    const rows = globalThis.getDateReservationsWithProtectionFlags('2026-04-16');
    expect(rows.length).toBe(1);
    expect(rows[0].member_id).toBe('X-9999');
    expect(rows[0].is_temporary).toBe(0);
  });

  it('filters strictly by the supplied date', () => {
    insertMember({ id: 'T-0001', name: '山田' });
    insertTransaction({ date: '2026-04-15', member_id: 'T-0001', member_name_snapshot: '山田' });
    insertTransaction({ date: '2026-04-16', member_id: 'T-0001', member_name_snapshot: '山田' });
    insertTransaction({ date: '2026-04-17', member_id: 'T-0001', member_name_snapshot: '山田' });

    const rows = globalThis.getDateReservationsWithProtectionFlags('2026-04-16');
    expect(rows.length).toBe(1);
  });

  it('returns an empty array when no reservations exist for the date', () => {
    const rows = globalThis.getDateReservationsWithProtectionFlags('2026-04-16');
    expect(rows).toEqual([]);
  });

  it('orders results by transaction id ascending', () => {
    insertMember({ id: 'T-0001', name: '山田' });
    insertMember({ id: 'T-0002', name: '佐藤' });
    insertMember({ id: 'T-0003', name: '鈴木' });
    const id1 = insertTransaction({ date: '2026-04-16', member_id: 'T-0001', member_name_snapshot: '山田' });
    const id2 = insertTransaction({ date: '2026-04-16', member_id: 'T-0002', member_name_snapshot: '佐藤' });
    const id3 = insertTransaction({ date: '2026-04-16', member_id: 'T-0003', member_name_snapshot: '鈴木' });

    const rows = globalThis.getDateReservationsWithProtectionFlags('2026-04-16');
    expect(rows.map((r) => r.id)).toEqual([id1, id2, id3]);
  });
});

// ==========================================================================
// Phase 14: syncReservationsFromCsv (merge executor)
// ==========================================================================

describe('syncReservationsFromCsv (Phase 14 merge)', () => {
  it('merges a mixed scenario: inserts new, keeps existing, auto-deletes unprotected, preserves protected', async () => {
    /** Seed member master with five members. */
    insertMember({ id: 'T-0001', name: '山田' });
    insertMember({ id: 'T-0002', name: '佐藤' });
    insertMember({ id: 'T-0003', name: '鈴木' });
    insertMember({ id: 'T-0004', name: '田中' });
    insertMember({ id: 'W-0001', name: 'ウォークイン', is_temporary: 1 });

    /** Seed existing transactions on the target date with mixed protection states. */
    const id0001 = insertTransaction({ date: '2026-04-16', member_id: 'T-0001', member_name_snapshot: '山田' });                // unprotected, kept in CSV → alreadyExists
    const id0002 = insertTransaction({ date: '2026-04-16', member_id: 'T-0002', member_name_snapshot: '佐藤' });                // unprotected, missing from CSV → auto-delete
    const id0003 = insertTransaction({ date: '2026-04-16', member_id: 'T-0003', member_name_snapshot: '鈴木', is_attended: 1 }); // protected by attended
    const idWalk = insertTransaction({ date: '2026-04-16', member_id: 'W-0001', member_name_snapshot: 'ウォークイン' });        // protected by walk-in

    /** Incoming CSV: keeps T-0001, adds T-0004, omits T-0002 / T-0003 / W-0001, includes unknown X-9999. */
    const headers = ['会員ID', '日付'];
    const rows = [
      ['T-0001', '2026-04-16'],
      ['T-0004', '2026-04-16'],
      ['X-9999', '2026-04-16'],
    ];

    const result = await globalThis.syncReservationsFromCsv(headers, rows, '2026-04-16');

    expect(result.added).toBe(1);
    expect(result.alreadyExists).toBe(1);
    expect(result.autoDeleted.length).toBe(1);
    expect(result.autoDeleted[0].id).toBe(id0002);
    expect(result.autoDeleted[0].member_id).toBe('T-0002');
    expect(result.protectedRows.length).toBe(2);
    const protectedIds = result.protectedRows.map((r) => r.id).sort();
    expect(protectedIds).toEqual([id0003, idWalk].sort());
    expect(result.notInMaster).toEqual(['X-9999']);

    /** Verify actual DB state. */
    const survivors = globalThis.getDateReservationsWithProtectionFlags('2026-04-16');
    const survivorIds = survivors.map((r) => r.member_id).sort();
    expect(survivorIds).toEqual(['T-0001', 'T-0003', 'T-0004', 'W-0001']);
  });

  it('throws when the reservation CSV is missing the required member_id column', async () => {
    const headers = ['日付'];
    const rows = [['2026-04-16']];
    await expect(globalThis.syncReservationsFromCsv(headers, rows, '2026-04-16')).rejects.toThrow(/会員ID/);
  });

  it('throws when targetDate is malformed', async () => {
    const headers = ['会員ID', '日付'];
    await expect(globalThis.syncReservationsFromCsv(headers, [], '2026-4-16')).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('is idempotent: re-running with the same CSV adds nothing and deletes nothing', async () => {
    insertMember({ id: 'T-0001', name: 'A' });
    insertMember({ id: 'T-0002', name: 'B' });
    const headers = ['会員ID', '日付'];
    const rows = [
      ['T-0001', '2026-04-16'],
      ['T-0002', '2026-04-16'],
    ];

    const first = await globalThis.syncReservationsFromCsv(headers, rows, '2026-04-16');
    expect(first.added).toBe(2);
    expect(first.autoDeleted.length).toBe(0);

    const second = await globalThis.syncReservationsFromCsv(headers, rows, '2026-04-16');
    expect(second.added).toBe(0);
    expect(second.alreadyExists).toBe(2);
    expect(second.autoDeleted.length).toBe(0);
    expect(second.protectedRows.length).toBe(0);
  });

  it('cascades transaction_items deletion when a transaction is auto-deleted', async () => {
    insertMember({ id: 'T-0001', name: 'A' });
    const txnId = insertTransaction({ date: '2026-04-16', member_id: 'T-0001', member_name_snapshot: 'A' });
    globalThis.db.run(
      'INSERT INTO transaction_items (transaction_id, product_code, product_name_snapshot, price_snapshot, quantity) VALUES (?, ?, ?, ?, ?)',
      [txnId, '001', '体験', 1100, 1]
    );

    /** Confirm cascade happens even though the transaction has items,
     *  because the user's Phase 14 rule only protects by attended / received / walk-in. */
    const headers = ['会員ID', '日付'];
    const result = await globalThis.syncReservationsFromCsv(headers, [], '2026-04-16');

    expect(result.autoDeleted.length).toBe(1);
    const itemRows = globalThis.dbQuery('SELECT 1 FROM transaction_items WHERE transaction_id = ?', [txnId]);
    expect(itemRows.length).toBe(0);
  });
});

// ==========================================================================
// Phase 15: Date-parameterized repository functions (T15.3)
// ==========================================================================

describe('getTodayVisitorList with targetDate parameter', () => {
  it('returns transactions for the specified date, not today', () => {
    insertMember({ id: 'T-0001', name: 'A' });
    insertTransaction({ date: '2026-03-20', member_id: 'T-0001', member_name_snapshot: 'A' });
    insertTransaction({ date: '2026-04-16', member_id: 'T-0001', member_name_snapshot: 'A' });

    const marchRows = globalThis.getTodayVisitorList('2026-03-20');
    expect(marchRows.length).toBe(1);
    expect(marchRows[0].date).toBe('2026-03-20');

    const aprilRows = globalThis.getTodayVisitorList('2026-04-16');
    expect(aprilRows.length).toBe(1);
    expect(aprilRows[0].date).toBe('2026-04-16');
  });
});

describe('addMemberTransaction with targetDate parameter', () => {
  it('inserts a transaction on the specified date', async () => {
    insertMember({ id: 'T-0001', name: 'A' });
    await globalThis.addMemberTransaction('T-0001', '2026-03-15');
    const rows = globalThis.dbQuery('SELECT date FROM transactions WHERE member_id = ?', ['T-0001']);
    expect(rows.length).toBe(1);
    expect(rows[0].date).toBe('2026-03-15');
  });
});

describe('addItemToMemberToday with targetDate parameter', () => {
  it('creates a transaction and item on the specified date', async () => {
    insertMember({ id: 'T-0001', name: 'A' });
    await globalThis.addItemToMemberToday('T-0001', { code: '001', name: '体験', price: 1100 }, '2026-03-10');
    const txn = globalThis.dbQuery('SELECT id, date FROM transactions WHERE member_id = ? AND date = ?', ['T-0001', '2026-03-10']);
    expect(txn.length).toBe(1);
    expect(txn[0].date).toBe('2026-03-10');
    const items = globalThis.dbQuery('SELECT product_code FROM transaction_items WHERE transaction_id = ?', [txn[0].id]);
    expect(items.length).toBe(1);
    expect(items[0].product_code).toBe('001');
  });
});

describe('createWalkInWithTransaction with targetDate parameter', () => {
  it('creates a walk-in member and transaction on the specified date', async () => {
    const walkInId = await globalThis.createWalkInWithTransaction('テスト来場者', '2026-03-05');
    expect(walkInId).toMatch(/^W-20260305-/);
    const txn = globalThis.dbQuery('SELECT date FROM transactions WHERE member_id = ?', [walkInId]);
    expect(txn.length).toBe(1);
    expect(txn[0].date).toBe('2026-03-05');
  });
});

// ==========================================================================
// Phase 17: Fallback path tests for four Phase 15 date-parameterized functions (T17.4)
// ==========================================================================

describe('Phase 15 repository functions fall back to today JST when targetDate is omitted or falsy', () => {
  const FIXED_TODAY = '2026-04-17';

  beforeEach(() => {
    vi.useFakeTimers();
    /** Lock the clock to a JST-friendly UTC time that yields FIXED_TODAY through
     *  the `sv-SE` + `Asia/Tokyo` helper used by getTodayJST. 06:00 UTC is
     *  15:00 JST, safely inside the same calendar day in both zones. */
    vi.setSystemTime(new Date('2026-04-17T06:00:00Z'));
  });

  it('getTodayVisitorList with undefined targetDate falls back to today JST', () => {
    insertMember({ id: 'T-0001', name: 'A' });
    insertTransaction({ date: FIXED_TODAY, member_id: 'T-0001', member_name_snapshot: 'A' });
    insertTransaction({ date: '2026-03-20', member_id: 'T-0001', member_name_snapshot: 'A' });

    const rows = globalThis.getTodayVisitorList();
    expect(rows.length).toBe(1);
    expect(rows[0].date).toBe(FIXED_TODAY);
  });

  it('getTodayVisitorList with null targetDate falls back to today JST', () => {
    insertMember({ id: 'T-0001', name: 'A' });
    insertTransaction({ date: FIXED_TODAY, member_id: 'T-0001', member_name_snapshot: 'A' });

    const rows = globalThis.getTodayVisitorList(null);
    expect(rows.length).toBe(1);
    expect(rows[0].date).toBe(FIXED_TODAY);
  });

  it('addMemberTransaction with undefined targetDate inserts on today JST', async () => {
    insertMember({ id: 'T-0001', name: 'A' });

    await globalThis.addMemberTransaction('T-0001');

    const rows = globalThis.dbQuery('SELECT date FROM transactions WHERE member_id = ?', ['T-0001']);
    expect(rows.length).toBe(1);
    expect(rows[0].date).toBe(FIXED_TODAY);
  });

  it('addItemToMemberToday with undefined targetDate creates the transaction on today JST', async () => {
    insertMember({ id: 'T-0001', name: 'A' });

    await globalThis.addItemToMemberToday('T-0001', { code: '001', name: '体験', price: 1100 });

    const txn = globalThis.dbQuery('SELECT date FROM transactions WHERE member_id = ?', ['T-0001']);
    expect(txn.length).toBe(1);
    expect(txn[0].date).toBe(FIXED_TODAY);
  });

  it('createWalkInWithTransaction with undefined targetDate uses today JST for id prefix and transaction date', async () => {
    const walkInId = await globalThis.createWalkInWithTransaction('テスト来場者');

    /** id prefix is todays date compacted (YYYYMMDD with no dashes). */
    expect(walkInId).toMatch(/^W-20260417-/);
    const txn = globalThis.dbQuery('SELECT date FROM transactions WHERE member_id = ?', [walkInId]);
    expect(txn.length).toBe(1);
    expect(txn[0].date).toBe(FIXED_TODAY);
  });
});

// ==========================================================================
// Phase 17: Boundary-value tests for four Phase 15 date-parameterized functions (T17.5)
//
// These tests lock the *current* unvalidated behavior of the four repository
// functions. The contrast with `syncReservationsFromCsv` is deliberate: the
// CSV sync validates because it sits at an external input boundary, while
// these four are only called from internal code. The tests document the
// observed policy rather than enforce validation.
// ==========================================================================

describe('Phase 15 repository functions observed behavior for ill-formed targetDate', () => {
  const FIXED_TODAY = '2026-04-17';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T06:00:00Z'));
  });

  it('getTodayVisitorList with empty-string targetDate falls back to today JST through the falsy coercion', () => {
    insertMember({ id: 'T-0001', name: 'A' });
    insertTransaction({ date: FIXED_TODAY, member_id: 'T-0001', member_name_snapshot: 'A' });
    insertTransaction({ date: '2026-03-20', member_id: 'T-0001', member_name_snapshot: 'A' });

    const rows = globalThis.getTodayVisitorList('');
    expect(rows.length).toBe(1);
    expect(rows[0].date).toBe(FIXED_TODAY);
  });

  it('getTodayVisitorList with a non-date string returns zero rows because no transaction date matches verbatim', () => {
    insertMember({ id: 'T-0001', name: 'A' });
    insertTransaction({ date: FIXED_TODAY, member_id: 'T-0001', member_name_snapshot: 'A' });

    const rows = globalThis.getTodayVisitorList('invalid-date-string');
    expect(rows.length).toBe(0);
  });

  it('addMemberTransaction with empty-string targetDate falls back to today JST', async () => {
    insertMember({ id: 'T-0001', name: 'A' });

    await globalThis.addMemberTransaction('T-0001', '');

    const rows = globalThis.dbQuery('SELECT date FROM transactions WHERE member_id = ?', ['T-0001']);
    expect(rows.length).toBe(1);
    expect(rows[0].date).toBe(FIXED_TODAY);
  });

  it('addMemberTransaction with a non-date string propagates the string verbatim into the date column', async () => {
    /** No validation exists; the column accepts any TEXT. This locks the
     *  observed behavior so a future refactor cannot silently change it. */
    insertMember({ id: 'T-0001', name: 'A' });

    await globalThis.addMemberTransaction('T-0001', 'not-a-date');

    const rows = globalThis.dbQuery('SELECT date FROM transactions WHERE member_id = ?', ['T-0001']);
    expect(rows.length).toBe(1);
    expect(rows[0].date).toBe('not-a-date');
  });

  it('addItemToMemberToday with empty-string targetDate creates the transaction on today JST', async () => {
    insertMember({ id: 'T-0001', name: 'A' });

    await globalThis.addItemToMemberToday('T-0001', { code: '001', name: '体験', price: 1100 }, '');

    const rows = globalThis.dbQuery('SELECT date FROM transactions WHERE member_id = ?', ['T-0001']);
    expect(rows.length).toBe(1);
    expect(rows[0].date).toBe(FIXED_TODAY);
  });

  it('addItemToMemberToday with a non-zero-padded date propagates the string verbatim', async () => {
    /** Shape like 2026-4-17 (not zero-padded). No validation exists, so the
     *  string lands in the date column as-is. Observed-behavior lock. */
    insertMember({ id: 'T-0001', name: 'A' });

    await globalThis.addItemToMemberToday('T-0001', { code: '001', name: '体験', price: 1100 }, '2026-4-17');

    const rows = globalThis.dbQuery('SELECT date FROM transactions WHERE member_id = ?', ['T-0001']);
    expect(rows.length).toBe(1);
    expect(rows[0].date).toBe('2026-4-17');
  });

  it('createWalkInWithTransaction with empty-string targetDate uses today JST for both id prefix and transaction date', async () => {
    const walkInId = await globalThis.createWalkInWithTransaction('テスト来場者', '');

    expect(walkInId).toMatch(/^W-20260417-/);
    const txn = globalThis.dbQuery('SELECT date FROM transactions WHERE member_id = ?', [walkInId]);
    expect(txn.length).toBe(1);
    expect(txn[0].date).toBe(FIXED_TODAY);
  });

  it('createWalkInWithTransaction with a non-date string embeds the compacted form in the walk-in id', async () => {
    /** The id prefix is `W-${targetDate.replace(/-/g, '')}-`. A non-date
     *  string with dashes gets the dashes stripped and embedded as-is.
     *  No validation exists; this records the observed shape. */
    const walkInId = await globalThis.createWalkInWithTransaction('テスト来場者', 'bad-date-str');

    expect(walkInId).toMatch(/^W-baddatestr-/);
    const txn = globalThis.dbQuery('SELECT date FROM transactions WHERE member_id = ?', [walkInId]);
    expect(txn.length).toBe(1);
    expect(txn[0].date).toBe('bad-date-str');
  });
});

// ==========================================================================
// Phase 18: Sales-detail CSV import end-to-end
// ==========================================================================

describe('Phase 18: syncSalesFromCsv end-to-end', () => {
  /** Bring the DB up to schema V2 (staff_name column + GUEST seed) before
   *  each sales-import test. Without this the sales executor cannot write
   *  the staff_name column and the GUEST pseudo-member is absent. */
  beforeEach(() => {
    globalThis.migrations[2]();
  });

  /** Seed helpers so tests start from a known member / product / payment baseline. */
  function seedMembers() {
    insertMember({ id: 'T-0001', name: '山田 太郎', is_temporary: 0 });
    insertMember({ id: 'T-0002', name: '佐藤 花子', is_temporary: 0 });
  }

  function seedDuplicateNames() {
    insertMember({ id: 'D-0001', name: '同名 太郎', is_temporary: 0 });
    insertMember({ id: 'D-0002', name: '同名 太郎', is_temporary: 0 });
  }

  /** Seed payment_methods to match what sales CSV will reference. */
  function seedSalesPaymentMethods() {
    /** seedData already inserted 現金 / PayPay / カード. Add 現金/スマホ and ステラ
     *  explicitly so the sales resolver can bind. Leave seeded methods in place. */
    globalThis.db.run(
      `INSERT INTO payment_methods (name, is_active, sort_order) VALUES ('現金/スマホ', 1, 10)`
    );
    globalThis.db.run(
      `INSERT INTO payment_methods (name, is_active, sort_order) VALUES ('ステラ', 1, 11)`
    );
  }

  /** Header row used for every sales CSV in these tests. */
  const HEADERS = ['ステータス', '売上日', '会員名', '明細', '売上種別', '売上金額', '支払方法', '担当者', '入金/返金', '備考'];

  function buildRow(status, date, name, item, category, amount, pay, staff, paidOrRefund, remark) {
    return [status, date, name, item, category, String(amount), pay || '', staff || '', paidOrRefund || '', remark || ''];
  }

  it('imports a mixed CSV covering every summary counter on the happy path', async () => {
    seedMembers();
    seedSalesPaymentMethods();
    const rows = [
      /** Known member, existing product (binds 001 体験レッスン) */
      buildRow('入金済', '2026-04-18', '山田 太郎', '体験レッスン', '販売商品', 1100, '現金/スマホ', '平野 智子', '2026-04-18', ''),
      /** Guest (non-member) row, known product */
      buildRow('入金済', '2026-04-18', '非会員', '体験レッスン', '販売商品', 1000, '現金/スマホ', '平野 智子', '2026-04-18', 'ウォークイン対応'),
      /** Unpaid row with unresolved payment method (empty) — counts as a transaction with no payment method */
      buildRow('未入金', '2026-04-18', '佐藤 花子', '振替手数料', '振替手数料', 100, '', '野開 佳子', '', ''),
      /** Second item for 山田 太郎 — same bucket */
      buildRow('入金済', '2026-04-18', '山田 太郎', 'ボール(1缶)', '販売商品', 800, '現金/スマホ', '平野 智子', '2026-04-18', ''),
      /** Unknown member + unknown product → walk-in + Z-001 */
      buildRow('入金済', '2026-04-18', '新規 太郎', 'コキュージュニアラケット', '販売商品', 4455, 'ステラ', '野開 佳子', '2026-04-18', 'ジュニア用'),
      /** Unknown payment method — counts as unresolved and leaves txn.payment_method_id NULL */
      buildRow('入金済', '2026-04-19', '山田 太郎', '振替手数料', '振替手数料', 100, 'Apple Pay', '', '', '')
    ];

    const result = await globalThis.syncSalesFromCsv(HEADERS, rows);

    expect(result.aborted).toBe(false);
    /** 4 distinct (date, member) buckets: 山田/04-18, GUEST/04-18, 佐藤/04-18, 新規太郎walkin/04-18, 山田/04-19 = 5 */
    expect(result.addedTxns).toBe(5);
    expect(result.updatedTxns).toBe(0);
    /** 6 CSV rows → 6 items INSERTed (all new, no duplicates pre-existed) */
    expect(result.addedItems).toBe(6);
    expect(result.skippedDupItems).toBe(0);
    /** One unresolved payment: 'Apple Pay' on the last row */
    expect(result.unresolvedPayments).toBe(1);
    expect(result.unresolvedPaymentLabels).toContain('Apple Pay');
    /** One walk-in member was auto-created */
    expect(result.newMembers).toHaveLength(1);
    expect(result.newMembers[0].id).toMatch(/^W-20260418-/);
    /** Two Z-coded products were auto-created: 振替手数料 (first-seen in row 3) and
     *  コキュージュニアラケット (first-seen in row 5). Row 6's 振替手数料 reuses Z-001
     *  via the run-scope product cache and does not create a third Z-code. */
    expect(result.newProducts).toHaveLength(2);
    const zCodes = result.newProducts.map((p) => p.code).sort();
    expect(zCodes).toEqual(['Z-001', 'Z-002']);

    /** Verify DB state: 5 transactions, 6 items, GUEST member exists, walk-in exists */
    const txns = globalThis.dbQuery('SELECT * FROM transactions ORDER BY id ASC');
    expect(txns.length).toBe(5);
    const items = globalThis.dbQuery('SELECT * FROM transaction_items ORDER BY id ASC');
    expect(items.length).toBe(6);
    const guestTxn = globalThis.dbQuery(
      "SELECT member_name_snapshot, is_received FROM transactions WHERE member_id = 'GUEST'"
    );
    expect(guestTxn).toHaveLength(1);
    expect(guestTxn[0].member_name_snapshot).toBe('非会員');
    const walkInMember = globalThis.dbQuery(
      "SELECT name FROM members WHERE id = ?",
      [result.newMembers[0].id]
    );
    expect(walkInMember).toHaveLength(1);
    expect(walkInMember[0].name).toBe('新規 太郎');
    /** Apple-Pay row has payment_method_id NULL */
    const appleTxn = globalThis.dbQuery(
      "SELECT payment_method_id, is_received FROM transactions WHERE member_id = 'T-0001' AND date = '2026-04-19'"
    );
    expect(appleTxn[0].payment_method_id).toBe(null);
    expect(appleTxn[0].is_received).toBe(1);
    /** staff_name is recorded */
    const yamadaTxn = globalThis.dbQuery(
      "SELECT staff_name FROM transactions WHERE member_id = 'T-0001' AND date = '2026-04-18'"
    );
    expect(yamadaTxn[0].staff_name).toBe('平野 智子');
  });

  it('is idempotent: a second import with the same CSV adds zero transactions and zero items', async () => {
    seedMembers();
    seedSalesPaymentMethods();
    const rows = [
      buildRow('入金済', '2026-04-18', '山田 太郎', '体験レッスン', '販売商品', 1100, '現金/スマホ', '平野', '', ''),
      buildRow('入金済', '2026-04-18', '山田 太郎', 'ボール(1缶)', '販売商品', 800, '現金/スマホ', '平野', '', '')
    ];

    const first = await globalThis.syncSalesFromCsv(HEADERS, rows);
    expect(first.addedTxns).toBe(1);
    expect(first.addedItems).toBe(2);

    const second = await globalThis.syncSalesFromCsv(HEADERS, rows);
    expect(second.addedTxns).toBe(0);
    expect(second.updatedTxns).toBe(1);
    expect(second.addedItems).toBe(0);
    expect(second.skippedDupItems).toBe(2);

    /** DB state unchanged */
    const txns = globalThis.dbQuery('SELECT COUNT(*) AS n FROM transactions');
    expect(txns[0].n).toBe(1);
    const items = globalThis.dbQuery('SELECT COUNT(*) AS n FROM transaction_items');
    expect(items[0].n).toBe(2);
  });

  it('merges SaaS-authoritative fields on an existing (date, member) transaction without overwriting attendance', async () => {
    seedMembers();
    seedSalesPaymentMethods();

    /** Pre-existing local transaction: attendance is 1, received is 0, no staff_name */
    insertTransaction({
      date: '2026-04-18',
      member_id: 'T-0001',
      member_name_snapshot: '山田 太郎',
      is_attended: 1,
      is_received: 0,
      memo: 'reception note'
    });

    const rows = [
      buildRow('入金済', '2026-04-18', '山田 太郎', '体験レッスン', '販売商品', 1100, '現金/スマホ', '平野 智子', '2026-04-18', 'CSV remark')
    ];
    const result = await globalThis.syncSalesFromCsv(HEADERS, rows);

    expect(result.aborted).toBe(false);
    expect(result.updatedTxns).toBe(1);
    expect(result.addedItems).toBe(1);

    /** is_attended stays untouched (not SaaS-authoritative); is_received is now 1;
     *  staff_name and memo are now from the CSV. */
    const txn = globalThis.dbGetOne(
      "SELECT is_attended, is_received, staff_name, memo FROM transactions WHERE member_id = 'T-0001' AND date = '2026-04-18'"
    );
    expect(txn.is_attended).toBe(1);
    expect(txn.is_received).toBe(1);
    expect(txn.staff_name).toBe('平野 智子');
    expect(txn.memo).toBe('CSV remark | 2026-04-18');
  });

  it('aborts the whole import when two non-temporary members share a normalized name', async () => {
    seedMembers();
    seedDuplicateNames();
    seedSalesPaymentMethods();

    const rows = [
      /** Non-ambiguous row first — if the abort policy is correct, even this row is NOT written */
      buildRow('入金済', '2026-04-18', '山田 太郎', '体験レッスン', '販売商品', 1100, '現金/スマホ', '', '', ''),
      /** Ambiguous row */
      buildRow('入金済', '2026-04-18', '同名 太郎', '体験レッスン', '販売商品', 1100, '現金/スマホ', '', '', '')
    ];

    const result = await globalThis.syncSalesFromCsv(HEADERS, rows);

    expect(result.aborted).toBe(true);
    expect(result.ambiguousNames).toEqual(['同名 太郎']);
    expect(result.addedTxns).toBe(0);
    expect(result.addedItems).toBe(0);

    /** DB untouched */
    const txns = globalThis.dbQuery('SELECT COUNT(*) AS n FROM transactions');
    expect(txns[0].n).toBe(0);
    const items = globalThis.dbQuery('SELECT COUNT(*) AS n FROM transaction_items');
    expect(items[0].n).toBe(0);
  });

  it('emits exactly one saveToOPFS write on the happy path (single-transaction guarantee)', async () => {
    seedMembers();
    seedSalesPaymentMethods();

    let saveCount = 0;
    globalThis.saveToOPFS = async () => { saveCount++; };

    const rows = [
      buildRow('入金済', '2026-04-18', '山田 太郎', '体験レッスン', '販売商品', 1100, '現金/スマホ', '', '', ''),
      buildRow('入金済', '2026-04-18', '山田 太郎', 'ボール(1缶)', '販売商品', 800, '現金/スマホ', '', '', ''),
      buildRow('入金済', '2026-04-19', '佐藤 花子', '体験レッスン', '販売商品', 1100, 'ステラ', '', '', '')
    ];
    await globalThis.syncSalesFromCsv(HEADERS, rows);

    expect(saveCount).toBe(1);
  });

  it('emits zero saveToOPFS writes on the aborted path', async () => {
    seedMembers();
    seedDuplicateNames();
    seedSalesPaymentMethods();

    let saveCount = 0;
    globalThis.saveToOPFS = async () => { saveCount++; };

    const rows = [buildRow('入金済', '2026-04-18', '同名 太郎', '体験レッスン', '販売商品', 1100, '現金/スマホ', '', '', '')];
    const result = await globalThis.syncSalesFromCsv(HEADERS, rows);

    expect(result.aborted).toBe(true);
    expect(saveCount).toBe(0);
  });

  it('creates the schema V2 staff_name column and the GUEST pseudo-member via migrations[2]', async () => {
    /** The migration runs in the describe-level beforeEach. Confirm its effects directly. */
    const cols = globalThis.dbQuery("PRAGMA table_info('transactions')");
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('staff_name');

    const guest = globalThis.dbGetOne('SELECT id, name, is_temporary FROM members WHERE id = ?', ['GUEST']);
    expect(guest).toBeTruthy();
    expect(guest.name).toBe('非会員');
    expect(guest.is_temporary).toBe(1);
  });
});
