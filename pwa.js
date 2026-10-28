/* 설치형 앱 기능: 앱 파일을 기기에 담아 두기(서비스 워커), 공유받은 파일 열기, 파일 연결로 열기, 설치 안내 */
(function () {
  'use strict';
  const SHARE_CACHE = 'hwpx-viewer-share';
  const standalone = () =>
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  const prefs = {
    get(k) { try { return localStorage.getItem('hwpx-viewer:' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('hwpx-viewer:' + k, v); } catch (e) { /* 저장 안 됨 */ } },
  };
  const viewer = () => window.HwpxViewer || null;

  // ------------------------------------------------------------------ 서비스 워커
  if ('serviceWorker' in navigator) {
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && viewer()) viewer().toast('새 버전을 받았습니다. 앱을 다시 열면 적용됩니다.');
      hadController = true;
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 설치 기능 없이도 뷰어는 동작 */ });
    });
  }

  // ------------------------------------------------------------------ 시작할 때: 다른 앱에서 공유받은 파일
  window.HWPX_BOOT = async function (api) {
    const q = new URLSearchParams(location.search);
    if (!q.has('share')) return false;
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* 주소 정리 실패는 무시 */ }
    if (!('caches' in window)) return false;
    try {
      const cache = await caches.open(SHARE_CACHE);
      const keys = await cache.keys();
      if (!keys.length) {
        api.toast('공유받은 파일을 찾지 못했습니다. 다시 공유해 주세요.');
        return false;
      }
      const res = await cache.match(keys[0]);
      let name = '공유받은 문서.hwpx';
      try { name = decodeURIComponent(res.headers.get('x-file-name') || '') || name; } catch (e) { /* 이름 없음 */ }
      const buf = await res.arrayBuffer();
      for (const k of keys) await cache.delete(k);
      await api.openBuffer(buf, { name });
      return api.hasDoc();
    } catch (e) {
      return false;
    }
  };

  // ------------------------------------------------------------------ 파일 연결로 열기(지원하는 기기에서만)
  if (window.launchQueue && typeof window.launchQueue.setConsumer === 'function') {
    window.launchQueue.setConsumer(async (params) => {
      if (!params || !params.files || !params.files.length) return;
      try {
        const file = await params.files[0].getFile();
        const go = () => viewer() && viewer().openFile(file);
        if (viewer()) go(); else document.addEventListener('DOMContentLoaded', go, { once: true });
      } catch (e) { /* 열지 못함 */ }
    });
  }

  // ------------------------------------------------------------------ 기기 저장 공간을 지우지 않도록 요청
  try {
    if (navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then((ok) => { if (!ok && navigator.storage.persist) navigator.storage.persist(); }).catch(() => {});
    }
  } catch (e) { /* 지원 안 함 */ }

  // ------------------------------------------------------------------ 설치 안내
  let deferred = null;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function hideInstall() {
    const el = document.getElementById('install');
    if (el) { el.hidden = true; el.innerHTML = ''; el.onclick = null; }
  }
  function showInstall(kind) {
    if (standalone() || prefs.get('install-dismissed')) return;
    const el = document.getElementById('install');
    if (!el) return;
    el.innerHTML = kind === 'android'
      ? '<p>이 뷰어를 휴대폰에 앱으로 설치할 수 있습니다. 설치하면 인터넷이 없어도 열립니다.</p><div class="row"><button class="btn primary" type="button" data-act="install">설치</button><button class="btn" type="button" data-act="dismiss">닫기</button></div>'
      : '<p>공유 단추를 누른 뒤 <b>홈 화면에 추가</b>를 고르면 앱처럼 설치됩니다. 설치하면 인터넷이 없어도 열립니다.</p><div class="row"><button class="btn" type="button" data-act="dismiss">닫기</button></div>';
    el.hidden = false;
    el.onclick = async (ev) => {
      const t = ev.target.closest('[data-act]');
      if (!t) return;
      if (t.dataset.act === 'install' && deferred) {
        const prompt = deferred;
        deferred = null;
        try { await prompt.prompt(); await prompt.userChoice; } catch (e) { /* 취소 */ }
        hideInstall();
      } else if (t.dataset.act === 'dismiss') {
        prefs.set('install-dismissed', '1');
        hideInstall();
      }
    };
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    showInstall('android');
  });
  window.addEventListener('appinstalled', () => { deferred = null; hideInstall(); });
  const onReady = () => { if (isIOS && !standalone()) showInstall('ios'); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
  else onReady();
})();
