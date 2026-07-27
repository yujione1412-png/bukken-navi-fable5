/* scraper/yokatown.js
   よかタウン(bukken.yoka-town.com)の熊本エリアの新築一戸建てを収集して
   data/listings.json のよかタウン分を更新する。
   実行: node scraper/yokatown.js
   ─────────────────────────────────
   構造(実ページを解析して確認済み):
   ・検索結果ページに roomXXXXXXXX.html 形式の詳細リンク。ページ送りは pg=2 リンクを辿る
   ・詳細ページは th/td の項目名/値ペア(物件名・価格・所在地・階建・築年月・設備条件など)
   ・写真は「物件番号_連番_横_縦_3.jpg」形式。自物件の番号で始まるものだけが物件写真
   ・学校は紹介文の「◯◯小学校で徒歩12分」形式から抽出
   ・1ページ=1棟なので棟数の問題はない
   ・実行のたびに robots.txt を確認し、禁止されていれば収集せずに終了する
*/
const cheerio = require("cheerio");
const { fetchHtml, sleep, pickPrice, tablePairs, robotsAllows, mergeListings,
  loadData, saveData, todayStr, geocode, reuseLocText, WAIT_MS,
  getFetchStats, getMergeReport, recordScrapeStatus, countBadFields } = require("./common");

const BASE = "https://bukken.yoka-town.com";
const DATA_FILE = __dirname + "/../data/listings.json";
const SOURCE = "yokatown";
const MAX_PHOTOS = 5;
const MAX_PAGES = 20;   // 検索結果のページ送り上限(暴走防止)

// 2026年7月のサイトリニューアルで旧検索(/search/index/)は廃止され、
// 市区町ごとの固定ページ /area_b2/bknshiku_yo{コード}/ に変わった。
// コードは新ページの「近くの市区町村」一覧に合わせて14市区町(宇城市・御船町を追加)。
const CITIES = [
  ["43101","熊本市中央区"],["43102","熊本市東区"],["43103","熊本市西区"],
  ["43104","熊本市南区"],["43105","熊本市北区"],
  ["43210","菊池市"],["43211","宇土市"],["43213","宇城市"],["43216","合志市"],
  ["43403","菊池郡大津町"],["43404","菊池郡菊陽町"],
  ["43441","上益城郡御船町"],["43442","上益城郡嘉島町"],["43443","上益城郡益城町"],
];
const cityUrl = (code) => `${BASE}/area_b2/bknshiku_yo${code}/`;

const absUrl = (u) => { try { return new URL(String(u).replace(/&amp;/g, "&"), BASE).href; } catch (e) { return ""; } };

function pickRoomLinks(html) {
  const out = new Map(); // url → roomId
  const re = /href="([^"]*\/room(\d+)\.html)[^"]*"/g;
  let m;
  while ((m = re.exec(html))) out.set(absUrl(m[1]), m[2]);
  return out;
}
/* 同じ市区町ページ内のページ送りリンク(pg=2以降)を拾う */
function pickPageLinks(html, basePath) {
  const out = new Set();
  const re = /href="([^"]*[?&](?:amp;)?pg=\d+[^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    const u = absUrl(m[1]);
    if (!u || !u.startsWith(BASE + basePath)) continue;
    if (/[?&]pg=1(&|$)/.test(u)) continue;
    out.add(u);
  }
  return out;
}

/* 詳細ページ1件を解析 */
function parseDetail(html, url, warnings) {
  const $ = cheerio.load(html);
  const warn = (msg) => warnings.push(`${url}\n    → ${msg}`);
  const kv = tablePairs($);
  const kvGet = (prefix) => {
    for (const k of Object.keys(kv)) if (k.startsWith(prefix)) return kv[k];
    return "";
  };
  const roomId = (url.match(/room(\d+)\.html/) || [])[1] || "";

  const name = ($("h1").first().text() || kv["物件名"] || "").replace(/\s+/g, " ").trim();
  if (!name) { warn("物件名が取れませんでした → スキップ"); return null; }

  const address = (kv["所在地"] || "").replace(/\s+/g, " ").trim();
  if (address && !address.includes("熊本")) {
    warn(`熊本県外の物件のためスキップ(${address})`);
    return null;
  }

  const fullText = $("body").text().replace(/\s+/g, " ");
  const price = pickPrice(kv, fullText, warn);

  // 間取り「4LDK」
  let layout = (kvGet("間取り") || kvGet("間取") || "").replace(/\s/g, "");
  const lm = layout.match(/\d[SLDK]{1,5}/i);
  layout = lm ? lm[0].toUpperCase() : "";

  // 階建「2階建」
  const kai = kvGet("階建") || kvGet("種別/構造") || "";
  const stories = /平屋|平家/.test(kai) ? "平屋"
    : /3階/.test(kai) ? "3階建て" : /2階/.test(kai) ? "2階建て" : "";

  // 築年月「2026年 12月(予定)」→「2026年12月」
  let builtAt = "";
  const bm = kvGet("築年月").match(/(\d{4})年\s*0?(\d{1,2})月/);
  if (bm) builtAt = `${bm[1]}年${bm[2]}月`;

  // 駐車場: 設備条件の「駐車3台可」を優先、なければ 駐車場/料金 の「有」
  let parking = "";
  const pm = (kv["設備条件"] || "").match(/駐車\s*(\d+)\s*台/);
  if (pm) parking = pm[1] + "台";
  else {
    const p0 = (kvGet("駐車場") || "").split("/")[0].trim();
    if (p0 && p0 !== "-") parking = p0;
  }

  // 交通 →「◯◯「健軍町」駅 徒歩36分」「「榎団地西口」バス停下車 徒歩6分」を施設に
  const facilities = [];
  const koutsu = (kv["交通"] || "").replace(/\u00a0/g, " ");
  const fre = /([^\s「」]*「[^」]+」(?:駅|バス停)[^徒]{0,10}?徒歩\s*\d+\s*分)/g;
  let fm;
  while ((fm = fre.exec(koutsu))) {
    const seg = fm[1].trim();
    const min = (seg.match(/徒歩\s*(\d+)\s*分/) || [])[1] || "";
    facilities.push({ name: seg, min, cat: /バス停/.test(seg) ? "bus" : "station" });
  }
  if (!facilities.length && /徒歩\s*\d+\s*分/.test(koutsu)) {
    const min = (koutsu.match(/徒歩\s*(\d+)\s*分/) || [])[1] || "";
    facilities.push({ name: koutsu.trim(), min, cat: /バス/.test(koutsu) ? "bus" : "station" });
  }

  // 学校: 紹介文の「◯◯小学校で徒歩12分」形式から
  let elementary = "", elementaryMin = "", junior = "", juniorMin = "";
  const em = fullText.match(/([^\s、。,，！!？?」はがをにで・/／()（）]{2,12}小学校)(?:で|が|まで)?[^0-9]{0,8}徒歩\s*(\d+)\s*分/);
  if (em) { elementary = em[1]; elementaryMin = em[2]; }
  const jm = fullText.match(/([^\s、。,，！!？?」はがをにで・/／()（）]{2,12}中学校)(?:で|が|まで)?[^0-9]{0,8}徒歩\s*(\d+)\s*分/);
  if (jm) { junior = jm[1]; juniorMin = jm[2]; }

  // 写真: ファイル名が「自分の物件番号_連番_横_縦_◯.jpg」のものだけ。
  //  同じ連番のサイズ違いは大きい方を採用し、連番順に最大5枚
  const groups = new Map();
  const consider = (src) => {
    if (!src) return;
    const fname = src.split("/").pop().split("?")[0];
    const mm = fname.match(new RegExp("^" + roomId + "_(\\d+)_(\\d+)_(\\d+)_\\d+\\.(?:jpe?g|png)$", "i"));
    if (!mm) return;
    const num = +mm[1], w = +mm[2];
    const u = absUrl2(src);
    const g = groups.get(num);
    if (!g || w > g.w) groups.set(num, { url: u, w });
  };
  const absUrl2 = (u) => { try { return new URL(u, url).href; } catch (e) { return u; } };
  consider($('meta[property="og:image"]').attr("content"));
  $("img").each((_, el) => {
    consider($(el).attr("src"));
    consider($(el).attr("data-src"));
  });
  const photos = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_PHOTOS)
    .map(([, g], i) => ({ id: "p" + (i + 1), url: g.url, main: i === 0 }));
  if (!photos.length) warn("写真が1枚も取れませんでした");

  // 緯度経度: HPの埋め込み地図(google.com/maps/embed/v1/place?q=緯度,経度)から直接取得。
  //  取れたものは「正確」扱い。取れないページだけ、後段の住所推定(おおよそ)で補完する。
  let locText = "", locPrec = "";
  const locM = html.match(/[?&](?:amp;)?q=([0-9]{2}\.[0-9]{3,})\s*(?:,|%2C)\s*([0-9]{3}\.[0-9]{3,})/i)
            || html.match(/!3d([0-9]{2}\.[0-9]{3,})[^0-9]{0,4}!2d?([0-9]{3}\.[0-9]{3,})/);
  if (locM) { locText = `${locM[1]}, ${locM[2]}`; locPrec = ""; }

  return {
    id: `${SOURCE}-${roomId}`,
    source: SOURCE,
    name, price, address,
    detailUrl: url,
    layout, stories, builtAt,
    buildingArea: kvGet("建物面積"), landArea: kvGet("土地面積"),
    parking, units: "",
    elementary, elementaryMin, junior, juniorMin,
    facilities, photos, locText, locPrec,
    hpText: ($('meta[name="description"]').attr("content") || "").trim(),
    tags: [],
  };
}

async function main() {
  console.log("=== よかタウン(熊本) 収集開始 ===");
  const warnings = [];

  // 0. robots.txt を確認(禁止されていれば収集しない)
  const robots = await fetchHtml(BASE + "/robots.txt");
  if (robots && (!robotsAllows(robots, "/search/") || !robotsAllows(robots, "/room"))) {
    console.error("[ERROR] robots.txt が対象ページの自動アクセスを禁止しているため、収集を行いません。");
    recordScrapeStatus(SOURCE, { count: 0, notFound: getFetchStats().notFound,
      fatal: "よかタウンのHPが自動収集を禁止する設定に変わったため、収集を止めています" });
    return;
  }

  // 1. 市区町ごとの固定ページを巡回(ページ送りは実物のリンクを辿る)
  const detailUrls = new Map();
  for (const [code, cityName] of CITIES) {
    const basePath = `/area_b2/bknshiku_yo${code}/`;
    const queue = [cityUrl(code)];
    const visited = new Set();
    const before = detailUrls.size;
    while (queue.length && visited.size < 10) {
      const pageUrl = queue.shift();
      if (visited.has(pageUrl)) continue;
      visited.add(pageUrl);
      await sleep(WAIT_MS);
      const html = await fetchHtml(pageUrl);
      if (!html) { if (pageUrl === cityUrl(code)) visited.delete(pageUrl); continue; }
      for (const [u, id] of pickRoomLinks(html)) detailUrls.set(u, id);
      for (const p of pickPageLinks(html, basePath)) if (!visited.has(p)) queue.push(p);
    }
    if (!visited.size) {
      console.log(`  ${cityName}(${code}): 現在このエリアの公開物件はありません(ページなし)`);
    } else {
      console.log(`  ${cityName}(${code}): ${visited.size}ページ → +${detailUrls.size - before}件`);
    }
  }
  console.log(`物件詳細 合計${detailUrls.size}件を発見`);
  console.log(`(※各ページの「新着物件」欄経由で他市区の物件が混ざることがありますが、重複は自動で1件にまとまり、熊本県外は除外されます)`);

  // 2. 各詳細ページを解析
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

  // 位置情報: ①HPの地図から直接取得(最優先・正確) ②前回値の引き継ぎ ③住所からの推定
  const fromMap = scraped.filter((s) => s.locText).length;
  console.log(`[位置情報] HPの地図から直接取得: ${fromMap}件/${scraped.length}件`);
  const prevForLoc = loadData(DATA_FILE);
  const reused = reuseLocText(prevForLoc.listings, scraped);
  let geocoded = 0, geoFail = 0;
  const GEO_LIMIT = 200;  // 1回の実行での上限(1.2秒間隔を守るため、200件でも約5分)
  for (const s of scraped) {
    if (s.locText || !s.address) continue;   // HP地図または前回値があれば推定不要
    if (geocoded + geoFail >= GEO_LIMIT) break;
    await sleep(1200);
    const g = await geocode(s.address);
    if (g.loc) { s.locText = g.loc; s.locPrec = g.prec; geocoded++; }
    else geoFail++;
  }
  const noLoc = scraped.filter((s) => !s.locText).length;
  const approx = scraped.filter((s) => s.locPrec === "banchi" || s.locPrec === "town").length;
  console.log(`[位置情報] 前回から引き継ぎ ${reused}件 / 新規取得 ${geocoded}件(うち、おおよその位置 ${approx}件) / 取得できず ${geoFail}件`);
  console.log(`[位置情報] 位置情報が未設定の物件: 残り${noLoc}件` +
    (noLoc ? "(住所が地図サービスで見つからない物件。アプリの✎編集で緯度・経度を手動設定できます)" : " → 全件完了!"));
  if (scraped.length) {
    const total = scraped.reduce((n, s) => n + s.photos.length, 0);
    console.log(`[写真診断] 平均 ${(total / scraped.length).toFixed(1)}枚`);
  }

  // 3. 差分反映(よかタウン分のみ更新。他社・手動データには触れない)
  const prev = loadData(DATA_FILE);
  const merged = mergeListings(prev.listings || [], { [SOURCE]: scraped }, [SOURCE], todayStr());
  saveData(DATA_FILE, merged);

  const ended = merged.filter((l) => l.source === SOURCE && l.status === "ended").length;
  // 収集状況を記録(アプリのお知らせ表示に使う)。
  // 市区町ページの404は「そのエリアに公開物件が無い」だけなので、
  // 404の件数が前回より大きく増えた時だけ注意として扱う(common.js側で判定)。
  const rep = getMergeReport(SOURCE);
  recordScrapeStatus(SOURCE, { count: scraped.length, badFields: countBadFields(scraped),
    kept: rep.kept, prevActive: rep.prevActive, notFound: getFetchStats().notFound });
  console.log(`=== 完了: よかタウン 掲載中 ${scraped.length}件 / 掲載終了 ${ended}件 ===`);
  if (warnings.length) {
    console.log(`\n[注意] ${warnings.length}件の警告:\n  - ` + warnings.join("\n  - "));
  }
}

main().catch((e) => {
  console.error("[ERROR]", e);
  try {
    recordScrapeStatus(SOURCE, { count: 0, notFound: getFetchStats().notFound,
      fatal: `収集の処理が途中で止まりました(${e.message})` });
  } catch (e2) {}
  process.exit(1);
});
