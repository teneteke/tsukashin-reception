/**
 * repository.js — つかしん窓口精算ツール データアクセス層
 *
 * 全てのドメイン固有のデータ操作をここに集約する。
 * UIモジュールは dbRun / dbQuery / dbGetOne を直接呼ばず、
 * このファイルの関数経由でデータにアクセスする。
 *
 * 依存: js/db.js（dbRun / dbQuery / dbGetOne / getSetting / upsertSetting / getTodayJST / getNowISO）
 */

// ============================================
// 会員（members）
// ============================================

/**
 * 会員IDで1件取得する
 * @param {string} memberId
 * @returns {Object|null} { id, name, phone, class, timeslot, memo }
 */
function getMemberById(memberId) {
  return dbGetOne(
    'SELECT id, name, phone, class, timeslot, memo FROM members WHERE id = ?',
    [memberId]
  );
}

/**
 * 会員名だけ取得する
 * @param {string} memberId
 * @returns {string|null}
 */
function getMemberName(memberId) {
  const row = dbGetOne('SELECT name FROM members WHERE id = ?', [memberId]);
  return row ? row.name : null;
}

/**
 * 会員を検索する（ID / 電話番号 / カタカナ名で統合検索）
 * @param {string} query - 検索文字列
 * @param {number} limit - 最大件数
 * @returns {Array<{id, name, name_kana, phone}>}
 */
function searchMembers(query, limit) {
  let results = [];

  /** ID前方一致 */
  const idResults = dbQuery(
    'SELECT id, name, name_kana, phone FROM members WHERE id LIKE ? LIMIT ?',
    [query + '%', limit]
  );
  results = results.concat(idResults);

  /** 電話番号前方一致（ID検索の結果を除外） */
  if (results.length < limit) {
    const excludeClause = results.length > 0
      ? 'AND id NOT IN (' + results.map(() => '?').join(',') + ')'
      : '';
    const excludeParams = results.map((r) => r.id);
    const phoneResults = dbQuery(
      'SELECT id, name, name_kana, phone FROM members WHERE phone LIKE ? ' +
      excludeClause + ' LIMIT ?',
      [query + '%', ...excludeParams, limit - results.length]
    );
    results = results.concat(phoneResults);
  }

  /** カタカナ名前方一致
   *  Phase 9 T9.7: 旧実装は '%query%' の両端ワイルドカードで idx_members_name_kana が効かず
   *  フルテーブルスキャンになっていた。id / phone と同じ前方一致に揃え、インデックスを活用する。
   *  UX 上の影響: 氏名途中からの部分一致（例: "タロウ" → "山田タロウ"）はヒットしなくなる。 */
  if (results.length < limit) {
    const excludeClause = results.length > 0
      ? 'AND id NOT IN (' + results.map(() => '?').join(',') + ')'
      : '';
    const excludeParams = results.map((r) => r.id);
    const kanaResults = dbQuery(
      'SELECT id, name, name_kana, phone FROM members WHERE name_kana LIKE ? ' +
      excludeClause + ' LIMIT ?',
      [query + '%', ...excludeParams, limit - results.length]
    );
    results = results.concat(kanaResults);
  }

  return results;
}

/**
 * 全クラスの一覧を取得する（DISTINCT）
 * @returns {string[]}
 */
function getDistinctClasses() {
  const rows = dbQuery(
    'SELECT DISTINCT class FROM members WHERE class IS NOT NULL AND class != "" ORDER BY class'
  );
  return rows.map((r) => r.class);
}

/**
 * 全時間枠の一覧を取得する（DISTINCT）
 * @returns {string[]}
 */
function getDistinctTimeslots() {
  const rows = dbQuery(
    'SELECT DISTINCT timeslot FROM members WHERE timeslot IS NOT NULL AND timeslot != "" ORDER BY timeslot'
  );
  return rows.map((r) => r.timeslot);
}

/**
 * 会員メモを更新する
 * @param {string} memberId
 * @param {string|null} memo
 */
async function updateMemberMemo(memberId, memo) {
  await dbRun(
    'UPDATE members SET memo = ?, updated_at = ? WHERE id = ?',
    [memo, getNowISO(), memberId]
  );
}

/**
 * ウォークイン会員を作成し、本日の取引も同時に作成する
 * @param {string} name - 会員名
 * @returns {Promise<string>} 生成されたウォークインID
 */
async function createWalkInWithTransaction(name, targetDate) {
  const today = targetDate || getTodayJST();
  const now = getNowISO();
  const dateCompact = today.replace(/-/g, '');
  const prefix = `W-${dateCompact}-`;

  const existingWalkIns = dbQuery(
    'SELECT id FROM members WHERE id LIKE ?',
    [prefix + '%']
  );

  const maxNum = existingWalkIns.reduce((max, w) => {
    const suffix = parseInt(w.id.split('-').pop(), 10);
    return isNaN(suffix) ? max : Math.max(max, suffix);
  }, 0);
  const nextNum = maxNum + 1;
  const walkInId = `${prefix}${String(nextNum).padStart(3, '0')}`;

  await dbRun(`
    INSERT INTO members (id, name, name_kana, phone, class, timeslot, is_temporary, memo, created_at, updated_at)
    VALUES (?, ?, NULL, NULL, NULL, NULL, 1, NULL, ?, ?)
  `, [walkInId, name, now, now]);

  await dbRun(`
    INSERT INTO transactions (date, member_id, member_name_snapshot, is_attended, is_received, created_at, updated_at)
    VALUES (?, ?, ?, 0, 0, ?, ?)
  `, [today, walkInId, name, now, now]);

  return walkInId;
}

// ============================================
// 取引（transactions）
// ============================================

/**
 * 本日の来館者一覧データを取得する（N+1解消済み）
 * items / lineTotal / payment_method_name を含む
 * @returns {Array<Object>}
 */
function getTodayVisitorList(targetDate) {
  const today = targetDate || getTodayJST();

  /** メインクエリ: transactions + members + items + payment_methods を一括JOIN */
  const rows = dbQuery(`
    SELECT
      t.id AS txn_id,
      t.date,
      t.member_id,
      t.member_name_snapshot,
      t.class_override,
      t.timeslot_override,
      t.payment_method_id,
      t.is_attended,
      t.is_received,
      t.memo AS txn_memo,
      m.class AS member_class,
      m.timeslot AS member_timeslot,
      pm.name AS payment_method_name,
      ti.product_code,
      ti.product_name_snapshot,
      ti.price_snapshot,
      ti.quantity
    FROM transactions t
    LEFT JOIN members m ON t.member_id = m.id
    LEFT JOIN payment_methods pm ON t.payment_method_id = pm.id
    LEFT JOIN transaction_items ti ON ti.transaction_id = t.id
    WHERE t.date = ?
    ORDER BY t.id ASC, ti.id ASC
  `, [today]);

  /** txn_id でグルーピング */
  const txnMap = new Map();
  for (const row of rows) {
    if (!txnMap.has(row.txn_id)) {
      txnMap.set(row.txn_id, {
        txn_id: row.txn_id,
        date: row.date,
        member_id: row.member_id,
        member_name_snapshot: row.member_name_snapshot,
        class_override: row.class_override,
        timeslot_override: row.timeslot_override,
        payment_method_id: row.payment_method_id,
        is_attended: row.is_attended,
        is_received: row.is_received,
        txn_memo: row.txn_memo,
        member_class: row.member_class,
        member_timeslot: row.member_timeslot,
        payment_method_name: row.payment_method_name || '',
        items: [],
        lineTotal: 0
      });
    }
    const txn = txnMap.get(row.txn_id);
    if (row.product_code != null) {
      const subtotal = Number(row.price_snapshot || 0) * Number(row.quantity || 0);
      txn.items.push({
        product_code: row.product_code,
        product_name_snapshot: row.product_name_snapshot,
        price_snapshot: row.price_snapshot,
        quantity: row.quantity
      });
      txn.lineTotal += subtotal;
    }
  }

  return Array.from(txnMap.values());
}

/**
 * 特定日の取引が既に存在するか確認する
 * @param {string} date - YYYY-MM-DD
 * @param {string} memberId
 * @returns {boolean}
 */
function hasTransactionForDate(date, memberId) {
  const row = dbGetOne(
    'SELECT 1 AS x FROM transactions WHERE date = ? AND member_id = ?',
    [date, memberId]
  );
  return !!row;
}

/**
 * 指定日の全予約（トランザクション）を、members JOIN で is_temporary も含めて取得する。
 * Phase 14 のマージ判定で、CSVに載っていないローカル行を自動削除するか保護するかを決める判断材料となる。
 * members が削除済みのトランザクション（孤児）は is_temporary=0 として扱う。
 * @param {string} date - YYYY-MM-DD
 * @returns {Array<{id:number, member_id:string, member_name_snapshot:string, is_attended:number, is_received:number, is_temporary:number}>}
 */
function getDateReservationsWithProtectionFlags(date) {
  return dbQuery(`
    SELECT
      t.id,
      t.member_id,
      t.member_name_snapshot,
      t.is_attended,
      t.is_received,
      COALESCE(m.is_temporary, 0) AS is_temporary
    FROM transactions t
    LEFT JOIN members m ON t.member_id = m.id
    WHERE t.date = ?
    ORDER BY t.id ASC
  `, [date]);
}

/**
 * 会員を本日の来館者として追加する
 * @param {string} memberId
 * @returns {Promise<void>}
 */
async function addMemberTransaction(memberId, targetDate) {
  const today = targetDate || getTodayJST();
  const now = getNowISO();
  const name = getMemberName(memberId);
  await dbRun(`
    INSERT INTO transactions (date, member_id, member_name_snapshot, is_attended, is_received, created_at, updated_at)
    VALUES (?, ?, ?, 0, 0, ?, ?)
  `, [today, memberId, name || memberId, now, now]);
}

/**
 * 出席状態を取得する
 * @param {number} txnId
 * @returns {Object|null} { is_attended }
 */
function getTransactionAttendance(txnId) {
  return dbGetOne('SELECT is_attended FROM transactions WHERE id = ?', [txnId]);
}

/**
 * 出席状態を切り替える
 * @param {number} txnId
 * @param {number} newValue - 0 or 1
 */
async function updateAttendance(txnId, newValue) {
  await dbRun(
    'UPDATE transactions SET is_attended = ?, updated_at = ? WHERE id = ?',
    [newValue, getNowISO(), txnId]
  );
}

/**
 * 受取状態を取得する
 * @param {number} txnId
 * @returns {Object|null} { is_received, payment_method_id }
 */
function getTransactionReceived(txnId) {
  return dbGetOne(
    'SELECT is_received, payment_method_id FROM transactions WHERE id = ?',
    [txnId]
  );
}

/**
 * 受取を解除する（is_received=0, payment_method_id=NULL）
 * @param {number} txnId
 */
async function clearReceived(txnId) {
  await dbRun(
    'UPDATE transactions SET is_received = 0, payment_method_id = NULL, updated_at = ? WHERE id = ?',
    [getNowISO(), txnId]
  );
}

/**
 * 受取済みにして決済方法を設定する
 * @param {number} txnId
 * @param {number} paymentMethodId
 */
async function setReceivedWithPayment(txnId, paymentMethodId) {
  await dbRun(
    'UPDATE transactions SET is_received = 1, payment_method_id = ?, updated_at = ? WHERE id = ?',
    [paymentMethodId, getNowISO(), txnId]
  );
}

/**
 * クラスオーバーライドを更新する
 * @param {number} txnId
 * @param {string} value
 */
async function updateClassOverride(txnId, value) {
  await dbRun(
    'UPDATE transactions SET class_override = ?, updated_at = ? WHERE id = ?',
    [value, getNowISO(), txnId]
  );
}

/**
 * 時間枠オーバーライドを更新する
 * @param {number} txnId
 * @param {string} value
 */
async function updateTimeslotOverride(txnId, value) {
  await dbRun(
    'UPDATE transactions SET timeslot_override = ?, updated_at = ? WHERE id = ?',
    [value, getNowISO(), txnId]
  );
}

/**
 * 取引メモを更新する
 * @param {number} txnId
 * @param {string} memo
 */
async function updateTransactionMemo(txnId, memo) {
  await dbRun(
    'UPDATE transactions SET memo = ?, updated_at = ? WHERE id = ?',
    [memo, getNowISO(), txnId]
  );
}

/**
 * 取引を削除する
 * @param {number} txnId
 */
async function deleteTransaction(txnId) {
  await dbRun('DELETE FROM transactions WHERE id = ?', [txnId]);
}

// ============================================
// 精算明細（transaction_items）
// ============================================

/**
 * 本日の精算明細を取得する（個人詳細画面用）
 * @param {string} memberId
 * @returns {Array<Object>}
 */
function getTodaySettlementItems(memberId) {
  const today = getTodayJST();
  return dbQuery(`
    SELECT
      t.id AS txn_id,
      t.date AS txn_date,
      t.payment_method_id,
      ti.id AS item_id,
      ti.product_code,
      ti.product_name_snapshot,
      ti.price_snapshot,
      ti.quantity,
      pm.name AS payment_method_name
    FROM transactions t
    LEFT JOIN transaction_items ti ON ti.transaction_id = t.id
    LEFT JOIN payment_methods pm ON t.payment_method_id = pm.id
    WHERE t.member_id = ?
      AND t.date = ?
    ORDER BY t.id ASC, ti.id ASC
  `, [memberId, today]);
}

/**
 * 期間の精算明細を取得する（期間履歴画面用）
 * @param {string} memberId
 * @param {string} dateFrom
 * @param {string} dateTo
 * @returns {Array<Object>}
 */
function getPeriodSettlementItems(memberId, dateFrom, dateTo) {
  return dbQuery(`
    SELECT
      t.id AS txn_id,
      t.date AS txn_date,
      t.payment_method_id,
      ti.id AS item_id,
      ti.product_code,
      ti.product_name_snapshot,
      ti.price_snapshot,
      ti.quantity,
      pm.name AS payment_method_name
    FROM transactions t
    LEFT JOIN transaction_items ti ON ti.transaction_id = t.id
    LEFT JOIN payment_methods pm ON t.payment_method_id = pm.id
    WHERE t.member_id = ?
      AND t.date >= ?
      AND t.date <= ?
    ORDER BY t.date ASC, t.id ASC, ti.id ASC
  `, [memberId, dateFrom, dateTo]);
}

/**
 * 期間の精算合計を取得する
 * @param {string} memberId
 * @param {string} dateFrom
 * @param {string} dateTo
 * @returns {number}
 */
function getSettlementTotal(memberId, dateFrom, dateTo) {
  const result = dbGetOne(`
    SELECT COALESCE(SUM(ti.price_snapshot * ti.quantity), 0) AS total
    FROM transactions t
    JOIN transaction_items ti ON ti.transaction_id = t.id
    WHERE t.member_id = ?
      AND t.date >= ?
      AND t.date <= ?
  `, [memberId, dateFrom, dateTo]);
  return result ? Number(result.total) : 0;
}

/**
 * 取引に商品を追加する（既存なら数量+1、なければ新規）
 * 取引がなければ自動作成する
 * @param {string} memberId
 * @param {Object} product - { code, name, price }
 * @returns {Promise<void>}
 */
async function addItemToMemberToday(memberId, product, targetDate) {
  const today = targetDate || getTodayJST();
  const now = getNowISO();

  /** Phase 9 T9.9: 最大4回の dbRun（INSERT transaction / 再SELECT / INSERT or UPDATE item）を
   *  単一トランザクションにまとめて OPFS 書き込みを1回に圧縮する。 */
  await withTransaction(async () => {
    /** 既存取引を検索、なければ作成 */
    let txn = dbGetOne(
      'SELECT id FROM transactions WHERE date = ? AND member_id = ? ORDER BY id DESC LIMIT 1',
      [today, memberId]
    );

    if (!txn) {
      const memberName = getMemberName(memberId);
      await dbRun(`
        INSERT INTO transactions (date, member_id, member_name_snapshot, is_attended, is_received, created_at, updated_at)
        VALUES (?, ?, ?, 0, 0, ?, ?)
      `, [today, memberId, memberName || memberId, now, now]);
      /** last_insert_rowid() で直前の自動採番 ID を取得（再SELECT を省略） */
      const lastIdRow = dbGetOne('SELECT last_insert_rowid() AS id');
      txn = { id: lastIdRow.id };
    }

    /** 既存明細を検索 */
    const existingItem = dbGetOne(
      'SELECT id, quantity FROM transaction_items WHERE transaction_id = ? AND product_code = ?',
      [txn.id, product.code]
    );

    if (existingItem) {
      await dbRun(
        'UPDATE transaction_items SET quantity = quantity + 1 WHERE id = ?',
        [existingItem.id]
      );
    } else {
      await dbRun(`
        INSERT INTO transaction_items (transaction_id, product_code, product_name_snapshot, price_snapshot, quantity)
        VALUES (?, ?, ?, ?, 1)
      `, [txn.id, product.code, product.name, product.price]);
    }
  });
}

/**
 * 明細の数量を更新する
 * @param {number} itemId
 * @param {number} newQty
 */
async function updateItemQuantity(itemId, newQty) {
  await dbRun(
    'UPDATE transaction_items SET quantity = ? WHERE id = ?',
    [newQty, itemId]
  );
}

/**
 * 明細を削除する
 * @param {number} itemId
 */
async function deleteTransactionItem(itemId) {
  await dbRun('DELETE FROM transaction_items WHERE id = ?', [itemId]);
}

// ============================================
// 商品（products）
// ============================================

/**
 * 全商品を取得する（有効→無効の順）
 * @returns {Array<Object>}
 */
function getAllProducts() {
  return dbQuery(
    'SELECT code, name, category, price, is_provisional, is_active FROM products ORDER BY is_active DESC, code ASC'
  );
}

/**
 * 商品コードで検索する（完全一致 → 前方一致のフォールバック）
 * @param {string} code
 * @returns {Object|null} { code, name, price, is_active }
 */
function lookupProduct(code) {
  /** ゼロ埋め3桁の完全一致 */
  const padded = code.padStart(3, '0');
  const exact = dbGetOne(
    'SELECT code, name, price, is_active FROM products WHERE code = ? AND is_active = 1',
    [padded]
  );
  if (exact) return exact;

  /** 前方一致フォールバック */
  return dbGetOne(
    'SELECT code, name, price, is_active FROM products WHERE code LIKE ? AND is_active = 1 ORDER BY code ASC LIMIT 1',
    [code + '%']
  );
}

/**
 * 商品コードが存在するか確認する
 * @param {string} code
 * @returns {boolean}
 */
function productCodeExists(code) {
  return !!dbGetOne('SELECT code FROM products WHERE code = ?', [code]);
}

/**
 * 商品を新規作成する（仮登録）
 * @param {Object} product - { code, name, category, price }
 */
async function createProduct(product) {
  const now = getNowISO();
  await dbRun(`
    INSERT INTO products (code, name, category, price, is_provisional, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 1, ?, ?)
  `, [product.code, product.name, product.category, product.price, now, now]);
}

/**
 * 商品のフィールドを更新する
 * @param {string} code
 * @param {string} column - 'name' | 'category' | 'price'
 * @param {*} value
 */
async function updateProductField(code, column, value) {
  const allowed = ['name', 'category', 'price'];
  if (!allowed.includes(column)) {
    throw new Error('更新不可のカラムです: ' + column);
  }
  await dbRun(
    `UPDATE products SET ${column} = ?, updated_at = ? WHERE code = ?`,
    [value, getNowISO(), code]
  );
}

/**
 * 商品の有効/無効を取得する
 * @param {string} code
 * @returns {Object|null} { is_active, name }
 */
function getProductStatus(code) {
  return dbGetOne('SELECT is_active, name FROM products WHERE code = ?', [code]);
}

/**
 * 商品の有効/無効を切り替える
 * @param {string} code
 * @param {number} isActive - 0 or 1
 */
async function setProductActive(code, isActive) {
  await dbRun(
    'UPDATE products SET is_active = ?, updated_at = ? WHERE code = ?',
    [isActive, getNowISO(), code]
  );
}

// ============================================
// 決済方法（payment_methods）
// ============================================

/**
 * 有効な決済方法一覧を取得する
 * @returns {Array<{id, name}>}
 */
function getActivePaymentMethods() {
  return dbQuery(
    'SELECT id, name FROM payment_methods WHERE is_active = 1 ORDER BY sort_order'
  );
}

// ============================================
// 領収書（receipt_log）
// ============================================

/**
 * 次の領収書番号を生成する（会計年度ベース、MAX+1方式）
 * @returns {string} "YYYY-NNNN" 形式
 */
function getNextReceiptNumber() {
  const fiscalYear = getJSTFiscalYear();
  const prefix = `${fiscalYear}-`;

  const result = dbGetOne(
    'SELECT MAX(CAST(SUBSTR(receipt_number, 6) AS INTEGER)) AS max_suffix FROM receipt_log WHERE receipt_number LIKE ?',
    [prefix + '%']
  );

  const nextSuffix = (result && result.max_suffix ? result.max_suffix : 0) + 1;
  return `${prefix}${String(nextSuffix).padStart(4, '0')}`;
}

/**
 * 領収書データを取得する（PDF生成用）
 * @param {string} memberId
 * @param {string} dateFrom
 * @param {string} dateTo
 * @returns {Object}
 */
function gatherReceiptData(memberId, dateFrom, dateTo) {
  const items = dbQuery(`
    SELECT
      t.date AS txn_date,
      ti.product_code,
      ti.product_name_snapshot,
      ti.price_snapshot,
      ti.quantity,
      p.category AS category
    FROM transactions t
    JOIN transaction_items ti ON ti.transaction_id = t.id
    LEFT JOIN products p ON p.code = ti.product_code
    WHERE t.member_id = ?
      AND t.date >= ?
      AND t.date <= ?
    ORDER BY t.date ASC, ti.id ASC
  `, [memberId, dateFrom, dateTo]);

  const totalAmount = Math.round(
    items.reduce((sum, i) => sum + Number(i.price_snapshot || 0) * Number(i.quantity || 0), 0)
  );

  const issuerName = getSetting('receipt_issuer') || 'テニスラウンジつかしん';
  const issuerAddress = getSetting('receipt_issuer_address') || '';
  const issuerPhone = getSetting('receipt_issuer_phone') || '';
  const issuerInvoiceNumber = getSetting('receipt_issuer_invoice_number') || '';

  return { items, totalAmount, issuerName, issuerAddress, issuerPhone, issuerInvoiceNumber };
}

/**
 * 領収書発行記録を保存する
 * @param {Object} record
 */
async function insertReceiptLog(record) {
  await dbRun(`
    INSERT INTO receipt_log
      (receipt_number, member_id, recipient_name, date_from, date_to,
       total_amount, description, issuer, issued_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    record.receiptNumber,
    record.memberId,
    record.recipientName,
    record.dateFrom,
    record.dateTo,
    record.totalAmount,
    record.description,
    record.issuerName,
    record.issuedAt
  ]);
}

/**
 * 会員の最新領収書発行履歴を取得する
 * @param {string} memberId
 * @returns {Object|null}
 */
function getLastReceipt(memberId) {
  return dbGetOne(`
    SELECT receipt_number, total_amount, issued_at
    FROM receipt_log
    WHERE member_id = ?
    ORDER BY issued_at DESC
    LIMIT 1
  `, [memberId]);
}

// ============================================
// CSVエクスポート用データ取得
// ============================================

/**
 * 精算データをCSV出力用に取得する
 * @param {string} dateFrom
 * @param {string} dateTo
 * @returns {Array<Object>}
 */
function getSettlementExportData(dateFrom, dateTo) {
  return dbQuery(`
    SELECT
      t.date AS date,
      t.member_id AS member_id,
      t.member_name_snapshot AS member_name,
      ti.product_code AS product_code,
      ti.product_name_snapshot AS product_name,
      ti.price_snapshot AS price,
      ti.quantity AS quantity,
      (ti.price_snapshot * ti.quantity) AS line_total,
      COALESCE(pm.name, '') AS payment_method,
      t.is_received AS is_received
    FROM transactions t
    LEFT JOIN transaction_items ti ON ti.transaction_id = t.id
    LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
    WHERE t.date >= ? AND t.date <= ?
    ORDER BY t.date ASC, t.id ASC, ti.id ASC
  `, [dateFrom, dateTo]);
}
