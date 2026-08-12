/* OPS 設備追蹤 — 離線快取
   改版時把 VERSION 加一，使用者下次開啟就會拿到新版。 */
const VERSION = "ops-equip-v3";

const SHELL = [
  "./", "./index.html", "./js/app.js", "./js/store.js",
  "./manifest.json", "./icon-192.png", "./icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 資料的來源絕不能被快取——一旦攔下來，同步就會永遠拿到舊清單。
   data.json 也排除：它是資料，不是靜態資源，由 app 自己管快取。 */
const PASS_THROUGH = [
  /^https:\/\/api\.github\.com\//,
  /^https:\/\/raw\.githubusercontent\.com\//,
  /\/data\.json(\?|$)/,
];

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (PASS_THROUGH.some(re => re.test(req.url))) return;

  // 頁面本身走 network-first，確保部署後拿得到新版
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html").then(r => r || caches.match("./")))
    );
    return;
  }

  // 其餘資源 cache-first
  e.respondWith(
    caches.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req).then(res => {
        if (res.ok && new URL(req.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
