/**
 * Unit tests for pure date and time helpers in `js/db.js`.
 *
 * Covers getTodayJST, getNowISO, getJSTFiscalYear, formatJstTimestamp.
 * All helpers rely on toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' })
 * so tests use `vi.setSystemTime` with explicit UTC instants to pin the
 * wall-clock position that the JST formatter sees.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
});

describe('getTodayJST', () => {
  it('returns a YYYY-MM-DD string', () => {
    const result = globalThis.getTodayJST();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('reflects JST midday for a mid-UTC instant', () => {
    vi.useFakeTimers();
    /** 2026-04-16 06:00 UTC equals 2026-04-16 15:00 JST */
    vi.setSystemTime(new Date('2026-04-16T06:00:00Z'));
    expect(globalThis.getTodayJST()).toBe('2026-04-16');
  });

  it('crosses the date boundary at JST midnight, not UTC midnight', () => {
    vi.useFakeTimers();
    /** 2026-04-16 23:00 UTC equals 2026-04-17 08:00 JST */
    vi.setSystemTime(new Date('2026-04-16T23:00:00Z'));
    expect(globalThis.getTodayJST()).toBe('2026-04-17');
  });

  it('stays on the prior JST date late-UTC-evening', () => {
    vi.useFakeTimers();
    /** 2026-04-16 14:00 UTC equals 2026-04-16 23:00 JST */
    vi.setSystemTime(new Date('2026-04-16T14:00:00Z'));
    expect(globalThis.getTodayJST()).toBe('2026-04-16');
  });
});

describe('getNowISO', () => {
  it('returns an ISO-like JST timestamp with T separator', () => {
    const result = globalThis.getNowISO();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it('converts to JST wall-clock time', () => {
    vi.useFakeTimers();
    /** 2026-04-16 06:30:45 UTC equals 2026-04-16 15:30:45 JST */
    vi.setSystemTime(new Date('2026-04-16T06:30:45Z'));
    expect(globalThis.getNowISO()).toBe('2026-04-16T15:30:45');
  });
});

describe('getJSTFiscalYear', () => {
  it('returns the calendar year when month is April (start of fiscal year)', () => {
    vi.useFakeTimers();
    /** 2026-04-01 00:00 JST equals 2026-03-31 15:00 UTC */
    vi.setSystemTime(new Date('2026-03-31T15:00:00Z'));
    expect(globalThis.getJSTFiscalYear()).toBe(2026);
  });

  it('returns the previous calendar year when month is March (end of fiscal year)', () => {
    vi.useFakeTimers();
    /** 2026-03-31 23:59 JST equals 2026-03-31 14:59 UTC */
    vi.setSystemTime(new Date('2026-03-31T14:59:00Z'));
    expect(globalThis.getJSTFiscalYear()).toBe(2025);
  });

  it('returns the previous calendar year when month is January', () => {
    vi.useFakeTimers();
    /** 2026-01-15 12:00 JST equals 2026-01-15 03:00 UTC */
    vi.setSystemTime(new Date('2026-01-15T03:00:00Z'));
    expect(globalThis.getJSTFiscalYear()).toBe(2025);
  });

  it('returns the current calendar year when month is December', () => {
    vi.useFakeTimers();
    /** 2026-12-31 23:00 JST equals 2026-12-31 14:00 UTC */
    vi.setSystemTime(new Date('2026-12-31T14:00:00Z'));
    expect(globalThis.getJSTFiscalYear()).toBe(2026);
  });
});

describe('formatJstTimestamp', () => {
  it('formats an ISO string as YYYY/MM/DD HH:mm in JST', () => {
    expect(globalThis.formatJstTimestamp('2026-04-16T06:30:00Z')).toBe('2026/04/16 15:30');
  });

  it('accepts a Date object', () => {
    const d = new Date('2026-04-16T06:30:00Z');
    expect(globalThis.formatJstTimestamp(d)).toBe('2026/04/16 15:30');
  });

  it('crosses midnight at JST boundary, not UTC', () => {
    /** 2026-04-16 15:30 UTC equals 2026-04-17 00:30 JST */
    expect(globalThis.formatJstTimestamp('2026-04-16T15:30:00Z')).toBe('2026/04/17 00:30');
  });

  it('returns empty string for null', () => {
    expect(globalThis.formatJstTimestamp(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(globalThis.formatJstTimestamp(undefined)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(globalThis.formatJstTimestamp('')).toBe('');
  });

  it('returns empty string for an invalid date string', () => {
    expect(globalThis.formatJstTimestamp('not a date')).toBe('');
  });
});
