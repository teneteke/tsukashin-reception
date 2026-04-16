/**
 * Smoke test for the Vitest harness itself.
 *
 * Verifies that `test/setup.mjs` loaded the project JS files into the jsdom
 * global scope. If this fails, every subsequent test will fail too, so this
 * is the canary.
 */

import { describe, it, expect } from 'vitest';

describe('test harness', () => {
  it('loads ui-helpers globals', () => {
    expect(typeof globalThis.formatCurrency).toBe('function');
    expect(typeof globalThis.escapeHtml).toBe('function');
  });

  it('loads db.js date helpers as globals', () => {
    expect(typeof globalThis.getTodayJST).toBe('function');
    expect(typeof globalThis.getNowISO).toBe('function');
    expect(typeof globalThis.getJSTFiscalYear).toBe('function');
    expect(typeof globalThis.formatJstTimestamp).toBe('function');
  });

  it('loads csv.js helpers as globals', () => {
    expect(typeof globalThis.parseCsv).toBe('function');
    expect(typeof globalThis.serializeCsv).toBe('function');
    expect(typeof globalThis.escapeCsvField).toBe('function');
  });

  it('loads sync.js alias helpers as globals', () => {
    expect(typeof globalThis.findColumnIndex).toBe('function');
    expect(typeof globalThis.buildColumnMap).toBe('function');
    expect(typeof globalThis.detectCsvKind).toBe('function');
  });

  it('loads repository.js functions as globals', () => {
    expect(typeof globalThis.searchMembers).toBe('function');
    expect(typeof globalThis.getTodayVisitorList).toBe('function');
  });

  it('loads receipt.js pure helpers as globals', () => {
    expect(typeof globalThis.generateReceiptDescription).toBe('function');
  });

  it('has a jsdom document available', () => {
    expect(typeof document).toBe('object');
    expect(typeof window).toBe('object');
  });
});
