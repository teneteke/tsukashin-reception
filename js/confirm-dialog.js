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
