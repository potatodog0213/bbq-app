
const CACHE_NAME = 'malinji-pwa-shell-v2';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

// ================================
// 安裝 Service Worker
// ================================

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    await cache.addAll(APP_SHELL);

    await self.skipWaiting();
  })());
});


// ================================
// 啟用及清除舊版快取
// ================================

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    await Promise.all(
      keys
        .filter((key) =>
          key.startsWith('malinji-pwa-shell-') &&
          key !== CACHE_NAME
        )
        .map((key) => caches.delete(key))
    );

    await self.clients.claim();
  })());
});


// ================================
// 背景推播接收
// ================================

self.addEventListener('push', (event) => {

  event.waitUntil((async () => {

    let payload = {};

    try {

      if (event.data) {

        const raw = event.data.text();

        try {
          payload = JSON.parse(raw);
        } catch (_) {
          payload = {
            body: raw
          };
        }

      }

    } catch (error) {

      console.error(
        '[馬鈴吉碳烤] 讀取推播內容失敗：',
        error
      );

    }

    const title = String(
      payload.title || '馬鈴吉碳烤｜新訂單'
    );

    const options = {

      body: String(
        payload.body ||
        '收到一筆新訂單，請開啟訂單管理查看。'
      ),

      icon: './icons/icon-192.png',

      badge: './icons/icon-192.png',

      tag: payload.tag ||
        'malinji-customer-order',

      renotify: true,

      data: {

        url: payload.url || './'

      }

    };

    await self.registration.showNotification(
      title,
      options
    );

  })());

});


// ================================
// 點擊通知後開啟店家後台
// ================================

self.addEventListener('notificationclick', (event) => {

  event.notification.close();

  event.waitUntil((async () => {

    const scopeUrl = new URL(
      self.registration.scope
    );

    const rawTarget =
      event.notification.data &&
      event.notification.data.url
        ? String(event.notification.data.url)
        : './';

    let targetUrl;

    if (
      rawTarget === '/' ||
      rawTarget === ''
    ) {

      targetUrl = scopeUrl;

    } else {

      targetUrl = new URL(
        rawTarget,
        scopeUrl
      );

    }

    // 避免通知跳出本網站
    if (targetUrl.origin !== scopeUrl.origin) {
      targetUrl = scopeUrl;
    }

    const windowClients =
      await self.clients.matchAll({

        type: 'window',

        includeUncontrolled: true

      });

    // 如果店家後台已經開啟，就切回原本視窗
    for (const client of windowClients) {

      if (
        client.url.startsWith(
          scopeUrl.origin + scopeUrl.pathname
        )
      ) {

        if (
          'navigate' in client &&
          client.url !== targetUrl.href
        ) {

          await client.navigate(
            targetUrl.href
          );

        }

        return client.focus();

      }

    }

    // 如果後台沒有開啟，就開啟新的視窗
    return self.clients.openWindow(
      targetUrl.href
    );

  })());

});


// ================================
// 網頁快取與離線支援
// ================================

self.addEventListener('fetch', (event) => {

  const request = event.request;

  const url = new URL(request.url);

  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin
  ) {
    return;
  }

  // 網頁採用網路優先
  if (request.mode === 'navigate') {

    event.respondWith((async () => {

      const cache = await caches.open(
        CACHE_NAME
      );

      try {

        const response = await fetch(request);

        if (response && response.ok) {

          cache.put(
            request,
            response.clone()
          );

        }

        return response;

      } catch (error) {

        return (
          await cache.match(request)
        ) ||
        (
          await cache.match('./index.html')
        ) ||
        Response.error();

      }

    })());

    return;

  }


  // 圖示及 manifest 使用快取
  // 不攔截 Supabase 或其他 API

  if (
    /\/(icons\/|manifest\.json$)/.test(
      url.pathname
    )
  ) {

    event.respondWith((async () => {

      const cache = await caches.open(
        CACHE_NAME
      );

      const cached = await cache.match(
        request
      );

      if (cached) {
        return cached;
      }

      const response = await fetch(request);

      if (response && response.ok) {

        cache.put(
          request,
          response.clone()
        );

      }

      return response;

    })());

  }

});
