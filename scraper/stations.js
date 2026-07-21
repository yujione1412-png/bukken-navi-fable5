/* scraper/stations.js
   駅情報がない物件に、位置情報から最寄り駅を自動設定する。
   実行: node scraper/stations.js(毎日の収集の後に実行される)
   ─────────────────────────────────
   ・OpenStreetMapの無料データベース(Overpass API)で周囲20kmの駅・電停を検索し、
     一番近いものを周辺施設に「(自動・最寄り)」として追加する
   ・距離・徒歩分は付けない(「一番近い駅はどこ?」に答えるための情報。距離はMapで確認)
   ・同じ場所(約100m単位)の問い合わせ結果は data/stations.json に控えて再利用し、
     毎回問い合わせ直さない(新規物件のぶんだけ、1.5秒間隔で最大50件/回)
   ・すでに駅・電停の情報がある物件(すまいーだ・よかタウン等)には何もしない
*/
const fs = require("fs");
const path = require("path");
const { sleep, loadData } = require("./common");

const DATA_FILE = path.join(__dirname, "../data/listings.json");
const CACHE_FILE = path.join(__dirname, "../data/stations.json");
const UA = "BukkenNaviBot/1.0 (shanai-riyou)";
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const RADIUS_M = 20000;   // 駅が遠い地域でも必ず見つかるよう20km
const LIMIT = 50;         // 1回の実行での新規問い合わせ上限
const DELAY_MS = 1500;

const cacheKey = (lat, lon) => lat.toFixed(3) + "," + lon.toFixed(3);
function coordsOf(l) {
  const m = String(l.locText || "").match(/(-?\d{1,2}\.\d{3,})\s*[, ]\s*(-?\d{2,3}\.\d{3,})/);
  return m ? [+m[1], +m[2]] : null;
}
function distKm(a, b) {
  const R = 6371, rad = (x) => x * Math.PI / 180;
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
/* すでに駅・電停の情報を持っているか(バス停だけの物件には駅を足す) */
function hasEki(l) {
  return (l.facilities || []).some((f) =>
    f.cat === "station" || /駅|電停/.test(String(f.name || "")));
}

/* 最寄り駅を1件返す: { name: "南熊本駅" } / 見つからなければ null */
async function queryNearest(lat, lon) {
  const q = `[out:json][timeout:25];(` +
    `node(around:${RADIUS_M},${lat},${lon})[railway=station];` +
    `node(around:${RADIUS_M},${lat},${lon})[railway=halt];` +
    `node(around:${RADIUS_M},${lat},${lon})[railway=tram_stop];` +
    `);out body;`;
  for (const ep of ENDPOINTS) {
    try {
      const res = await fetch(ep, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(q),
      });
      if (!res.ok) continue;
      const j = await res.json();
      const els = (j.elements || []).filter((e) =>
        e.lat && e.lon && e.tags && (e.tags["name:ja"] || e.tags.name));
      if (!els.length) return null;
      let best = null, bd = Infinity;
      for (const e of els) {
        const d = distKm([lat, lon], [e.lat, e.lon]);
        if (d < bd) { bd = d; best = e; }
      }
      const nm = best.tags["name:ja"] || best.tags.name;
      const suffix = best.tags.railway === "tram_stop" ? "電停"
        : /駅$/.test(nm) ? "" : "駅";
      return { name: nm + suffix };
    } catch (e) { /* 次のエンドポイントを試す */ }
  }
  return null;
}

async function main() {
  console.log("=== 最寄り駅の自動設定 開始 ===");
  const data = loadData(DATA_FILE);
  const listings = data.listings || [];
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) || {}; } catch (e) {}

  let attached = 0, queried = 0, cacheHit = 0, noCoord = 0, skipped = 0;
  for (const l of listings) {
    if (l.status === "ended") continue;
    if (hasEki(l)) { skipped++; continue; }
    const c = coordsOf(l);
    if (!c) { noCoord++; continue; }
    const k = cacheKey(c[0], c[1]);
    let hit = cache[k];
    if (hit === undefined) {
      if (queried >= LIMIT) continue;   // 上限に達した分は次回の実行で
      await sleep(DELAY_MS);
      const r = await queryNearest(c[0], c[1]);
      hit = cache[k] = { name: (r && r.name) || "" };
      queried++;
    } else cacheHit++;
    if (hit.name) {
      l.facilities = [{ name: hit.name, min: "", cat: "station", auto: true },
        ...(l.facilities || [])];
      attached++;
    }
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
  fs.writeFileSync(DATA_FILE, JSON.stringify(
    { updatedAt: data.updatedAt, count: listings.length, listings }, null, 1));
  console.log(`=== 完了: 最寄り駅を設定 ${attached}件` +
    `(新規問い合わせ ${queried}件 / 控えから再利用 ${cacheHit}件` +
    ` / 駅情報あり ${skipped}件 / 位置情報なし ${noCoord}件)===`);
}

module.exports = { queryNearest, hasEki, cacheKey };
if (require.main === module) main().catch((e) => { console.error("[ERROR]", e); process.exit(1); });
