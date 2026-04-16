/**
 * csv.js — つかしん窓口精算ツール CSVユーティリティ
 *
 * RFC4180準拠のCSVパーサ・シリアライザと、エンコーディングヘルパを提供する。
 * - T4.1 来館者一覧からのCSVエクスポート
 * - T5.1/T5.2/T5.3 SaaSデータのCSVインポート
 * で共用される。
 *
 * 依存: lib/encoding.min.js（Shift_JIS変換 / エンコード自動検出）
 */

// ============================================
// CSVパース（RFC4180準拠）
// ============================================

/**
 * クォート内の1文字を処理する
 * @param {string} text - CSV全体テキスト
 * @param {Object} s - パーサ状態オブジェクト
 */
function parseQuotedChar(text, s) {
  const ch = text[s.i];
  if (ch === '"') {
    if (s.i + 1 < text.length && text[s.i + 1] === '"') {
      s.field += '"';
      s.i += 2;
      return;
    }
    s.inQuotes = false;
    s.i++;
    return;
  }
  s.field += ch;
  s.i++;
}

/**
 * クォート外の1文字を処理する
 * @param {string} text - CSV全体テキスト
 * @param {Object} s - パーサ状態オブジェクト
 */
function parseUnquotedChar(text, s) {
  const ch = text[s.i];

  if (ch === '"') {
    if (s.fieldStart) {
      s.inQuotes = true;
      s.fieldStart = false;
      s.i++;
      return;
    }
    s.field += ch;
    s.i++;
    return;
  }

  if (ch === ',') {
    s.row.push(s.field);
    s.field = '';
    s.fieldStart = true;
    s.i++;
    return;
  }

  if (ch === '\r') {
    csvFinishRow(s);
    s.i++;
    if (s.i < text.length && text[s.i] === '\n') s.i++;
    return;
  }

  if (ch === '\n') {
    csvFinishRow(s);
    s.i++;
    return;
  }

  s.field += ch;
  s.fieldStart = false;
  s.i++;
}

/**
 * 現在のフィールドを行に追加し、行を確定してリセットする
 * @param {Object} s - パーサ状態オブジェクト
 */
function csvFinishRow(s) {
  s.row.push(s.field);
  s.field = '';
  s.fieldStart = true;
  s.rows.push(s.row);
  s.row = [];
}

/**
 * CSV文字列をパースし、ヘッダ行とデータ行の配列を返す
 *
 * 対応仕様:
 * - ダブルクォートで囲まれたフィールド内のカンマ、改行を保持
 * - エスケープされたダブルクォート `""` → `"`
 * - 行末はLF / CRLF / CR のいずれも受け付ける
 * - 先頭・末尾の空行はスキップ
 *
 * @param {string} text - CSV全体のテキスト
 * @returns {{ headers: string[], rows: string[][] }}
 */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }

  const s = { rows: [], row: [], field: '', inQuotes: false, fieldStart: true, i: 0 };

  while (s.i < text.length) {
    if (s.inQuotes) {
      parseQuotedChar(text, s);
    } else {
      parseUnquotedChar(text, s);
    }
  }

  if (s.field.length > 0 || s.row.length > 0) {
    s.row.push(s.field);
    s.rows.push(s.row);
  }

  const nonEmpty = s.rows.filter((r) => !(r.length === 1 && r[0] === ''));

  if (nonEmpty.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = nonEmpty[0].map((h) => h.trim());
  const dataRows = nonEmpty.slice(1);
  return { headers, rows: dataRows };
}

// ============================================
// CSVシリアライズ（RFC4180準拠）
// ============================================

/**
 * 1フィールドをCSVとしてエスケープする
 * カンマ・改行・ダブルクォートを含む場合はダブルクォートで囲み、
 * 内部のダブルクォートは "" にエスケープする
 * @param {*} value - 任意のスカラー値
 * @returns {string} エスケープ済みフィールド
 */
function escapeCsvField(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * ヘッダとデータ行をCSV文字列に変換する
 * 行区切りはCRLF（Windows Excel互換）
 * @param {string[]} headers - ヘッダ配列
 * @param {Array<Array<*>>} rows - データ行の2次元配列
 * @returns {string} CSV全体のテキスト
 */
function serializeCsv(headers, rows) {
  const lines = [];
  lines.push(headers.map(escapeCsvField).join(','));
  for (const row of rows) {
    lines.push(row.map(escapeCsvField).join(','));
  }
  /** 行末はCRLF、最終行にも付与 */
  return lines.join('\r\n') + '\r\n';
}

// ============================================
// エンコーディングヘルパ
// ============================================

/**
 * UTF-8（BOM付き）バイト列にエンコードする
 * Excelで日本語を正しく読むためBOMを先頭に付与する
 * @param {string} text - CSV全体のテキスト
 * @returns {Uint8Array} BOM + UTF-8バイト列
 */
function encodeCsvUtf8Bom(text) {
  const utf8Bytes = new TextEncoder().encode(text);
  const result = new Uint8Array(utf8Bytes.length + 3);
  /** UTF-8 BOM: 0xEF, 0xBB, 0xBF */
  result[0] = 0xEF;
  result[1] = 0xBB;
  result[2] = 0xBF;
  result.set(utf8Bytes, 3);
  return result;
}

/**
 * Shift_JISバイト列にエンコードする
 * encoding-japanese の Encoding.convert を使用
 * @param {string} text - CSV全体のテキスト
 * @returns {Uint8Array} Shift_JISバイト列
 */
function encodeCsvSjis(text) {
  if (typeof Encoding === 'undefined') {
    throw new Error('encoding-japanese が読み込まれていません');
  }
  const unicodeArray = Encoding.stringToCode(text);
  const sjisArray = Encoding.convert(unicodeArray, { to: 'SJIS', from: 'UNICODE' });
  return new Uint8Array(sjisArray);
}

/**
 * バイト列を自動検出 → Unicode文字列にデコードする
 * UTF-8 / Shift_JIS / EUC-JP / ISO-2022-JP を自動判別する
 * 判別できない場合はUTF-8と仮定する
 * @param {Uint8Array|ArrayBuffer} bytes - 入力バイト列
 * @returns {string} Unicode文字列
 */
function detectAndDecode(bytes) {
  if (typeof Encoding === 'undefined') {
    throw new Error('encoding-japanese が読み込まれていません');
  }
  const byteArray = bytes instanceof Uint8Array ? Array.from(bytes) : Array.from(new Uint8Array(bytes));
  let detected = Encoding.detect(byteArray);
  if (!detected || detected === 'BINARY' || detected === 'ASCII') {
    detected = 'UTF8';
  }
  const unicode = Encoding.convert(byteArray, {
    to: 'UNICODE',
    from: detected,
    type: 'string'
  });
  return unicode;
}

// ============================================
// T4.1 CSV出力
// ============================================

/**
 * CSV出力ダイアログを初期化し、各ボタンのイベントを登録する
 */
function initCsvExport() {
  const btnExport = document.getElementById('btn-csv-export');
  const overlay = document.getElementById('csv-export-overlay');
  const btnCancel = document.getElementById('btn-csv-export-cancel');
  const btnRun = document.getElementById('btn-csv-export-run');
  const customBox = document.getElementById('csv-export-custom');
  const fromInput = document.getElementById('csv-export-from');
  const toInput = document.getElementById('csv-export-to');

  if (!btnExport || !overlay || !btnCancel || !btnRun) return;

  /** [CSV] クリックでダイアログを開く */
  btnExport.addEventListener('click', () => {
    const today = getTodayJST();
    /** カスタム日付の初期値を今日に揃える */
    fromInput.value = today;
    toInput.value = today;
    overlay.hidden = false;
  });

  /** キャンセルで閉じる */
  btnCancel.addEventListener('click', () => {
    overlay.hidden = true;
  });

  /** オーバーレイ外側クリックで閉じる */
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.hidden = true;
  });

  /** 期間ラジオ変更でカスタム日付の表示を切替 */
  const rangeRadios = document.querySelectorAll('input[name="csv-range"]');
  rangeRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      customBox.hidden = radio.value !== 'custom' || !radio.checked;
      if (radio.value === 'custom' && radio.checked) customBox.hidden = false;
      if (radio.value !== 'custom' && radio.checked) customBox.hidden = true;
    });
  });

  /** [出力] 実行 */
  btnRun.addEventListener('click', () => {
    try {
      runCsvExport();
      overlay.hidden = true;
    } catch (error) {
      /** 技術詳細はコンソールのみに残す（T6.9） */
      console.error('CSV出力エラー:', error);
      /** ユーザーには対処方法を示す（T6.9） */
      showToast('CSVの書き出しに失敗しました。期間を短くしてから、もう一度お試しください。');
    }
  });
}

/**
 * 選択されている期間プリセット／カスタム日付から from / to を決定する
 * @returns {{from: string, to: string}} YYYY-MM-DD形式のJST日付
 */
function resolveCsvDateRange() {
  const checked = document.querySelector('input[name="csv-range"]:checked');
  const value = checked ? checked.value : 'today';
  const today = getTodayJST();

  if (value === 'today') {
    return { from: today, to: today };
  }
  if (value === 'month') {
    /** 今月1日からJST今日まで */
    const firstDay = today.slice(0, 8) + '01';
    return { from: firstDay, to: today };
  }
  /** custom */
  const from = document.getElementById('csv-export-from').value || today;
  const to = document.getElementById('csv-export-to').value || today;
  /** from > to の場合は自動入れ替え */
  if (from > to) {
    return { from: to, to: from };
  }
  return { from, to };
}

/**
 * 選択されているエンコーディングを返す
 * @returns {'utf8'|'sjis'}
 */
function resolveCsvEncoding() {
  const checked = document.querySelector('input[name="csv-encoding"]:checked');
  return checked ? checked.value : 'utf8';
}

/**
 * CSVエクスポートを実行する（クエリ → シリアライズ → エンコード → ダウンロード）
 */
function runCsvExport() {
  const { from, to } = resolveCsvDateRange();
  const encoding = resolveCsvEncoding();

  /** 1明細=1行のデータを取得（repository経由） */
  const rows = getSettlementExportData(from, to);

  /** ヘッダ（日本語） */
  const headers = [
    '日付',
    '会員ID',
    '氏名',
    '商品コード',
    '商品名',
    '単価',
    '数量',
    '小計',
    '決済方法',
    '受取済み'
  ];

  /** データ配列への変換。明細がない来館者（LEFT JOIN結果のNULL）は明細列を空欄で1行残す */
  const dataRows = rows.map((r) => [
    r.date || '',
    r.member_id || '',
    r.member_name || '',
    r.product_code || '',
    r.product_name || '',
    r.price !== null && r.price !== undefined ? String(r.price) : '',
    r.quantity !== null && r.quantity !== undefined ? String(r.quantity) : '',
    r.line_total !== null && r.line_total !== undefined ? String(r.line_total) : '',
    r.payment_method || '',
    r.is_received ? '1' : '0'
  ]);

  const csvText = serializeCsv(headers, dataRows);
  const bytes = encoding === 'sjis' ? encodeCsvSjis(csvText) : encodeCsvUtf8Bom(csvText);

  /** ファイル名 */
  const fromCompact = from.replace(/-/g, '');
  const toCompact = to.replace(/-/g, '');
  const filename = from === to
    ? `settlement_${fromCompact}.csv`
    : `settlement_${fromCompact}-${toCompact}.csv`;

  downloadBytes(bytes, filename, 'text/csv');
  showToast(`CSVを出力しました: ${filename} (${dataRows.length}行)`);
}
