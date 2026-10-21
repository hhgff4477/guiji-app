/* 鬼邮局 Service Worker
   作用：1) 让页面能被「装到桌面」并弹系统通知；2) 断网时还能打开外壳。
   装的是网页，更新策略必须偏保守——宁可多走网络，也不能让用户看到旧脚本。 */

const CACHE = 'guiji-shell-v4';
const SHELL = [
  './',
  './index.html',
  './assets/style.css',
  './assets/sdk.js',
  './assets/jszip.min.js',
  './assets/icon-192.png',
  './assets/icon-180.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 脚本和样式：网络优先。拿不到才用缓存。
   这样每次发版都是新代码，不会出现「新页面 + 旧脚本」。 */
function networkFirst(req) {
  return fetch(req).then((res) => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  }).catch(() =>
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || Response.error())
  );
}

function cacheFirst(req) {
  return caches.match(req, { ignoreSearch: true }).then((hit) => {
    if (hit) return hit;
    return fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;

  // 打开页面：网络优先，断网用缓存
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
        return res;
      }).catch(() =>
        caches.match('./index.html', { ignoreSearch: true })
          .then((hit) => hit || caches.match('./', { ignoreSearch: true }))
          .then((hit) => hit || new Response('没网，连上再打开一次', {
            status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          }))
      )
    );
    return;
  }

  if (/\.(js|css)$/.test(url.pathname)) {
    event.respondWith(networkFirst(req));
    return;
  }

  if (/\.(png|jpg|jpeg|svg|ico)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
  }
});

/* 点通知：优先聚焦已开的页面并跳到时间表 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if ('focus' in c) {
          try { c.postMessage({ type: 'open-todos' }); } catch (e) {}
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow('./?tab=todos');
    })
  );
});
