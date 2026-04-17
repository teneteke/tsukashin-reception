/**
 * data-management.js — つかしん窓口精算ツール DBバックアップ/リストア
 *
 * T4.2: DBエクスポート（ファイル保存）と DBインポート（二段階確認付き上書き）。
 * 設定ボタン（⚙ #btn-settings）のポップオーバーから呼び出される。
 *
 * 依存: js/db.js（exportDB / importDB）
 */

/** インポート後のリロード遅延（トースト表示確保のため） */
const RELOAD_DELAY_MS = 800;

// ============================================
// エクスポート
// ============================================

/**
 * DB全体をSQLiteファイルとしてダウンロードさせる
 * ファイル名は tsukashin_backup_YYYYMMDD.sqlite（JST日付）
 */
async function exportDBToFile() {
  try {
    /** APIキーが設定されている場合、バックアップに含まれる旨を警告 */
    const apiKeyValue = getSetting('saas_api_key');
    if (apiKeyValue) {
      const ok = typeof window.confirmAction === 'function'
        ? await window.confirmAction(
            'バックアップの注意',
            'このバックアップファイルにはAPI設定（APIキー）が含まれます。\nファイルの取り扱いにご注意ください。'
          )
        : window.confirm('このバックアップファイルにはAPI設定（APIキー）が含まれます。\nファイルの取り扱いにご注意ください。\n続行しますか？');
      if (!ok) return;
    }

    const data = exportDB();
    const todayCompact = getTodayJST().replace(/-/g, '');
    const filename = `tsukashin_backup_${todayCompact}.sqlite`;

    const blob = new Blob([data], { type: 'application/vnd.sqlite3' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    console.log(`DBエクスポート完了: ${filename} (${data.length} bytes)`);
    showToast(`DBをエクスポートしました: ${filename}`);
  } catch (error) {
    /** 技術詳細はコンソールのみに残す（T6.9） */
    console.error('DBエクスポートに失敗しました:', error);
    /** ユーザーには対処方法を示す（T6.9） */
    showToast('バックアップの書き出しに失敗しました。もう一度お試しください。');
  }
}

// ============================================
// インポート（二段階確認付き）
// ============================================

/**
 * ファイルからDBをインポートする
 * 二段階確認: 1) confirm 上書き警告 → 2) prompt で "DELETE" を入力
 * 両方通過した場合のみ importDB を実行し、成功時はページリロード
 * @param {File} file - 選択されたSQLiteファイル
 */
async function importDBFromFile(file) {
  if (!file) return;

  /** 1段階目: 共有モーダルで上書き警告（T6.10） */
  const step1 = typeof window.confirmAction === 'function'
    ? await window.confirmAction(
        'DBインポートの確認',
        '現在のデータがすべて上書きされます。\nこの操作は元に戻せません。続行しますか？'
      )
    : window.confirm('現在のデータがすべて上書きされます。\nこの操作は元に戻せません。続行しますか？');
  if (!step1) return;

  /** 2段階目: DELETE の完全一致を要求（指定通り従来のままブラウザ prompt） */
  const step2 = window.prompt('確認のため DELETE と入力してください');
  if (step2 !== 'DELETE') {
    showToast('入力が一致しなかったためインポートを中止しました');
    return;
  }

  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    await importDB(bytes);
    showToast('DBインポートが完了しました。ページを再読み込みします...');
    /** 画面状態とインメモリキャッシュを確実に更新するためリロード */
    setTimeout(() => window.location.reload(), RELOAD_DELAY_MS);
  } catch (error) {
    /** 技術詳細はコンソールのみに残す（T6.9） */
    console.error('DBインポートに失敗しました:', error);
    /** ユーザーには対処方法を示す（T6.9） */
    showToast('バックアップの読み込みに失敗しました。もう一度お試しください。');
  }
}

// ============================================
// API設定の読み書き（T6.12）
// ============================================

/**
 * settingsテーブルから saas_api_endpoint と saas_api_key を読み込み、
 * 入力欄に反映する（未登録時は空文字）
 * @param {HTMLInputElement|null} endpointInput
 * @param {HTMLInputElement|null} keyInput
 */
function loadApiSettingsIntoInputs(endpointInput, keyInput) {
  if (!endpointInput || !keyInput) return;

  endpointInput.value = getSetting('saas_api_endpoint') || '';
  keyInput.value = getSetting('saas_api_key') || '';
}

/**
 * settingsテーブルの saas_api_endpoint と saas_api_key を更新する
 * @param {string} endpoint - APIエンドポイントURL
 * @param {string} apiKey - APIキー
 */
async function saveApiSettings(endpoint, apiKey) {
  const trimmedEndpoint = (endpoint || '').trim();
  const trimmedKey = (apiKey || '').trim();

  await upsertSetting('saas_api_endpoint', trimmedEndpoint);
  await upsertSetting('saas_api_key', trimmedKey);

  console.log('API設定を保存しました（endpoint=' + (trimmedEndpoint ? 'set' : 'empty') + ', key=' + (trimmedKey ? 'set' : 'empty') + '）');
}

// ============================================
// ストレージ使用量表示（Phase 15 T15.2）
// ============================================

/**
 * データ管理ダイアログのストレージセクションに使用量と永続化状態を表示する。
 * Storage API 未対応ブラウザではフォールバックメッセージを表示する。
 */
async function updateStorageUsageDisplay() {
  const textEl = document.getElementById('storage-usage-text');
  const statusEl = document.getElementById('storage-persist-status');
  if (!textEl) return;

  if (!navigator.storage || typeof navigator.storage.estimate !== 'function') {
    textEl.textContent = 'ストレージ情報を取得できません';
    if (statusEl) statusEl.textContent = '';
    return;
  }

  try {
    const estimate = await navigator.storage.estimate();
    const usageMB = ((estimate.usage || 0) / 1024 / 1024).toFixed(1);
    const quotaGB = ((estimate.quota || 0) / 1024 / 1024 / 1024).toFixed(1);
    textEl.textContent = `使用: ${usageMB} MB / 上限: ${quotaGB} GB`;

    if (statusEl && typeof navigator.storage.persisted === 'function') {
      const isPersisted = await navigator.storage.persisted();
      statusEl.textContent = isPersisted ? '（永続化: 有効）' : '（永続化: 未設定）';
      statusEl.classList.toggle('storage-usage__status--ok', isPersisted);
    }
  } catch (error) {
    console.warn('ストレージ情報の取得に失敗:', error);
    textEl.textContent = 'ストレージ情報を取得できませんでした';
    if (statusEl) statusEl.textContent = '';
  }
}

// ============================================
// 設定ポップオーバー初期化
// ============================================

/**
 * ⚙ ボタンとポップオーバーのイベントを登録する
 */
function initDataManagement() {
  const btnSettings = document.getElementById('btn-settings');
  const overlay = document.getElementById('data-mgmt-overlay');
  const btnExport = document.getElementById('btn-db-export');
  const btnImport = document.getElementById('btn-db-import');
  const btnClose = document.getElementById('btn-db-close');
  const fileInput = document.getElementById('db-import-file');

  /** API設定（T6.12） */
  const apiEndpointInput = document.getElementById('api-endpoint-input');
  const apiKeyInput = document.getElementById('api-key-input');
  const btnApiSave = document.getElementById('btn-api-save');

  if (!btnSettings || !overlay || !btnExport || !btnImport || !btnClose || !fileInput) return;

  /** ⚙ クリックで開く。開くたびに settings から API 設定を読み込み、ストレージ使用量を更新 */
  btnSettings.addEventListener('click', () => {
    loadApiSettingsIntoInputs(apiEndpointInput, apiKeyInput);
    updateStorageUsageDisplay();
    overlay.hidden = false;
  });

  /** API設定の保存 */
  if (btnApiSave && apiEndpointInput && apiKeyInput) {
    btnApiSave.addEventListener('click', async () => {
      await saveApiSettings(apiEndpointInput.value, apiKeyInput.value);
      showToast('API設定を保存しました');
    });
  }

  /** オーバーレイ外側クリックで閉じる */
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.hidden = true;
  });

  /** Esc で閉じる */
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') overlay.hidden = true;
  });

  /** 閉じるボタン */
  btnClose.addEventListener('click', () => {
    overlay.hidden = true;
  });

  /** DBエクスポート */
  btnExport.addEventListener('click', () => {
    overlay.hidden = true;
    exportDBToFile();
  });

  /** DBインポート: 隠しファイル入力を起動 */
  btnImport.addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });

  /** ファイル選択直後にインポート処理を起動 */
  fileInput.addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) {
      overlay.hidden = true;
      importDBFromFile(file);
    }
  });
}
