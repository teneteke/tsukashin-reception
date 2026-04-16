/**
 * product-master.js — つかしん窓口精算ツール 商品マスタ管理モジュール
 *
 * 画面2の商品マスタセクションを担当する:
 * - T3.4 商品マスタの新規作成（仮登録）
 *        商品マスタの一覧表示とインライン編集
 *        ソフト削除（is_active フラグ）
 */

// ============================================
// T3.4 商品マスタ描画
// ============================================

/**
 * 商品マスタの一覧を描画する
 * アクティブな商品が先、無効な商品は薄く表示
 */
function renderProductMasterTable() {
  const tbody = document.getElementById('product-master-body');
  if (!tbody) return;

  /** すべての商品を取得（アクティブ優先、コード昇順） */
  const products = getAllProducts();

  tbody.innerHTML = '';

  for (const p of products) {
    const row = document.createElement('tr');
    row.dataset.code = p.code;
    if (!p.is_active) {
      row.classList.add('product-row--inactive');
    }

    /** 状態バッジ */
    let statusBadge = '';
    if (!p.is_active) {
      statusBadge += '<span class="product-status product-status--inactive">無効</span>';
    } else if (p.is_provisional) {
      statusBadge += '<span class="product-status product-status--provisional">仮</span>';
    } else {
      statusBadge += '<span class="product-status product-status--active">有効</span>';
    }

    row.innerHTML = `
      <td>${escapeHtml(p.code)}</td>
      <td>
        <input type="text" class="input input--inline-table product-master-field"
               data-code="${escapeHtml(p.code)}" data-field="name"
               value="${escapeHtml(p.name)}">
      </td>
      <td>
        <input type="text" class="input input--inline-table product-master-field"
               data-code="${escapeHtml(p.code)}" data-field="category"
               value="${escapeHtml(p.category)}">
      </td>
      <td class="td-right">
        <input type="number" class="input input--inline-table product-master-field product-master-field--price"
               data-code="${escapeHtml(p.code)}" data-field="price"
               value="${p.price}" min="0">
      </td>
      <td>
        ${statusBadge}
        <button type="button" class="btn--inline-toggle" data-code="${escapeHtml(p.code)}">
          ${p.is_active ? '無効化' : '有効化'}
        </button>
      </td>
    `;

    tbody.appendChild(row);
  }

  if (tbody.children.length === 0) {
    const row = document.createElement('tr');
    row.className = 'empty-row';
    row.innerHTML = `<td colspan="5">商品が登録されていません</td>`;
    tbody.appendChild(row);
  }
}

// ============================================
// T3.4 商品マスタ新規作成
// ============================================

/**
 * 商品マスタ新規作成フォームの送信を処理する
 * @param {Event} event - submitイベント
 */
async function handleProductFormSubmit(event) {
  event.preventDefault();

  const codeEl = document.getElementById('product-code');
  const nameEl = document.getElementById('product-name');
  const categoryEl = document.getElementById('product-category');
  const priceEl = document.getElementById('product-price');

  if (!codeEl || !nameEl || !categoryEl || !priceEl) return;

  const code = codeEl.value.trim();
  const name = nameEl.value.trim();
  const category = categoryEl.value.trim();
  const priceStr = priceEl.value.trim();
  const price = parseInt(priceStr, 10);

  /** 入力検証 */
  if (!code || !name || !category || !priceStr) {
    showToast('すべての項目を入力してください');
    return;
  }
  if (!Number.isInteger(price) || price < 0) {
    showToast('金額は0以上の整数で入力してください');
    return;
  }

  /** コード重複チェック */
  if (productCodeExists(code)) {
    showToast(`コード「${code}」は既に登録されています`);
    return;
  }

  /** INSERT（仮登録） */
  try {
    await createProduct({ code, name, category, price });
  } catch (error) {
    console.error('商品の登録に失敗しました:', error);
    showToast('商品の登録に失敗しました');
    return;
  }

  console.log(`商品を仮登録しました: ${code} ${name} ¥${price}`);

  /** フォームをクリアし、テーブルを再描画 */
  codeEl.value = '';
  nameEl.value = '';
  categoryEl.value = '';
  priceEl.value = '';

  renderProductMasterTable();
  showToast(`「${name}」を仮登録しました`);
}

// ============================================
// T3.4 商品マスタ編集（インライン）
// ============================================

/**
 * 商品マスタのフィールド変更を保存する
 * @param {Event} event - focusout / change イベント
 */
async function handleProductMasterFieldChange(event) {
  const input = event.target;
  if (!input.classList.contains('product-master-field')) return;

  /** 値が変更されていなければDB書き込みをスキップ */
  if (input.dataset.originalValue !== undefined && input.value === input.dataset.originalValue) {
    return;
  }

  const code = input.dataset.code;
  const field = input.dataset.field;
  if (!code || !field) return;

  let value = input.value.trim();

  if (field === 'price') {
    const priceInt = parseInt(value, 10);
    if (!Number.isInteger(priceInt) || priceInt < 0) {
      showToast('金額は0以上の整数で入力してください');
      renderProductMasterTable();
      return;
    }
    value = priceInt;
  } else {
    /** 名称・カテゴリは必須 */
    if (!value) {
      showToast(`${field === 'name' ? '名称' : 'カテゴリ'}は空にできません`);
      renderProductMasterTable();
      return;
    }
  }

  /** フィールド名とSQLのマッピング */
  const fieldColumnMap = {
    name: 'name',
    category: 'category',
    price: 'price',
  };

  const column = fieldColumnMap[field];
  if (!column) return;

  try {
    await updateProductField(code, column, value);
  } catch (error) {
    console.error('変更の保存に失敗しました:', error);
    showToast('変更の保存に失敗しました');
    renderProductMasterTable();
    return;
  }

  console.log(`商品マスタを更新しました: ${code} ${field}=${value}`);
}

/**
 * 商品のアクティブ状態をトグル（ソフト削除）する
 * @param {string} code - 商品コード
 */
async function toggleProductActive(code) {
  const product = getProductStatus(code);
  if (!product) return;

  /** 無効化（削除相当）のときのみ確認ダイアログ。有効化は即時 */
  if (product.is_active) {
    const confirmed = await window.confirmAction(
      '商品の無効化',
      `「${product.name}」を無効化します。\nこの商品は今後の明細追加で選べなくなります。\nよろしいですか？\n\n※過去の明細スナップショットはそのまま残ります。`
    );
    if (!confirmed) return;
  }

  const newValue = product.is_active ? 0 : 1;

  try {
    await setProductActive(code, newValue);
  } catch (error) {
    console.error('状態の変更に失敗しました:', error);
    showToast('状態の変更に失敗しました');
    return;
  }

  console.log(`商品のアクティブ状態を変更しました: ${code} is_active=${newValue}`);
  renderProductMasterTable();

  showToast(newValue ? `「${product.name}」を有効化しました` : `「${product.name}」を無効化しました`);
}

// ============================================
// イベント委譲セットアップ
// ============================================

/**
 * 商品マスタのイベントリスナーを設定する
 */
function initProductMasterEvents() {
  /** 新規作成フォーム */
  const form = document.getElementById('product-form');
  if (form) {
    form.addEventListener('submit', handleProductFormSubmit);
  }

  /** 商品マスタテーブルのイベント委譲 */
  const tbody = document.getElementById('product-master-body');
  if (tbody) {
    /** インライン編集のフォーカスイン時に元の値を保存 */
    tbody.addEventListener('focusin', (event) => {
      const target = event.target;
      if (target.classList.contains('product-master-field')) {
        target.dataset.originalValue = target.value;
      }
    });

    /** インライン編集のblur保存 */
    tbody.addEventListener('focusout', (event) => {
      if (event.target.classList.contains('product-master-field')) {
        handleProductMasterFieldChange(event);
      }
    });

    /** Enter キーで blur（保存確定） */
    tbody.addEventListener('keydown', (event) => {
      if (event.target.classList.contains('product-master-field') && event.key === 'Enter') {
        event.preventDefault();
        event.target.blur();
      }
    });

    /** 有効化/無効化ボタン */
    tbody.addEventListener('click', (event) => {
      const target = event.target;
      if (target.classList.contains('btn--inline-toggle')) {
        const code = target.dataset.code;
        if (code) toggleProductActive(code);
      }
    });
  }

  console.log('商品マスタのイベントリスナーを初期化しました');
}
