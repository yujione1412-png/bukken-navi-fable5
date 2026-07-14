/* 物件ナビ Service Worker
   方針:
   - アプリ本体(index.html)や物件データは「まずネットワークから取得」する。
     → デプロイした更新がすぐ反映される(古い画面が残らない)
   - 取得に成功したらキャッシュに保存し、圏外のときはキャッシュで表示する。
     → 現地(電波の悪い分譲地)でも一度開いたアプリは見られる
*/
const CACHE = "bukken-navi-v2";
const PRECACHE = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部(写真など)には触らない

  // 縮小写真(data/img/)は内容が変わらないため「キャッシュ優先」:
  // 一度見た写真は通信せずに表示でき、圏外でも見られる
  if (url.pathname.includes("/data/img/")) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || caches.match("./index.html"))
      )
  );
});
