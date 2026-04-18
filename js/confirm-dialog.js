/**
 * js/confirm-dialog.js — 共有の破壊的操作 確認モーダル（T6.10）
 *
 * design-system.md §4.18 の仕様に沿った in-app モーダル。
 * 実行ボタンは .btn--accent（赤系）、キャンセルは .btn--outline（グレー）。
 * 初期フォーカスはキャンセル（安全側のデフォルト）。
 * Esc → false / Enter → true / 背景クリック → false。
 * Tab / Shift+Tab はダイアログ内でループ（キーボードトラップ）。
 *
 * 使い方:
 *   const ok = await confirmAction('削除の確認', '〇〇を削除します。...');
 *   if (!ok) return;
 */

(function () {
  'use strict';

  /** @type {Array|null} pending-resolve の Promise とイベントハンドラ退避領域 */
  let currentSession = null;

  /**
   * ダイアログ内の focusable な要素を収集する
   * @param {HTMLElement} container
   * @returns {HTMLElement[]}
   */
  function getFocusableElements(container) {
    const selector = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    return Array.from(container.querySelectorAll(selector));
  }

  /**
   * 確認ダイアログを表示して Promise<boolean> を返す
   * @param {string} title - ダイアログのタイトル
   * @param {string} message - 本文メッセージ（\n で改行可）
   * @returns {Promise<boolean>} 実行なら true、キャンセルなら false
   */
  function confirmAction(title, message) {
    const overlay = document.getElementById('confirm-dialog-overlay');
    const dialog = overlay ? overlay.querySelector('.dialog') : null;
    const titleEl = document.getElementById('confirm-dialog-title');
    const messageEl = document.getElementById('confirm-dialog-message');
    const btnExecute = document.getElementById('btn-confirm-dialog-execute');
    const btnCancel = document.getElementById('btn-confirm-dialog-cancel');

    if (!overlay || !dialog || !titleEl || !messageEl || !btnExecute || !btnCancel) {
      console.error('確認ダイアログのDOMが見つかりません。index.htmlの#confirm-dialog-overlayブロックを確認してください。');
      /** フォールバックとしてネイティブ confirm を使用（最低限の安全装置） */
      return Promise.resolve(window.confirm(`${title}\n\n${message}`));
    }

    /** すでに開いているセッションがあれば先にキャンセル扱いで解決 */
    if (currentSession) {
      const prev = currentSession;
      currentSession = null;
      cleanup(prev);
      prev.resolve(false);
    }

    /** テキスト差し替え */
    titleEl.textContent = title;
    messageEl.textContent = message;
    overlay.hidden = false;

    /** 前のフォーカス元を覚えて復帰できるようにする */
    const previouslyFocused = document.activeElement;

    return new Promise((resolve) => {
      const session = {
        resolve,
        previouslyFocused,
        overlay,
        dialog,
        btnExecute,
        btnCancel,
        handlers: {},
      };

      /** クリックハンドラ */
      session.handlers.onExecute = () => {
        finish(session, true);
      };
      session.handlers.onCancel = () => {
        finish(session, false);
      };
      session.handlers.onOverlay = (event) => {
        if (event.target === overlay) finish(session, false);
      };

      /** キーボード: Esc=false / Enter=true / Tab=ループ */
      session.handlers.onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(session, false);
          return;
        }
        if (event.key === 'Enter') {
          /** 対象が button のキャンセルなら false、それ以外は true として扱う */
          if (event.target === btnCancel) {
            event.preventDefault();
            finish(session, false);
            return;
          }
          event.preventDefault();
          finish(session, true);
          return;
        }
        if (event.key === 'Tab') {
          const focusables = getFocusableElements(dialog);
          if (focusables.length === 0) {
            event.preventDefault();
            return;
          }
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          const active = document.activeElement;
          if (event.shiftKey) {
            if (active === first || !dialog.contains(active)) {
              event.preventDefault();
              last.focus();
            }
          } else {
            if (active === last || !dialog.contains(active)) {
              event.preventDefault();
              first.focus();
            }
          }
        }
      };

      btnExecute.addEventListener('click', session.handlers.onExecute);
      btnCancel.addEventListener('click', session.handlers.onCancel);
      overlay.addEventListener('click', session.handlers.onOverlay);
      document.addEventListener('keydown', session.handlers.onKeyDown);

      currentSession = session;

      /** 初期フォーカスはキャンセル */
      setTimeout(() => btnCancel.focus(), 0);
    });
  }

  /**
   * セッションのクリーンアップ（イベントリスナー解除・オーバーレイ非表示・フォーカス復帰）
   * @param {Object} session
   */
  function cleanup(session) {
    session.btnExecute.removeEventListener('click', session.handlers.onExecute);
    session.btnCancel.removeEventListener('click', session.handlers.onCancel);
    session.overlay.removeEventListener('click', session.handlers.onOverlay);
    document.removeEventListener('keydown', session.handlers.onKeyDown);
    session.overlay.hidden = true;

    /** フォーカスを呼び出し元に戻す */
    if (session.previouslyFocused && typeof session.previouslyFocused.focus === 'function') {
      try {
        session.previouslyFocused.focus();
      } catch (_) {
        /* ignore */
      }
    }
  }

  /**
   * セッションを解決して終わらせる
   * @param {Object} session
   * @param {boolean} result
   */
  function finish(session, result) {
    if (currentSession !== session) return;
    currentSession = null;
    cleanup(session);
    session.resolve(result);
  }

  /** グローバル公開 */
  window.confirmAction = confirmAction;
})();

/**
 * Phase 14 T14.4: 予約CSVマージ結果の read-only ダイアログ
 *
 * 4セクション構成: 新規追加 count / 維持 count / 自動削除リスト / 保護リスト。
 * リスト行は「氏名 (ID)」形式、保護リストには保護理由を付与。
 * 単一 OK ボタンで閉じる。Esc / Enter / 背景クリックでも閉じる。
 *
 * 使い方:
 *   await showSyncResult({
 *     added: 2, alreadyExists: 5,
 *     autoDeleted: [{id, member_id, member_name}, ...],
 *     protectedRows: [{id, member_id, member_name, reason}, ...],
 *     notInMaster: ['X-9999'],
 *   });
 */
(function () {
  'use strict';

  /** 保護理由コードから日本語ラベルへの対応表 */
  const PROTECTION_REASON_LABELS = {
    received: '受領済み',
    attended: '出席済み',
    'walk-in': 'ウォークイン',
  };

  let resultSession = null;

  /** 内部ユーティリティ: HTMLエスケープ（ui-helpers.js の escapeHtml と同義だが独立実装で依存関係を単純化） */
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 本文の DOM を組み立てる */
  function renderBody(summary) {
    const added = summary.added || 0;
    const alreadyExists = summary.alreadyExists || 0;
    const autoDeleted = Array.isArray(summary.autoDeleted) ? summary.autoDeleted : [];
    const protectedRows = Array.isArray(summary.protectedRows) ? summary.protectedRows : [];
    const notInMaster = Array.isArray(summary.notInMaster) ? summary.notInMaster : [];

    const parts = [];

    parts.push(`<div class="sync-result__counts">`);
    parts.push(`<div class="sync-result__count-line"><span class="sync-result__count-label">新規追加</span><span class="sync-result__count-value">${added} 件</span></div>`);
    parts.push(`<div class="sync-result__count-line"><span class="sync-result__count-label">維持（既存）</span><span class="sync-result__count-value">${alreadyExists} 件</span></div>`);
    parts.push(`</div>`);

    if (autoDeleted.length > 0) {
      parts.push(`<div class="sync-result__section">`);
      parts.push(`<h3 class="sync-result__section-title">自動削除（${autoDeleted.length} 件）</h3>`);
      parts.push(`<ul class="sync-result__list">`);
      for (const row of autoDeleted) {
        parts.push(
          `<li class="sync-result__item">` +
          `<span class="sync-result__item-name">${esc(row.member_name || '')}</span>` +
          `<span class="sync-result__item-id">${esc(row.member_id || '')}</span>` +
          `</li>`
        );
      }
      parts.push(`</ul>`);
      parts.push(`</div>`);
    }

    if (protectedRows.length > 0) {
      parts.push(`<div class="sync-result__section">`);
      parts.push(`<h3 class="sync-result__section-title">保護（${protectedRows.length} 件）</h3>`);
      parts.push(`<p class="sync-result__section-note">CSVから外れていましたが、以下の理由で削除しませんでした。</p>`);
      parts.push(`<ul class="sync-result__list">`);
      for (const row of protectedRows) {
        const reason = PROTECTION_REASON_LABELS[row.reason] || row.reason || '';
        parts.push(
          `<li class="sync-result__item">` +
          `<span class="sync-result__item-name">${esc(row.member_name || '')}</span>` +
          `<span class="sync-result__item-id">${esc(row.member_id || '')}</span>` +
          `<span class="sync-result__item-reason">${esc(reason)}</span>` +
          `</li>`
        );
      }
      parts.push(`</ul>`);
      parts.push(`</div>`);
    }

    if (notInMaster.length > 0) {
      parts.push(`<div class="sync-result__section">`);
      parts.push(`<h3 class="sync-result__section-title">未登録会員（${notInMaster.length} 件）</h3>`);
      parts.push(`<p class="sync-result__section-note">CSVに載っていましたが、会員マスタに存在しないIDです。</p>`);
      parts.push(`<ul class="sync-result__list">`);
      for (const id of notInMaster) {
        parts.push(
          `<li class="sync-result__item">` +
          `<span class="sync-result__item-id">${esc(id)}</span>` +
          `</li>`
        );
      }
      parts.push(`</ul>`);
      parts.push(`</div>`);
    }

    return parts.join('');
  }

  function cleanupSession(session) {
    session.btnClose.removeEventListener('click', session.handlers.onClose);
    session.overlay.removeEventListener('click', session.handlers.onOverlay);
    document.removeEventListener('keydown', session.handlers.onKeyDown);
    session.overlay.hidden = true;
    if (session.previouslyFocused && typeof session.previouslyFocused.focus === 'function') {
      try {
        session.previouslyFocused.focus();
      } catch (_) {
        /* ignore */
      }
    }
  }

  function finishSession(session) {
    if (resultSession !== session) return;
    resultSession = null;
    cleanupSession(session);
    session.resolve(undefined);
  }

  function showSyncResult(summary) {
    const overlay = document.getElementById('sync-result-overlay');
    const body = document.getElementById('sync-result-body');
    const btnClose = document.getElementById('btn-sync-result-close');

    if (!overlay || !body || !btnClose) {
      console.error('サマリダイアログのDOMが見つかりません。index.htmlの#sync-result-overlayブロックを確認してください。');
      return Promise.resolve();
    }

    if (resultSession) {
      const prev = resultSession;
      resultSession = null;
      cleanupSession(prev);
      prev.resolve(undefined);
    }

    body.innerHTML = renderBody(summary || {});
    overlay.hidden = false;

    const previouslyFocused = document.activeElement;

    return new Promise((resolve) => {
      const session = {
        resolve,
        previouslyFocused,
        overlay,
        btnClose,
        handlers: {},
      };

      session.handlers.onClose = () => finishSession(session);
      session.handlers.onOverlay = (event) => {
        if (event.target === overlay) finishSession(session);
      };
      session.handlers.onKeyDown = (event) => {
        if (event.key === 'Escape' || event.key === 'Enter') {
          event.preventDefault();
          finishSession(session);
        }
      };

      btnClose.addEventListener('click', session.handlers.onClose);
      overlay.addEventListener('click', session.handlers.onOverlay);
      document.addEventListener('keydown', session.handlers.onKeyDown);

      resultSession = session;
      setTimeout(() => btnClose.focus(), 0);
    });
  }

  window.showSyncResult = showSyncResult;
})();

/**
 * Phase 18 T18.7: 売上明細CSV取り込み結果の read-only ダイアログ
 *
 * セクション構成:
 *   - 中止時（aborted=true）: 警告バナー + あいまい氏名リスト
 *   - 成功時（aborted=false）: 6行のカウンタセクション（追加取引 / 更新取引 /
 *     明細追加 / 重複スキップ / 未解決決済 / パースエラー）と、自動作成会員リスト、
 *     自動作成商品リスト
 *
 * 単一 OK ボタンで閉じる。Esc / Enter / 背景クリックでも閉じる。
 * syncSalesFromCsv の返り値をそのまま渡して使う想定。
 *
 * 使い方:
 *   await showSalesResult({ aborted: false, addedTxns: 3, updatedTxns: 1, ... });
 */
(function () {
  'use strict';

  let salesResultSession = null;

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 本文DOMを組み立てる */
  function renderSalesBody(summary) {
    const parts = [];

    if (summary && summary.aborted) {
      const names = Array.isArray(summary.ambiguousNames) ? summary.ambiguousNames : [];
      parts.push(`<div class="sync-result__abort-banner">`);
      parts.push(`<strong>取り込みを中止しました</strong>`);
      parts.push(`CSVの会員名が複数の会員と一致したため、どの会員の売上か特定できませんでした。データベースは変更していません。`);
      parts.push(`</div>`);

      if (names.length > 0) {
        parts.push(`<div class="sync-result__section">`);
        parts.push(`<h3 class="sync-result__section-title">同名の会員が存在する名前（${names.length} 件）</h3>`);
        parts.push(`<p class="sync-result__section-note">以下の氏名について、会員マスタ内で同姓同名の会員が複数存在します。会員マスタ側で区別できる形にしてから再取り込みしてください。</p>`);
        parts.push(`<ul class="sync-result__list">`);
        for (const name of names) {
          parts.push(
            `<li class="sync-result__item">` +
            `<span class="sync-result__item-name">${esc(name)}</span>` +
            `</li>`
          );
        }
        parts.push(`</ul>`);
        parts.push(`</div>`);
      }
      return parts.join('');
    }

    const added = summary.addedTxns || 0;
    const updated = summary.updatedTxns || 0;
    const addedItems = summary.addedItems || 0;
    const skippedDup = summary.skippedDupItems || 0;
    const unresolved = summary.unresolvedPayments || 0;
    const skippedParse = Array.isArray(summary.skippedParseErrors) ? summary.skippedParseErrors.length : 0;
    const newMembers = Array.isArray(summary.newMembers) ? summary.newMembers : [];
    const newProducts = Array.isArray(summary.newProducts) ? summary.newProducts : [];

    /** 6行のカウンタ */
    parts.push(`<div class="sync-result__counts">`);
    parts.push(`<div class="sync-result__count-line"><span class="sync-result__count-label">新規取引</span><span class="sync-result__count-value">${added} 件</span></div>`);
    parts.push(`<div class="sync-result__count-line"><span class="sync-result__count-label">更新取引（既存に合流）</span><span class="sync-result__count-value">${updated} 件</span></div>`);
    parts.push(`<div class="sync-result__count-line"><span class="sync-result__count-label">明細追加</span><span class="sync-result__count-value">${addedItems} 件</span></div>`);
    parts.push(`<div class="sync-result__count-line"><span class="sync-result__count-label">重複スキップ</span><span class="sync-result__count-value">${skippedDup} 件</span></div>`);
    parts.push(`<div class="sync-result__count-line"><span class="sync-result__count-label">未解決の支払方法</span><span class="sync-result__count-value">${unresolved} 件</span></div>`);
    parts.push(`<div class="sync-result__count-line"><span class="sync-result__count-label">パースエラー</span><span class="sync-result__count-value">${skippedParse} 件</span></div>`);
    parts.push(`</div>`);

    /** 自動作成会員リスト */
    if (newMembers.length > 0) {
      parts.push(`<div class="sync-result__section">`);
      parts.push(`<h3 class="sync-result__section-title">自動作成した会員（${newMembers.length} 件）</h3>`);
      parts.push(`<p class="sync-result__section-note">CSVの会員名が会員マスタに見つからなかったため、ウォークイン扱いで自動登録しました。</p>`);
      parts.push(`<ul class="sync-result__list">`);
      for (const m of newMembers) {
        parts.push(
          `<li class="sync-result__item">` +
          `<span class="sync-result__item-name">${esc(m.name || '')}</span>` +
          `<span class="sync-result__item-id">${esc(m.id || '')}</span>` +
          `</li>`
        );
      }
      parts.push(`</ul>`);
      parts.push(`</div>`);
    }

    /** 自動作成商品リスト */
    if (newProducts.length > 0) {
      parts.push(`<div class="sync-result__section">`);
      parts.push(`<h3 class="sync-result__section-title">自動作成した商品（${newProducts.length} 件）</h3>`);
      parts.push(`<p class="sync-result__section-note">CSVの明細が商品マスタに見つからなかったため、仮登録商品として自動作成しました。必要に応じて商品マスタ画面で修正してください。</p>`);
      parts.push(`<ul class="sync-result__list">`);
      for (const p of newProducts) {
        parts.push(
          `<li class="sync-result__item">` +
          `<span class="sync-result__item-name">${esc(p.name || '')}</span>` +
          `<span class="sync-result__item-code">${esc(p.code || '')}</span>` +
          `</li>`
        );
      }
      parts.push(`</ul>`);
      parts.push(`</div>`);
    }

    return parts.join('');
  }

  function cleanupSession(session) {
    session.btnClose.removeEventListener('click', session.handlers.onClose);
    session.overlay.removeEventListener('click', session.handlers.onOverlay);
    document.removeEventListener('keydown', session.handlers.onKeyDown);
    session.overlay.hidden = true;
    if (session.previouslyFocused && typeof session.previouslyFocused.focus === 'function') {
      try {
        session.previouslyFocused.focus();
      } catch (_) {
        /* ignore */
      }
    }
  }

  function finishSession(session) {
    if (salesResultSession !== session) return;
    salesResultSession = null;
    cleanupSession(session);
    session.resolve(undefined);
  }

  function showSalesResult(summary) {
    const overlay = document.getElementById('sales-result-overlay');
    const body = document.getElementById('sales-result-body');
    const btnClose = document.getElementById('btn-sales-result-close');

    if (!overlay || !body || !btnClose) {
      console.error('売上明細サマリダイアログのDOMが見つかりません。index.htmlの#sales-result-overlayブロックを確認してください。');
      return Promise.resolve();
    }

    if (salesResultSession) {
      const prev = salesResultSession;
      salesResultSession = null;
      cleanupSession(prev);
      prev.resolve(undefined);
    }

    body.innerHTML = renderSalesBody(summary || {});
    overlay.hidden = false;

    const previouslyFocused = document.activeElement;

    return new Promise((resolve) => {
      const session = {
        resolve,
        previouslyFocused,
        overlay,
        btnClose,
        handlers: {}
      };

      session.handlers.onClose = () => finishSession(session);
      session.handlers.onOverlay = (event) => {
        if (event.target === overlay) finishSession(session);
      };
      session.handlers.onKeyDown = (event) => {
        if (event.key === 'Escape' || event.key === 'Enter') {
          event.preventDefault();
          finishSession(session);
        }
      };

      btnClose.addEventListener('click', session.handlers.onClose);
      overlay.addEventListener('click', session.handlers.onOverlay);
      document.addEventListener('keydown', session.handlers.onKeyDown);

      salesResultSession = session;
      setTimeout(() => btnClose.focus(), 0);
    });
  }

  window.showSalesResult = showSalesResult;
})();
