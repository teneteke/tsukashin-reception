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
 *   1. member: id と name がどちらも解決できる（最も識別性が高い）
 *   2. payment: name が解決できる（id は存在しない想定）
 *   3. reservation: member_id が解決できる
 *   4. それ以外は unknown
 *
 * member_id の alias は id を含むため、先に member を判定することで
 * 氏名列を持つ会員CSVが予約CSVに誤分類されるのを防ぐ。
 *
 * @param {string[]} headers - CSVのヘッダ行
 * @returns {'member'|'payment'|'reservation'|'unknown'}
 */
function detectCsvKind(headers) {
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

async function syncReservationsFromCsv(headers, rows, targetDate) {
  const columnMap = buildColumnMap(headers, RESERVATION_COLUMN_ALIASES);

  if (columnMap.member_id === -1) {
    throw new Error('予約CSVに必須列（会員ID または member_id）が見つかりませんでした');
  }

  const defaultDate = targetDate || getTodayJST();

  if (targetDate && !DATE_PATTERN.test(targetDate)) {
    throw new Error('targetDate の形式が不正です（YYYY-MM-DD）: ' + targetDate);
  }

  /** 事前集計（DB書き込みなし） */
  const { toAdd, unknownIds, alreadyExists } = classifyReservationRows(rows, columnMap, defaultDate);
  const addedPlanned = toAdd.length;
  const notInMaster = unknownIds.length;

  /** ユーザー確認 */
  const message =
    `予約CSVを取り込みます。\n\n` +
    `追加予定: ${addedPlanned} 件\n` +
    `既に存在: ${alreadyExists} 件\n` +
    `未登録会員: ${notInMaster} 件\n\n` +
    `実行しますか？`;

  const ok = typeof window.confirmAction === 'function'
    ? await window.confirmAction('予約データの取り込み', message)
    : window.confirm(message);

  if (!ok) {
    console.log('予約同期: ユーザーがキャンセルしました');
    return { confirmed: false, added: 0, alreadyExists, notInMaster, unknownIds };
  }

  /** 確認OK: INSERT ループを単一トランザクションで実行（Phase 9 T9.3）
   *  OPFS 書き込みは commit 後の1回のみ。個別 INSERT 失敗は per-row catch で握りつぶし、
   *  残りの行は引き続き処理する（SQLite の statement-level error はトランザクションを中断しない）。 */
  const now = getNowISO();
  let added = 0;

  await withTransaction(async () => {
    for (const item of toAdd) {
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
  });

  console.log(`予約同期完了: 追加 ${added} 件, 既存 ${alreadyExists} 件, 未登録 ${notInMaster} 件`);

  return { confirmed: true, added, alreadyExists, notInMaster, unknownIds };
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
        summary.reservations = await syncReservationsFromCsv(headers, rows);
      } else {
        summary.unknownFiles.push(file.name);
      }
    } catch (error) {
      console.error(`ファイル処理に失敗: ${file.name}`, error);
      summary.errorFiles.push({ name: file.name, message: '処理中にエラーが発生しました' });
    }
  }

  /** サマリダイアログ（共有モーダルを情報表示に利用） */
  if (typeof window.confirmAction === 'function') {
    await window.confirmAction('取り込み結果', buildSyncSummaryMessage(summary));
  } else {
    alert(buildSyncSummaryMessage(summary));
  }

  /** 来館者一覧を再描画（新規予約行・クラス/時間枠の変更を反映） */
  if (typeof renderVisitorTable === 'function') {
    renderVisitorTable();
  }
}

/**
 * 同期結果サマリを人間可読な文字列に整形する
 * @param {{
 *   members: { updated: number, skipped: number }|null,
 *   payments: { updated: number, deactivated: number, protected: number }|null,
 *   reservations: { confirmed: boolean, added: number, alreadyExists: number, notInMaster: number, unknownIds: string[] }|null,
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

  if (summary.reservations) {
    lines.push('【本日の予約】');
    if (!summary.reservations.confirmed) {
      lines.push('  ユーザーによりキャンセルされました');
    } else {
      lines.push(`  追加: ${summary.reservations.added} 件`);
      lines.push(`  既に存在: ${summary.reservations.alreadyExists} 件`);
      lines.push(`  未登録会員: ${summary.reservations.notInMaster} 件`);
      if (summary.reservations.unknownIds.length > 0) {
        const head = summary.reservations.unknownIds.slice(0, 10).join(', ');
        const more = summary.reservations.unknownIds.length > 10
          ? ` ... 他 ${summary.reservations.unknownIds.length - 10} 件`
          : '';
        lines.push(`  未登録ID: ${head}${more}`);
      }
    }
    lines.push('');
  }

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

  if (
    !summary.members &&
    !summary.payments &&
    !summary.reservations &&
    summary.unknownFiles.length === 0 &&
    summary.errorFiles.length === 0
  ) {
    lines.push('処理対象のCSVがありませんでした。');
  }

  return lines.join('\n').trimEnd();
}
