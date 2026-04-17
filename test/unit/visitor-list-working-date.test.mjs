/**
 * Unit tests for the Phase 15 and Phase 16 working-date surface in
 * `js/visitor-list.js`.
 *
 * Phase 15 introduced three UI helpers: `getWorkingDate`, `initWorkingDatePicker`,
 * and `updateDateInputAppearance`. Phase 16 T16.2 made `addMemberToToday`
 * capture the working-date once at entry and reuse it for both the duplicate
 * guard and the insert call.
 *
 * These tests replace the repository-layer and UI-side helpers with
 * test doubles to exercise the control flow in isolation (no database,
 * no network, no other DOM side-effects).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Swap a globalThis property for the duration of a single test.
 * Returns a restore callback that the test's afterEach uses.
 */
function override(name, replacement) {
  const original = globalThis[name];
  globalThis[name] = replacement;
  return () => {
    globalThis[name] = original;
  };
}

describe('addMemberToToday — Phase 16 T16.2 working-date capture', () => {
  const savedFixedDate = '2026-04-01';
  const mutatedDate = '2026-04-17';
  const restorers = [];

  beforeEach(() => {
    globalThis.currentWorkingDate = savedFixedDate;
  });

  afterEach(() => {
    while (restorers.length) restorers.pop()();
  });

  it('passes a single captured working-date to both the guard and the insert on the happy path', async () => {
    const guardSpy = vi.fn(() => false);
    const getMemberSpy = vi.fn(() => ({ id: 'T-0001', name: 'A' }));
    const insertSpy = vi.fn().mockResolvedValue(undefined);

    restorers.push(override('hasTransactionForDate', guardSpy));
    restorers.push(override('getMemberById', getMemberSpy));
    restorers.push(override('addMemberTransaction', insertSpy));
    restorers.push(override('renderVisitorTable', () => {}));
    restorers.push(override('hideAutocomplete', () => {}));
    restorers.push(override('clearSearchInput', () => {}));
    restorers.push(override('showToast', () => {}));

    await globalThis.addMemberToToday('T-0001');

    expect(guardSpy).toHaveBeenCalledTimes(1);
    expect(guardSpy).toHaveBeenCalledWith(savedFixedDate, 'T-0001');
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy).toHaveBeenCalledWith('T-0001', savedFixedDate);
  });

  it('ignores a mid-flow mutation of the working-date and still inserts on the entry-captured date', async () => {
    /** The guard mutates the module-level working-date to simulate a user
     *  flipping the header picker between the guard check and the INSERT.
     *  If the production code were to re-read the module variable before
     *  calling addMemberTransaction, the insert would see `mutatedDate`.
     *  Phase 16 T16.2 captured the date once at entry so both calls must
     *  see `savedFixedDate` regardless of the mid-flow mutation. */
    const guardSpy = vi.fn((_date, _id) => {
      globalThis.currentWorkingDate = mutatedDate;
      return false;
    });
    const getMemberSpy = vi.fn(() => ({ id: 'T-0001', name: 'A' }));
    const insertSpy = vi.fn().mockResolvedValue(undefined);

    restorers.push(override('hasTransactionForDate', guardSpy));
    restorers.push(override('getMemberById', getMemberSpy));
    restorers.push(override('addMemberTransaction', insertSpy));
    restorers.push(override('renderVisitorTable', () => {}));
    restorers.push(override('hideAutocomplete', () => {}));
    restorers.push(override('clearSearchInput', () => {}));
    restorers.push(override('showToast', () => {}));

    await globalThis.addMemberToToday('T-0001');

    expect(guardSpy).toHaveBeenCalledWith(savedFixedDate, 'T-0001');
    expect(insertSpy).toHaveBeenCalledWith('T-0001', savedFixedDate);
    expect(insertSpy).not.toHaveBeenCalledWith('T-0001', mutatedDate);
  });

  it('does not insert when the duplicate guard returns true', async () => {
    /** The early-return branch must not reach addMemberTransaction so the
     *  captured-date contract is trivially preserved. */
    const guardSpy = vi.fn(() => true);
    const insertSpy = vi.fn().mockResolvedValue(undefined);

    restorers.push(override('hasTransactionForDate', guardSpy));
    restorers.push(override('addMemberTransaction', insertSpy));
    restorers.push(override('hideAutocomplete', () => {}));
    restorers.push(override('clearSearchInput', () => {}));
    restorers.push(override('showToast', () => {}));

    /** jsdom lacks CSS.escape; provide a minimal stand-in for the querySelector
     *  call on the guard-hit branch. */
    if (typeof globalThis.CSS === 'undefined' || typeof globalThis.CSS.escape !== 'function') {
      const savedCSS = globalThis.CSS;
      globalThis.CSS = { escape: (s) => String(s) };
      restorers.push(() => {
        globalThis.CSS = savedCSS;
      });
    }
    document.body.innerHTML = '<table><tbody id="visitor-table-body"></tbody></table>';

    await globalThis.addMemberToToday('T-0001');

    expect(guardSpy).toHaveBeenCalledWith(savedFixedDate, 'T-0001');
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe('getWorkingDate — Phase 15 T15.4 getter', () => {
  const restorers = [];

  afterEach(() => {
    while (restorers.length) restorers.pop()();
  });

  it('returns todays JST date after module evaluation when nothing has mutated it', () => {
    /** The setup file loaded the module once with today as the default.
     *  Reassigning here mirrors what the picker-change listener does. */
    globalThis.currentWorkingDate = globalThis.getTodayJST();
    expect(globalThis.getWorkingDate()).toBe(globalThis.getTodayJST());
  });

  it('reflects subsequent module-level assignments to currentWorkingDate', () => {
    globalThis.currentWorkingDate = '2026-03-15';
    expect(globalThis.getWorkingDate()).toBe('2026-03-15');
  });
});

describe('updateDateInputAppearance — Phase 15 T15.4 warning style toggle', () => {
  const restorers = [];

  afterEach(() => {
    while (restorers.length) restorers.pop()();
    document.body.innerHTML = '';
  });

  it('does not apply the past-date class when the working-date equals today', () => {
    globalThis.currentWorkingDate = globalThis.getTodayJST();
    const input = document.createElement('input');
    globalThis.updateDateInputAppearance(input);
    expect(input.classList.contains('header-bar__date-input--past')).toBe(false);
  });

  it('applies the past-date class when the working-date differs from today', () => {
    globalThis.currentWorkingDate = '2020-01-01';
    const input = document.createElement('input');
    globalThis.updateDateInputAppearance(input);
    expect(input.classList.contains('header-bar__date-input--past')).toBe(true);
  });

  it('clears the past-date class when the working-date returns to today', () => {
    globalThis.currentWorkingDate = '2020-01-01';
    const input = document.createElement('input');
    globalThis.updateDateInputAppearance(input);
    expect(input.classList.contains('header-bar__date-input--past')).toBe(true);

    globalThis.currentWorkingDate = globalThis.getTodayJST();
    globalThis.updateDateInputAppearance(input);
    expect(input.classList.contains('header-bar__date-input--past')).toBe(false);
  });
});

describe('initWorkingDatePicker — Phase 15 T15.4 picker wiring', () => {
  const restorers = [];

  beforeEach(() => {
    globalThis.currentWorkingDate = globalThis.getTodayJST();
    document.body.innerHTML = `
      <input type="date" id="working-date-input">
      <button type="button" id="btn-today"></button>
    `;
  });

  afterEach(() => {
    while (restorers.length) restorers.pop()();
    document.body.innerHTML = '';
  });

  it('sets the input value to the current working-date on initialization', () => {
    restorers.push(override('renderVisitorTable', () => {}));
    globalThis.initWorkingDatePicker();
    const input = document.getElementById('working-date-input');
    expect(input.value).toBe(globalThis.getTodayJST());
  });

  it('returns early without binding listeners when the date input is missing', () => {
    document.body.innerHTML = '';
    /** No throw and no side effect on missing DOM. */
    expect(() => globalThis.initWorkingDatePicker()).not.toThrow();
  });

  it('updates the module variable and re-renders when the input change fires', () => {
    const renderSpy = vi.fn();
    restorers.push(override('renderVisitorTable', renderSpy));

    globalThis.initWorkingDatePicker();

    const input = document.getElementById('working-date-input');
    input.value = '2026-03-15';
    input.dispatchEvent(new Event('change'));

    expect(globalThis.currentWorkingDate).toBe('2026-03-15');
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(input.classList.contains('header-bar__date-input--past')).toBe(true);
  });

  it('ignores a change event that clears the input value', () => {
    /** The change listener has a guard: if the new value is empty, do
     *  not mutate currentWorkingDate or re-render. This keeps the picker
     *  from dropping into an invalid date state. */
    const renderSpy = vi.fn();
    restorers.push(override('renderVisitorTable', renderSpy));

    globalThis.initWorkingDatePicker();

    const input = document.getElementById('working-date-input');
    const before = globalThis.currentWorkingDate;
    input.value = '';
    input.dispatchEvent(new Event('change'));

    expect(globalThis.currentWorkingDate).toBe(before);
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('resets the working-date and the input to today when the today button is clicked', () => {
    const renderSpy = vi.fn();
    restorers.push(override('renderVisitorTable', renderSpy));

    globalThis.initWorkingDatePicker();

    const input = document.getElementById('working-date-input');
    const btnToday = document.getElementById('btn-today');

    /** Start from a past date, then click the today button. */
    input.value = '2020-01-01';
    input.dispatchEvent(new Event('change'));
    renderSpy.mockClear();

    btnToday.click();

    expect(globalThis.currentWorkingDate).toBe(globalThis.getTodayJST());
    expect(input.value).toBe(globalThis.getTodayJST());
    expect(input.classList.contains('header-bar__date-input--past')).toBe(false);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });
});
