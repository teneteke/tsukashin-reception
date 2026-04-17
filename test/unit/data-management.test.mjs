/**
 * Unit tests for the storage usage display error-isolation contract in
 * `js/data-management.js`.
 *
 * Phase 16 T16.1 split the single try-catch that wrapped both storage API
 * calls so a failure in `navigator.storage.persisted()` no longer wipes a
 * successfully obtained usage readout. The three scenarios below lock that
 * contract: both APIs succeed, estimate succeeds but persisted throws, and
 * estimate throws outright.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** DOM fixture that mirrors the real storage usage block in index.html. */
function installStorageDom() {
  document.body.innerHTML = `
    <div>
      <span id="storage-usage-text"></span>
      <span id="storage-persist-status"></span>
    </div>
  `;
}

/** Stub navigator.storage with configurable resolvers. Returns a restore fn. */
function stubNavigatorStorage({ estimate, persisted }) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      estimate,
      persisted,
    },
  });
  return () => {
    if (originalDescriptor) {
      Object.defineProperty(navigator, 'storage', originalDescriptor);
    } else {
      delete navigator.storage;
    }
  };
}

describe('updateStorageUsageDisplay — Phase 16 T16.1 error isolation', () => {
  let restoreNavigator = () => {};
  let warnSpy;

  beforeEach(() => {
    installStorageDom();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    restoreNavigator();
    warnSpy.mockRestore();
    document.body.innerHTML = '';
  });

  it('populates both the usage line and the persistence label when both APIs succeed', async () => {
    restoreNavigator = stubNavigatorStorage({
      estimate: async () => ({ usage: 3 * 1024 * 1024, quota: 10 * 1024 * 1024 * 1024 }),
      persisted: async () => true,
    });

    await globalThis.updateStorageUsageDisplay();

    const textEl = document.getElementById('storage-usage-text');
    const statusEl = document.getElementById('storage-persist-status');
    expect(textEl.textContent).toBe('使用: 3.0 MB / 上限: 10.0 GB');
    expect(statusEl.textContent).toBe('（永続化: 有効）');
    expect(statusEl.classList.contains('storage-usage__status--ok')).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('shows a not-persisted label without the ok class when persisted resolves false', async () => {
    restoreNavigator = stubNavigatorStorage({
      estimate: async () => ({ usage: 1024 * 1024, quota: 5 * 1024 * 1024 * 1024 }),
      persisted: async () => false,
    });

    await globalThis.updateStorageUsageDisplay();

    const statusEl = document.getElementById('storage-persist-status');
    expect(statusEl.textContent).toBe('（永続化: 未設定）');
    expect(statusEl.classList.contains('storage-usage__status--ok')).toBe(false);
  });

  it('preserves the usage line when estimate succeeds but persisted throws', async () => {
    /** This is the headline Phase 16 T16.1 contract: a failing persistence
     *  check must not wipe a successfully rendered usage readout. */
    restoreNavigator = stubNavigatorStorage({
      estimate: async () => ({ usage: 2 * 1024 * 1024, quota: 20 * 1024 * 1024 * 1024 }),
      persisted: async () => { throw new Error('boom'); },
    });

    await globalThis.updateStorageUsageDisplay();

    const textEl = document.getElementById('storage-usage-text');
    const statusEl = document.getElementById('storage-persist-status');
    expect(textEl.textContent).toBe('使用: 2.0 MB / 上限: 20.0 GB');
    expect(statusEl.textContent).toBe('');
    expect(statusEl.classList.contains('storage-usage__status--ok')).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to the error message and clears the status when estimate throws', async () => {
    restoreNavigator = stubNavigatorStorage({
      estimate: async () => { throw new Error('nope'); },
      persisted: async () => true,
    });

    await globalThis.updateStorageUsageDisplay();

    const textEl = document.getElementById('storage-usage-text');
    const statusEl = document.getElementById('storage-persist-status');
    expect(textEl.textContent).toBe('ストレージ情報を取得できませんでした');
    expect(statusEl.textContent).toBe('');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('shows the unsupported message when navigator.storage.estimate is missing', async () => {
    restoreNavigator = stubNavigatorStorage({
      estimate: undefined,
      persisted: undefined,
    });

    await globalThis.updateStorageUsageDisplay();

    const textEl = document.getElementById('storage-usage-text');
    const statusEl = document.getElementById('storage-persist-status');
    expect(textEl.textContent).toBe('ストレージ情報を取得できません');
    expect(statusEl.textContent).toBe('');
  });

  it('returns silently when the usage text element is not present in the DOM', async () => {
    document.body.innerHTML = '';
    restoreNavigator = stubNavigatorStorage({
      estimate: async () => ({ usage: 0, quota: 0 }),
      persisted: async () => true,
    });

    /** Early return path: no throw even though the DOM is empty. */
    await expect(globalThis.updateStorageUsageDisplay()).resolves.toBeUndefined();
  });

  it('leaves the persistence label alone when the status element is missing even though estimate succeeds', async () => {
    document.body.innerHTML = '<span id="storage-usage-text"></span>';
    restoreNavigator = stubNavigatorStorage({
      estimate: async () => ({ usage: 0, quota: 1024 * 1024 * 1024 }),
      persisted: async () => true,
    });

    await globalThis.updateStorageUsageDisplay();

    const textEl = document.getElementById('storage-usage-text');
    expect(textEl.textContent).toBe('使用: 0.0 MB / 上限: 1.0 GB');
  });

  it('dispatches estimate and persisted concurrently, not sequentially (Phase 17 T17.6)', async () => {
    /** Sequential implementation: estimate must resolve before persisted
     *  is called. With allSettled both are called synchronously inside the
     *  same microtask tick, so by the time estimate's 20ms delay resolves,
     *  persisted has already been invoked and is also ~20ms old. The probe
     *  records the absolute call timestamps and asserts both fired within a
     *  few ms of each other. */
    const callTimes = [];
    restoreNavigator = stubNavigatorStorage({
      estimate: async () => {
        callTimes.push({ name: 'estimate', at: performance.now() });
        await new Promise((r) => setTimeout(r, 20));
        return { usage: 0, quota: 0 };
      },
      persisted: async () => {
        callTimes.push({ name: 'persisted', at: performance.now() });
        await new Promise((r) => setTimeout(r, 20));
        return true;
      },
    });

    await globalThis.updateStorageUsageDisplay();

    expect(callTimes).toHaveLength(2);
    const delta = Math.abs(callTimes[0].at - callTimes[1].at);
    /** A sequential implementation would force delta ≥ 20ms because persisted
     *  waits for estimate's await to resolve. Parallel dispatch collapses the
     *  gap to a few ms at most. Allow a generous 10ms ceiling for CI noise. */
    expect(delta).toBeLessThan(10);
  });
});
