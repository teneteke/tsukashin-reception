/**
 * db.js — つかしん窓口精算ツール データベースモジュール
 *
 * sql.js（WebAssembly SQLite）の初期化、OPFS永続化、
 * スキーマ管理、マイグレーション、公開APIを提供する。
 */

// ============================================
// 定数
// ============================================

/** OPFSに保存するDBファイル名 */
const OPFS_DB_FILENAME = 'tsukashin.sqlite';

/** BroadcastChannelの名前（タブ重複検知用） */
const BROADCAST_CHANNEL_NAME = 'tsukashin-app';

/** 現在のスキーマバージョン */
const CURRENT_SCHEMA_VERSION = 2;

/** 非会員（SaaS売上明細CSVの「非会員」行）を集約する固定擬似会員のID。
 *  W- プレフィックス（walk-in）と重ならない別プレフィックスを使う。
 *  会員マスタCSVがこのIDを持つ行を含んだ場合に備え、members 同期側の
 *  DELETE は is_temporary=0 限定のままで干渉しない設計。 */
const GUEST_MEMBER_ID = 'GUEST';

/** 非会員擬似会員の表示名。SaaS CSV の列値と一致させておく。 */
const GUEST_MEMBER_NAME = '非会員';

// ============================================
// モジュール状態
// ============================================

/** @type {Object|null} sql.jsのデータベースインスタンス */
let db = null;

/** @type {Object|null} initSqlJs()の戻り値をキャッシュ */
let sqlFactory = null;

/** @type {boolean} 書き込みがブロックされているか（タブ重複時） */
let isWriteBlocked = false;

/** @type {BroadcastChannel|null} タブ間通信チャンネル */
let broadcastChannel = null;

/**
 * 現在 withTransaction フレーム内かどうか
 * true の間は dbRun が OPFS 保存をスキップし、commit 時にまとめて1回保存する
 * @type {boolean}
 */
let isInTransaction = false;

// ============================================
// JST日付ヘルパ
// ============================================

/**
 * 本日のJST日付をYYYY-MM-DD形式で返す
 * @returns {string} 例: "2026-04-14"
 */
function getTodayJST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

/**
 * 現在のJST日時をISO 8601形式で返す
 * sv-SE ロケール + Asia/Tokyo タイムゾーンで統一（手動オフセット計算を廃止）
 * @returns {string} 例: "2026-04-14T18:30:00"
 */
function getNowISO() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(' ', 'T');
}

/**
 * 現在のJST会計年度を返す（4月始まり）
 * 1-3月は前年度、4-12月は当年度
 * @returns {number} 会計年度（例: 2026）
 */
function getJSTFiscalYear() {
  const jstNow = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const year = parseInt(jstNow.slice(0, 4), 10);
  const month = parseInt(jstNow.slice(5, 7), 10);
  return month >= 4 ? year : year - 1;
}

/**
 * ISO文字列またはDateを JST の "YYYY/MM/DD HH:mm" 形式で返す
 * @param {Date|string} isoString - Date オブジェクトまたは ISO 文字列
 * @returns {string}
 */
function formatJstTimestamp(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 16).replace(/-/g, '/');
}

// ============================================
// OPFS 永続化
// ============================================

/**
 * データベースをOPFSに保存する
 * 全てのDB書き込み操作の後に呼び出す
 */
async function saveToOPFS() {
  if (!db) {
    throw new Error('DB未初期化: OPFSへの保存に失敗しました');
  }

  try {
    const data = db.export();
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(OPFS_DB_FILENAME, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
  } catch (error) {
    /** 技術詳細はコンソールのみに残す（T6.9） */
    console.error('OPFSへの保存に失敗しました:', error);
    /** ユーザー向けには対処方法を示す（T6.9） */
    showWarningBanner('データの保存場所にアクセスできません。アドレスバーが http://localhost:8000 になっているか確認してください。');
  }
}

/**
 * OPFSからデータベースを読み込む
 * @returns {Uint8Array|null} DBデータ、存在しない場合はnull
 */
async function loadFromOPFS() {
  try {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(OPFS_DB_FILENAME);
    const file = await fileHandle.getFile();
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
  } catch (error) {
    /** ファイルが存在しない場合（初回起動）は正常ケース、バナーは出さない */
    if (error.name === 'NotFoundError') {
      console.log('OPFSにDBが見つかりません。新規作成します。');
      return null;
    }
    /** それ以外の読み込み失敗はユーザーに警告バナーで通知（T6.9） */
    console.error('OPFSからの読み込みに失敗しました:', error);
    showWarningBanner('データの保存場所にアクセスできません。アドレスバーが http://localhost:8000 になっているか確認してください。');
    return null;
  }
}

// ============================================
// タブ重複検知
// ============================================

/** 既知の制限: 2タブが完全同時にオープンした場合、双方がpongを受信し
 *  両方とも書き込みブロック状態になる可能性がある（極めて稀）。 */

/**
 * BroadcastChannelを使用してタブ重複を検知する
 */
function initBroadcastChannel() {
  if (!('BroadcastChannel' in window)) {
    console.log('BroadcastChannel非対応: タブ重複検知はスキップします');
    return;
  }

  broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);

  /** 存在通知を送信 */
  broadcastChannel.postMessage({ type: 'ping' });

  /** 他タブからのメッセージを処理 */
  broadcastChannel.onmessage = (event) => {
    if (event.data.type === 'ping') {
      /** 他タブが新規に開かれた — 応答を返す */
      broadcastChannel.postMessage({ type: 'pong' });
    } else if (event.data.type === 'pong') {
      /** 別のタブが既に開かれている */
      isWriteBlocked = true;
      showWarningBanner('別のタブでアプリが開かれています。このタブではデータの書き込みができません。');
      console.warn('タブ重複検知: 書き込みをブロックしました');
    }
  };
}

// ============================================
// 公開API
// ============================================

/**
 * SQLを実行する（INSERT/UPDATE/DELETE用）
 * 実行後に自動的にOPFSに保存する
 * @param {string} sql - 実行するSQL文
 * @param {Array} [params=[]] - バインドパラメータ
 * @returns {Object} 実行結果（changes等）
 */
async function dbRun(sql, params = []) {
  if (!db) {
    throw new Error('DBが初期化されていません');
  }
  if (isWriteBlocked) {
    throw new Error('別タブが開かれているため、書き込みがブロックされています');
  }

  try {
    db.run(sql, params);
    const changes = db.getRowsModified();
    /** withTransaction フレーム内では OPFS 保存をスキップ（commit 時に1回だけ行う） */
    if (!isInTransaction) {
      await saveToOPFS();
    }
    return { changes };
  } catch (error) {
    console.error('DB実行エラー:', error.message, '\nSQL:', sql);
    throw error;
  }
}

/**
 * 複数の書き込み操作を単一のトランザクションとしてまとめる
 *
 * BEGIN TRANSACTION → asyncFn 実行 → COMMIT → OPFS 保存（成功時1回のみ）の流れで動く。
 * asyncFn 内で例外が発生した場合は ROLLBACK して再スローし、OPFS には書き込まない。
 * フレーム内の dbRun 呼び出しは OPFS 保存をスキップするため、N 件の書き込みでも
 * OPFS 書き出しは最終 COMMIT 後の1回だけになる（Phase 9 Critical 対策の要）。
 *
 * ネスト呼び出しは明示的に禁止する。将来ネストが必要になったら深度カウンタで拡張できる。
 *
 * @template T
 * @param {() => Promise<T>} asyncFn - トランザクション内で実行する非同期関数
 * @returns {Promise<T>} asyncFn の戻り値
 */
async function withTransaction(asyncFn) {
  if (!db) {
    throw new Error('DBが初期化されていません');
  }
  if (isWriteBlocked) {
    throw new Error('別タブが開かれているため、書き込みがブロックされています');
  }
  if (isInTransaction) {
    throw new Error('withTransaction はネストできません');
  }

  isInTransaction = true;
  try {
    db.run('BEGIN TRANSACTION');
    let result;
    try {
      result = await asyncFn();
    } catch (error) {
      /** 内部エラーは ROLLBACK して再スロー。OPFS は書き換えない */
      try {
        db.run('ROLLBACK');
      } catch (rollbackError) {
        console.error('ROLLBACK に失敗しました:', rollbackError);
      }
      throw error;
    }
    db.run('COMMIT');
    /** commit 成功後に OPFS へ1回だけ書き出す */
    await saveToOPFS();
    return result;
  } finally {
    isInTransaction = false;
  }
}

/**
 * SQLを実行し結果をオブジェクト配列で返す（SELECT用）
 * @param {string} sql - 実行するSQL文
 * @param {Array} [params=[]] - バインドパラメータ
 * @returns {Array<Object>} 結果の行配列
 */
function dbQuery(sql, params = []) {
  if (!db) {
    throw new Error('DBが初期化されていません');
  }

  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } catch (error) {
    console.error('DBクエリエラー:', error.message, '\nSQL:', sql);
    throw error;
  } finally {
    stmt.free();
  }
}

/**
 * SQLを実行し最初の1行をオブジェクトで返す
 * @param {string} sql - 実行するSQL文
 * @param {Array} [params=[]] - バインドパラメータ
 * @returns {Object|null} 結果の行、なければnull
 */
function dbGetOne(sql, params = []) {
  const rows = dbQuery(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

// ============================================
// 設定テーブルヘルパ
// ============================================

/**
 * settingsテーブルから値を取得する
 * @param {string} key - 設定キー
 * @returns {string|null} 値。キーが存在しない場合はnull
 */
function getSetting(key) {
  const row = dbGetOne('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

/**
 * settingsテーブルに値を書き込む（存在すれば更新、なければ挿入）
 * @param {string} key - 設定キー
 * @param {string} value - 設定値
 */
async function upsertSetting(key, value) {
  await dbRun(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

// ============================================
// エクスポート/インポート
// ============================================

/**
 * データベースをUint8Arrayとしてエクスポートする（バックアップ用）
 * @returns {Uint8Array} DBデータ
 */
function exportDB() {
  if (!db) {
    throw new Error('DBが初期化されていません');
  }
  return db.export();
}

/**
 * データベースを差し替える（インポート用）
 * 呼び出し元で確認ダイアログを処理すること
 * @param {Uint8Array} data - インポートするDBデータ
 */
async function importDB(data) {
  if (!db) {
    throw new Error('DBが初期化されていません');
  }

  /** SQLiteマジックヘッダーを検証 */
  const SQLITE_MAGIC = [0x53,0x51,0x4C,0x69,0x74,0x65,0x20,0x66,0x6F,0x72,0x6D,0x61,0x74,0x20,0x33,0x00];
  if (data.length < 16 || !SQLITE_MAGIC.every((b, i) => data[i] === b)) {
    throw new Error('SQLiteファイルとして認識できません');
  }

  try {
    /** 仮オープンしてスキーマを検証（既存DBはまだ閉じない） */
    const SQL = sqlFactory || await initSqlJs({ locateFile: (file) => 'lib/' + file });
    const candidate = new SQL.Database(data);

    const REQUIRED_TABLES = ['settings', 'members', 'products', 'transactions', 'transaction_items', 'payment_methods', 'receipt_log'];
    try {
      const tableRows = candidate.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      );
      const existingTables = tableRows.length > 0
        ? tableRows[0].values.map((r) => r[0])
        : [];
      const missing = REQUIRED_TABLES.filter((t) => !existingTables.includes(t));
      if (missing.length > 0) {
        throw new Error('必須テーブルが不足しています: ' + missing.join(', '));
      }
    } catch (schemaError) {
      try { candidate.close(); } catch (_) { /* close失敗は無視 */ }
      throw schemaError;
    }

    /** 検証OK — 差し替え（旧DBはOPFS保存成功後に閉じる） */
    const oldDb = db;
    db = candidate;

    try {
      await saveToOPFS();
    } catch (opfsError) {
      /** OPFS保存失敗 — 旧DBに復元 */
      db = oldDb;
      try { candidate.close(); } catch (_) { /* close失敗は無視 */ }
      throw opfsError;
    }

    /** 成功 — 旧DBを閉じる */
    try { oldDb.close(); } catch (_) { /* close失敗は無視 */ }
    console.log('DBインポートが完了しました');
  } catch (error) {
    console.error('DBインポートに失敗しました:', error);
    throw error;
  }
}

/**
 * 生のsql.jsデータベースインスタンスを返す（上級用途）
 * @returns {Object|null}
 */
function getDB() {
  return db;
}

// ============================================
// スキーマ作成（バージョン1）
// ============================================

/**
 * スキーマバージョン1のテーブルを作成する
 */
function createSchemaV1() {
  const now = getNowISO();

  /** テーブル作成SQL群 */
  const statements = [
    /** 1. settings — KVS設定 */
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )`,

    /** 2. members — 会員マスタ */
    `CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      name_kana TEXT,
      phone TEXT,
      class TEXT,
      timeslot TEXT,
      is_temporary INTEGER NOT NULL DEFAULT 0 CHECK (is_temporary IN (0, 1)),
      memo TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,

    /** membersの検索用INDEX */
    `CREATE INDEX IF NOT EXISTS idx_members_name_kana ON members(name_kana)`,
    `CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone)`,

    /** 3. products — 商品マスタ */
    `CREATE TABLE IF NOT EXISTS products (
      code TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price INTEGER NOT NULL CHECK (price >= 0),
      is_provisional INTEGER NOT NULL DEFAULT 0 CHECK (is_provisional IN (0, 1)),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,

    /** 4. payment_methods — 決済方法マスタ */
    `CREATE TABLE IF NOT EXISTS payment_methods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0
    )`,

    /** 5. transactions — 取引記録 */
    `CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      member_id TEXT NOT NULL,
      member_name_snapshot TEXT NOT NULL,
      class_override TEXT,
      timeslot_override TEXT,
      payment_method_id INTEGER,
      is_attended INTEGER NOT NULL DEFAULT 0 CHECK (is_attended IN (0, 1)),
      is_received INTEGER NOT NULL DEFAULT 0 CHECK (is_received IN (0, 1)),
      memo TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(date, member_id),
      FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id)
    )`,

    /** transactionsのINDEX */
    `CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date)`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_date_member ON transactions(date, member_id)`,

    /** 6. transaction_items — 取引明細 */
    `CREATE TABLE IF NOT EXISTS transaction_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      product_code TEXT NOT NULL,
      product_name_snapshot TEXT NOT NULL,
      price_snapshot INTEGER NOT NULL CHECK (price_snapshot >= 0),
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    )`,

    /** transaction_itemsのINDEX */
    `CREATE INDEX IF NOT EXISTS idx_transaction_items_txn ON transaction_items(transaction_id)`,

    /** 7. receipt_log — 領収書ログ */
    `CREATE TABLE IF NOT EXISTS receipt_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_number TEXT NOT NULL UNIQUE,
      member_id TEXT NOT NULL,
      recipient_name TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      total_amount INTEGER NOT NULL,
      description TEXT NOT NULL,
      issuer TEXT NOT NULL,
      issued_at TEXT NOT NULL
    )`
  ];

  /** テーブル作成を一括実行（トランザクション内で実行） */
  db.run('BEGIN TRANSACTION');
  try {
    for (const sql of statements) {
      db.run(sql);
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }

  console.log('スキーマV1: 7テーブルを作成しました');
}

// ============================================
// シードデータ
// ============================================

/**
 * 初期データを投入する（初回起動時のみ）
 */
function seedData() {
  const now = getNowISO();

  /** settingsシード。schema_version は常に 1（初期スキーマの世代）として記録し、
   *  V2 以降の追加カラム／追加シードは runMigrations で段階的に適用する。
   *  これによって新規インストールも既存インストールも同じ migration を通って V2 に到達する。 */
  const settingsData = [
    ['csv_encoding', 'utf-8'],
    ['schema_version', '1'],
    ['receipt_next_number', '1'],
    ['receipt_issuer', 'テニスラウンジつかしん'],
    ['receipt_issuer_address', ''],
    ['receipt_issuer_phone', ''],
    ['receipt_issuer_invoice_number', ''],
    ['last_member_sync', ''],
    /** SaaS API連携設定（T6.12）— 値は設定画面で後から登録 */
    ['saas_api_endpoint', ''],
    ['saas_api_key', '']
  ];

  for (const [key, value] of settingsData) {
    db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value]);
  }

  /** payment_methodsシード */
  const paymentMethods = [
    ['現金', 1],
    ['PayPay', 2],
    ['カード', 3]
  ];

  for (const [name, sortOrder] of paymentMethods) {
    db.run('INSERT OR IGNORE INTO payment_methods (name, sort_order) VALUES (?, ?)', [name, sortOrder]);
  }

  /** productsシード（PLAN.md仕様準拠） */
  const products = [
    ['001', '体験レッスン', 'レッスン', 1100],
    ['002', 'イベント参加費', 'レッスン', 2200],
    ['010', 'ガット張り(ナイロン)', '商品', 2000],
    ['011', 'ガット張り(ポリ)', '商品', 2500],
    ['012', 'ガット持込', '商品', 1500],
    ['020', 'グリップテープ', '商品', 1000],
    ['021', 'ボール(1缶)', '商品', 800],
    ['030', 'ラケットレンタル', 'レンタル', 330],
    ['031', '商品券', '商品', 1000]
  ];

  for (const [code, name, category, price] of products) {
    db.run(
      'INSERT OR IGNORE INTO products (code, name, category, price, is_provisional, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 1, ?, ?)',
      [code, name, category, price, now, now]
    );
  }

  console.log('シードデータを投入しました');
}

// ============================================
// マイグレーションフレームワーク
// ============================================

/**
 * マイグレーション関数のレジストリ
 * キーはバージョン番号、値はマイグレーション関数
 * @type {Object.<number, Function>}
 */
const migrations = {
  /**
   * V2: Phase 18 Sales-detail CSV import の基盤。
   *   1. transactions.staff_name を追加（担当者のスナップショット）。既に存在する場合は無視する。
   *   2. 非会員を代表する固定擬似会員行（GUEST_MEMBER_ID / GUEST_MEMBER_NAME, is_temporary=1）を INSERT OR IGNORE で投入。
   * ALTER TABLE は冪等ではないため、PRAGMA table_info を使った存在チェックで二重適用を回避する。
   */
  2: function migrateV1toV2() {
    const columns = dbQuery("PRAGMA table_info('transactions')");
    const hasStaffName = columns.some((col) => col.name === 'staff_name');
    if (!hasStaffName) {
      db.run('ALTER TABLE transactions ADD COLUMN staff_name TEXT');
    }

    const now = getNowISO();
    db.run(
      `INSERT OR IGNORE INTO members
       (id, name, name_kana, phone, class, timeslot, is_temporary, memo, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, NULL, NULL, 1, NULL, ?, ?)`,
      [GUEST_MEMBER_ID, GUEST_MEMBER_NAME, now, now]
    );

    console.log('マイグレーション: V1 → V2 完了（staff_name 追加 + GUEST擬似会員シード）');
  }
};

/**
 * 必要なマイグレーションを実行する
 * settings.schema_version から現在バージョンを取得し、
 * CURRENT_SCHEMA_VERSIONまで順次マイグレーションを適用する
 */
function runMigrations() {
  const row = dbGetOne('SELECT value FROM settings WHERE key = ?', ['schema_version']);
  const currentVersion = row ? parseInt(row.value, 10) : 0;

  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    console.log(`スキーマは最新です（バージョン ${currentVersion}）`);
    return;
  }

  console.log(`マイグレーション開始: V${currentVersion} → V${CURRENT_SCHEMA_VERSION}`);

  for (let v = currentVersion + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
    if (migrations[v]) {
      migrations[v]();
    }
    db.run('UPDATE settings SET value = ? WHERE key = ?', [String(v), 'schema_version']);
    console.log(`マイグレーション: V${v - 1} → V${v} 完了`);
  }
}

// ============================================
// DB初期化
// ============================================

/**
 * データベースを初期化する
 * - sql.js WASMを初期化
 * - OPFSから既存DBを読み込み、なければ新規作成
 * - スキーマ作成・シードデータ投入・マイグレーション実行
 * - タブ重複検知を開始
 * @returns {boolean} 初期化が成功したかどうか
 */
async function initDB() {
  console.log('DB初期化を開始します...');

  try {
    /** sql.js WASM初期化 */
    sqlFactory = await initSqlJs({ locateFile: (file) => 'lib/' + file });
    const SQL = sqlFactory;

    /** OPFSから既存DBを読み込み */
    const existingData = await loadFromOPFS();

    if (existingData) {
      /** 既存DBを開く */
      db = new SQL.Database(existingData);
      console.log('OPFSから既存DBを読み込みました');

      /** 外部キー制約を有効化 */
      db.run('PRAGMA foreign_keys = ON');

      /** マイグレーションを実行 */
      runMigrations();
    } else {
      /** 新規DBを作成 */
      db = new SQL.Database();
      console.log('新規DBを作成しました');

      /** 外部キー制約を有効化 */
      db.run('PRAGMA foreign_keys = ON');

      /** スキーマ作成 */
      createSchemaV1();

      /** シードデータ投入（schema_version は 1 として記録される） */
      seedData();

      /** 新規インストールも段階的 migration を通して CURRENT_SCHEMA_VERSION に追いつかせる。
       *  既存インストール（OPFS読み込みパス）と同じ migration 関数を通るため、
       *  V2 以降の schema 追加は migrations map に書けば両パスに自動で反映される。 */
      runMigrations();

      /** OPFSに保存 */
      await saveToOPFS();
    }

    /** タブ重複検知を開始 */
    initBroadcastChannel();

    console.log('DB初期化が完了しました');
    return true;
  } catch (error) {
    console.error('DB初期化に失敗しました:', error);
    showWarningBanner('データベースの初期化に失敗しました。ページを再読み込みしてください。');
    return false;
  }
}
