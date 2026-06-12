// 乘风2026 Service Worker
// 只缓存同源 GET 请求，跳过 chrome-extension / POST / Worker API 请求
// ⚠️ 每次更新文件时修改这里的版本号，SW 会自动清除旧缓存并接管页面

const CACHE_NAME = "cf2026-2026-06-11-v12";

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("install", (event) => {
  // 预缓存核心资源
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(["/", "/index.html", "/manifest.json"])
        .catch(() => {}) // 资源不存在时不阻塞安装
    )
  );
});

self.addEventListener("activate", (event) => {
  // 清理旧缓存
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // ── 跳过条件 ──────────────────────────────────────────
  // 1. 非 GET 请求（POST / PUT 等不可缓存）
  if (req.method !== "GET") return;

  // 2. chrome-extension:// 或其他非 http(s) 协议
  if (!req.url.startsWith("http://") && !req.url.startsWith("https://")) return;

  // 3. Worker API（投票接口、KV 同步接口）——始终走网络
  if (req.url.includes("workers.dev") || req.url.includes("vote.api.mgtv.com")) return;

  // 4. Google Fonts 等第三方资源——不拦截，让浏览器自己处理
  if (!req.url.startsWith(self.location.origin)) return;
  // ──────────────────────────────────────────────────────

  // 同源 GET：Cache First，网络兜底
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((response) => {
        // 只缓存成功的普通响应
        if (response && response.status === 200 && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return response;
      });
    })
  );
});
