/**
 * sync.js — つかしん窓口精算ツール SaaS同期モジュール
 *
 * SaaSデータ（CSV）と ローカルDB の唯一の翻訳層。
 * 会員マスタ、決済方法、予約リストのCSV取り込みを司る。
 * 他のモジュールはこのファイル経由でしか members / payment_methods /
 * 予約用 transactions 行に書き込みを行わない。
 *
 * 依存: js/db.js（dbRun / dbQuery / dbGetOne / getTodayJST / getNowISO）
 */

// ============================================
// カラムエイリアステーブル
// ============================================

/**
 * 会員CSVの列名エイリアス
 * SaaSの列名ゆれを吸収するために、各論理フィールドに対して
 * 受け入れ可能な列名のリストを持つ。マッチは大文字小文字無視・前後空白除去。
 */
const MEMBER_COLUMN_ALIASES = {
  id:        ['会員ID', '会員id', 'ID', 'id', 'member_id', 'memberid', '会員番号'],
  name:      ['氏名', '名前', 'name', '会員名'],
  name_kana: ['カナ', 'フリガナ', 'ふりがな', 'name_kana', 'kana', 'カナ氏名'],
  phone:     ['電話番号', 'TEL', 'tel', '電話', 'phone', 'phone_number'],
  class:     ['クラス', 'class', 'クラス名'],
  timeslot:  ['時間枠', '時間帯', 'timeslot', 'time_slot']
};

/**
 * 決済方法CSVの列名エイリアス
 */
const PAYMENT_METHOD_COLUMN_ALIASES = {
  name:       ['決済方法', '支払方法', '名称', 'name', '決済'],
  sort_order: ['ソート順', '並び順', 'sort_order', 'order']
};

/**
 * 予約CSVの列名エイリアス
 */
const RESERVATION_COLUMN_ALIASES = {
  member_id: ['会員ID', '会員id', 'ID', 'id', 'member_id', '会員番号'],
  date:      ['日付', '予約日', 'date', '来館日']
};

/**
 * 売上明細CSV（Phase 18）の列名エイリアス。
 * SaaS (HiTouch) の売上明細CSVが持つ10列を吸収する。
 * 必須列（status, sale_date, member_name, item_description）が揃えば
 * 種別判定が sales ルートに入る。任意列（staff_name, paid_or_refund, remark）は
 * 取り込めれば使う／なければ空として扱う。
 */
const SALES_COLUMN_ALIASES = {
  status:           ['ステータス', 'status', '状態', '入金ステータス'],
  sale_date:        ['売上日', '日付', 'date', 'sale_date', '売上日付', '取引日'],
  member_name:      ['会員名', '氏名', 'name', 'member_name', '顧客名', 'お客様名'],
  item_description: ['明細', '内容', 'item', 'description', '明細内容', '品名'],
  sale_category:    ['売上種別', '種別', 'category', 'sale_category', '区分', 'type'],
  sale_amount:      ['売上金額', '金額', 'amount', 'sale_amount', '売上', '税込金額'],
  payment_method:   ['支払方法', '決済方法', 'payment', 'payment_method', '決済'],
  staff_name:       ['担当者', 'staff', 'staff_name', '担当', 'スタッフ'],
  paid_or_refund:   ['入金/返金', '入金返金', '入返金', 'paid_or_refund', '区分(入返金)'],
  remark:           ['備考', 'remark', 'remarks', 'note', 'notes', 'メモ']
};

// ============================================
// 内部ユーティリティ
// ============================================

/**
 * ヘッダ配列と論理フィールド名を受け取り、該当する列インデックスを返す
 * @param {string[]} headers - CSVのヘッダ行
 * @param {string[]} aliases - 論理フィールドに対するエイリアス配列
 * @returns {number} 見つかった列インデックス、見つからなければ -1
 */
function findColumnIndex(headers, aliases) {
  const normalized = headers.map((h) => (h || '').trim().toLowerCase());
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias.trim().toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * 論理フィールド名をキーとした列インデックスのマップを作成する
 * 見つからなかったフィールドの値は -1 になる
 * @param {string[]} headers - CSVのヘッダ行
 * @param {Object<string, string[]>} aliasTable - エイリアステーブル
 * @returns {Object<string, number>} フィールド名 → インデックス
 */
function buildColumnMap(headers, aliasTable) {
  const map = {};
  for (const [field, aliases] of Object.entries(aliasTable)) {
    map[field] = findColumnIndex(headers, aliases);
  }
  return map;
}

/**
 * 行配列から指定列の値を取得し、トリムして返す
 * 列が見つからない場合や値がundefinedの場合は空文字を返す
 * @param {string[]} row - データ行
 * @param {number} index - 列インデックス（-1で未マッピング）
 * @returns {string} トリム済みの値（未マッピングまたは未定義時は ''）
 */
/** CSV入力フィールドの最大文字数 */
const MAX_FIELD_LENGTH = 255;

/** 日付フォーマット検証用正規表現 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function getFieldValue(row, index) {
  if (index === -1) return '';
  const v = row[index];
  if (v === null || v === undefined) return '';
  const trimmed = String(v).trim();
  return trimmed.length > MAX_FIELD_LENGTH ? trimmed.slice(0, MAX_FIELD_LENGTH) : trimmed;
}

/**
 * ヘッダ集合がエイリアステーブルの必須フィールドをすべて含むかを判定する
 * 判定に使う必須フィールド名のリストは呼び出し側が指定する
 * @param {string[]} headers - CSVのヘッダ行
 * @param {Object<string, string[]>} aliasTable - エイリアステーブル
 * @param {string[]} requiredFields - 必須フィールド名
 * @returns {boolean} 必須がすべてマッチしたら true
 */
function headersMatchAliasTable(headers, aliasTable, requiredFields) {
  for (const field of requiredFields) {
    const aliases = aliasTable[field];
    if (!aliases) return false;
    if (findColumnIndex(headers, aliases) === -1) return false;
  }
  return true;
}

// ============================================
// CSV種別判定（T5.4）
// ============================================

/**
 * CSVのヘッダ行を見て、どの種別の同期に使うかを判定する
 *
 * 判定順:
 *   1. sales: status + sale_date + member_name + item_description の4列すべて解決できる
 *      （最も識別性が高い4列必須なので誤判定しにくく、先に判定する）
 *   2. member: id と name がどちらも解決できる
 *   3. payment: name が解決できる（id は存在しない想定）
 *   4. reservation: member_id が解決できる
 *   5. それ以外は unknown
 *
 * member_id の alias は id を含むため、member を sales の後かつ reservation の前に判定し、
 * 氏名列を持つ会員CSVが予約CSVに誤分類されるのを防ぐ。
 * 売上明細CSVは「明細」列を含むため、会員CSV・予約CSVと確実に区別できる。
 *
 * @param {string[]} headers - CSVのヘッダ行
 * @returns {'sales'|'member'|'payment'|'reservation'|'unknown'}
 */
function detectCsvKind(headers) {
  /** 4列必須の sales を最初に判定することで他種別との衝突を避ける */
  if (headersMatchAliasTable(headers, SALES_COLUMN_ALIASES, ['status', 'sale_date', 'member_name', 'item_description'])) {
    return 'sales';
  }
  if (headersMatchAliasTable(headers, MEMBER_COLUMN_ALIASES, ['id', 'name'])) {
    return 'member';
  }
  /** 注意: 決済方法CSVは「名称」列のみで判定するため、同名列を持つ
   *  別種CSVを誤判定する可能性がある。SaaSの実CSVで列名が確定後に改善すること。 */
  if (headersMatchAliasTable(headers, PAYMENT_METHOD_COLUMN_ALIASES, ['name'])) {
    return 'payment';
  }
  if (headersMatchAliasTable(headers, RESERVATION_COLUMN_ALIASES, ['member_id'])) {
    return 'reservation';
  }
  return 'unknown';
}

// ============================================
// 会員マスタ同期（T5.1）
// ============================================

/**
 * 会員CSVの解析済み行を DB に取り込む
 *
 * 処理内容:
 *   1. 既存の非一時会員の memo を id → memo の Map に退避
 *   2. 非一時会員を全削除
 *   3. CSV行を1件ずつ INSERT（memo はマップから復元）
 *   4. settings.last_member_sync を現在JSTで更新
 *
 * 一時会員（is_temporary=1）は一切触らない。
 * transactions / transaction_items の履歴スナップショットも保護される。
 *
 * @param {string[]} headers - CSVのヘッダ行
 * @param {string[][]} rows - CSVのデータ行（ヘッダを除く）
 * @returns {Promise<{ updated: number, skipped: number }>} 更新件数とスキップ件数
 */
async function syncMembersFromCsv(headers, rows) {
  const columnMap = buildColumnMap(headers, MEMBER_COLUMN_ALIASES);

  /** id と name は必須（どちらかでもヘッダにマッピングできない場合は全件失敗扱い） */
  if (columnMap.id === -1 || columnMap.name === -1) {
    throw new Error('会員CSVに必須列（会員ID, 氏名）が見つかりませんでした');
  }

  /** 既存の非一時会員の memo を退避（読み取りのみなので transaction 外で実行） */
  const memoMap = new Map();
  const existing = dbQuery(
    'SELECT id, memo FROM members WHERE is_temporary = 0'
  );
  for (const m of existing) {
    if (m.memo !== null && m.memo !== undefined && m.memo !== '') {
      memoMap.set(m.id, m.memo);
    }
  }

  const now = getNowISO();
  let updated = 0;
  let skipped = 0;

  /** DELETE → INSERT ループ → last_member_sync UPDATE を単一トランザクションに統合（Phase 9 T9.2）。
   *  これにより OPFS 書き込みは commit 後の1回のみになり、途中失敗時には全体が ROLLBACK される。
   *  個別 INSERT 失敗（PK 重複など）は従来通り per-row catch でスキップ扱い。statement レベルの
   *  エラーはトランザクションを中断しないため、残りの行は引き続き処理される。 */
  await withTransaction(async () => {
    await dbRun('DELETE FROM members WHERE is_temporary = 0');

    for (const row of rows) {
      const id = getFieldValue(row, columnMap.id);
      const name = getFieldValue(row, columnMap.name);

      /** id か name が空の行はスキップ */
      if (!id || !name) {
        skipped++;
        continue;
      }

      const nameKana = getFieldValue(row, columnMap.name_kana) || null;
      const phone = getFieldValue(row, columnMap.phone) || null;
      const cls = getFieldValue(row, columnMap.class) || null;
      const timeslot = getFieldValue(row, columnMap.timeslot) || null;
      const memo = memoMap.has(id) ? memoMap.get(id) : null;

      try {
        await dbRun(
          `INSERT INTO members
           (id, name, name_kana, phone, class, timeslot, is_temporary, memo, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          [id, name, nameKana, phone, cls, timeslot, memo, now, now]
        );
        updated++;
      } catch (error) {
        console.error('会員行のINSERTに失敗:', error.message, 'id=' + id);
        skipped++;
      }
    }

    /** last_member_sync を更新（同じトランザクションに含める） */
    await dbRun(
      'UPDATE settings SET value = ? WHERE key = ?',
      [now, 'last_member_sync']
    );
  });

  console.log(`会員同期完了: 更新 ${updated} 件, スキップ ${skipped} 件`);
  return { updated, skipped };
}

// ============================================
// 決済方法同期（T5.2）
// ============================================

/**
 * 決済方法CSVの解析済み行を DB に取り込む
 *
 * 処理方針:
 *   - CSV に含まれる決済方法は name で INSERT（新規） または UPDATE（既存、is_active=1 に戻す）
 *   - CSV に含まれない既存決済方法:
 *       - transactions から参照されている場合は 有効のまま保護する（protected）
 *       - 参照されていない場合は is_active=0 に落とす（deactivated）
 *   - CSV側の重複（同一名）は最初の1件のみ採用
 *
 * sort_order が無い場合は行インデックス（1始まり）をフォールバックとして使用する。
 *
 * @param {string[]} headers - CSVのヘッダ行
 * @param {string[][]} rows - CSVのデータ行（ヘッダを除く）
 * @returns {Promise<{ updated: number, deactivated: number, protected: number }>}
 */
async function syncPaymentMethodsFromCsv(headers, rows) {
  const columnMap = buildColumnMap(headers, PAYMENT_METHOD_COLUMN_ALIASES);

  if (columnMap.name === -1) {
    throw new Error('決済方法CSVに必須列（決済方法 または name）が見つかりませんでした');
  }

  /** CSV側の取り込み対象を name → sort_order で収集（重複は最初の1件） */
  const incoming = new Map();
  rows.forEach((row, idx) => {
    const name = getFieldValue(row, columnMap.name);
    if (!name) return;
    if (incoming.has(name)) return;

    let sortOrder;
    if (columnMap.sort_order !== -1) {
      const raw = getFieldValue(row, columnMap.sort_order);
      const parsed = parseInt(raw, 10);
      sortOrder = Number.isFinite(parsed) ? parsed : idx + 1;
    } else {
      sortOrder = idx + 1;
    }

    incoming.set(name, sortOrder);
  });

  let updated = 0;
  let deactivated = 0;
  let protectedCount = 0;

  /** 既存の決済方法を一覧取得（読み取りのみ、transaction 外で実行） */
  const existing = dbQuery('SELECT id, name, is_active FROM payment_methods');
  const existingByName = new Map(existing.map((p) => [p.name, p]));

  /** 参照中の payment_method_id 集合を1 SELECT で取得（旧実装は未採用方法ごとの N+1 probe だった）。
   *  Phase 9 T9.4: transaction に入る前に読み取りを済ませておく。 */
  const referencedRows = dbQuery(
    'SELECT DISTINCT payment_method_id FROM transactions WHERE payment_method_id IS NOT NULL'
  );
  const referencedIds = new Set(referencedRows.map((r) => r.payment_method_id));

  /** 書き込み群は単一トランザクションに統合（Phase 9 T9.4）。
   *  commit 後の OPFS 書き込みは1回のみ。 */
  await withTransaction(async () => {
    /** 取り込み: INSERT or UPDATE（is_active=1 に戻す） */
    for (const [name, sortOrder] of incoming.entries()) {
      if (existingByName.has(name)) {
        const row = existingByName.get(name);
        await dbRun(
          'UPDATE payment_methods SET is_active = 1, sort_order = ? WHERE id = ?',
          [sortOrder, row.id]
        );
      } else {
        await dbRun(
          'INSERT INTO payment_methods (name, is_active, sort_order) VALUES (?, 1, ?)',
          [name, sortOrder]
        );
      }
      updated++;
    }

    /** CSVに含まれない既存方法の扱い（参照あり→保護、参照なし→無効化） */
    for (const p of existing) {
      if (incoming.has(p.name)) continue;

      if (referencedIds.has(p.id)) {
        /** 参照があるなら保護（何もしない） */
        protectedCount++;
      } else {
        /** 参照が無いなら無効化（既に無効なものはカウントしない） */
        if (p.is_active === 1) {
          await dbRun(
            'UPDATE payment_methods SET is_active = 0 WHERE id = ?',
            [p.id]
          );
          deactivated++;
        }
      }
    }
  });

  console.log(
    `決済方法同期完了: 更新 ${updated} 件, 無効化 ${deactivated} 件, 保護 ${protectedCount} 件`
  );
  return { updated, deactivated, protected: protectedCount };
}

// ============================================
// 予約リスト同期（T5.3）
// ============================================

/**
 * 予約CSVの解析済み行を DB に取り込む
 *
 * 実行順序:
 *   1. CSVを走査して追加予定・既存・未登録を事前集計する（DB書き込みなし）
 *   2. confirm() で追加件数・既存件数・未登録件数を表示してユーザー確認
 *   3. OK のときだけ transactions に INSERT する
 *   4. キャンセル時は DB に一切触らず { confirmed: false } を返す
 *
 * 予約された会員が members に存在しない場合:
 *   - notInMaster を加算し unknownIds に id を積む
 *   - 呼び出し側がサマリに表示するためのリストとして返す
 *
 * @param {string[]} headers - CSVのヘッダ行
 * @param {string[][]} rows - CSVのデータ行
 * @param {string} [targetDate] - 予約対象日（YYYY-MM-DD）。省略時は今日(JST)
 * @returns {Promise<{
 *   confirmed: boolean,
 *   added: number,
 *   alreadyExists: number,
 *   notInMaster: number,
 *   unknownIds: string[]
 * }>}
 */
/**
 * 予約CSV行を分類する（DB書き込みなし）
 * 各行を「追加予定」「既存」「未登録会員」に振り分ける
 * @param {string[][]} rows - パース済みCSVデータ行
 * @param {Object} columnMap - 列マッピング
 * @param {string} defaultDate - デフォルト日付（YYYY-MM-DD）
 * @returns {{ toAdd: Array, unknownIds: string[], alreadyExists: number }}
 */
function classifyReservationRows(rows, columnMap, defaultDate) {
  const toAdd = [];
  const unknownIds = [];
  let alreadyExists = 0;

  /** Phase 9 T9.6: 会員・既存取引を一度だけ一括ロードして Map 化する。
   *  旧実装は各 CSV 行ごとに dbGetOne を2回呼んでいたため、行数 M に対して 2M の DB 往復が
   *  発生していた（500行なら1000回）。ここではまず行から必要な memberId と日付を抽出し、
   *  会員 Map を1クエリ、既存取引 Map を1クエリで作成する。ループ内の処理は Map ルックアップのみ。 */

  /** まず全行を走査して必要なキー集合を作る（DB アクセスなし） */
  const neededMemberIds = new Set();
  const neededDates = new Set();
  for (const row of rows) {
    const memberId = getFieldValue(row, columnMap.member_id);
    if (!memberId) continue;
    const rawDate = getFieldValue(row, columnMap.date);
    if (rawDate && !DATE_PATTERN.test(rawDate)) continue;
    const rowDate = rawDate || defaultDate;
    neededMemberIds.add(memberId);
    neededDates.add(rowDate);
  }

  /** 会員 Map を一括取得: WHERE id IN (?, ?, ...) */
  const memberMap = new Map();
  if (neededMemberIds.size > 0) {
    const memberIds = Array.from(neededMemberIds);
    const placeholders = memberIds.map(() => '?').join(',');
    const memberRows = dbQuery(
      `SELECT id, name FROM members WHERE id IN (${placeholders})`,
      memberIds
    );
    for (const m of memberRows) {
      memberMap.set(m.id, m);
    }
  }

  /** 既存取引 Map を一括取得: WHERE date IN (...) AND member_id IN (...)。
   *  さらに絞り込むため date と member_id の AND 条件で取得し、キーは `date|member_id` で作る。 */
  const existingTxnKeys = new Set();
  if (neededMemberIds.size > 0 && neededDates.size > 0) {
    const memberIds = Array.from(neededMemberIds);
    const dates = Array.from(neededDates);
    const memberPlaceholders = memberIds.map(() => '?').join(',');
    const datePlaceholders = dates.map(() => '?').join(',');
    const txnRows = dbQuery(
      `SELECT date, member_id FROM transactions
       WHERE date IN (${datePlaceholders}) AND member_id IN (${memberPlaceholders})`,
      [...dates, ...memberIds]
    );
    for (const t of txnRows) {
      existingTxnKeys.add(`${t.date}|${t.member_id}`);
    }
  }

  /** 行ループは Map ルックアップのみ（DB アクセスなし） */
  for (const row of rows) {
    const memberId = getFieldValue(row, columnMap.member_id);
    if (!memberId) continue;

    const rawDate = getFieldValue(row, columnMap.date);
    const rowDate = rawDate || defaultDate;

    if (rawDate && !DATE_PATTERN.test(rawDate)) continue;

    const member = memberMap.get(memberId);
    if (!member) {
      unknownIds.push(memberId);
      continue;
    }

    if (existingTxnKeys.has(`${rowDate}|${memberId}`)) {
      alreadyExists++;
      continue;
    }

    toAdd.push({ date: rowDate, member_id: memberId, member_name: member.name });
  }

  return { toAdd, unknownIds, alreadyExists };
}

/**
 * Phase 14: 予約CSVマージ用分類器。
 * 流入CSVと、T14.1 の getDateReservationsWithProtectionFlags が返した既存行を受け取り、
 * 5バケット（toInsert / alreadyExists / toAutoDelete / toProtect / notInMaster）に振り分ける純関数。
 * DBアクセスは一切行わない。呼び出し側が memberMap と existingProtectionRows を用意する。
 *
 * 保護ルール: is_received=1 / is_attended=1 / is_temporary=1 のいずれかで保護対象。
 * 優先順位は received > attended > walk-in（金銭が絡む順）。
 *
 * 単日スコープ: targetDate と異なる日付を持つCSV行は無視する。
 * @param {Array<Array<string>>} csvRows - CSV行配列
 * @param {Object} columnMap - buildColumnMap 出力（member_id, date）
 * @param {string} targetDate - YYYY-MM-DD
 * @param {Array<Object>} existingProtectionRows - T14.1 の戻り値
 * @param {Map<string, {id, name}>} memberMap - 会員IDから会員情報への参照
 * @returns {{toInsert:Array, alreadyExists:Array, toAutoDelete:Array, toProtect:Array, notInMaster:Array<string>}}
 */
function classifyReservationsForMerge(csvRows, columnMap, targetDate, existingProtectionRows, memberMap) {
  const toInsert = [];
  const alreadyExists = [];
  const toAutoDelete = [];
  const toProtect = [];
  const notInMasterSet = new Set();

  /** Step 1: targetDate に該当するCSV行から member_id 集合を作る */
  const csvMemberIds = new Set();
  for (const row of csvRows) {
    const memberId = getFieldValue(row, columnMap.member_id);
    if (!memberId) continue;
    const rawDate = getFieldValue(row, columnMap.date);
    if (rawDate && !DATE_PATTERN.test(rawDate)) continue;
    const rowDate = rawDate || targetDate;
    if (rowDate !== targetDate) continue;
    csvMemberIds.add(memberId);
  }

  /** Step 2: 既存行を走査。CSVに無いものを保護/自動削除に振り分け */
  const existingMemberIds = new Set();
  for (const txn of existingProtectionRows) {
    existingMemberIds.add(txn.member_id);
    if (csvMemberIds.has(txn.member_id)) continue;

    let reason = null;
    if (txn.is_received) reason = 'received';
    else if (txn.is_attended) reason = 'attended';
    else if (txn.is_temporary) reason = 'walk-in';

    if (reason) {
      toProtect.push({
        id: txn.id,
        member_id: txn.member_id,
        member_name: txn.member_name_snapshot,
        reason,
      });
    } else {
      toAutoDelete.push({
        id: txn.id,
        member_id: txn.member_id,
        member_name: txn.member_name_snapshot,
      });
    }
  }

  /** Step 3: CSV行を走査。未登録会員・既存・新規に振り分け
   *  T14.7: member_id 単位でデデュープし、CSV重複行によるカウント膨張を防止する */
  const seenCsvMemberIds = new Set();
  for (const row of csvRows) {
    const memberId = getFieldValue(row, columnMap.member_id);
    if (!memberId) continue;
    const rawDate = getFieldValue(row, columnMap.date);
    if (rawDate && !DATE_PATTERN.test(rawDate)) continue;
    const rowDate = rawDate || targetDate;
    if (rowDate !== targetDate) continue;
    if (seenCsvMemberIds.has(memberId)) continue;
    seenCsvMemberIds.add(memberId);

    const member = memberMap.get(memberId);
    if (!member) {
      notInMasterSet.add(memberId);
      continue;
    }

    if (existingMemberIds.has(memberId)) {
      alreadyExists.push({ member_id: memberId, member_name: member.name });
    } else {
      toInsert.push({ date: targetDate, member_id: memberId, member_name: member.name });
    }
  }

  return {
    toInsert,
    alreadyExists,
    toAutoDelete,
    toProtect,
    notInMaster: Array.from(notInMasterSet),
  };
}

/**
 * Phase 14: 予約CSVを Git 的マージで取り込む。
 * 事前 confirm は廃止。T14.1 で既存行を fetch → T14.2 で5バケット分類 → 単一トランザクションで INSERT + DELETE。
 * 保護ルール: is_received / is_attended / is_temporary のいずれか立っていれば削除しない。
 *
 * @param {string[]} headers - CSVヘッダ
 * @param {Array<Array<string>>} rows - CSVデータ行
 * @param {string} [targetDate] - マージ対象日 YYYY-MM-DD（省略時は本日JST）
 * @returns {Promise<{added:number, alreadyExists:number, notInMaster:string[], autoDeleted:Array, protectedRows:Array}>}
 */
async function syncReservationsFromCsv(headers, rows, targetDate) {
  const columnMap = buildColumnMap(headers, RESERVATION_COLUMN_ALIASES);

  if (columnMap.member_id === -1) {
    throw new Error('予約CSVに必須列（会員ID または member_id）が見つかりませんでした');
  }

  if (targetDate && !DATE_PATTERN.test(targetDate)) {
    throw new Error('targetDate の形式が不正です（YYYY-MM-DD）: ' + targetDate);
  }

  const effectiveDate = targetDate || getTodayJST();

  /** T14.1: 対象日の既存行を保護フラグ付きで取得 */
  const existingProtectionRows = getDateReservationsWithProtectionFlags(effectiveDate);

  /** CSVに現れる member_id を一括で会員Map化（未登録判定のため） */
  const csvMemberIds = new Set();
  for (const row of rows) {
    const mid = getFieldValue(row, columnMap.member_id);
    if (mid) csvMemberIds.add(mid);
  }
  const memberMap = new Map();
  if (csvMemberIds.size > 0) {
    const ids = Array.from(csvMemberIds);
    const placeholders = ids.map(() => '?').join(',');
    const memberRows = dbQuery(
      `SELECT id, name FROM members WHERE id IN (${placeholders})`,
      ids
    );
    for (const m of memberRows) {
      memberMap.set(m.id, m);
    }
  }

  /** T14.2: 5バケットに分類 */
  const {
    toInsert,
    alreadyExists,
    toAutoDelete,
    toProtect,
    notInMaster,
  } = classifyReservationsForMerge(rows, columnMap, effectiveDate, existingProtectionRows, memberMap);

  /** 単一トランザクションで INSERT + DELETE。OPFS 書き込みは commit 後の1回のみ。 */
  const now = getNowISO();
  let added = 0;
  const autoDeletedActual = [];

  await withTransaction(async () => {
    for (const item of toInsert) {
      try {
        await dbRun(
          `INSERT INTO transactions
           (date, member_id, member_name_snapshot, is_attended, is_received, created_at, updated_at)
           VALUES (?, ?, ?, 0, 0, ?, ?)`,
          [item.date, item.member_id, item.member_name, now, now]
        );
        added++;
      } catch (error) {
        console.error('予約INSERT失敗:', error.message, 'member_id=' + item.member_id);
      }
    }

    for (const row of toAutoDelete) {
      try {
        await dbRun('DELETE FROM transactions WHERE id = ?', [row.id]);
        autoDeletedActual.push(row);
      } catch (error) {
        console.error('予約DELETE失敗:', error.message, 'id=' + row.id);
      }
    }
  });

  console.log(
    `予約マージ完了: 追加 ${added} 件, 維持 ${alreadyExists.length} 件, ` +
    `自動削除 ${autoDeletedActual.length} 件, 保護 ${toProtect.length} 件, 未登録 ${notInMaster.length} 件`
  );

  return {
    added,
    alreadyExists: alreadyExists.length,
    notInMaster,
    autoDeleted: autoDeletedActual,
    protectedRows: toProtect,
  };
}

// ============================================
// 売上明細CSV取り込み（Phase 18）
// ============================================

/**
 * 売上明細CSVの支払方法エイリアス。
 * SaaS（HiTouch）が吐き出す文字列揺れを吸収し、payment_methods.name に解決するためのマップ。
 * 各エントリは [canonical, [aliases...]] 形式で、aliases に含まれる（正規化後の）文字列が来たら
 * canonical 名を payment_methods.name と照合する。
 * 現状 3 択（現金/スマホ, ステラ, PayPay）。payment_methods に実際に登録されている行に合わせて
 * 運用する必要があるため、未解決のときはユーザー側でCSVを使って別途取り込む前提。
 */
const SALES_PAYMENT_METHOD_ALIASES = [
  ['現金/スマホ', ['現金/スマホ', '現金・スマホ', '現金スマホ', '現金', 'cash', '現金・スマ', '現金/スマ']],
  ['ステラ', ['ステラ', 'stella']],
  ['PayPay', ['PayPay', 'paypay', 'ペイペイ', 'Paypay', 'PAYPAY']]
];

/**
 * 売上明細CSVで自動生成するウォークイン会員IDの正規表現（W-YYYYMMDD-NNN）。
 * 採番衝突回避のための既存IDパース用。
 */
const WALK_IN_ID_PATTERN = /^W-(\d{8})-(\d+)$/;

/**
 * 売上明細CSVで自動生成する仮登録商品コードの正規表現（Z-NNN）。
 * 採番衝突回避のための既存コードパース用。
 */
const Z_PRODUCT_CODE_PATTERN = /^Z-(\d+)$/;

/**
 * 氏名・品名・支払方法文字列を突合用の正規形に変換する。
 * NFKC 正規化（半角カタカナを全角に、全角英数を半角に）→ 前後トリム →
 * 空白の連続（全角半角含む）を単一の半角スペースに圧縮。
 * @param {string} raw
 * @returns {string}
 */
function normalizeSalesName(raw) {
  if (raw === null || raw === undefined) return '';
  const str = String(raw);
  /** NFKC 変換は String.prototype.normalize('NFKC') で標準的に行える */
  const nfkc = str.normalize ? str.normalize('NFKC') : str;
  return nfkc.trim().replace(/[\s\u3000]+/g, ' ');
}

/**
 * 売上日文字列を YYYY-MM-DD に正規化する。
 * 対応形式:
 *   - ISO: YYYY-MM-DD（そのまま）
 *   - スラッシュ区切り: YYYY/MM/DD, YYYY/M/D
 *   - 日本語: YYYY年MM月DD日, YYYY年M月D日
 * どれにも当てはまらなければ空文字を返す（呼び出し側でスキップ扱い）。
 * 全角数字は NFKC で半角に変換してから解釈する。
 * @param {string} raw
 * @returns {string} YYYY-MM-DD または ''
 */
function parseSalesDate(raw) {
  if (raw === null || raw === undefined) return '';
  const s = String(raw).normalize ? String(raw).normalize('NFKC').trim() : String(raw).trim();
  if (!s) return '';
  /** ISO dash */
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  /** Slash-separated */
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  /** Japanese year-month-day */
  m = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return '';
}

/**
 * 売上金額文字列を整数（円）に正規化する。
 * 受け入れ:
 *   - 数字のみ "1000"
 *   - 三桁区切りあり "1,000" "1，000"（全角カンマも）
 *   - 通貨記号プレフィックス "¥1,000" "￥1000"
 *   - 末尾に "円"
 * それ以外は NaN を返す（負数・小数も NaN 扱い）。
 * 全角数字は NFKC で半角に変換してから解釈する。
 * @param {string} raw
 * @returns {number} 整数円または NaN
 */
function parseSalesAmount(raw) {
  if (raw === null || raw === undefined) return NaN;
  let s = String(raw).normalize ? String(raw).normalize('NFKC').trim() : String(raw).trim();
  if (!s) return NaN;
  /** 通貨記号・カンマ・円記号を除去 */
  s = s.replace(/[¥￥]/g, '').replace(/,/g, '').replace(/円$/, '').trim();
  if (!/^\d+$/.test(s)) return NaN;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

/**
 * 売上明細の支払方法ラベルを、既存 payment_methods.name に解決する。
 * 1. CSV値を正規化
 * 2. 正規化済み値が SALES_PAYMENT_METHOD_ALIASES の alias リストに一致するなら、canonical 名で Map を引く
 * 3. alias に当たらなければ正規化済み値で直接 Map を引く
 * 4. どちらも当たらなければ null（未解決）
 * @param {string} raw
 * @param {Map<string, {id:number, name:string}>} paymentsByKey - normalizedName → payment_methods 行
 * @returns {{id:number, name:string}|null}
 */
function resolveSalesPaymentMethod(raw, paymentsByKey) {
  if (!raw) return null;
  const normalized = normalizeSalesName(raw);
  if (!normalized) return null;
  for (const [canonical, aliases] of SALES_PAYMENT_METHOD_ALIASES) {
    for (const alias of aliases) {
      if (normalizeSalesName(alias) === normalized) {
        const pm = paymentsByKey.get(normalizeSalesName(canonical));
        if (pm) return pm;
      }
    }
  }
  /** エイリアスに当たらないなら CSV 値そのままで直接ルックアップ */
  const direct = paymentsByKey.get(normalized);
  return direct || null;
}

/**
 * 売上明細CSV行を分類して、DB 書き込みの「計画」を組み立てる純関数。
 * DB アクセスは一切行わない。呼び出し側が members / products / payment_methods /
 * 既存ウォークインID / 既存Zコード を全てロード済みで渡す。
 *
 * 返り値の txnBuckets は Map で、キーは `${date}|${memberId}` 形式。各バケットが
 * 1つの transactions 行に対応し、その配下に items 配列を持つ。
 *
 * ambiguousNames に値が1つでも入っていれば、呼び出し側は DB に触らず中止する契約。
 *
 * @param {Array<Array<string>>} rows - パース済み CSV データ行（ヘッダ除く）
 * @param {Object<string, number>} columnMap - buildColumnMap の結果
 * @param {Object} ctx - 外部から注入するリゾルバ用コンテキスト
 * @param {Map<string, Array<{id:string, name:string}>>} ctx.membersByKey - 正規化氏名 → 会員配列（同名複数時は要素 2+）
 * @param {Map<string, {code:string, name:string, category:string, price:number}>} ctx.productsByKey - 正規化品名 → 商品
 * @param {Map<string, {id:number, name:string}>} ctx.paymentsByKey - 正規化決済名 → 決済方法
 * @param {Array<{id:string}>} ctx.existingWalkIns - 既存 W-* 会員
 * @param {Array<{code:string}>} ctx.existingZCodes - 既存 Z-* 商品コード
 * @param {string} ctx.guestMemberId - 非会員擬似会員ID
 * @param {string} ctx.guestMemberName - 非会員ラベル（CSV値との照合用）
 * @returns {{
 *   newMembers: Array<{id:string, name:string}>,
 *   newProducts: Array<{code:string, name:string, category:string, price:number}>,
 *   txnBuckets: Map<string, Object>,
 *   ambiguousNames: string[],
 *   skippedParseErrors: Array<{rowIndex:number, reason:string, value?:string}>,
 *   unresolvedPaymentCount: number,
 *   unresolvedPaymentLabels: string[]
 * }}
 */
function classifySalesRows(rows, columnMap, ctx) {
  const newMembers = [];
  const newProducts = [];
  const txnBuckets = new Map();
  const ambiguousNames = [];
  const skippedParseErrors = [];
  const unresolvedPaymentLabels = [];
  let unresolvedPaymentCount = 0;

  /** 氏名・品名解決の run-scope キャッシュ。重複CSV行が複数のウォークイン／Zコードを
   *  生成しないようにするために使う。 */
  const memberNameCache = new Map();
  const productNameCache = new Map();

  /** ウォークインID採番の土台（日付ごとの最大連番） */
  const walkInMaxByDate = new Map();
  for (const w of ctx.existingWalkIns || []) {
    const m = WALK_IN_ID_PATTERN.exec(w.id);
    if (m) {
      const date = m[1];
      const seq = parseInt(m[2], 10);
      walkInMaxByDate.set(date, Math.max(walkInMaxByDate.get(date) || 0, seq));
    }
  }

  /** Z 商品コード採番の土台（全期間の最大連番） */
  let zMax = 0;
  for (const p of ctx.existingZCodes || []) {
    const m = Z_PRODUCT_CODE_PATTERN.exec(p.code);
    if (m) zMax = Math.max(zMax, parseInt(m[1], 10));
  }

  /** 非会員ラベルの正規形（比較用） */
  const guestNameNormalized = normalizeSalesName(ctx.guestMemberName || '');

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    /** rowIndex はユーザーが Excel で見たときの行番号相当（ヘッダ行 + 1-indexed） */
    const rowIndex = i + 2;

    const rawStatus = getFieldValue(row, columnMap.status);
    const rawDate = getFieldValue(row, columnMap.sale_date);
    const rawMemberName = getFieldValue(row, columnMap.member_name);
    const rawItemDesc = getFieldValue(row, columnMap.item_description);
    const rawCategory = getFieldValue(row, columnMap.sale_category);
    const rawAmount = getFieldValue(row, columnMap.sale_amount);
    const rawPaymentMethod = getFieldValue(row, columnMap.payment_method);
    const rawStaffName = getFieldValue(row, columnMap.staff_name);
    const rawPayRefund = getFieldValue(row, columnMap.paid_or_refund);
    const rawRemark = getFieldValue(row, columnMap.remark);

    /** 必須4列が空ならスキップ */
    if (!rawStatus || !rawDate || !rawMemberName || !rawItemDesc) {
      skippedParseErrors.push({ rowIndex, reason: 'missing-required' });
      continue;
    }

    /** 売上日パース */
    const date = parseSalesDate(rawDate);
    if (!date) {
      skippedParseErrors.push({ rowIndex, reason: 'bad-date', value: rawDate });
      continue;
    }

    /** 金額パース */
    const amount = parseSalesAmount(rawAmount);
    if (!Number.isFinite(amount)) {
      skippedParseErrors.push({ rowIndex, reason: 'bad-amount', value: rawAmount });
      continue;
    }

    /** ステータス → is_received（入金済 のみ 1、それ以外は 0） */
    const isReceived = String(rawStatus).includes('入金済') ? 1 : 0;

    /** 会員解決 */
    const normMemberName = normalizeSalesName(rawMemberName);
    let memberId = null;
    let memberNameSnapshot = rawMemberName;

    if (normMemberName === guestNameNormalized) {
      memberId = ctx.guestMemberId;
      memberNameSnapshot = ctx.guestMemberName;
    } else if (memberNameCache.has(normMemberName)) {
      const cached = memberNameCache.get(normMemberName);
      if (cached === 'AMBIGUOUS') {
        /** 既にあいまい扱い。中止対象として前段で記録済みなのでここでは足さない */
        continue;
      }
      memberId = cached;
    } else {
      const candidates = ctx.membersByKey.get(normMemberName) || [];
      if (candidates.length === 1) {
        memberId = candidates[0].id;
        memberNameCache.set(normMemberName, memberId);
      } else if (candidates.length >= 2) {
        ambiguousNames.push(rawMemberName);
        memberNameCache.set(normMemberName, 'AMBIGUOUS');
        continue;
      } else {
        /** 未登録 → ウォークイン自動作成（日付プレフィックスは当該行の売上日で生成） */
        const dateCompact = date.replace(/-/g, '');
        const nextSeq = (walkInMaxByDate.get(dateCompact) || 0) + 1;
        walkInMaxByDate.set(dateCompact, nextSeq);
        const walkInId = `W-${dateCompact}-${String(nextSeq).padStart(3, '0')}`;
        newMembers.push({ id: walkInId, name: rawMemberName });
        memberId = walkInId;
        memberNameCache.set(normMemberName, memberId);
      }
    }

    /** 商品解決 */
    const normProdName = normalizeSalesName(rawItemDesc);
    let productCode;
    if (productNameCache.has(normProdName)) {
      productCode = productNameCache.get(normProdName);
    } else {
      const existing = ctx.productsByKey.get(normProdName);
      if (existing) {
        productCode = existing.code;
      } else {
        zMax += 1;
        productCode = `Z-${String(zMax).padStart(3, '0')}`;
        newProducts.push({
          code: productCode,
          name: rawItemDesc,
          category: rawCategory || 'その他',
          price: amount
        });
      }
      productNameCache.set(normProdName, productCode);
    }

    /** 支払方法解決 */
    let paymentMethodId = null;
    if (rawPaymentMethod) {
      const pm = resolveSalesPaymentMethod(rawPaymentMethod, ctx.paymentsByKey);
      if (pm) {
        paymentMethodId = pm.id;
      } else {
        unresolvedPaymentCount++;
        unresolvedPaymentLabels.push(rawPaymentMethod);
      }
    }

    /** memo 合成: 備考 | 入金/返金マーカー（パイプ区切り） */
    const memoParts = [];
    if (rawRemark) memoParts.push(rawRemark);
    if (rawPayRefund) memoParts.push(rawPayRefund);
    const composedMemo = memoParts.length > 0 ? memoParts.join(' | ') : null;

    const staffName = rawStaffName || null;

    /** (date, memberId) バケットへ寄せる */
    const bucketKey = `${date}|${memberId}`;
    let bucket = txnBuckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        date,
        memberId,
        memberNameSnapshot,
        isReceived,
        paymentMethodId,
        staffName,
        memo: composedMemo,
        items: []
      };
      txnBuckets.set(bucketKey, bucket);
    } else {
      /** 複数行で「入金済」「未入金」が混ざった場合は、入金済を優先して代表値にする。
       *  payment_method_id も入金済側の値を採用することで整合を保つ。 */
      if (isReceived === 1 && bucket.isReceived === 0) {
        bucket.isReceived = 1;
        bucket.paymentMethodId = paymentMethodId;
      }
      /** staff_name は先勝ち。異なる staff が混ざっても上書きしない（plan 上の first-write-wins ルール） */
      if (!bucket.staffName && staffName) bucket.staffName = staffName;
      /** memo は既存値があれば維持。同一取引で複数行が備考を持っていたら先勝ち */
      if (!bucket.memo && composedMemo) bucket.memo = composedMemo;
    }

    bucket.items.push({
      productCode,
      productName: rawItemDesc,
      price: amount
    });
  }

  /** ambiguousNames から重複を除去 */
  const uniqueAmbiguous = Array.from(new Set(ambiguousNames));

  return {
    newMembers,
    newProducts,
    txnBuckets,
    ambiguousNames: uniqueAmbiguous,
    skippedParseErrors,
    unresolvedPaymentCount,
    unresolvedPaymentLabels
  };
}

/**
 * 売上明細CSVを取り込む公開関数（T18.6 取り込み実行体）。
 *
 * フェーズ:
 *   1. 事前ロード: 非一時会員 / 有効商品 / 有効決済方法 / 既存W-ID / 既存Z-コード
 *   2. 分類: classifySalesRows で純粋に計画を作る
 *   3. ambiguousNames が空でなければ中止（DB書き込みゼロ）
 *   4. 既存トランザクション/明細を (date, memberId) でルックアップし、バケットに注釈
 *   5. withTransaction で単一書き込み: 新規会員 → 新規商品 → 取引 INSERT/UPDATE → 明細 INSERT（重複スキップ）
 *
 * 返り値:
 *   aborted=true なら ambiguousNames に該当名のリスト。DB はロールバック済み（書き込みしていない）。
 *   aborted=false なら各種カウンタと新規作成リスト。
 *
 * @param {string[]} headers
 * @param {Array<Array<string>>} rows
 * @returns {Promise<{
 *   aborted:boolean,
 *   ambiguousNames:string[],
 *   addedTxns:number,
 *   updatedTxns:number,
 *   addedItems:number,
 *   skippedDupItems:number,
 *   unresolvedPayments:number,
 *   unresolvedPaymentLabels:string[],
 *   skippedParseErrors:Array,
 *   newMembers:Array<{id:string,name:string}>,
 *   newProducts:Array<{code:string,name:string,category:string,price:number}>
 * }>}
 */
async function syncSalesFromCsv(headers, rows) {
  const columnMap = buildColumnMap(headers, SALES_COLUMN_ALIASES);

  if (
    columnMap.status === -1 ||
    columnMap.sale_date === -1 ||
    columnMap.member_name === -1 ||
    columnMap.item_description === -1
  ) {
    throw new Error('売上明細CSVに必須列（ステータス／売上日／会員名／明細）が見つかりませんでした');
  }

  /** 事前ロード（読み取りのみ、transaction 外） */
  const memberRows = getNonTemporaryMembersForSalesResolver();
  const productRows = getActiveProductsForSalesResolver();
  const paymentRows = dbQuery('SELECT id, name FROM payment_methods WHERE is_active = 1');
  const existingWalkIns = getExistingWalkInIdsForSalesResolver();
  const existingZCodes = getExistingZProductCodesForSalesResolver();

  /** 正規化氏名 → 会員配列 の Map（同名複数検知のため配列で保持） */
  const membersByKey = new Map();
  for (const m of memberRows) {
    const key = normalizeSalesName(m.name);
    if (!key) continue;
    if (!membersByKey.has(key)) membersByKey.set(key, []);
    membersByKey.get(key).push(m);
  }

  /** 正規化品名 → 商品 Map（同名は先勝ち） */
  const productsByKey = new Map();
  for (const p of productRows) {
    const key = normalizeSalesName(p.name);
    if (!key) continue;
    if (!productsByKey.has(key)) productsByKey.set(key, p);
  }

  /** 正規化決済名 → 決済方法 Map */
  const paymentsByKey = new Map();
  for (const pm of paymentRows) {
    const key = normalizeSalesName(pm.name);
    if (!key) continue;
    paymentsByKey.set(key, pm);
  }

  /** 分類 */
  const plan = classifySalesRows(rows, columnMap, {
    membersByKey,
    productsByKey,
    paymentsByKey,
    existingWalkIns,
    existingZCodes,
    guestMemberId: GUEST_MEMBER_ID,
    guestMemberName: GUEST_MEMBER_NAME
  });

  /** 同名衝突があれば DB に触らず中止 */
  if (plan.ambiguousNames.length > 0) {
    return {
      aborted: true,
      ambiguousNames: plan.ambiguousNames,
      addedTxns: 0,
      updatedTxns: 0,
      addedItems: 0,
      skippedDupItems: 0,
      unresolvedPayments: plan.unresolvedPaymentCount,
      unresolvedPaymentLabels: plan.unresolvedPaymentLabels,
      skippedParseErrors: plan.skippedParseErrors,
      newMembers: [],
      newProducts: []
    };
  }

  /** 既存トランザクションを (date, memberId) で引き当て、各バケットに existingTxnId / existingItemKeys を注釈 */
  const pairs = Array.from(plan.txnBuckets.values()).map((b) => ({
    date: b.date,
    memberId: b.memberId
  }));
  const { txns: existingTxns, items: existingItems } = getExistingTxnsAndItemsForSales(pairs);
  const txnIdByKey = new Map();
  for (const t of existingTxns) {
    txnIdByKey.set(`${t.date}|${t.member_id}`, t.id);
  }
  const itemKeysByTxnId = new Map();
  for (const it of existingItems) {
    if (!itemKeysByTxnId.has(it.transaction_id)) itemKeysByTxnId.set(it.transaction_id, new Set());
    itemKeysByTxnId.get(it.transaction_id).add(
      `${normalizeSalesName(it.product_name_snapshot)}|${Number(it.price_snapshot)}`
    );
  }

  for (const [key, bucket] of plan.txnBuckets) {
    bucket.existingTxnId = txnIdByKey.get(key) || null;
    bucket.existingItemKeys = bucket.existingTxnId ? (itemKeysByTxnId.get(bucket.existingTxnId) || new Set()) : new Set();
  }

  /** 単一トランザクションで書き込みを実行（OPFS 書き込みは commit 後の1回のみ） */
  const now = getNowISO();
  let addedTxns = 0;
  let updatedTxns = 0;
  let addedItems = 0;
  let skippedDupItems = 0;

  await withTransaction(async () => {
    /** 新規ウォークイン会員を先に INSERT（後続の FK 参照を満たすため） */
    for (const wm of plan.newMembers) {
      await dbRun(
        `INSERT INTO members
         (id, name, name_kana, phone, class, timeslot, is_temporary, memo, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, NULL, NULL, 1, NULL, ?, ?)`,
        [wm.id, wm.name, now, now]
      );
    }

    /** 新規仮登録商品を INSERT */
    for (const np of plan.newProducts) {
      await dbRun(
        `INSERT INTO products
         (code, name, category, price, is_provisional, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
        [np.code, np.name, np.category, np.price, now, now]
      );
    }

    /** transactions の INSERT / UPDATE と transaction_items の INSERT */
    for (const bucket of plan.txnBuckets.values()) {
      let txnId = bucket.existingTxnId;
      if (!txnId) {
        await dbRun(
          `INSERT INTO transactions
           (date, member_id, member_name_snapshot, payment_method_id, is_attended, is_received, memo, staff_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
          [bucket.date, bucket.memberId, bucket.memberNameSnapshot, bucket.paymentMethodId, bucket.isReceived, bucket.memo, bucket.staffName, now, now]
        );
        const lastIdRow = dbGetOne('SELECT last_insert_rowid() AS id');
        txnId = lastIdRow.id;
        addedTxns++;
      } else {
        /** 既存 txn の SaaS 権威フィールドのみ更新（is_received / payment_method_id / staff_name / memo） */
        await dbRun(
          `UPDATE transactions
           SET is_received = ?, payment_method_id = ?, staff_name = ?, memo = ?, updated_at = ?
           WHERE id = ?`,
          [bucket.isReceived, bucket.paymentMethodId, bucket.staffName, bucket.memo, now, txnId]
        );
        updatedTxns++;
      }

      /** 明細挿入（重複キー検知） */
      const knownKeys = new Set(bucket.existingItemKeys);
      for (const item of bucket.items) {
        const key = `${normalizeSalesName(item.productName)}|${Number(item.price)}`;
        if (knownKeys.has(key)) {
          skippedDupItems++;
          continue;
        }
        await dbRun(
          `INSERT INTO transaction_items
           (transaction_id, product_code, product_name_snapshot, price_snapshot, quantity)
           VALUES (?, ?, ?, ?, 1)`,
          [txnId, item.productCode, item.productName, item.price]
        );
        knownKeys.add(key);
        addedItems++;
      }
    }
  });

  console.log(
    `売上明細取り込み完了: 新規取引 ${addedTxns} 件, 更新取引 ${updatedTxns} 件, ` +
    `明細追加 ${addedItems} 件, 重複スキップ ${skippedDupItems} 件, ` +
    `未解決決済 ${plan.unresolvedPaymentCount} 件, パースエラー ${plan.skippedParseErrors.length} 件, ` +
    `新規会員 ${plan.newMembers.length} 件, 新規商品 ${plan.newProducts.length} 件`
  );

  return {
    aborted: false,
    ambiguousNames: [],
    addedTxns,
    updatedTxns,
    addedItems,
    skippedDupItems,
    unresolvedPayments: plan.unresolvedPaymentCount,
    unresolvedPaymentLabels: plan.unresolvedPaymentLabels,
    skippedParseErrors: plan.skippedParseErrors,
    newMembers: plan.newMembers,
    newProducts: plan.newProducts
  };
}

// ============================================
// T5.4 [更新] ボタン（SaaS同期パイプライン）
// ============================================

/**
 * [更新] ボタンと隠しファイル入力を初期化する
 * 複数CSVを一括処理し、結果を1つのダイアログで表示する
 */
function initSaasSync() {
  const btnSync = document.getElementById('btn-sync');
  const fileInput = document.getElementById('sync-file-input');
  const overlay = document.getElementById('sync-intro-overlay');
  const btnProceed = document.getElementById('btn-sync-intro-proceed');
  const btnCancel = document.getElementById('btn-sync-intro-cancel');
  if (!btnSync || !fileInput || !overlay || !btnProceed || !btnCancel) return;

  /** ダイアログを開く */
  const openIntro = () => {
    overlay.hidden = false;
    /** 安全なデフォルトとしてキャンセルに初期フォーカス */
    setTimeout(() => btnCancel.focus(), 0);
  };

  /** ダイアログを閉じる */
  const closeIntro = () => {
    overlay.hidden = true;
  };

  /** [更新] クリックでまず説明ダイアログを開く */
  btnSync.addEventListener('click', openIntro);

  /** 「ファイルを選択する」押下で隠しファイル入力を起動 */
  btnProceed.addEventListener('click', () => {
    closeIntro();
    fileInput.value = '';
    fileInput.click();
  });

  /** キャンセル／オーバーレイ外クリック／Esc でダイアログを閉じる */
  btnCancel.addEventListener('click', closeIntro);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeIntro();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) {
      closeIntro();
    }
  });

  /** ファイル選択完了でパイプラインを走らせる */
  fileInput.addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    try {
      btnSync.disabled = true;
      await runSaasSyncPipeline(files);
    } catch (error) {
      /** 技術詳細はコンソールのみに残す（T6.9） */
      console.error('SaaS同期パイプラインでエラーが発生しました:', error);
      /** ユーザーには対処方法を示す（T6.9） */
      showToast('CSVの取り込みに失敗しました。ファイルの内容を確認してから、もう一度お試しください。');
    } finally {
      btnSync.disabled = false;
    }
  });
}

/**
 * 選択された複数CSVファイルを順次処理する
 * 各ファイルのヘッダから種別を判定し、対応する同期関数を呼び出す
 * 全処理完了後にサマリダイアログを表示し、来館者一覧を再描画する
 * @param {File[]} files - 選択されたCSVファイル群
 */
async function runSaasSyncPipeline(files) {
  /** 集計用: 各種別ごとの結果とエラー / 不明ファイルのリスト */
  const summary = {
    members: null,
    payments: null,
    reservations: null,
    sales: null,
    unknownFiles: [],
    errorFiles: []
  };

  for (const file of files) {
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const text = detectAndDecode(bytes);
      const { headers, rows } = parseCsv(text);

      if (headers.length === 0) {
        summary.unknownFiles.push(file.name);
        continue;
      }

      const kind = detectCsvKind(headers);

      if (kind === 'member') {
        summary.members = await syncMembersFromCsv(headers, rows);
      } else if (kind === 'payment') {
        summary.payments = await syncPaymentMethodsFromCsv(headers, rows);
      } else if (kind === 'reservation') {
        summary.reservations = await syncReservationsFromCsv(headers, rows, typeof getWorkingDate === 'function' ? getWorkingDate() : undefined);
      } else if (kind === 'sales') {
        summary.sales = await syncSalesFromCsv(headers, rows);
      } else {
        summary.unknownFiles.push(file.name);
      }
    } catch (error) {
      console.error(`ファイル処理に失敗: ${file.name}`, error);
      summary.errorFiles.push({ name: file.name, message: '処理中にエラーが発生しました' });
    }
  }

  /** T14.5 / T18.8: 会員マスタ / 決済方法 / 未知 / エラーファイルは従来通りのテキストサマリダイアログ。
   *  予約と売上明細は専用の構造化ダイアログに任せる。
   *  複数ある場合はテキスト → 予約ダイアログ → 売上明細ダイアログ の順で直列表示する。 */
  const textHasContent =
    !!summary.members ||
    !!summary.payments ||
    summary.unknownFiles.length > 0 ||
    summary.errorFiles.length > 0;

  if (textHasContent) {
    if (typeof window.confirmAction === 'function') {
      await window.confirmAction('取り込み結果', buildSyncSummaryMessage(summary));
    } else {
      alert(buildSyncSummaryMessage(summary));
    }
  }

  if (summary.reservations && typeof window.showSyncResult === 'function') {
    await window.showSyncResult(summary.reservations);
  } else if (summary.reservations) {
    /** フォールバック: showSyncResult が未ロードの場合はテキストで */
    alert(buildReservationSummaryText(summary.reservations));
  }

  if (summary.sales && typeof window.showSalesResult === 'function') {
    await window.showSalesResult(summary.sales);
  } else if (summary.sales) {
    /** フォールバック: showSalesResult が未ロードの場合はテキストで */
    alert(buildSalesSummaryText(summary.sales));
  }

  /** 来館者一覧を再描画（新規予約行・クラス/時間枠の変更・売上取込の新規取引を反映） */
  if (typeof renderVisitorTable === 'function') {
    renderVisitorTable();
  }
}

/**
 * 売上明細サマリをテキスト表現するフォールバック（showSalesResult が利用不可な場合のみ使用）
 * @param {Object} r - syncSalesFromCsv の返り値
 * @returns {string}
 */
function buildSalesSummaryText(r) {
  const lines = ['売上明細CSV取り込み結果', ''];
  if (r && r.aborted) {
    lines.push('取り込みを中止しました。');
    lines.push('同名の会員が複数存在する氏名があったため、会員マスタ側を確認して再取り込みしてください。');
    const names = Array.isArray(r.ambiguousNames) ? r.ambiguousNames : [];
    if (names.length > 0) {
      lines.push('');
      lines.push('【あいまいな氏名】');
      for (const n of names) lines.push(`  - ${n}`);
    }
    return lines.join('\n');
  }
  lines.push(`新規取引: ${r.addedTxns || 0} 件`);
  lines.push(`更新取引: ${r.updatedTxns || 0} 件`);
  lines.push(`明細追加: ${r.addedItems || 0} 件`);
  lines.push(`重複スキップ: ${r.skippedDupItems || 0} 件`);
  lines.push(`未解決の支払方法: ${r.unresolvedPayments || 0} 件`);
  const skippedParse = Array.isArray(r.skippedParseErrors) ? r.skippedParseErrors.length : 0;
  lines.push(`パースエラー: ${skippedParse} 件`);
  lines.push(`自動作成会員: ${(r.newMembers || []).length} 件`);
  lines.push(`自動作成商品: ${(r.newProducts || []).length} 件`);
  return lines.join('\n');
}

/**
 * 予約サマリをテキスト表現するフォールバック（showSyncResult が利用不可な場合のみ使用）
 * @param {{added:number, alreadyExists:number, autoDeleted:Array, protectedRows:Array, notInMaster:string[]}} r
 * @returns {string}
 */
function buildReservationSummaryText(r) {
  const lines = ['予約CSV取り込み結果', ''];
  lines.push(`新規追加: ${r.added || 0} 件`);
  lines.push(`維持（既存）: ${r.alreadyExists || 0} 件`);
  lines.push(`自動削除: ${(r.autoDeleted || []).length} 件`);
  lines.push(`保護: ${(r.protectedRows || []).length} 件`);
  lines.push(`未登録会員: ${(r.notInMaster || []).length} 件`);
  return lines.join('\n');
}

/**
 * 同期結果サマリを人間可読な文字列に整形する
 * @param {{
 *   members: { updated: number, skipped: number }|null,
 *   payments: { updated: number, deactivated: number, protected: number }|null,
 *   reservations: { added: number, alreadyExists: number, notInMaster: string[], autoDeleted: Array, protectedRows: Array }|null,
 *   unknownFiles: string[],
 *   errorFiles: { name: string, message: string }[]
 * }} summary
 * @returns {string}
 */
function buildSyncSummaryMessage(summary) {
  const lines = ['SaaS同期が完了しました。', ''];

  if (summary.members) {
    lines.push('【会員マスタ】');
    lines.push(`  更新: ${summary.members.updated} 件`);
    lines.push(`  スキップ: ${summary.members.skipped} 件`);
    lines.push('');
  }

  if (summary.payments) {
    lines.push('【決済方法】');
    lines.push(`  更新: ${summary.payments.updated} 件`);
    lines.push(`  無効化: ${summary.payments.deactivated} 件`);
    lines.push(`  保護（参照あり）: ${summary.payments.protected} 件`);
    lines.push('');
  }

  /** T14.5: 予約サマリはテキストには出さず、専用ダイアログ（showSyncResult）に任せる */

  if (summary.unknownFiles.length > 0) {
    lines.push('【種別を判定できなかったファイル】');
    summary.unknownFiles.forEach((n) => lines.push(`  - ${n}`));
    lines.push('');
  }

  if (summary.errorFiles.length > 0) {
    lines.push('【処理中にエラーが発生したファイル】');
    summary.errorFiles.forEach((e) => lines.push(`  - ${e.name}: ${e.message}`));
    lines.push('');
  }

  /** T14.5 以降、予約サマリはテキストから外した。
   *  buildSyncSummaryMessage は呼び出し側の textHasContent が真のときだけ実行されるため、
   *  この関数内で「何もなかった」パスは発生しない想定だが、保険として残す。 */
  if (
    !summary.members &&
    !summary.payments &&
    summary.unknownFiles.length === 0 &&
    summary.errorFiles.length === 0
  ) {
    lines.push('処理対象のCSVがありませんでした。');
  }

  return lines.join('\n').trimEnd();
}
