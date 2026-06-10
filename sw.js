// sw.js — 自动跟随 index.html 版本更新缓存
// 版本由 index.html 通过 postMessage 传入，无需手动改此文件

let CACHE = "cf2026-v1"; // 初始值，会被 index.html 传来的版本号覆盖
const ASSETS = ["./", "./index.html", "./manifest.json"];

// 收到 index.html 发来的版本号，更新缓存名并清除旧缓存
self.addEventListener("message", e => {
  if (e.data && e.data.type === "SET_VERSION") {
    const newCache = "cf2026-" + e.data.version;
    if (newCache !== CACHE) {
      CACHE = newCache;
      // 清除所有旧缓存
      caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
      ).then(() => {
        // 重新缓存最新资源
        caches.open(CACHE).then(c => c.addAll(ASSETS));
      });
    }
  }
  if (e.data && e.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // API 请求走网络，不缓存
  if (url.hostname.includes("mgtv.com") || url.hostname.includes("localhost")) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ errno: -1, errmsg: "离线" }), {
          headers: { "Content-Type": "application/json" }
        })
      )
    );
    return;
  }

  // 应用资源：网络优先，失败走缓存（保证总是拿最新文件）
  e.respondWith(
    fetch(e.request).then(resp => {
      if (resp.ok) {
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return resp;
    }).catch(() => caches.match(e.request))
  );
});
