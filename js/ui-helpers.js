/**
 * ui-helpers.js — つかしん窓口精算ツール 共有UIユーティリティ
 *
 * 複数のUIモジュールから参照される汎用UI関数を集約する。
 * DOM操作・フォーマット・トースト通知・警告バナー・ダウンロード等。
 *
 * 依存: なし（純粋なUI関数のみ）
 */

// ============================================
// フォーマット
// ============================================

/**
 * 金額を¥X,XXX形式にフォーマットする
 * @param {number} amount - 金額（整数、円）
 * @returns {string} フォーマットされた金額文字列
 */
function formatCurrency(amount) {
  return '¥' + Number(amount).toLocaleString('ja-JP');
}

/**
 * HTMLエスケープ
 * @param {string} str - エスケープする文字列
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================
// 検索クエリ正規化（かな検索の表記ゆれ吸収）
// ============================================

/** ひらがな範囲の先頭コードポイント（U+3041 = ぁ） */
const HIRAGANA_START = 0x3041;

/** ひらがな範囲の末尾コードポイント（U+3096 = ゖ） */
const HIRAGANA_END = 0x3096;

/** ひらがなから全角カタカナへのコードポイント差（0x30A1 - 0x3041） */
const HIRAGANA_TO_KATAKANA_OFFSET = 0x60;

/**
 * 会員検索（かな検索）用にクエリを正規化する
 *
 * NFKCで半角カタカナ（ｶｲｲﾝ）を全角カタカナ（カイイン）に畳み込み、
 * 続けてひらがな（かいいん）を全角カタカナ（カイイン）へ変換する。
 * ASCII英数字・漢字・ハイフン等の非かな文字は影響を受けない。
 * members.name_kana が全角カタカナ想定なので、IMEの入力形式を問わず
 * 前方一致検索が成立するようにするためのヘルパー。
 *
 * @param {string} query - 生の検索文字列
 * @returns {string} 正規化後の検索文字列
 */
function normalizeKanaQuery(query) {
  if (!query) return '';
  const nfkc = String(query).normalize('NFKC');
  let result = '';
  for (const ch of nfkc) {
    const code = ch.codePointAt(0);
    if (code >= HIRAGANA_START && code <= HIRAGANA_END) {
      result += String.fromCodePoint(code + HIRAGANA_TO_KATAKANA_OFFSET);
    } else {
      result += ch;
    }
  }
  return result;
}

// ============================================
// トースト通知
// ============================================

/** トーストの表示時間（ミリ秒） */
const TOAST_DURATION_MS = 4000;

/** トーストのフェードアウト時間（ミリ秒） */
const TOAST_FADE_MS = 150;

/**
 * トースト通知を表示する
 * @param {string} message - 表示するメッセージ
 */
function showToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast--leaving');
    setTimeout(() => toast.remove(), TOAST_FADE_MS);
  }, TOAST_DURATION_MS);
}

// ============================================
// 警告バナー
// ============================================

/**
 * 警告バナーを表示する
 * @param {string} message - 表示するメッセージ
 */
function showWarningBanner(message) {
  const banner = document.getElementById('warning-banner');
  const messageEl = document.getElementById('warning-banner-message');
  if (banner && messageEl) {
    messageEl.textContent = message;
    banner.hidden = false;
  }
}

// ============================================
// ダウンロード
// ============================================

/** Blob URL の遅延解放時間（ミリ秒） */
const REVOKE_URL_DELAY_MS = 1000;

/**
 * バイト列をBlobにしてファイルとしてダウンロードさせる
 * @param {Uint8Array} bytes - ダウンロードするバイト列
 * @param {string} filename - ファイル名
 * @param {string} [mimeType='text/csv'] - MIMEタイプ
 */
function downloadBytes(bytes, filename, mimeType = 'text/csv') {
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_URL_DELAY_MS);
}

// ============================================
// 商品コード入力ポップオーバー（T8.2 共通化）
// ============================================

/** ポップオーバー表示後のフォーカス遅延（ミリ秒） */
const POPOVER_FOCUS_DELAY_MS = 50;

/**
 * 商品コード入力ポップオーバーを生成し、anchorElement に追加する
 *
 * 呼び出し元（画面1・画面2）の違いはコールバックで吸収する。
 * DOM生成・商品検索・キーボード操作・ボタン操作のロジックは共通。
 *
 * @param {Object} options
 * @param {HTMLElement} options.anchorElement - ポップオーバーを追加する親要素
 * @param {string}      options.popoverClass  - ポップオーバーのCSSクラス文字列
 * @param {Function}    options.onConfirm     - 商品確定時コールバック (product) => void
 * @param {Function}    options.onClose       - キャンセル/Escape時コールバック () => void
 * @returns {HTMLElement} 生成されたポップオーバー要素
 */
function createItemPopover(options) {
  const { anchorElement, popoverClass, onConfirm, onClose } = options;

  const popover = document.createElement('div');
  popover.className = popoverClass;
  popover.innerHTML = `
    <div class="item-popover__input-row">
      <input type="text" class="input" placeholder="商品コード" autofocus>
      <span class="item-popover__result"></span>
    </div>
    <div class="item-popover__actions" hidden>
      <button type="button" class="btn btn--primary">追加</button>
      <button type="button" class="btn btn--outline">キャンセル</button>
    </div>
    <div class="item-popover__error" hidden></div>
  `;

  anchorElement.appendChild(popover);

  const input = popover.querySelector('input');
  const resultSpan = popover.querySelector('.item-popover__result');
  const actionsDiv = popover.querySelector('.item-popover__actions');
  const errorDiv = popover.querySelector('.item-popover__error');
  const addBtn = actionsDiv.querySelector('.btn--primary');
  const cancelBtn = actionsDiv.querySelector('.btn--outline');

  let foundProduct = null;

  input.addEventListener('input', () => {
    const code = input.value.trim();
    if (code.length === 0) {
      resultSpan.textContent = '';
      actionsDiv.hidden = true;
      errorDiv.hidden = true;
      foundProduct = null;
      return;
    }

    foundProduct = lookupProduct(code);

    if (foundProduct) {
      resultSpan.textContent = `${foundProduct.code}: ${foundProduct.name} ${formatCurrency(foundProduct.price)}`;
      resultSpan.classList.add('item-popover__result--found');
      actionsDiv.hidden = false;
      errorDiv.hidden = true;
    } else {
      resultSpan.textContent = '';
      resultSpan.classList.remove('item-popover__result--found');
      actionsDiv.hidden = true;
      errorDiv.textContent = 'コードが見つかりません';
      errorDiv.hidden = false;
      foundProduct = null;
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && foundProduct) {
      e.preventDefault();
      onConfirm(foundProduct);
    } else if (e.key === 'Escape') {
      onClose();
    }
  });

  addBtn.addEventListener('click', () => {
    if (foundProduct) onConfirm(foundProduct);
  });

  cancelBtn.addEventListener('click', () => onClose());

  setTimeout(() => input.focus(), POPOVER_FOCUS_DELAY_MS);

  return popover;
}
