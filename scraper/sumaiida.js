/* scraper/sumaiida.js
   すまいーだ(sumaiida.com)の熊本県内の新築一戸建てを収集して
   data/listings.json のすまいーだ分を更新する。
   実行: node scraper/sumaiida.js
   ─────────────────────────────────
   構造(実ページを解析して確認済み):
   ・県ページ /ikkodate/area/kyushu/kumamoto/ に市区町村一覧リンク
   ・市区町村一覧 /ikkodate/list/area/kyushu/kumamoto/431XX/(page_numでページ送り)
   ・詳細ページは dt/dd の項目名/値ペア。1ページ=分譲地単位で、
     価格は「3,598万円～3,798万円」のような幅表記のことがある。
   ・robots.txt は物件ページの収集を禁止していない(問い合わせフォームのみ禁止)
*/
const cheerio = require("cheerio");
const { fetchHtml, sleep, pickPrice, dlPairs, mergeListings,
  loadData, saveData, todayStr, WAIT_MS } = require("./common");

const BASE = "https://sumaiida.com";
const PREF = BASE + "/ikkodate/area/kyushu/kumamoto/";
const DATA_FILE = __dirname + "/../data/listings.json";
const SOURCE = "sumaiida";
const MAX_PHOTOS = 5;
const MAX_PAGES_PER_CITY = 10;   // 暴走防止

const abs = (u) => (u.startsWith("http") ? u : BASE + u);
const DETAIL_RE = /href="([^"]*\/ikkodate\/[a-z0-9_-]+\/[a-z0-9_-]+\/(\d{8,}[-\d]*)\/?)"/g;

/* ページ内に実際に書かれているページ送りリンク(page_num=2以降)を拾う。
   URLを自前で組み立てると検索条件が欠けて1ページ目が返るため、実物のリンクを辿る */
function pickPageLinks(html, cityPath) {
  const out = new Set();
  const re = /href="([^"]*page_num=\d+[^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    let u = m[1].replace(/&amp;/g, "&");
    u = abs(u);
    if (!u.startsWith(BASE + cityPath)) continue;      // 同じ市区町村のページ送りだけ
    if (/[?&]page_num=1(&|$)/.test(u)) continue;       // 1ページ目は取得済み
    out.add(u);
  }
  return out;
}

function pickDetailLinks(html) {
  const out = new Map(); // url → id部分
  let m;
  DETAIL_RE.lastIndex = 0;
  while ((m = DETAIL_RE.exec(html))) {
    const url = abs(m[1]).replace(/\/?$/, "/");
    out.set(url, m[2]);
  }
  return out;
}

/* 詳細ページ1件を解析 */
function parseDetail(html, url, warnings) {
  const $ = cheerio.load(html);
  const warn = (msg) => warnings.push(`${url}\n    → ${msg}`);
  const kv = dlPairs($);
  const fullText = $("body").text().replace(/\s+/g, " ");

  const name = ($("h1").first().text() || "").replace(/\s+/g, " ").trim();
  if (!name) { warn("物件名(h1)が取れませんでした → スキップ"); return null; }

  // 価格(「販売価格」優先。幅表記「3,598万円～3,798万円」はそのまま残す)
  const price = pickPrice(kv, fullText, warn);

  // 所在地(「地図を見る」などの付属文言を除去)
  const address = (kv["所在地"] || "").replace(/地図を見る.*$/, "").replace(/\s+/g, " ").trim();

  // 面積(m² 表記はそのまま。幅表記も残す)
  const landArea = (kv["土地面積"] || "").trim();
  const buildingArea = (kv["建物面積"] || "").trim();

  // 間取り
  const layout = (kv["間取り"] || kv["間取"] || "").replace(/\s/g, "");

  // 構造/階数「木造 地上2～2階建」→ 2階建て
  const kozo = kv["構造/階数"] || kv["構造"] || "";
  const stories = /平屋|平家/.test(kozo) ? "平屋"
    : /3階/.test(kozo) ? "3階建て" : /2階/.test(kozo) ? "2階建て" : "";

  // 築年月「2026年07月完成予定」→「2026年7月」
  let builtAt = "";
  const bm = (kv["築年月"] || kv["完成時期"] || "").match(/(\d{4})年\s*0?(\d{1,2})月/);
  if (bm) builtAt = `${bm[1]}年${bm[2]}月`;

  // 販売棟数(分譲地の残り棟数。営業的に重要なので保持)
  const units = (kv["販売棟数"] || "").trim();

  // 交通(沿線・駅)を周辺施設として1件登録
  const facilities = [];
  const koutsu = (kv["沿線・駅"] || kv["交通"] || "").trim();
  if (koutsu) {
    const min = (koutsu.match(/徒歩\s*(\d+)\s*分/) || [])[1] || "";
    facilities.push({ name: koutsu, min, cat: /バス/.test(koutsu) && !/駅/.test(koutsu) ? "bus" : "station" });
  }

  // 緯度経度(Googleマップ埋め込みから)
  const lm = html.match(/q=([0-9.]{6,})\s*,\s*([0-9.]{6,})/);
  const locText = lm ? `${lm[1]}, ${lm[2]}` : "";

  // 写真: /bukken/image/H00130057580_3.jpg 形式。
  //  縮小版(_s)は本体に統合し、掲載順に最大5枚
  const groups = new Map();
  let order = 0;
  $("img[src]").each((_, img) => {
    let u = $(img).attr("src") || "";
    if (!/\/bukken\/image\/[^"']+\.(jpe?g|png)/i.test(u)) return;
    u = abs(u);
    const key = u.split("/").pop().replace(/_s(?=\.)/i, "").toLowerCase();
    const isSmall = /_s\.(jpe?g|png)$/i.test(u);
    const g = groups.get(key);
    if (!g) groups.set(key, { url: u, small: isSmall, order: order++ });
    else if (g.small && !isSmall) { g.url = u; g.small = false; }  // 大きい版を優先
  });
  const photos = [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .slice(0, MAX_PHOTOS)
    .map((g, i) => ({ id: "p" + (i + 1), url: g.url, main: i === 0 }));
  if (!photos.length) warn("写真が1枚も取れませんでした");

  const slug = ((url.match(/\/(\d{8,}[-\d]*)\/?$/) || [])[1] || "").replace(/\/$/, "");
  return {
    id: `${SOURCE}-${slug}`,
    source: SOURCE,
    name, price, address,
    detailUrl: url,
    layout, stories, builtAt,
    buildingArea, landArea,
    parking: "", units,
    elementary: "", elementaryMin: "", junior: "", juniorMin: "",
    facilities, photos, locText,
    hpText: ($('meta[name="description"]').attr("content") || "").trim(),
    tags: [],
  };
}

async function main() {
  console.log("=== すまいーだ(熊本県) 収集開始 ===");
  const warnings = [];

  // 1. 県ページ → 市区町村一覧リンク(まとめページ 43100 は重複するので除外)
  const prefHtml = await fetchHtml(PREF);
  if (!prefHtml) { console.error("[ERROR] 県ページが取得できません。中止します。"); process.exit(1); }
  const cityUrls = [...new Set(
    (prefHtml.match(/href="([^"]*\/ikkodate\/list\/area\/kyushu\/kumamoto\/\d{5}\/?)"/g) || [])
      .map((h) => abs(h.replace(/^href="/, "").replace(/"$/, "")).replace(/\/?$/, "/"))
  )].filter((u) => !/\/43100\/$/.test(u));
  console.log(`市区町村ページ: ${cityUrls.length}件`);

  // 2. 各市区町村ページから詳細リンクを集める。
  //    2ページ目以降は、ページ内に実際に書かれているページ送りリンクを辿る
  const detailUrls = new Map();
  for (const cityUrl of cityUrls) {
    const cityPath = new URL(cityUrl).pathname;
    const queue = [cityUrl];
    const visited = new Set();
    const beforeCity = detailUrls.size;
    while (queue.length && visited.size < MAX_PAGES_PER_CITY) {
      const pageUrl = queue.shift();
      if (visited.has(pageUrl)) continue;
      visited.add(pageUrl);
      await sleep(WAIT_MS);
      const html = await fetchHtml(pageUrl);
      if (!html) continue;
      for (const [u, id] of pickDetailLinks(html)) detailUrls.set(u, id);
      for (const p of pickPageLinks(html, cityPath)) if (!visited.has(p)) queue.push(p);
    }
    const added = detailUrls.size - beforeCity;
    console.log(`  ${cityPath} : ${visited.size}ページ巡回 → ${added}件`);
  }
  console.log(`物件詳細 合計${detailUrls.size}件を発見`);

  // 3. 各詳細ページを解析
  const scraped = [];
  for (const url of detailUrls.keys()) {
    await sleep(WAIT_MS);
    const html = await fetchHtml(url);
    if (!html) { warnings.push(`${url}\n    → ページ取得に失敗`); continue; }
    const item = parseDetail(html, url, warnings);
    if (item) scraped.push(item);
  }
  scraped.sort((a, b) => a.id.localeCompare(b.id));
  console.log(`解析完了: ${scraped.length}件`);
  if (scraped.length) {
    const total = scraped.reduce((n, s) => n + s.photos.length, 0);
    console.log(`[写真診断] 平均 ${(total / scraped.length).toFixed(1)}枚`);
  }

  // 4. 差分反映(すまいーだ分のみ更新。マエムラ・手動データには触れない)
  const prev = loadData(DATA_FILE);
  const merged = mergeListings(prev.listings || [], { [SOURCE]: scraped }, [SOURCE], todayStr());
  saveData(DATA_FILE, merged);

  const ended = merged.filter((l) => l.source === SOURCE && l.status === "ended").length;
  console.log(`=== 完了: すまいーだ 掲載中 ${scraped.length}件 / 掲載終了 ${ended}件 ===`);
  if (warnings.length) {
    console.log(`\n[注意] ${warnings.length}件の警告:\n  - ` + warnings.join("\n  - "));
  }
}

main().catch((e) => { console.error("[ERROR]", e); process.exit(1); });
