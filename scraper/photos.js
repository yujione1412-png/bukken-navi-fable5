/* scraper/photos.js
   掲載中の全物件の写真を横640pxに縮小して data/img/ に保存し、
   listings.json の各写真に local(縮小版のパス)を書き込む。
   実行: node scraper/photos.js(毎週の収集の後に実行される)
   ─────────────────────────────────
   ・同じ写真は2回落とさない(URLのハッシュ名で保存し、既存ならスキップ)
   ・掲載終了物件は新規取得しない(すでにある縮小版はそのまま残す)
   ・取得に失敗した写真は local を付けない(アプリは元URLで表示する)
*/
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const { sleep, loadData } = require("./common");

const DATA_FILE = path.join(__dirname, "../data/listings.json");
const IMG_DIR = path.join(__dirname, "../data/img");
const WIDTH = 640;      // 縮小後の横幅(px)
const QUALITY = 72;     // JPEG画質(1-100)
const DELAY_MS = 300;   // 1枚ごとの待ち時間(相手サーバーへの配慮)
const UA = "BukkenNaviBot/1.0 (shanai-riyou)";

function hashName(url) {
  return crypto.createHash("sha1").update(String(url)).digest("hex").slice(0, 20) + ".jpg";
}
async function processPhoto(buf) {
  return sharp(buf)
    .rotate()                                        // 撮影時の向き情報を反映
    .resize({ width: WIDTH, withoutEnlargement: true })
    .jpeg({ quality: QUALITY, mozjpeg: true })
    .toBuffer();
}

async function main() {
  console.log("=== 写真の縮小保存 開始 ===");
  const data = loadData(DATA_FILE);
  const listings = data.listings || [];
  fs.mkdirSync(IMG_DIR, { recursive: true });

  let done = 0, skip = 0, fail = 0;
  for (const l of listings) {
    if (l.status === "ended") continue;   // 掲載中のみ新規取得
    for (const p of (l.photos || [])) {
      if (!p || !p.url) continue;
      const name = hashName(p.url);
      const rel = "data/img/" + name;
      const file = path.join(IMG_DIR, name);
      if (fs.existsSync(file)) { p.local = rel; skip++; continue; }
      await sleep(DELAY_MS);
      try {
        const res = await fetch(p.url, { headers: { "User-Agent": UA } });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        const out = await processPhoto(buf);
        fs.writeFileSync(file, out);
        p.local = rel;
        done++;
        if (done % 50 === 0) console.log(`  縮小保存 ${done}枚目…`);
      } catch (e) {
        fail++;   // 失敗した写真はlocalなし(アプリが元URLで表示)
      }
    }
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(
    { updatedAt: data.updatedAt, count: listings.length, listings }, null, 1));

  const files = fs.readdirSync(IMG_DIR);
  const bytes = files.reduce((n, f) => n + fs.statSync(path.join(IMG_DIR, f)).size, 0);
  console.log(`=== 完了: 新規${done}枚 / 既存${skip}枚 / 失敗${fail}枚` +
    ` / 保存合計 ${files.length}枚 ≒ ${(bytes / 1024 / 1024).toFixed(1)}MB ===`);
}

module.exports = { hashName, processPhoto };
if (require.main === module) main().catch((e) => { console.error("[ERROR]", e); process.exit(1); });
