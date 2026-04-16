/**
 * receipt.js — つかしん窓口精算ツール 領収書PDF生成モジュール
 *
 * 画面2の領収書発行機能を担当する:
 * - T3.5 A4 PDF領収書の生成
 *        フォント遅延ロード（Noto Sans JP）
 *        会計年度単位の領収書番号採番（receipt_log MAX+1方式）
 *        カテゴリベースの但し書き「〇〇代として」生成
 *        receipt_log への発行記録
 */

// ============================================
// モジュール状態
// ============================================

/**
 * Noto Sans JP フォントのbase64データ（遅延ロード後にキャッシュ）
 * @type {string|null}
 */
let notoSansJpBase64 = null;

/**
 * 現在進行中のフォントロード Promise を保持する（並行呼び出しをまとめる用）
 * Phase 9 T9.8: 旧実装はフラグ＋50ms ポーリングでビジーループしていたが、
 * in-flight Promise を共有する形に置き換えて CPU・バッテリーの無駄を無くす。
 * @type {Promise<string>|null}
 */
let fontLoadPromise = null;

/**
 * 領収書PDFで使用するフォント名（jsPDFに登録する名前）
 */
const RECEIPT_FONT_NAME = 'NotoSansJP';

/**
 * 但し書きのカテゴリマッピング
 * 未知のカテゴリは「{カテゴリ}代」を自動生成する
 */
const CATEGORY_DESCRIPTION_MAP = {
  'レッスン': 'レッスン代',
  '商品': '商品代',
  'レンタル': 'レンタル代',
};

// ============================================
// T3.5 フォント遅延ロード
// ============================================

/**
 * ArrayBufferをbase64文字列に変換する
 * @param {ArrayBuffer} buffer
 * @returns {string} base64文字列
 */
/** base64変換時のチャンクサイズ（32KB、スタックオーバーフロー回避） */
const BASE64_CHUNK_SIZE = 0x8000;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = BASE64_CHUNK_SIZE;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

/**
 * Noto Sans JP フォントを遅延ロードする
 *
 * 初回呼び出し時のみ fetch と base64 変換を行い、以降はキャッシュを返す。
 * 並行呼び出しは同一の in-flight Promise を共有する（Phase 9 T9.8）。
 * 失敗時は fontLoadPromise をクリアして次回の呼び出しでリトライできるようにする。
 *
 * @returns {Promise<string>} base64 エンコードされたフォントデータ
 */
function ensureFontLoaded() {
  if (notoSansJpBase64) return Promise.resolve(notoSansJpBase64);

  if (fontLoadPromise) {
    /** 別呼び出し元が既にロード中なら同じ Promise を共有する（ポーリング不要） */
    return fontLoadPromise;
  }

  fontLoadPromise = (async () => {
    try {
      showToast('フォントを読み込んでいます...');
      const response = await fetch('./lib/NotoSansJP-Regular.ttf');
      if (!response.ok) {
        throw new Error(`フォントの取得に失敗: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      notoSansJpBase64 = arrayBufferToBase64(arrayBuffer);
      console.log(`Noto Sans JP フォントを読み込みました (${arrayBuffer.byteLength} bytes)`);
      return notoSansJpBase64;
    } catch (error) {
      /** 失敗時は Promise をクリアして次回呼び出しで再試行できるようにする */
      fontLoadPromise = null;
      throw error;
    }
  })();

  return fontLoadPromise;
}

// ============================================
// T3.5 会計年度ベースの領収書番号採番
// ============================================

/**
 * 次の領収書番号を生成する
 * repository.js の getNextReceiptNumber() に委譲
 * @returns {string} 領収書番号（"{FY}-{NNNN}"形式）
 */
function generateReceiptNumber() {
  return getNextReceiptNumber();
}

// ============================================
// T3.5 但し書き「〇〇代として」生成
// ============================================

/**
 * transaction_itemsから但し書きテキストを生成する
 * カテゴリごとに「〇〇代」を列挙し「、」で結合、末尾に「として」を付与する
 * @param {Array} items - {product_code, category}を含むitemsの配列
 * @returns {string} 但し書きテキスト
 */
function generateReceiptDescription(items) {
  if (!items || items.length === 0) return 'お品代として';

  /** カテゴリを収集・重複排除・ソート */
  const categories = [...new Set(items.map((i) => i.category).filter((c) => c))];
  categories.sort();

  if (categories.length === 0) return 'お品代として';

  /** 各カテゴリを「〇〇代」に変換 */
  const phrases = categories.map((c) => CATEGORY_DESCRIPTION_MAP[c] || `${c}代`);

  return phrases.join('、') + 'として';
}

// ============================================
// T3.5 PDF生成（jsPDF）— T8.1 でセクション関数に分割
// ============================================

/** PDFレイアウト定数 */
const PDF_LAYOUT = {
  pageWidth: 210,
  margin: 20,
  startY: 20,
  titleFontSize: 28,
  metaFontSize: 10,
  recipientFontSize: 16,
  amountFontSize: 22,
  sectionFontSize: 12,
  itemFontSize: 10,
  issuerTitleFontSize: 11,
  issuerFontSize: 10,
  itemCol1: 20,
  itemCol2: 50,
  itemCol3: 120,
  itemCol4: 145,
  pageBreakThreshold: 260,
  issuerPageBreakThreshold: 240,
  maxProductNameLength: 20,
};

/**
 * PDFヘッダー部を描画する（タイトル〜「正に領収いたしました」まで）
 * @param {Object} doc - jsPDFインスタンス
 * @param {Object} params - 生成パラメータ
 * @returns {number} 描画後のY座標
 */
function drawReceiptHeader(doc, params) {
  const { receiptNumber, issueDate, recipientName, totalAmount, description, dateFrom, dateTo } = params;
  const L = PDF_LAYOUT;
  let y = L.startY;

  doc.setFontSize(L.titleFontSize);
  doc.text('領収書', L.pageWidth / 2, y, { align: 'center' });
  y += 12;

  doc.setFontSize(L.metaFontSize);
  doc.text(`No. ${receiptNumber}`, L.pageWidth - L.margin, y, { align: 'right' });
  y += 5;
  doc.text(`発行日: ${issueDate}`, L.pageWidth - L.margin, y, { align: 'right' });
  y += 10;

  doc.setFontSize(L.recipientFontSize);
  doc.text(`${recipientName} 様`, L.margin, y);
  doc.setLineWidth(0.3);
  doc.line(L.margin, y + 2, L.pageWidth - L.margin, y + 2);
  y += 12;

  doc.setFontSize(L.amountFontSize);
  const amountText = `¥ ${Number(totalAmount).toLocaleString('ja-JP')}  (税込)`;
  doc.text(amountText, L.pageWidth / 2, y, { align: 'center' });
  doc.setLineWidth(0.5);
  doc.rect(40, y - 10, L.pageWidth - 80, 14);
  y += 12;

  doc.setFontSize(L.sectionFontSize);
  doc.text(`但し  ${description}`, L.margin, y);
  y += 8;

  doc.setFontSize(L.metaFontSize);
  const periodText = dateFrom === dateTo ? `対象日: ${dateFrom}` : `対象期間: ${dateFrom} 〜 ${dateTo}`;
  doc.text(periodText, L.margin, y);
  y += 4;
  doc.text('上記金額を正に領収いたしました。', L.margin, y);
  y += 10;

  return y;
}

/**
 * PDF内訳テーブルを描画する（【内訳】ヘッダー〜合計行まで）
 * @param {Object} doc - jsPDFインスタンス
 * @param {Object} params - 生成パラメータ
 * @param {number} startY - 描画開始Y座標
 * @returns {number} 描画後のY座標
 */
function drawReceiptItems(doc, params, startY) {
  const { items, totalAmount } = params;
  const L = PDF_LAYOUT;
  let y = startY;

  doc.setFontSize(L.sectionFontSize);
  doc.text('【内訳】', L.margin, y);
  y += 6;

  doc.setFontSize(L.itemFontSize);
  doc.text('日付', L.itemCol1, y);
  doc.text('商品名', L.itemCol2, y);
  doc.text('単価', L.itemCol3, y, { align: 'right' });
  doc.text('数量', L.itemCol4, y, { align: 'right' });
  doc.text('小計', L.pageWidth - L.margin, y, { align: 'right' });
  y += 2;
  doc.setLineWidth(0.2);
  doc.line(L.margin, y, L.pageWidth - L.margin, y);
  y += 5;

  for (const item of items) {
    if (y > L.pageBreakThreshold) {
      doc.addPage();
      doc.setFont(RECEIPT_FONT_NAME);
      y = L.startY;
    }

    const subtotal = Number(item.price_snapshot) * Number(item.quantity);
    doc.text(item.txn_date, L.itemCol1, y);
    const productName = item.product_name_snapshot.length > L.maxProductNameLength
      ? item.product_name_snapshot.substring(0, L.maxProductNameLength) + '…'
      : item.product_name_snapshot;
    doc.text(productName, L.itemCol2, y);
    doc.text(`¥${Number(item.price_snapshot).toLocaleString('ja-JP')}`, L.itemCol3, y, { align: 'right' });
    doc.text(String(item.quantity), L.itemCol4, y, { align: 'right' });
    doc.text(`¥${subtotal.toLocaleString('ja-JP')}`, L.pageWidth - L.margin, y, { align: 'right' });
    y += 5;
  }

  y += 2;
  doc.setLineWidth(0.3);
  doc.line(L.margin, y, L.pageWidth - L.margin, y);
  y += 5;
  doc.setFontSize(L.sectionFontSize);
  doc.text('合計', L.itemCol1, y);
  doc.text(`¥${Number(totalAmount).toLocaleString('ja-JP')}  (税込)`, L.pageWidth - L.margin, y, { align: 'right' });
  y += 15;

  return y;
}

/**
 * PDF発行元ブロックを描画する
 * @param {Object} doc - jsPDFインスタンス
 * @param {Object} params - 生成パラメータ
 * @param {number} startY - 描画開始Y座標
 * @returns {number} 描画後のY座標
 */
function drawReceiptIssuer(doc, params, startY) {
  const { issuerName, issuerAddress, issuerPhone, issuerInvoiceNumber } = params;
  const L = PDF_LAYOUT;
  let y = startY;

  if (y > L.issuerPageBreakThreshold) {
    doc.addPage();
    doc.setFont(RECEIPT_FONT_NAME);
    y = L.startY;
  }

  doc.setFontSize(L.issuerTitleFontSize);
  doc.text('【発行元】', L.margin, y);
  y += 5;

  doc.setFontSize(L.issuerFontSize);
  doc.text(issuerName, L.margin, y);
  y += 5;
  if (issuerAddress) {
    doc.text(issuerAddress, L.margin, y);
    y += 5;
  }
  if (issuerPhone) {
    doc.text(`TEL: ${issuerPhone}`, L.margin, y);
    y += 5;
  }
  if (issuerInvoiceNumber) {
    doc.text(`登録番号: ${issuerInvoiceNumber}`, L.margin, y);
    y += 5;
  }

  return y;
}

/**
 * 領収書PDFを生成してBlob URLを返す
 * @param {Object} params - 生成パラメータ
 * @returns {Promise<string>} 生成されたPDFのBlob URL
 */
async function generateReceiptPdf(params) {
  const fontBase64 = await ensureFontLoaded();

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

  doc.addFileToVFS('NotoSansJP-Regular.ttf', fontBase64);
  doc.addFont('NotoSansJP-Regular.ttf', RECEIPT_FONT_NAME, 'normal');
  doc.setFont(RECEIPT_FONT_NAME);

  let y = drawReceiptHeader(doc, params);
  y = drawReceiptItems(doc, params, y);
  drawReceiptIssuer(doc, params, y);

  const blob = doc.output('blob');
  return URL.createObjectURL(blob);
}

// ============================================
// T3.5 領収書発行（メインエントリ）
// ============================================

/**
 * 領収書発行のバリデーションを行い、有効な入力データを返す
 * いずれかの条件を満たさない場合はトーストを表示してnullを返す
 * @returns {Object|null} バリデーション済みデータ、または null
 */
function validateReceiptInput() {
  const memberId = typeof getCurrentDetailMemberId === 'function'
    ? getCurrentDetailMemberId()
    : null;
  if (!memberId) {
    showToast('会員が選択されていません');
    return null;
  }

  const range = typeof getCurrentDateRange === 'function'
    ? getCurrentDateRange()
    : { from: '', to: '' };
  if (!range.from || !range.to) {
    showToast('日付範囲が設定されていません');
    return null;
  }

  const recipientInput = document.getElementById('receipt-recipient');
  const recipientName = recipientInput ? recipientInput.value.trim() : '';
  if (!recipientName) {
    showToast('宛名を入力してください');
    return null;
  }
  if (recipientName.length > 50) {
    showToast('宛名は50文字以内で入力してください');
    return null;
  }

  const data = gatherReceiptData(memberId, range.from, range.to);
  if (data.items.length === 0 || data.totalAmount <= 0) {
    showToast('領収書を発行する明細がありません');
    return null;
  }

  return { memberId, dateFrom: range.from, dateTo: range.to, recipientName, data };
}

/**
 * 領収書を発行する
 * 画面2の [発行・印刷] ボタンから呼ばれる
 */
async function issueReceipt() {
  const input = validateReceiptInput();
  if (!input) return;

  const { memberId, dateFrom, dateTo, recipientName, data } = input;

  /** T7.3: 発行前の確認モーダル */
  if (typeof window.confirmAction === 'function') {
    const confirmed = await window.confirmAction(
      '領収書の発行',
      `${recipientName} 様 宛 ${formatCurrency(data.totalAmount)} の領収書を発行します。\n発行後の取り消しはできません。\nよろしいですか？`
    );
    if (!confirmed) {
      console.log('領収書発行はユーザー操作によりキャンセルされました');
      return;
    }
  }

  const issueBtn = document.getElementById('btn-issue-receipt');
  if (issueBtn) issueBtn.disabled = true;

  try {
    const description = generateReceiptDescription(data.items);
    const issueDate = getTodayJST();
    const receiptNumber = generateReceiptNumber();
    const now = getNowISO();

    await insertReceiptLog({
      receiptNumber, memberId, recipientName, dateFrom, dateTo,
      totalAmount: data.totalAmount, description,
      issuerName: data.issuerName, issuedAt: now,
    });

    const blobUrl = await generateReceiptPdf({
      receiptNumber, issueDate, recipientName,
      totalAmount: data.totalAmount, description,
      items: data.items, dateFrom, dateTo,
      issuerName: data.issuerName,
      issuerAddress: data.issuerAddress,
      issuerPhone: data.issuerPhone,
      issuerInvoiceNumber: data.issuerInvoiceNumber,
    });

    console.log(`領収書を発行しました: ${receiptNumber}`);
    showToast(`領収書 ${receiptNumber} を発行しました`);
    updateLastIssuedDisplay();

    const opened = window.open(blobUrl, '_blank');
    if (!opened) {
      showToast('ポップアップがブロックされました。ブラウザの設定を確認してください。');
    }
  } catch (error) {
    console.error('領収書発行に失敗:', error);
    showToast('領収書の発行に失敗しました。再度お試しください。');
  } finally {
    if (issueBtn) issueBtn.disabled = false;
  }
}

/**
 * 画面2の「最終発行」ラインを更新する（T7.3 新規）
 *
 * receipt_log からこの会員の最新の発行履歴を1件取得し、
 * 「最終発行: YYYY/MM/DD HH:mm 受領番号 ¥金額」の形式で表示する。
 * 履歴が無ければ「発行履歴なし」を表示する。
 */
function updateLastIssuedDisplay() {
  const el = document.getElementById('receipt-last-issued');
  if (!el) return;

  const memberId = typeof getCurrentDetailMemberId === 'function'
    ? getCurrentDetailMemberId()
    : null;

  if (!memberId) {
    el.textContent = '発行履歴なし';
    el.classList.remove('receipt-last-issued--has-history');
    return;
  }

  const row = getLastReceipt(memberId);

  if (!row) {
    el.textContent = '発行履歴なし';
    el.classList.remove('receipt-last-issued--has-history');
    return;
  }

  /** issued_at は ISO 形式（例: "2026-04-16T09:45:00.000Z"）。
   *  JST の YYYY/MM/DD HH:mm に整形する。 */
  const issuedDate = new Date(row.issued_at);
  const jstLabel = formatJstTimestamp(issuedDate);

  el.textContent = `最終発行: ${jstLabel} ${row.receipt_number} ${formatCurrency(row.total_amount)}`;
  el.classList.add('receipt-last-issued--has-history');
}

/**
 * 領収書発行ボタンの有効/無効を更新する
 * 合計が0円の場合は無効化する
 */
function updateReceiptButtonState() {
  const btn = document.getElementById('btn-issue-receipt');
  if (!btn) return;

  const total = typeof getCurrentSettlementTotal === 'function'
    ? getCurrentSettlementTotal()
    : 0;
  btn.disabled = total <= 0;
}

// ============================================
// イベント委譲セットアップ
// ============================================

/**
 * 領収書セクションのイベントリスナーを設定する
 */
function initReceiptEvents() {
  const btnIssue = document.getElementById('btn-issue-receipt');
  if (btnIssue) {
    btnIssue.addEventListener('click', issueReceipt);
  }

  console.log('領収書発行のイベントリスナーを初期化しました');
}
