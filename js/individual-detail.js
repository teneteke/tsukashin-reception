/**
 * individual-detail.js — つかしん窓口精算ツール 個人詳細モジュール
 *
 * 画面2（個人詳細）の機能を担当する:
 * - T3.1 会員情報表示とメモ編集
 * - T3.2 本日分精算の表示と編集
 * - T3.3 期間履歴ビュー
 */

// ============================================
// モジュール状態
// ============================================

/**
 * 現在表示中の会員ID
 * @type {string|null}
 */
let currentDetailMemberId = null;

/**
 * 現在表示中の日付範囲
 * @type {{from: string, to: string}}
 */
let currentDateRange = { from: '', to: '' };

/**
 * 他のスクリプトから現在の会員IDを取得するためのgetter
 * let束縛はスクリプト間で共有されない場合があるため関数経由でアクセスする
 * @returns {string|null}
 */
function getCurrentDetailMemberId() {
  return currentDetailMemberId;
}

/**
 * 他のスクリプトから現在の日付範囲を取得するためのgetter
 * @returns {{from: string, to: string}}
 */
function getCurrentDateRange() {
  return { from: currentDateRange.from, to: currentDateRange.to };
}

// ============================================
// T3.1 会員情報の読み込みと表示
// ============================================

/**
 * 個人詳細画面を読み込む
 * @param {string} memberId - 会員ID（画面1の選択から渡される）
 */
function loadIndividualDetail(memberId) {
  if (!memberId) {
    console.error('member_idが指定されていません');
    return;
  }

  currentDetailMemberId = memberId;

  /** 会員情報を取得 */
  const member = getMemberById(memberId);

  if (!member) {
    console.error(`会員が見つかりません: ${memberId}`);
    showToast('会員情報が取得できませんでした');
    return;
  }

  /** 会員情報ブロックを更新 */
  setFieldText('detail-member-id', member.id);
  setFieldText('detail-member-name', member.name || '—');
  setFieldText('detail-member-phone', member.phone || '—');
  setFieldText('detail-member-class', member.class || '—');
  setFieldText('detail-member-timeslot', member.timeslot || '—');

  /** メモを読み込む */
  const memoInput = document.getElementById('detail-memo');
  if (memoInput) {
    memoInput.value = member.memo || '';
  }

  /** 日付セレクタを今日にセット */
  const today = getTodayJST();
  const dateFrom = document.getElementById('date-from');
  const dateTo = document.getElementById('date-to');
  if (dateFrom) dateFrom.value = today;
  if (dateTo) dateTo.value = today;
  currentDateRange = { from: today, to: today };

  /** 精算テーブルを描画 */
  renderSettlementTable();

  /** T7.2: 商品マスタは画面4に移動。画面2の読み込み時には描画しない。
   *  画面4への遷移時（navigateToProductMaster）に描画する。 */

  /** 領収書発行ボタンの有効/無効を更新 */
  if (typeof updateReceiptButtonState === 'function') {
    updateReceiptButtonState();
  }

  /** T7.3: 最終発行ラインを更新 */
  if (typeof updateLastIssuedDisplay === 'function') {
    updateLastIssuedDisplay();
  }

  /** 宛名欄を会員名にデフォルト設定 */
  const recipientInput = document.getElementById('receipt-recipient');
  if (recipientInput) {
    recipientInput.value = member.name || '';
  }

  console.log(`個人詳細を読み込みました: ${member.id} ${member.name}`);
}

/**
 * 会員情報の表示フィールドにテキストを設定する
 * @param {string} elementId - 対象要素のID
 * @param {string} value - 表示するテキスト
 */
function setFieldText(elementId, value) {
  const el = document.getElementById(elementId);
  if (el) el.textContent = value;
}

/**
 * 会員メモの変更を保存する（focusout時）
 * @param {Event} event - focusoutイベント
 */
async function handleDetailMemoBlur(event) {
  if (!currentDetailMemberId) return;

  const input = event.target;
  const value = input.value.trim() || null;

  try {
    await updateMemberMemo(currentDetailMemberId, value);
  } catch (error) {
    console.error('メモの保存に失敗しました', error);
    showToast('メモの保存に失敗しました');
    return;
  }

  console.log(`会員メモを保存しました: ${currentDetailMemberId}`);
}

// ============================================
// T3.2 / T3.3 精算テーブルの描画
// ============================================

/**
 * YYYY-MM-DD 形式を YYYY/MM/DD 形式に変換する（T7.6）
 * @param {string} dashDate - "2026-04-16" 形式
 * @returns {string} "2026/04/16" 形式
 */
function formatSlashDate(dashDate) {
  if (!dashDate) return '';
  return String(dashDate).replace(/-/g, '/');
}

/**
 * 画面2の精算テーブルを描画する（本日分のみ、T7.1で変更）
 *
 * 画面2は常に本日のみを表示する。期間履歴は画面3で参照する。
 * currentDateRange（date-from / date-to）は画面3と領収書発行の範囲として
 * 別途利用され、画面2の表示には影響しない。
 */
function renderSettlementTable() {
  if (!currentDetailMemberId) return;

  const tbody = document.getElementById('settlement-table-body');
  const totalEl = document.getElementById('settlement-total');
  if (!tbody) return;

  const today = getTodayJST();

  /** T7.6: セクションタイトルに本日日付を動的に挿入 */
  const titleEl = document.getElementById('settlement-section-title');
  if (titleEl) {
    titleEl.textContent = `◆ 本日の窓口料金（${formatSlashDate(today)}）`;
  }

  /** 本日分のtransactionとitemsを取得 */
  const items = getTodaySettlementItems(currentDetailMemberId);

  tbody.innerHTML = '';

  let totalAmount = 0;

  for (const item of items) {
    /** 明細が無いtransactionはスキップ（item_idがNULL） */
    if (item.item_id == null) continue;

    const subtotal = item.price_snapshot * item.quantity;
    totalAmount += subtotal;

    /** 画面2は常に本日の行 → 全行編集可能 */
    const row = document.createElement('tr');
    row.dataset.itemId = String(item.item_id);
    row.dataset.txnId = String(item.txn_id);
    row.dataset.isToday = '1';

    row.innerHTML = `
      <td>${escapeHtml(item.txn_date)}</td>
      <td>${escapeHtml(item.product_code)}</td>
      <td>${escapeHtml(item.product_name_snapshot)}</td>
      <td class="td-right">${formatCurrency(item.price_snapshot)}</td>
      <td class="td-center">
        <input type="number" class="input input--inline-qty" data-item-id="${item.item_id}"
               value="${item.quantity}" min="1" max="999">
      </td>
      <td class="td-right">${formatCurrency(subtotal)}</td>
      <td>
        ${escapeHtml(item.payment_method_name || '')}
        <button type="button" class="btn--inline-delete" data-item-id="${item.item_id}"
                title="明細を削除" aria-label="明細を削除">×</button>
      </td>
    `;

    tbody.appendChild(row);
  }

  /** 明細が0件の場合のメッセージ行 */
  if (tbody.children.length === 0) {
    const row = document.createElement('tr');
    row.className = 'empty-row';
    row.innerHTML = `<td colspan="7">本日の明細はまだありません</td>`;
    tbody.appendChild(row);
  }

  /** 合計表示 */
  if (totalEl) {
    totalEl.textContent = formatCurrency(totalAmount);
  }

  /** [+ 追加] ボタンは常に有効（画面2は本日のみ） */
  const btnAddItem = document.getElementById('btn-add-item');
  if (btnAddItem) {
    btnAddItem.disabled = false;
    btnAddItem.title = '商品を追加';
  }

  /** 領収書発行ボタンの有効/無効を更新 */
  if (typeof updateReceiptButtonState === 'function') {
    updateReceiptButtonState();
  }
}

/**
 * 画面3の期間履歴テーブルを描画する（T7.1 新規、T7.8 改修）
 *
 * currentDateRange の期間内の全取引を txn_id 単位でグルーピングし、
 * 1取引 = 1行で表示する。4列: 日付 / 内訳 / 決済方法 / 合計。
 * 完全に読み取り専用。
 */
function renderPeriodHistoryTable() {
  if (!currentDetailMemberId) return;

  const tbody = document.getElementById('history-table-body');
  const totalEl = document.getElementById('history-total');
  const rangeEl = document.getElementById('history-range-value');
  if (!tbody) return;

  const { from, to } = currentDateRange;

  /** 期間ラベルの更新 */
  if (rangeEl) {
    rangeEl.textContent = `${from} ～ ${to}`;
  }

  /** T7.6: セクションタイトルに期間をスラッシュ形式で動的に挿入 */
  const titleEl = document.getElementById('history-section-title');
  if (titleEl) {
    titleEl.textContent = `◆ 窓口料金（${formatSlashDate(from)} ～ ${formatSlashDate(to)}）`;
  }

  /** 期間内のtransactionとitemsを取得 */
  const items = getPeriodSettlementItems(currentDetailMemberId, from, to);

  /** txn_id 単位でグルーピング */
  const txnMap = new Map();
  for (const item of items) {
    if (item.item_id == null) continue;
    if (!txnMap.has(item.txn_id)) {
      txnMap.set(item.txn_id, {
        date: item.txn_date,
        paymentMethod: item.payment_method_name || '',
        items: []
      });
    }
    txnMap.get(item.txn_id).items.push(item);
  }

  tbody.innerHTML = '';

  let totalAmount = 0;

  for (const [, txn] of txnMap) {
    let txnTotal = 0;
    const breakdownParts = [];

    for (const item of txn.items) {
      const subtotal = item.price_snapshot * item.quantity;
      txnTotal += subtotal;
      const qtyStr = item.quantity > 1 ? `×${item.quantity}` : '';
      breakdownParts.push(`${item.product_name_snapshot} ${formatCurrency(item.price_snapshot)}${qtyStr}`);
    }

    totalAmount += txnTotal;

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(formatSlashDate(txn.date))}</td>
      <td>${escapeHtml(breakdownParts.join(' / '))}</td>
      <td>${escapeHtml(txn.paymentMethod)}</td>
      <td class="td-right">${formatCurrency(txnTotal)}</td>
    `;
    tbody.appendChild(row);
  }

  /** 明細が0件の場合のメッセージ行 */
  if (tbody.children.length === 0) {
    const row = document.createElement('tr');
    row.className = 'empty-row';
    row.innerHTML = `<td colspan="4">この期間に明細はありません</td>`;
    tbody.appendChild(row);
  }

  /** 期間合計の表示 */
  if (totalEl) {
    totalEl.textContent = formatCurrency(totalAmount);
  }
}

/**
 * 現在の精算合計金額を返す
 * @returns {number} 合計（円、税込）
 */
function getCurrentSettlementTotal() {
  if (!currentDetailMemberId) return 0;

  const { from, to } = currentDateRange;

  return getSettlementTotal(currentDetailMemberId, from, to);
}

// ============================================
// T3.2 商品追加（画面2用）
// ============================================

/** @type {HTMLElement|null} 現在表示中の画面2用ポップオーバー */
let detailActivePopover = null;

/**
 * 画面2の [+ 追加] ボタン押下時に商品コード入力ポップオーバーを表示する
 */
function showDetailAddItemPopover() {
  closeDetailPopover();

  const anchor = document.getElementById('btn-add-item');
  if (!anchor) return;

  const parent = anchor.parentElement;
  if (parent) {
    parent.style.position = 'relative';
  }

  detailActivePopover = createItemPopover({
    anchorElement: parent || document.body,
    popoverClass: 'item-popover item-popover--detail',
    onConfirm: (product) => addItemInDetail(product),
    onClose: () => closeDetailPopover(),
  });
}

/**
 * 画面2のポップオーバーを閉じる
 */
function closeDetailPopover() {
  if (detailActivePopover) {
    detailActivePopover.remove();
    detailActivePopover = null;
  }
}

/**
 * 画面2で商品を本日のtransactionに追加する
 * 本日のtransactionが無ければ自動作成する
 * @param {Object} product - 商品オブジェクト {code, name, price}
 */
async function addItemInDetail(product) {
  if (!currentDetailMemberId) {
    closeDetailPopover();
    return;
  }

  const today = getTodayJST();

  /** 現在の日付範囲が本日を含んでいない場合は追加不可 */
  if (currentDateRange.from > today || currentDateRange.to < today) {
    showToast('本日以外の日付では商品を追加できません');
    closeDetailPopover();
    return;
  }

  try {
    await addItemToMemberToday(currentDetailMemberId, product);
    console.log(`商品を追加しました: ${product.code} ${product.name}`);
  } catch (error) {
    console.error('商品の追加に失敗しました', error);
    showToast('商品の追加に失敗しました');
    closeDetailPopover();
    return;
  }

  closeDetailPopover();
  renderSettlementTable();
}

/**
 * 明細行の数量を変更する
 * @param {number} itemId - 明細ID
 * @param {number} newQty - 新しい数量
 */
async function handleItemQuantityChange(itemId, newQty) {
  if (newQty < 1 || newQty > 999 || !Number.isInteger(newQty)) {
    showToast('数量は1〜999の整数で入力してください');
    renderSettlementTable();
    return;
  }

  try {
    await updateItemQuantity(itemId, newQty);
  } catch (error) {
    console.error('数量の変更に失敗しました', error);
    showToast('数量の変更に失敗しました');
    renderSettlementTable();
    return;
  }

  renderSettlementTable();
}

/**
 * 明細行を削除する
 * @param {number} itemId - 明細ID
 */
async function deleteSettlementItem(itemId) {
  const confirmed = await window.confirmAction(
    '明細の削除',
    'この明細を削除します。\nこの操作は元に戻せません。よろしいですか？'
  );
  if (!confirmed) return;

  try {
    await deleteTransactionItem(itemId);
  } catch (error) {
    console.error('明細の削除に失敗しました', error);
    showToast('明細の削除に失敗しました');
    return;
  }

  renderSettlementTable();
  console.log(`明細を削除しました: itemId=${itemId}`);
}

// ============================================
// T3.3 日付範囲の変更
// ============================================

/**
 * 日付範囲が変更されたときに呼ばれる
 */
function handleDateRangeChange() {
  const dateFromEl = document.getElementById('date-from');
  const dateToEl = document.getElementById('date-to');
  if (!dateFromEl || !dateToEl) return;

  const from = dateFromEl.value;
  const to = dateToEl.value;

  if (!from || !to) return;

  /** from > to の場合は入れ替え */
  if (from > to) {
    currentDateRange = { from: to, to: from };
    dateFromEl.value = to;
    dateToEl.value = from;
  } else {
    currentDateRange = { from, to };
  }

  /** T7.1: 画面2のテーブルは本日分のみで描画済み（期間変更の影響なし）。
   *  領収書ボタンの有効/無効のみ期間合計で再評価する。 */
  if (typeof updateReceiptButtonState === 'function') {
    updateReceiptButtonState();
  }
}

// ============================================
// イベント委譲セットアップ
// ============================================

/**
 * 画面2のイベントリスナーを設定する
 */
function initIndividualDetailEvents() {
  /** メモのblur保存 */
  const memoInput = document.getElementById('detail-memo');
  if (memoInput) {
    memoInput.addEventListener('focusout', handleDetailMemoBlur);
  }

  /** 日付セレクタ */
  const dateFromEl = document.getElementById('date-from');
  const dateToEl = document.getElementById('date-to');
  if (dateFromEl) dateFromEl.addEventListener('change', handleDateRangeChange);
  if (dateToEl) dateToEl.addEventListener('change', handleDateRangeChange);

  /** [+ 追加] ボタン */
  const btnAddItem = document.getElementById('btn-add-item');
  if (btnAddItem) {
    btnAddItem.addEventListener('click', () => {
      showDetailAddItemPopover();
    });
  }

  /** 精算テーブル内のイベント委譲 */
  const settlementBody = document.getElementById('settlement-table-body');
  if (settlementBody) {
    /** 数量変更 */
    settlementBody.addEventListener('change', (event) => {
      const target = event.target;
      if (target.classList.contains('input--inline-qty')) {
        const itemId = parseInt(target.dataset.itemId, 10);
        if (isNaN(itemId)) return;
        const newQty = parseInt(target.value, 10);
        handleItemQuantityChange(itemId, newQty);
      }
    });

    /** 明細削除 */
    settlementBody.addEventListener('click', (event) => {
      const target = event.target;
      if (target.classList.contains('btn--inline-delete')) {
        const itemId = parseInt(target.dataset.itemId, 10);
        if (isNaN(itemId)) return;
        deleteSettlementItem(itemId);
      }
    });
  }

  console.log('個人詳細画面のイベントリスナーを初期化しました');
}
