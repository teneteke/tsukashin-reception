/**
 * app.js — つかしん窓口精算ツール メインモジュール
 *
 * 画面切り替え、キーボードショートカット、アプリ初期化を制御する。
 */

// ============================================
// 画面管理
// ============================================

/**
 * 現在アクティブな画面IDを保持する
 * @type {string}
 */
let currentScreen = 'screen-visitor-list';

/**
 * 現在選択されている来館者の会員ID（画面2への遷移で使用）
 * @type {string|null}
 */
let selectedMemberId = null;

/**
 * 指定した画面に切り替える
 * @param {string} screenId - 切り替え先の画面要素のID
 */
function switchScreen(screenId) {
  /** 全画面から active クラスを除去 */
  const screens = document.querySelectorAll('.screen');
  screens.forEach((screen) => {
    screen.classList.remove('screen--active');
  });

  /** 指定画面を活性化 */
  const targetScreen = document.getElementById(screenId);
  if (targetScreen) {
    targetScreen.classList.add('screen--active');
    currentScreen = screenId;
    console.log(`画面切り替え: ${screenId}`);
  } else {
    console.error(`画面が見つかりません: ${screenId}`);
  }
}

/**
 * 画面2（個人詳細）へ遷移する
 * 来館者テーブルで行が選択されている場合のみ遷移可能
 */
function navigateToDetail() {
  /** 選択行を取得 */
  const selectedRow = document.querySelector('#visitor-table-body tr.row--selected');

  if (!selectedRow) {
    console.log('行が選択されていないため、詳細画面に遷移できません');
    return;
  }

  /** 選択行の会員IDを取得（data属性から） */
  selectedMemberId = selectedRow.dataset.memberId || null;
  console.log(`詳細画面に遷移: 会員ID = ${selectedMemberId}`);

  switchScreen('screen-individual-detail');

  /** 画面2の内容を読み込む */
  if (typeof loadIndividualDetail === 'function' && selectedMemberId) {
    loadIndividualDetail(selectedMemberId);
  }
}

/**
 * 画面1（来館者一覧）へ戻る
 */
function navigateToList() {
  switchScreen('screen-visitor-list');
  /** 画面1に戻ったときにテーブルを再描画 */
  if (typeof renderVisitorTable === 'function') {
    renderVisitorTable();
  }

  /** 直前に選択されていた会員の行を再選択する */
  if (selectedMemberId) {
    const row = document.querySelector(
      `#visitor-table-body tr[data-member-id="${CSS.escape(selectedMemberId)}"]`
    );
    if (row) {
      selectRow(row);
    } else {
      updateFooterButtons(false);
    }
  }

  console.log('来館者一覧に戻りました');
}

/**
 * 画面3（期間履歴）へ遷移する（T7.1）
 * 画面2から呼ばれる。currentDateRange を使って履歴を描画する。
 */
function navigateToHistory() {
  switchScreen('screen-period-history');
  if (typeof renderPeriodHistoryTable === 'function') {
    renderPeriodHistoryTable();
  }
  console.log('期間履歴画面に遷移しました');
}

/**
 * 画面2（個人詳細）へ戻る（T7.1）
 * 画面3・画面4からの Esc / 戻るボタン で呼ばれる。
 */
function navigateBackToDetail() {
  switchScreen('screen-individual-detail');
  console.log('個人詳細画面に戻りました');
}

/**
 * 画面4（商品マスタ）へ遷移する（T7.2）
 * 画面2 から [商品マスタ] ボタンまたは F3 で呼ばれる。
 */
function navigateToProductMaster() {
  switchScreen('screen-product-master');
  if (typeof renderProductMasterTable === 'function') {
    renderProductMasterTable();
  }
  console.log('商品マスタ画面に遷移しました');
}

// ============================================
// テーブル行選択
// ============================================

/**
 * 来館者テーブルで行を選択状態にする
 * @param {HTMLTableRowElement} row - 選択する行要素
 */
function selectRow(row) {
  /** 既存の選択を解除 */
  const previouslySelected = document.querySelector('#visitor-table-body tr.row--selected');
  if (previouslySelected) {
    previouslySelected.classList.remove('row--selected');
    previouslySelected.setAttribute('aria-selected', 'false');
  }

  /** 新しい行を選択 */
  row.classList.add('row--selected');
  row.setAttribute('aria-selected', 'true');

  /** フッターボタンの有効化 */
  updateFooterButtons(true);
}

/**
 * 行の選択を解除する
 */
function clearRowSelection() {
  const selectedRow = document.querySelector('#visitor-table-body tr.row--selected');
  if (selectedRow) {
    selectedRow.classList.remove('row--selected');
    selectedRow.setAttribute('aria-selected', 'false');
  }
  updateFooterButtons(false);
}

/**
 * フッターのアクションボタンの有効/無効を切り替える
 * @param {boolean} hasSelection - 行が選択されているか
 */
function updateFooterButtons(hasSelection) {
  const btnDetail = document.getElementById('btn-detail');
  const btnDelete = document.getElementById('btn-delete');
  if (btnDetail) btnDetail.disabled = !hasSelection;
  if (btnDelete) btnDelete.disabled = !hasSelection;
}

/**
 * 矢印キーで選択行を上下に移動する
 * @param {'up'|'down'} direction - 移動方向
 */
function moveRowSelection(direction) {
  const tableBody = document.getElementById('visitor-table-body');
  if (!tableBody) return;

  const rows = Array.from(tableBody.querySelectorAll('tr'));
  if (rows.length === 0) return;

  const currentSelected = tableBody.querySelector('tr.row--selected');
  let currentIndex = currentSelected ? rows.indexOf(currentSelected) : -1;

  if (direction === 'up') {
    /** 上方向：先頭なら末尾にループ */
    currentIndex = currentIndex <= 0 ? rows.length - 1 : currentIndex - 1;
  } else {
    /** 下方向：末尾なら先頭にループ */
    currentIndex = currentIndex >= rows.length - 1 ? 0 : currentIndex + 1;
  }

  selectRow(rows[currentIndex]);
}

// ============================================
// キーボードショートカット
// ============================================

/**
 * グローバルキーボードイベントを処理する
 * @param {KeyboardEvent} event
 */
function handleKeyDown(event) {
  /** インプット要素にフォーカスがある場合は一部のショートカットを無効化 */
  const activeElement = document.activeElement;
  const isInputFocused = activeElement &&
    (activeElement.tagName === 'INPUT' ||
     activeElement.tagName === 'TEXTAREA' ||
     activeElement.tagName === 'SELECT');

  /** F2: 詳細画面に遷移（画面1でのみ） */
  if (event.key === 'F2' && currentScreen === 'screen-visitor-list') {
    event.preventDefault();
    navigateToDetail();
    return;
  }

  /** F3: 商品マスタ画面に遷移（画面2でのみ、T7.2） */
  if (event.key === 'F3' && currentScreen === 'screen-individual-detail') {
    event.preventDefault();
    navigateToProductMaster();
    return;
  }

  /** Escape の遷移マップ（T7.1で画面3、T7.2で画面4追加） */
  if (event.key === 'Escape') {
    /** モーダルやオーバーレイが開いている場合はそちらに任せる */
    const confirmOverlay = document.getElementById('confirm-dialog-overlay');
    const settingsOverlay = document.getElementById('data-mgmt-overlay');
    if ((confirmOverlay && !confirmOverlay.hidden) || (settingsOverlay && !settingsOverlay.hidden)) {
      return;
    }
    if (currentScreen === 'screen-individual-detail') {
      event.preventDefault();
      navigateToList();
      return;
    }
    if (currentScreen === 'screen-period-history') {
      event.preventDefault();
      navigateBackToDetail();
      return;
    }
    if (currentScreen === 'screen-product-master') {
      event.preventDefault();
      navigateBackToDetail();
      return;
    }
  }

  /** インプット非フォーカス時のみ有効なショートカット */
  if (!isInputFocused && currentScreen === 'screen-visitor-list') {
    /** 矢印キーで行選択移動 */
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveRowSelection('up');
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveRowSelection('down');
      return;
    }

    /** / キーで検索バーにフォーカス */
    if (event.key === '/') {
      event.preventDefault();
      const searchInput = document.getElementById('search-input');
      if (searchInput) searchInput.focus();
      return;
    }
  }
}

// ============================================
// イベントリスナー設定
// ============================================

/**
 * アプリのイベントリスナーを初期化する
 */
function initEventListeners() {
  /** キーボードショートカット */
  document.addEventListener('keydown', handleKeyDown);

  /** テーブル行クリックで選択 */
  const tableBody = document.getElementById('visitor-table-body');
  if (tableBody) {
    tableBody.addEventListener('click', (event) => {
      const row = event.target.closest('tr');
      if (row) {
        selectRow(row);
      }
    });
  }

  /** [詳細 F2] ボタン */
  const btnDetail = document.getElementById('btn-detail');
  if (btnDetail) {
    btnDetail.addEventListener('click', () => {
      navigateToDetail();
    });
  }

  /** [← 戻る] ボタン（画面2） */
  const btnBack = document.getElementById('btn-back');
  if (btnBack) {
    btnBack.addEventListener('click', () => {
      navigateToList();
    });
  }

  /** [履歴を表示] ボタン（画面2、T7.1） */
  const btnShowHistory = document.getElementById('btn-show-history');
  if (btnShowHistory) {
    btnShowHistory.addEventListener('click', () => {
      navigateToHistory();
    });
  }

  /** [← 戻る] ボタン（画面3、T7.1） */
  const btnBackHistory = document.getElementById('btn-back-history');
  if (btnBackHistory) {
    btnBackHistory.addEventListener('click', () => {
      navigateBackToDetail();
    });
  }

  /** [商品マスタ] ボタン（画面2、T7.2） */
  const btnOpenProductMaster = document.getElementById('btn-open-product-master');
  if (btnOpenProductMaster) {
    btnOpenProductMaster.addEventListener('click', () => {
      navigateToProductMaster();
    });
  }

  /** [← 戻る] ボタン（画面4、T7.2） */
  const btnBackProductMaster = document.getElementById('btn-back-product-master');
  if (btnBackProductMaster) {
    btnBackProductMaster.addEventListener('click', () => {
      navigateBackToDetail();
    });
  }

  console.log('イベントリスナーの初期化が完了しました');
}

// ============================================
// Service Worker 登録
// ============================================

/**
 * Service Workerを登録する
 */
async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js');
      console.log('Service Worker 登録成功:', registration.scope);
    } catch (error) {
      console.error('Service Worker 登録失敗:', error);
    }
  }
}

// ============================================
// アプリ初期化
// ============================================

/**
 * アプリを初期化する
 */
async function initApp() {
  console.log('つかしん窓口精算ツールを起動しています...');

  /** キーボードショートカット等のUI基本リスナー（DB不要） */
  initEventListeners();

  /** データベース初期化（DB依存リスナーの前に行う） */
  const dbReady = await initDB();
  if (!dbReady) {
    console.error('DB初期化に失敗したため、アプリは制限モードで動作します');
    /** Service Workerだけは登録してオフライン対応を維持 */
    registerServiceWorker();
    return;
  }

  /** DB初期化成功後にDB依存のイベントリスナーを設定 */

  /** 画面1の対話系リスナー（[+] / 出席 / 受取 / インラインselect / メモ / 削除 / 検索 / 更新） */
  if (typeof initVisitorListEvents === 'function') {
    initVisitorListEvents();
  }

  /** 画面2の対話系リスナー（メモ / 日付範囲 / 追加 / 明細編集） */
  if (typeof initIndividualDetailEvents === 'function') {
    initIndividualDetailEvents();
  }

  /** 商品マスタのリスナー（フォーム送信 / インライン編集 / ソフト削除） */
  if (typeof initProductMasterEvents === 'function') {
    initProductMasterEvents();
  }

  /** 領収書発行ボタンのリスナー */
  if (typeof initReceiptEvents === 'function') {
    initReceiptEvents();
  }

  /** データ管理（DBエクスポート/インポート）のリスナー */
  if (typeof initDataManagement === 'function') {
    initDataManagement();
  }

  /** 来館者テーブルの初期描画 */
  if (typeof renderVisitorTable === 'function') {
    renderVisitorTable();
  }

  /** Service Worker登録 */
  registerServiceWorker();

  console.log('アプリの初期化が完了しました');
}

/** DOMContentLoaded で初期化 */
document.addEventListener('DOMContentLoaded', initApp);
