/* HWPX 보고서 뷰어 서비스 워커
 * 앱 파일과 글꼴을 기기에 담아 두어 인터넷 없이도 열리게 하고, 다른 앱에서 공유한 파일을 받아 뷰어로 넘긴다.
 * 문서 파일은 기기 안에서만 다루며 어디로도 보내지 않는다. */
const VERSION = 'cf983bbd2b3b';
const APP_CACHE = 'hwpx-viewer-app-' + VERSION;
const SHARE_CACHE = 'hwpx-viewer-share';
const FILES = [
  "index.html",
  "engine.js",
  "metrics.js",
  "jszip.min.js",
  "pwa.js",
  "fonts.css",
  "manifest.webmanifest",
  "samples/event.json",
  "fonts/hwpxviewer-myeongjo-400.woff2",
  "fonts/hwpxviewer-myeongjo-700.woff2",
  "fonts/hwpxviewer-gothic-400.woff2",
  "fonts/hwpxviewer-gothic-700.woff2",
  "fonts/noto-sans-kr-400.woff2",
  "fonts/noto-sans-kr-500.woff2",
  "fonts/noto-sans-kr-700.woff2",
  "fonts/noto-sans-kr-800.woff2",
  "fonts/noto-sans-kr-900.woff2",
  "icons/apple-touch-icon.png",
  "icons/favicon.svg",
  "icons/icon-192.png",
  "icons/icon-32.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png"
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('hwpx-viewer-app-') && key !== APP_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

const scopePath = () => new URL(self.registration.scope).pathname;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const rel = url.pathname.slice(scopePath().length);
  if (req.method === 'POST' && rel === 'share') {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;
  event.respondWith((async () => {
    const cache = await caches.open(APP_CACHE);
    if (req.mode === 'navigate' && (rel === '' || rel === 'index.html' || rel === 'share')) {
      const page = await cache.match('index.html');
      if (page) return page;
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (e) {
      return new Response('', { status: 504, statusText: 'offline' });
    }
  })());
});

async function receiveShare(req) {
  try {
    const form = await req.formData();
    const files = form.getAll('file').filter((f) => f && typeof f === 'object' && typeof f.arrayBuffer === 'function');
    const cache = await caches.open(SHARE_CACHE);
    for (const k of await cache.keys()) await cache.delete(k);
    let i = 0;
    for (const f of files) {
      await cache.put(new Request('shared/' + i++), new Response(f, {
        headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(f.name || '공유받은 문서.hwpx') },
      }));
    }
  } catch (e) { /* 페이지가 '찾지 못했습니다'를 알린다 */ }
  return Response.redirect(new URL('./?share=1', self.registration.scope).href, 303);
}
