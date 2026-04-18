/**
 * Unit tests for the Phase 18 sales-detail CSV helpers in `js/sync.js`.
 *
 * Covers:
 *   - SALES_COLUMN_ALIASES header detection via detectCsvKind
 *   - Pure parsers: parseSalesDate, parseSalesAmount, normalizeSalesName, resolveSalesPaymentMethod
 *   - classifySalesRows: member / product resolution, bucket grouping, Z-code generation,
 *     ambiguity abort, run-scope caching
 *
 * No DB access; everything runs against fabricated inputs. sync.js exposes its
 * helpers as classic-script globals via the globalThis shim in test/setup.mjs.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '..', 'fixtures');

function readFixture(name) {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf-8');
}

describe('detectCsvKind — sales', () => {
  it('routes the sales-sample fixture to "sales"', () => {
    const csv = readFixture('sales-sample.csv');
    const { headers } = globalThis.parseCsv(csv);
    expect(globalThis.detectCsvKind(headers)).toBe('sales');
  });

  it('still routes members-sample to "member" after sales was added', () => {
    const csv = readFixture('members-sample.csv');
    const { headers } = globalThis.parseCsv(csv);
    expect(globalThis.detectCsvKind(headers)).toBe('member');
  });

  it('still routes reservations-sample to "reservation" after sales was added', () => {
    const csv = readFixture('reservations-sample.csv');
    const { headers } = globalThis.parseCsv(csv);
    expect(globalThis.detectCsvKind(headers)).toBe('reservation');
  });

  it('still routes payment-methods-sample to "payment" after sales was added', () => {
    const csv = readFixture('payment-methods-sample.csv');
    const { headers } = globalThis.parseCsv(csv);
    expect(globalThis.detectCsvKind(headers)).toBe('payment');
  });

  it('detects sales via English aliases', () => {
    const headers = ['status', 'sale_date', 'member_name', 'item'];
    expect(globalThis.detectCsvKind(headers)).toBe('sales');
  });

  it('returns unknown when only three of the four sales required columns are present', () => {
    const headers = ['ステータス', '売上日', '会員名']; // no 明細 / item_description
    expect(globalThis.detectCsvKind(headers)).toBe('unknown');
  });
});

describe('normalizeSalesName', () => {
  it('NFKC-folds half-width katakana to full-width', () => {
    expect(globalThis.normalizeSalesName('ﾔﾏﾀﾞ ﾀﾛｳ')).toBe('ヤマダ タロウ');
  });

  it('NFKC-folds full-width ASCII digits to half-width', () => {
    expect(globalThis.normalizeSalesName('T-０００１')).toBe('T-0001');
  });

  it('trims leading and trailing whitespace', () => {
    expect(globalThis.normalizeSalesName('  山田 太郎  ')).toBe('山田 太郎');
  });

  it('collapses multiple spaces (including full-width) to one', () => {
    expect(globalThis.normalizeSalesName('山田\u3000\u3000\u3000太郎')).toBe('山田 太郎');
  });

  it('returns empty string for null and undefined', () => {
    expect(globalThis.normalizeSalesName(null)).toBe('');
    expect(globalThis.normalizeSalesName(undefined)).toBe('');
  });
});

describe('parseSalesDate', () => {
  it('passes ISO dash dates through', () => {
    expect(globalThis.parseSalesDate('2026-04-18')).toBe('2026-04-18');
  });

  it('converts slash dates to ISO dash', () => {
    expect(globalThis.parseSalesDate('2026/04/18')).toBe('2026-04-18');
  });

  it('zero-pads single-digit month and day in slash form', () => {
    expect(globalThis.parseSalesDate('2026/4/8')).toBe('2026-04-08');
  });

  it('parses the Japanese year-month-day form', () => {
    expect(globalThis.parseSalesDate('2026年4月18日')).toBe('2026-04-18');
  });

  it('handles full-width digits via NFKC', () => {
    expect(globalThis.parseSalesDate('２０２６／０４／１８')).toBe('2026-04-18');
  });

  it('returns empty string on unknown format', () => {
    expect(globalThis.parseSalesDate('April 18, 2026')).toBe('');
    expect(globalThis.parseSalesDate('not a date')).toBe('');
  });

  it('returns empty string on null and empty input', () => {
    expect(globalThis.parseSalesDate(null)).toBe('');
    expect(globalThis.parseSalesDate('')).toBe('');
  });
});

describe('parseSalesAmount', () => {
  it('parses a plain integer', () => {
    expect(globalThis.parseSalesAmount('1000')).toBe(1000);
  });

  it('parses thousands-comma format', () => {
    expect(globalThis.parseSalesAmount('1,000')).toBe(1000);
  });

  it('strips yen sign prefix', () => {
    expect(globalThis.parseSalesAmount('¥1,100')).toBe(1100);
  });

  it('strips 円 suffix', () => {
    expect(globalThis.parseSalesAmount('1100円')).toBe(1100);
  });

  it('accepts full-width digits via NFKC', () => {
    expect(globalThis.parseSalesAmount('１０００')).toBe(1000);
  });

  it('returns NaN on negative values', () => {
    expect(Number.isNaN(globalThis.parseSalesAmount('-100'))).toBe(true);
  });

  it('returns NaN on non-numeric input', () => {
    expect(Number.isNaN(globalThis.parseSalesAmount('abc'))).toBe(true);
  });

  it('returns NaN on empty input', () => {
    expect(Number.isNaN(globalThis.parseSalesAmount(''))).toBe(true);
    expect(Number.isNaN(globalThis.parseSalesAmount(null))).toBe(true);
  });
});

describe('resolveSalesPaymentMethod', () => {
  const paymentsByKey = new Map([
    [globalThis.normalizeSalesName('現金/スマホ'), { id: 1, name: '現金/スマホ' }],
    [globalThis.normalizeSalesName('ステラ'), { id: 2, name: 'ステラ' }],
    [globalThis.normalizeSalesName('PayPay'), { id: 3, name: 'PayPay' }]
  ]);

  it('resolves the canonical cash-and-smartphone label', () => {
    const r = globalThis.resolveSalesPaymentMethod('現金/スマホ', paymentsByKey);
    expect(r && r.id).toBe(1);
  });

  it('resolves truncated cash-and-smartphone alias to the canonical row', () => {
    const r = globalThis.resolveSalesPaymentMethod('現金・スマ', paymentsByKey);
    expect(r && r.id).toBe(1);
  });

  it('resolves Stella in both Japanese and Roman spellings', () => {
    const a = globalThis.resolveSalesPaymentMethod('ステラ', paymentsByKey);
    const b = globalThis.resolveSalesPaymentMethod('stella', paymentsByKey);
    expect(a && a.id).toBe(2);
    expect(b && b.id).toBe(2);
  });

  it('resolves PayPay in multiple casings', () => {
    const a = globalThis.resolveSalesPaymentMethod('PayPay', paymentsByKey);
    const b = globalThis.resolveSalesPaymentMethod('paypay', paymentsByKey);
    const c = globalThis.resolveSalesPaymentMethod('PAYPAY', paymentsByKey);
    expect(a && a.id).toBe(3);
    expect(b && b.id).toBe(3);
    expect(c && c.id).toBe(3);
  });

  it('returns null for unknown labels', () => {
    expect(globalThis.resolveSalesPaymentMethod('Apple Pay', paymentsByKey)).toBe(null);
  });

  it('returns null for empty input', () => {
    expect(globalThis.resolveSalesPaymentMethod('', paymentsByKey)).toBe(null);
    expect(globalThis.resolveSalesPaymentMethod(null, paymentsByKey)).toBe(null);
  });
});

describe('classifySalesRows', () => {
  /** Shared fixture: pre-loaded lookup maps for reuse across tests. */
  function buildContext(overrides = {}) {
    const membersByKey = overrides.membersByKey || new Map([
      [globalThis.normalizeSalesName('山田 太郎'), [{ id: 'T-0001', name: '山田 太郎' }]],
      [globalThis.normalizeSalesName('佐藤 花子'), [{ id: 'T-0002', name: '佐藤 花子' }]]
    ]);
    const productsByKey = overrides.productsByKey || new Map([
      [globalThis.normalizeSalesName('体験レッスン'), { code: '001', name: '体験レッスン', category: 'レッスン', price: 1100 }],
      [globalThis.normalizeSalesName('ボール(1缶)'), { code: '021', name: 'ボール(1缶)', category: '商品', price: 800 }]
    ]);
    const paymentsByKey = overrides.paymentsByKey || new Map([
      [globalThis.normalizeSalesName('現金/スマホ'), { id: 1, name: '現金/スマホ' }],
      [globalThis.normalizeSalesName('ステラ'), { id: 2, name: 'ステラ' }],
      [globalThis.normalizeSalesName('PayPay'), { id: 3, name: 'PayPay' }]
    ]);
    return {
      membersByKey,
      productsByKey,
      paymentsByKey,
      existingWalkIns: overrides.existingWalkIns || [],
      existingZCodes: overrides.existingZCodes || [],
      guestMemberId: 'GUEST',
      guestMemberName: '非会員'
    };
  }

  /** Fabricate a columnMap matching the canonical column order we use in the fixture CSV. */
  const columnMap = {
    status: 0,
    sale_date: 1,
    member_name: 2,
    item_description: 3,
    sale_category: 4,
    sale_amount: 5,
    payment_method: 6,
    staff_name: 7,
    paid_or_refund: 8,
    remark: 9
  };

  function row(status, date, name, item, category, amount, pay, staff, paidOrRefund, remark) {
    return [status, date, name, item, category, String(amount), pay, staff, paidOrRefund, remark];
  }

  it('resolves a unique known member to the existing member id', () => {
    const rows = [row('入金済', '2026-04-18', '山田 太郎', '体験レッスン', '販売商品', 1100, '現金/スマホ', '平野 智子', '', '')];
    const plan = globalThis.classifySalesRows(rows, columnMap, buildContext());
    expect(plan.ambiguousNames).toEqual([]);
    expect(plan.newMembers).toEqual([]);
    const bucket = Array.from(plan.txnBuckets.values())[0];
    expect(bucket.memberId).toBe('T-0001');
    expect(bucket.isReceived).toBe(1);
    expect(bucket.paymentMethodId).toBe(1);
  });

  it('binds the non-member label to the guest pseudo-member id', () => {
    const rows = [row('入金済', '2026-04-18', '非会員', '体験レッスン', '販売商品', 1000, '現金/スマホ', '平野 智子', '', '')];
    const plan = globalThis.classifySalesRows(rows, columnMap, buildContext());
    const bucket = Array.from(plan.txnBuckets.values())[0];
    expect(bucket.memberId).toBe('GUEST');
    expect(bucket.memberNameSnapshot).toBe('非会員');
    expect(plan.newMembers).toEqual([]); // no walk-in created
  });

  it('creates a walk-in member for an unknown name and reuses it on subsequent rows', () => {
    const rows = [
      row('入金済', '2026-04-18', '新規 太郎', '体験レッスン', '販売商品', 1100, '現金/スマホ', '平野', '', ''),
      row('入金済', '2026-04-18', '新規 太郎', 'ボール(1缶)', '販売商品', 800, '現金/スマホ', '平野', '', '')
    ];
    const plan = globalThis.classifySalesRows(rows, columnMap, buildContext());
    expect(plan.newMembers).toHaveLength(1);
    const walkInId = plan.newMembers[0].id;
    expect(walkInId.startsWith('W-20260418-')).toBe(true);
    const bucket = Array.from(plan.txnBuckets.values())[0];
    expect(bucket.memberId).toBe(walkInId);
    expect(bucket.items).toHaveLength(2);
  });

  it('creates Z-code products for unknown item descriptions and reuses codes within the run', () => {
    const rows = [
      row('入金済', '2026-04-18', '山田 太郎', 'コキュージュニアラケット', '販売商品', 4455, 'ステラ', '野開', '', ''),
      row('入金済', '2026-04-19', '佐藤 花子', 'コキュージュニアラケット', '販売商品', 4455, 'ステラ', '野開', '', '')
    ];
    const plan = globalThis.classifySalesRows(rows, columnMap, buildContext());
    expect(plan.newProducts).toHaveLength(1);
    expect(plan.newProducts[0].code).toBe('Z-001');
    expect(plan.newProducts[0].name).toBe('コキュージュニアラケット');
  });

  it('increments Z-codes from the existing maximum', () => {
    const ctx = buildContext({ existingZCodes: [{ code: 'Z-001' }, { code: 'Z-007' }] });
    const rows = [row('入金済', '2026-04-18', '山田 太郎', 'フォーメーション本', '販売商品', 2000, 'PayPay', '', '', '')];
    const plan = globalThis.classifySalesRows(rows, columnMap, ctx);
    expect(plan.newProducts[0].code).toBe('Z-008');
  });

  it('aborts via ambiguousNames when two non-temporary members share a normalized name', () => {
    const ctx = buildContext({
      membersByKey: new Map([
        [globalThis.normalizeSalesName('山田 太郎'), [
          { id: 'T-0001', name: '山田 太郎' },
          { id: 'T-1234', name: '山田 太郎' }
        ]]
      ])
    });
    const rows = [row('入金済', '2026-04-18', '山田 太郎', '体験レッスン', '販売商品', 1100, '現金/スマホ', '', '', '')];
    const plan = globalThis.classifySalesRows(rows, columnMap, ctx);
    expect(plan.ambiguousNames).toEqual(['山田 太郎']);
  });

  it('groups rows with the same (date, member) into one bucket with multiple items', () => {
    const rows = [
      row('入金済', '2026-04-18', '山田 太郎', '体験レッスン', '販売商品', 1100, '現金/スマホ', '平野', '', ''),
      row('入金済', '2026-04-18', '山田 太郎', 'ボール(1缶)', '販売商品', 800, '現金/スマホ', '平野', '', '')
    ];
    const plan = globalThis.classifySalesRows(rows, columnMap, buildContext());
    expect(plan.txnBuckets.size).toBe(1);
    const bucket = Array.from(plan.txnBuckets.values())[0];
    expect(bucket.items).toHaveLength(2);
  });

  it('prefers an is_received=1 row over is_received=0 when both target the same bucket', () => {
    const rows = [
      row('未入金', '2026-04-18', '山田 太郎', '振替手数料', '振替手数料', 100, '', '', '', ''),
      row('入金済', '2026-04-18', '山田 太郎', '体験レッスン', '販売商品', 1100, '現金/スマホ', '平野', '', '')
    ];
    const plan = globalThis.classifySalesRows(rows, columnMap, buildContext());
    const bucket = Array.from(plan.txnBuckets.values())[0];
    expect(bucket.isReceived).toBe(1);
    expect(bucket.paymentMethodId).toBe(1);
  });

  it('counts unresolved payment methods without aborting', () => {
    const rows = [row('入金済', '2026-04-18', '山田 太郎', '体験レッスン', '販売商品', 1100, '謎ペイ', '', '', '')];
    const plan = globalThis.classifySalesRows(rows, columnMap, buildContext());
    expect(plan.unresolvedPaymentCount).toBe(1);
    expect(plan.unresolvedPaymentLabels).toContain('謎ペイ');
    const bucket = Array.from(plan.txnBuckets.values())[0];
    expect(bucket.paymentMethodId).toBe(null);
  });

  it('skips rows with a bad date and records the skip reason', () => {
    const rows = [row('入金済', 'not a date', '山田 太郎', '体験レッスン', '販売商品', 1100, '現金/スマホ', '', '', '')];
    const plan = globalThis.classifySalesRows(rows, columnMap, buildContext());
    expect(plan.txnBuckets.size).toBe(0);
    expect(plan.skippedParseErrors).toHaveLength(1);
    expect(plan.skippedParseErrors[0].reason).toBe('bad-date');
  });

  it('skips rows with a bad amount', () => {
    const rows = [row('入金済', '2026-04-18', '山田 太郎', '体験レッスン', '販売商品', 'N/A', '現金/スマホ', '', '', '')];
    const plan = globalThis.classifySalesRows(rows, columnMap, buildContext());
    expect(plan.txnBuckets.size).toBe(0);
    expect(plan.skippedParseErrors[0].reason).toBe('bad-amount');
  });

  it('composes remark and paid-or-refund into the memo with a pipe separator', () => {
    const rows = [row('入金済', '2026-04-18', '山田 太郎', '体験レッスン', '販売商品', 1100, '現金/スマホ', '', '2026-04-18', 'ジュニア用')];
    const plan = globalThis.classifySalesRows(rows, columnMap, buildContext());
    const bucket = Array.from(plan.txnBuckets.values())[0];
    expect(bucket.memo).toBe('ジュニア用 | 2026-04-18');
  });

  it('leaves memo null when both remark and paid-or-refund are empty', () => {
    const rows = [row('入金済', '2026-04-18', '山田 太郎', '体験レッスン', '販売商品', 1100, '現金/スマホ', '', '', '')];
    const plan = globalThis.classifySalesRows(rows, columnMap, buildContext());
    const bucket = Array.from(plan.txnBuckets.values())[0];
    expect(bucket.memo).toBe(null);
  });

  it('walks-in generator continues from the existing walk-in max sequence', () => {
    const ctx = buildContext({
      existingWalkIns: [{ id: 'W-20260418-001' }, { id: 'W-20260418-005' }]
    });
    const rows = [row('入金済', '2026-04-18', '全く新しい人', '体験レッスン', '販売商品', 1100, '現金/スマホ', '', '', '')];
    const plan = globalThis.classifySalesRows(rows, columnMap, ctx);
    expect(plan.newMembers[0].id).toBe('W-20260418-006');
  });
});
