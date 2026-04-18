/**
 * sw.js — つかしん窓口精算ツール Service Worker
 *
 * キャッシュファースト戦略で全アプリファイルをキャッシュし、
 * オフライン動作を実現する。
 */

/** キャッシュ名（バージョン変更でキャッシュ更新） */
const CACHE_NAME = 'tsukashin-v25';

/**
 * キャッシュ対象のアプリファイル一覧
 * 新規ファイル追加時はここにも追加すること
 */
const CACHE_FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/ui-helpers.js',
  './js/db.js',
  './js/repository.js',
  './js/csv.js',
  './js/confirm-dialog.js',
  './js/visitor-list.js',
  './js/individual-detail.js',
  './js/product-master.js',
  './js/receipt.js',
  './js/data-management.js',
  './js/sync.js',
  './lib/sql-wasm.js',
  './lib/sql-wasm.wasm',
  './lib/jspdf.umd.min.js',
  './lib/NotoSansJP-Regular.ttf',
  './lib/encoding.min.js',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
  './manifest.json'
];

/**
 * installイベント — 初回インストール時に全ファイルをキャッシュ
 */
self.addEventListener('install', (event) => {
  console.log('Service Worker: インストール開始');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Service Worker: ファイルをキャッシュに追加中...');
        return cache.addAll(CACHE_FILES);
      })
      .then(() => {
        console.log('Service Worker: インストール完了');
        /** 即座にアクティブ化 */
        return self.skipWaiting();
      })
      .catch((error) => {
        console.error('Service Worker: キャッシュ追加に失敗:', error);
      })
  );
});

/**
 * activateイベント — 古いキャッシュを削除
 */
self.addEventListener('activate', (event) => {
  console.log('Service Worker: アクティブ化');
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            /** 現在のバージョン以外のキャッシュを削除 */
            if (cacheName !== CACHE_NAME) {
              console.log(`Service Worker: 古いキャッシュを削除: ${cacheName}`);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => {
        /** 全クライアントを即座に制御下に置く */
        return self.clients.claim();
      })
  );
});

/**
 * fetchイベント — キャッシュファースト戦略
 * キャッシュにあればキャッシュから返し、なければネットワークへフォールバック
 */
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }

        /** キャッシュにない場合はネットワークから取得 */
        return fetch(event.request)
          .then((networkResponse) => {
            /**
             * キャッシュ対象を既知のアプリファイルに限定する
             * APIレスポンス等の機密データがキャッシュに残ることを防ぐ
             */
            if (
              networkResponse &&
              networkResponse.status === 200 &&
              networkResponse.type === 'basic'
            ) {
              const requestUrl = new URL(event.request.url);
              const scopePath = new URL(self.registration.scope).pathname;
              const relativePath = './' + requestUrl.pathname.replace(scopePath, '');
              const isCacheTarget = CACHE_FILES.includes(relativePath);
              if (isCacheTarget) {
                const responseToCache = networkResponse.clone();
                caches.open(CACHE_NAME)
                  .then((cache) => {
                    cache.put(event.request, responseToCache);
                  });
              }
            }
            return networkResponse;
          })
          .catch(() => {
            /**
             * ネットワークも失敗した場合
             * HTMLリクエストならオフラインページ（index.html）を返す
             */
            if (event.request.headers.get('accept') &&
                event.request.headers.get('accept').includes('text/html')) {
              return caches.match('./index.html');
            }
          });
      })
  );
});
