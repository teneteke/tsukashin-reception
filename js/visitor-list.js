/**
 * visitor-list.js — つかしん窓口精算ツール 来館者一覧モジュール
 *
 * 画面1（来館者一覧）の全機能を担当する:
 * - T2.1 テーブル描画
 * - T2.2 行選択・削除（app.jsと連携）
 * - T2.3 検索バー・会員追加
 * - T2.4 商品追加
 * - T2.5 出席/受取トグル・決済方法
 * - T2.6 クラス/時間枠インライン編集
 * - T2.7 インラインメモ
 * - T2.8 更新ボタン（SaaS同期スタブ）
 */

// ============================================
// 定数
// ============================================

/** 検索のデバウンス間隔（ミリ秒） */
const SEARCH_DEBOUNCE_MS = 200;

/** オートコンプリートの最大表示件数 */
const AUTOCOMPLETE_MAX_RESULTS = 10;

/** オートコンプリート閉じ遅延（blur時、クリック受付のため） */
const AUTOCOMPLETE_CLOSE_DELAY_MS = 200;

// ============================================
// T2.1 テーブル描画
// ============================================

/**
 * 来館者1行分のinnerHTMLを構築する
 *
 * Phase 9 T9.5: クラス／時間枠の DISTINCT リストは呼び出し側（renderVisitorTable）で
 * 1度だけ取得して引数経由で渡す。旧実装は行ごとに `getDistinctClasses` / `getDistinctTimeslots`
 * を呼んでいたため N+1 クエリが発生していた。
 *
 * @param {Object} txn - トランザクションオブジェクト（getTodayVisitorList の1要素）
 * @param {string[]} classOptions - 事前取得済みの DISTINCT クラス一覧
 * @param {string[]} timeslotOptions - 事前取得済みの DISTINCT 時間枠一覧
 * @returns {string} tr 内部のHTML文字列
 */
function buildVisitorRowHtml(txn, classOptions, timeslotOptions) {
  const displayClass = txn.class_override || txn.member_class || '';
  const classIsOverride = !!txn.class_override;
  const displayTimeslot = txn.timeslot_override || txn.member_timeslot || '';
  const timeslotIsOverride = !!txn.timeslot_override;

  const breakdownHtml = txn.items.map((item) =>
    `<div class="breakdown-line">${escapeHtml(item.product_name_snapshot)} ${formatCurrency(Number(item.price_snapshot || 0) * Number(item.quantity || 0))}</div>`
  ).join('');

  const showReceived = txn.lineTotal > 0;
  const paymentMethodName = txn.payment_method_name || '';

  return `
    <td class="col-id">${escapeHtml(txn.member_id)}</td>
    <td class="col-name">${escapeHtml(txn.member_name_snapshot)}</td>
    <td class="col-class">
      <select class="inline-select ${classIsOverride ? '' : 'inline-select--default'}" data-field="class" data-txn-id="${txn.txn_id}">
        ${buildClassOptions(displayClass, classOptions)}
      </select>
    </td>
    <td class="col-timeslot">
      <select class="inline-select ${timeslotIsOverride ? '' : 'inline-select--default'}" data-field="timeslot" data-txn-id="${txn.txn_id}">
        ${buildTimeslotOptions(displayTimeslot, timeslotOptions)}
      </select>
    </td>
    <td class="col-amount">
      ${txn.lineTotal > 0 ? formatCurrency(txn.lineTotal) : '<span class="amount--zero">¥0</span>'}
    </td>
    <td class="col-breakdown">${breakdownHtml}</td>
    <td class="col-add">
      <button type="button" class="btn btn--outline btn--icon btn--sm btn-add-item" data-txn-id="${txn.txn_id}"
              title="商品を追加" aria-label="商品を追加">+</button>
    </td>
    <td class="col-memo">
      <input type="text" class="input input--inline-table" data-txn-id="${txn.txn_id}"
             value="${escapeHtml(txn.txn_memo || '')}" placeholder="メモ">
    </td>
    <td class="col-attendance">
      <button type="button" class="toggle-btn toggle-attendance ${txn.is_attended ? 'toggle-btn--on' : ''}"
              data-txn-id="${txn.txn_id}" aria-pressed="${txn.is_attended ? 'true' : 'false'}"
              aria-label="出席" title="出席">
        ${txn.is_attended ? '✓' : '○'}
      </button>
    </td>
    <td class="col-received">
      ${showReceived ? `
        <div class="received-cell">
          <button type="button" class="toggle-btn toggle-received ${txn.is_received ? 'toggle-btn--on toggle-btn--received' : ''}"
                  data-txn-id="${txn.txn_id}" aria-pressed="${txn.is_received ? 'true' : 'false'}"
                  aria-label="受取" title="受取">
            ${txn.is_received ? '✓' : '○'}
          </button>
          ${txn.is_received && paymentMethodName ? `<span class="payment-badge">${escapeHtml(paymentMethodName)}</span>` : ''}
          <div class="payment-selector" data-txn-id="${txn.txn_id}" hidden></div>
        </div>
      ` : ''}
    </td>
  `;
}

/**
 * 来館者一覧テーブルを描画する
 * 本日のtransactionsをDBから取得し、テーブルに表示する
 */
function renderVisitorTable() {
  const tableBody = document.getElementById('visitor-table-body');
  if (!tableBody) return;

  const transactionsWithTotals = getTodayVisitorList();

  /** Phase 9 T9.5: クラス／時間枠の DISTINCT リストは1度だけ取得してループ内で使い回す。
   *  旧実装は buildVisitorRowHtml → buildClassOptions → getDistinctClasses の連鎖を行ごとに
   *  呼んでいたため N+1 SELECT DISTINCT が走っていた。 */
  const classOptions = getDistinctClasses();
  const timeslotOptions = getDistinctTimeslots();

  tableBody.innerHTML = '';

  for (const txn of transactionsWithTotals) {
    const row = document.createElement('tr');
    row.dataset.memberId = txn.member_id;
    row.dataset.txnId = String(txn.txn_id);
    row.innerHTML = buildVisitorRowHtml(txn, classOptions, timeslotOptions);
    tableBody.appendChild(row);
  }

  updateHeaderStats(transactionsWithTotals);

  console.log(`来館者テーブルを描画しました: ${transactionsWithTotals.length}名`);
}

/**
 * ヘッダーの来館者数と窓口総額を更新する
 * 窓口総額は is_received = 1 の行のみ合計
 * @param {Array} transactions - transactionsWithTotals
 */
function updateHeaderStats(transactions) {
  const countEl = document.getElementById('visitor-count');
  const totalEl = document.getElementById('header-total');

  if (countEl) {
    countEl.textContent = `(${transactions.length}名)`;
  }
  if (totalEl) {
    const receivedTotal = transactions
      .filter((t) => t.is_received)
      .reduce((sum, t) => sum + t.lineTotal, 0);
    totalEl.textContent = formatCurrency(receivedTotal);
  }
}

// ============================================
// T2.3 検索バー・会員追加
// ============================================

/** @type {number|null} デバウンス用のタイマーID */
let searchDebounceTimer = null;

/** @type {number} オートコンプリートで現在フォーカスされている候補のインデックス */
let autocompleteFocusIndex = -1;

/**
 * 検索バーを初期化する
 */
function initSearch() {
  const searchInput = document.getElementById('search-input');
  const dropdown = document.getElementById('search-autocomplete');
  if (!searchInput || !dropdown) return;

  /** 入力イベント（デバウンス付き） */
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      const query = searchInput.value.trim();
      if (query.length === 0) {
        hideAutocomplete();
        return;
      }
      performSearch(query);
    }, SEARCH_DEBOUNCE_MS);
  });

  /** キーボードナビゲーション */
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      navigateAutocomplete(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      navigateAutocomplete(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      selectAutocompleteItem();
    } else if (event.key === 'Escape') {
      hideAutocomplete();
      searchInput.blur();
    }
  });

  /** フォーカスが外れたらドロップダウンを閉じる（遅延付き） */
  searchInput.addEventListener('blur', () => {
    setTimeout(() => hideAutocomplete(), AUTOCOMPLETE_CLOSE_DELAY_MS);
  });
}

/**
 * 会員を検索し、オートコンプリートドロップダウンに表示する
 * @param {string} query - 検索文字列
 */
function performSearch(query) {
  const normalized = normalizeKanaQuery(query);
  const results = searchMembers(normalized, AUTOCOMPLETE_MAX_RESULTS);
  showAutocomplete(results, query);
}

/**
 * オートコンプリートドロップダウンを表示する
 * @param {Array} results - 検索結果
 * @param {string} query - 元の検索文字列
 */
function showAutocomplete(results, query) {
  const dropdown = document.getElementById('search-autocomplete');
  if (!dropdown) return;

  autocompleteFocusIndex = -1;
  dropdown.innerHTML = '';

  /** 検索結果の候補 */
  for (const member of results) {
    const item = document.createElement('div');
    item.className = 'autocomplete-item';
    item.dataset.memberId = member.id;
    item.setAttribute('role', 'option');
    item.innerHTML = `
      <span class="autocomplete-item__id">${escapeHtml(member.id)}</span>
      <span class="autocomplete-item__name">${escapeHtml(member.name)}</span>
      <span class="autocomplete-item__phone">${escapeHtml(member.phone || '')}</span>
    `;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      addMemberToToday(member.id);
    });
    dropdown.appendChild(item);
  }

  /** ウォークインオプション（検索にヒットしない場合） */
  if (results.length === 0 && query.length > 0) {
    const walkInItem = document.createElement('div');
    walkInItem.className = 'autocomplete-item autocomplete-item--walkin';
    walkInItem.setAttribute('role', 'option');
    walkInItem.innerHTML = `<em>ウォークインとして追加: 「${escapeHtml(query)}」</em>`;
    walkInItem.addEventListener('mousedown', (e) => {
      e.preventDefault();
      addWalkIn(query);
    });
    dropdown.appendChild(walkInItem);
  }

  dropdown.hidden = false;
}

/**
 * オートコンプリートドロップダウンを非表示にする
 */
function hideAutocomplete() {
  const dropdown = document.getElementById('search-autocomplete');
  if (dropdown) {
    dropdown.hidden = true;
    dropdown.innerHTML = '';
  }
  autocompleteFocusIndex = -1;
}

/**
 * オートコンプリート候補間をキーボードで移動する
 * @param {number} direction - 移動方向（1: 下, -1: 上）
 */
function navigateAutocomplete(direction) {
  const dropdown = document.getElementById('search-autocomplete');
  if (!dropdown || dropdown.hidden) return;

  const items = dropdown.querySelectorAll('.autocomplete-item');
  if (items.length === 0) return;

  /** 前のフォーカスを解除 */
  if (autocompleteFocusIndex >= 0 && autocompleteFocusIndex < items.length) {
    items[autocompleteFocusIndex].classList.remove('autocomplete-item--focused');
  }

  /** 新しいインデックスを計算 */
  autocompleteFocusIndex += direction;
  if (autocompleteFocusIndex < 0) autocompleteFocusIndex = items.length - 1;
  if (autocompleteFocusIndex >= items.length) autocompleteFocusIndex = 0;

  /** 新しいフォーカスを適用 */
  items[autocompleteFocusIndex].classList.add('autocomplete-item--focused');
}

/**
 * 現在フォーカスされているオートコンプリート候補を選択する
 */
function selectAutocompleteItem() {
  const dropdown = document.getElementById('search-autocomplete');
  if (!dropdown || dropdown.hidden) return;

  const items = dropdown.querySelectorAll('.autocomplete-item');
  if (autocompleteFocusIndex >= 0 && autocompleteFocusIndex < items.length) {
    const focusedItem = items[autocompleteFocusIndex];
    const memberId = focusedItem.dataset.memberId;
    if (memberId) {
      addMemberToToday(memberId);
    } else {
      /** ウォークインの場合 */
      const searchInput = document.getElementById('search-input');
      if (searchInput) addWalkIn(searchInput.value.trim());
    }
  }
}

/**
 * 既存会員を本日の来館者リストに追加する
 * @param {string} memberId - 会員ID
 */
async function addMemberToToday(memberId) {
  const today = getTodayJST();

  /** 既に本日のリストにいるか確認 */
  if (hasTransactionForDate(today, memberId)) {
    /** 既存の行をフォーカス */
    const existingRow = document.querySelector(`#visitor-table-body tr[data-member-id="${CSS.escape(memberId)}"]`);
    if (existingRow) selectRow(existingRow);
    showToast('この会員は既に一覧にいます');
    hideAutocomplete();
    clearSearchInput();
    return;
  }

  /** 会員情報を取得 */
  const member = getMemberById(memberId);
  if (!member) {
    showToast('会員が見つかりません');
    return;
  }

  try {
    /** transaction行を作成 */
    await addMemberTransaction(memberId);

    /** テーブルを再描画 */
    renderVisitorTable();
    hideAutocomplete();
    clearSearchInput();
    console.log(`来館者を追加しました: ${member.id} ${member.name}`);
  } catch (error) {
    console.error('来館者の追加に失敗しました:', error);
    showToast('来館者の追加に失敗しました');
  }
}

/**
 * ウォークイン（仮会員）を作成し、本日の来館者リストに追加する
 * @param {string} name - 入力された名前
 */
async function addWalkIn(name) {
  try {
    const walkInId = await createWalkInWithTransaction(name);

    /** テーブルを再描画 */
    renderVisitorTable();
    hideAutocomplete();
    clearSearchInput();
    console.log(`ウォークインを追加しました: ${walkInId} ${name}`);
  } catch (error) {
    console.error('ウォークインの追加に失敗しました:', error);
    showToast('ウォークインの追加に失敗しました');
  }
}

/**
 * 検索入力をクリアする
 */
function clearSearchInput() {
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.value = '';
}

// ============================================
// T2.4 商品追加
// ============================================

/** @type {HTMLElement|null} 現在表示中の商品コード入力ポップオーバー */
let activePopover = null;

/**
 * 商品コードから商品マスタを検索する（ゼロパディング・前方一致フォールバック付き）
 *
 * 手順:
 *   1. 入力が数字のみ かつ 3桁未満 → 先頭ゼロ埋めで完全一致を試みる（「1」→「001」）
 *   2. 上でヒットしなければ、生の入力で前方一致（code LIKE 'xxx%'）、
 *      code ASC で最初の1件を返す
 *   3. いずれも見つからなければ null
 *
 * @param {string} rawCode - ユーザー入力の商品コード（trim済み）
 * @returns {Object|null} {code, name, price} もしくは null
 */
function lookupProductByCode(rawCode) {
  if (!rawCode) return null;
  return lookupProduct(rawCode);
}

/**
 * 商品追加ポップオーバーを表示する
 * @param {number} txnId - トランザクションID
 * @param {HTMLElement} buttonEl - クリックされた[+]ボタン要素
 */
function showAddItemPopover(txnId, buttonEl) {
  closePopover();

  const cell = buttonEl.closest('td');
  cell.style.position = 'relative';

  activePopover = createItemPopover({
    anchorElement: cell,
    popoverClass: 'item-popover',
    onConfirm: (product) => addItemToTransaction(txnId, product),
    onClose: () => closePopover(),
  });
}

/**
 * 商品を取引に追加する
 * @param {number} txnId - トランザクションID
 * @param {Object} product - 商品オブジェクト {code, name, price}
 */
async function addItemToTransaction(txnId, product) {
  try {
    /** txnIdからmemberIdを取得（DOMの行データから） */
    const row = document.querySelector(`#visitor-table-body tr[data-txn-id="${txnId}"]`);
    const memberId = row ? row.dataset.memberId : null;
    if (!memberId) {
      showToast('会員情報が見つかりません');
      return;
    }

    await addItemToMemberToday(memberId, { code: product.code, name: product.name, price: product.price });
    console.log(`商品を追加しました: ${product.code} ${product.name} ${formatCurrency(product.price)}`);
  } catch (error) {
    console.error('商品の追加に失敗しました:', error);
    showToast('商品の追加に失敗しました');
  }

  closePopover();
  renderVisitorTable();
}

/**
 * 商品コード入力ポップオーバーを閉じる
 */
function closePopover() {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
}

// ============================================
// T2.5 出席/受取トグル・決済方法
// ============================================

/**
 * 出席ボタンをトグルする
 * @param {number} txnId - トランザクションID
 */
async function toggleAttendance(txnId) {
  try {
    const txn = getTransactionAttendance(txnId);
    if (!txn) return;

    const newValue = txn.is_attended ? 0 : 1;
    await updateAttendance(txnId, newValue);

    renderVisitorTable();
  } catch (error) {
    console.error('出席状態の変更に失敗しました:', error);
    showToast('出席状態の変更に失敗しました');
  }
}

/**
 * 受取ボタンをトグルする
 * 受取ONの場合、決済方法セレクタを表示する
 * @param {number} txnId - トランザクションID
 */
async function toggleReceived(txnId) {
  const txn = getTransactionReceived(txnId);
  if (!txn) return;

  if (txn.is_received) {
    /** 受取OFFにする */
    try {
      await clearReceived(txnId);
      renderVisitorTable();
    } catch (error) {
      console.error('受取状態の変更に失敗しました:', error);
      showToast('受取状態の変更に失敗しました');
    }
  } else {
    /** 決済方法セレクタを表示 */
    showPaymentSelector(txnId);
  }
}

/**
 * 決済方法セレクタを表示する
 * @param {number} txnId - トランザクションID
 */
function showPaymentSelector(txnId) {
  const selectorDiv = document.querySelector(`.payment-selector[data-txn-id="${txnId}"]`);
  if (!selectorDiv) return;

  /** アクティブな決済方法を取得 */
  const methods = getActivePaymentMethods();

  selectorDiv.innerHTML = methods.map((m) =>
    `<button type="button" class="payment-method-btn" data-method-id="${m.id}">${escapeHtml(m.name)}</button>`
  ).join('');
  selectorDiv.hidden = false;

  /** 決済方法ボタンのクリックイベント */
  selectorDiv.querySelectorAll('.payment-method-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const methodId = parseInt(btn.dataset.methodId, 10);
      try {
        await setReceivedWithPayment(txnId, methodId);
      } catch (error) {
        console.error('決済方法の変更に失敗しました:', error);
        showToast('決済方法の変更に失敗しました');
      }
      renderVisitorTable();
    });
  });
}

// ============================================
// T2.6 クラス/時間枠インライン編集
// ============================================

/**
 * クラスのドロップダウン選択肢を生成する
 *
 * Phase 9 T9.5: DISTINCT リストは呼び出し側で事前取得して渡す。
 * 関数内部で DB アクセスは行わない。
 *
 * @param {string} currentValue - 現在の値
 * @param {string[]} classes - 事前取得済みの DISTINCT クラス一覧
 * @returns {string} option要素のHTML
 */
function buildClassOptions(currentValue, classes) {
  let options = '<option value="">—</option>';
  for (const cls of classes) {
    const selected = cls === currentValue ? ' selected' : '';
    options += `<option value="${escapeHtml(cls)}"${selected}>${escapeHtml(cls)}</option>`;
  }
  /** 現在の値がリストにない場合、追加 */
  if (currentValue && !classes.includes(currentValue)) {
    options += `<option value="${escapeHtml(currentValue)}" selected>${escapeHtml(currentValue)}</option>`;
  }
  return options;
}

/**
 * 時間枠のドロップダウン選択肢を生成する
 *
 * Phase 9 T9.5: DISTINCT リストは呼び出し側で事前取得して渡す。
 * 関数内部で DB アクセスは行わない。
 *
 * @param {string} currentValue - 現在の値
 * @param {string[]} timeslots - 事前取得済みの DISTINCT 時間枠一覧
 * @returns {string} option要素のHTML
 */
function buildTimeslotOptions(currentValue, timeslots) {
  let options = '<option value="">—</option>';
  for (const ts of timeslots) {
    const selected = ts === currentValue ? ' selected' : '';
    options += `<option value="${escapeHtml(ts)}"${selected}>${escapeHtml(ts)}</option>`;
  }
  if (currentValue && !timeslots.includes(currentValue)) {
    options += `<option value="${escapeHtml(currentValue)}" selected>${escapeHtml(currentValue)}</option>`;
  }
  return options;
}

/**
 * クラスまたは時間枠のインライン編集を処理する
 * @param {Event} event - changeイベント
 */
async function handleInlineSelectChange(event) {
  const select = event.target;
  if (!select.classList.contains('inline-select')) return;

  const txnId = parseInt(select.dataset.txnId, 10);
  const field = select.dataset.field;
  const value = select.value || null;

  try {
    if (field === 'class') {
      await updateClassOverride(txnId, value);
    } else if (field === 'timeslot') {
      await updateTimeslotOverride(txnId, value);
    }
  } catch (error) {
    console.error('変更の保存に失敗しました:', error);
    showToast('変更の保存に失敗しました');
  }

  /** スタイルを更新（オーバーライドがあれば通常色、なければ薄い色） */
  select.classList.toggle('inline-select--default', !value);
}

// ============================================
// T2.7 インラインメモ
// ============================================

/**
 * メモの変更を保存する
 * @param {Event} event - blur/changeイベント
 */
async function handleMemoChange(event) {
  const input = event.target;
  if (!input.classList.contains('input--inline-table')) return;

  const txnId = parseInt(input.dataset.txnId, 10);
  const value = input.value.trim() || null;

  try {
    await updateTransactionMemo(txnId, value);
  } catch (error) {
    console.error('メモの保存に失敗しました:', error);
    showToast('メモの保存に失敗しました');
  }
}

// ============================================
// T2.2 削除
// ============================================

/**
 * 選択されている来館者を本日のリストから削除する
 */
async function deleteSelectedVisitor() {
  const selectedRow = document.querySelector('#visitor-table-body tr.row--selected');
  if (!selectedRow) return;

  const txnId = parseInt(selectedRow.dataset.txnId, 10);
  const memberName = selectedRow.querySelector('.col-name')?.textContent || '不明';

  /** 確認ダイアログ（共有モーダル、T6.10） */
  const confirmed = typeof window.confirmAction === 'function'
    ? await window.confirmAction(
        '来館者の削除',
        `「${memberName}」を本日の一覧から削除します。\nこの操作は元に戻せません。よろしいですか？\n\n※取引明細も一緒に削除されます。`
      )
    : window.confirm(`「${memberName}」を本日の一覧から削除します。\nこの操作は元に戻せません。よろしいですか？\n\n※取引明細も一緒に削除されます。`);
  if (!confirmed) return;

  try {
    /** DELETE（CASCADE で transaction_items も削除される） */
    await deleteTransaction(txnId);
    console.log(`来館者を削除しました: txnId=${txnId}`);
  } catch (error) {
    console.error('削除に失敗しました:', error);
    showToast('削除に失敗しました');
  }

  /** テーブルを再描画 */
  renderVisitorTable();
  updateFooterButtons(false);
}

// ============================================
// トースト通知
// ============================================

// ============================================
// イベント委譲セットアップ
// ============================================

/**
 * 画面1のイベントリスナーを設定する（イベント委譲パターン）
 */
function initVisitorListEvents() {
  const tableBody = document.getElementById('visitor-table-body');
  if (!tableBody) return;

  /** テーブル内のクリックイベント（イベント委譲） */
  tableBody.addEventListener('click', (event) => {
    const target = event.target;

    /** [+] 商品追加ボタン */
    if (target.classList.contains('btn-add-item') || target.closest('.btn-add-item')) {
      const btn = target.closest('.btn-add-item') || target;
      const txnId = parseInt(btn.dataset.txnId, 10);
      showAddItemPopover(txnId, btn);
      event.stopPropagation();
      return;
    }

    /** 出席トグルボタン */
    if (target.classList.contains('toggle-attendance') || target.closest('.toggle-attendance')) {
      const btn = target.closest('.toggle-attendance') || target;
      const txnId = parseInt(btn.dataset.txnId, 10);
      toggleAttendance(txnId);
      event.stopPropagation();
      return;
    }

    /** 受取トグルボタン */
    if (target.classList.contains('toggle-received') || target.closest('.toggle-received')) {
      const btn = target.closest('.toggle-received') || target;
      const txnId = parseInt(btn.dataset.txnId, 10);
      toggleReceived(txnId);
      event.stopPropagation();
      return;
    }

    /** 決済方法ボタン（payment-selector内のボタンはshowPaymentSelectorで処理済み） */
    if (target.classList.contains('payment-method-btn')) {
      event.stopPropagation();
      return;
    }
  });

  /** インラインselect変更 */
  tableBody.addEventListener('change', (event) => {
    handleInlineSelectChange(event);
  });

  /** インラインメモのblur */
  tableBody.addEventListener('focusout', (event) => {
    if (event.target.classList.contains('input--inline-table')) {
      handleMemoChange(event);
    }
  });

  /** インラインメモのEnterキー */
  tableBody.addEventListener('keydown', (event) => {
    if (event.target.classList.contains('input--inline-table') && event.key === 'Enter') {
      event.preventDefault();
      event.target.blur();
    }
  });

  /** [削除] ボタン */
  const btnDelete = document.getElementById('btn-delete');
  if (btnDelete) {
    btnDelete.addEventListener('click', () => deleteSelectedVisitor());
  }

  /** 検索バーの初期化 */
  initSearch();

  /** [更新] ボタン — T5.4: SaaS同期パイプライン */
  initSaasSync();

  /** [CSV] ボタン — T4.1 */
  initCsvExport();

  console.log('来館者一覧のイベントリスナーを初期化しました');
}

