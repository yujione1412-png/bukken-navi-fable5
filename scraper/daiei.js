/* scraper/daiei.js
   大英産業(daiei-codate.com)の熊本県内の新築一戸建て(大英CODATE)を収集して
   data/listings.json の大英産業分を更新する。
   実行: node scraper/daiei.js
   ─────────────────────────────────
   構造(2026年9月に実ページのHTMLを解析して確認済み):
   ・検索結果 /list/?type=1&codate_daiei=1&city_cd=43101-43102-… に
     <div class="property-list"> の <article> が並び、h3 の中に /detail/?id=1577-1 形式の詳細リンク。
     ページ送りは <div class="pager"> の page_num=2,3… リンクを辿る
   ・熊本県の全市町村コードを city_cd にまとめて渡す(熊本県外は検索対象にしない)。
     念のため所在地が「熊本県」で始まらない物件は取り込まない
   ・詳細ページの物件概要は表(th/td)ではなく
       <div class="item"><p class="title">所在地</p><p class="txt">…</p></div>
     の形。ページ下部の「同じ住宅地に別区画の住宅があります」欄には
     別の区画の th/td 表(価格つき)があるため、表は読まず物件概要の囲いだけを見る
   ・写真はページ上部のスライダー(block-detail-03)の中の、
     自物件の番号(H00133568859 など)で始まる「番号_連番.jpg」だけを採用(最大5枚)
   ・学校区は「小学校区／◯◯小学校 中学校区／◯◯中学校」。徒歩分は周辺環境の写真説明から
   ・位置はHPの埋め込み地図(maps/embed … q=緯度,経度)から直接取得
   ・1ページ=1区画(1棟)なので棟数の問題はない
   ・実行のたびに robots.txt を確認し、禁止されていれば収集せずに終了する
*/
const cheerio = require("cheerio");
const { fetchHtml, sleep, pickPrice, robotsAllows, mergeListings,
  loadData, saveData, todayStr, reuseLocText, WAIT_MS,
  getFetchStats, getMergeReport, recordScrapeStatus, countBadFields } = require("./common");

const BASE = "https://daiei-codate.com";
const DATA_FILE = __dirname + "/../data/listings.json";
const SOURCE = "daiei";
const MAX_PHOTOS = 5;
const MAX_PAGES = 20;   // 検索結果のページ送り上限(暴走防止)

// 熊本県の全市町村コード(熊本市の5区を含む)。県内に新しい分譲地ができても漏れないよう全部渡す
const KUMAMOTO_CITY_CODES = [
  "43101","43102","43103","43104","43105",           // 熊本市 中央区・東区・西区・南区・北区
  "43202","43203","43204","43205","43206","43208",   // 八代・人吉・荒尾・水俣・玉名・山鹿
  "43210","43211","43212","43213","43214","43215","43216", // 菊池・宇土・上天草・宇城・阿蘇・天草・合志
  "43348","43364","43367","43368","43369",           // 美里・玉東・南関・長洲・和水
  "43403","43404",                                   // 大津・菊陽
  "43423","43424","43425","43428","43432","43433",   // 南小国・小国・産山・高森・西原・南阿蘇
  "43441","43442","43443","43444","43447",           // 御船・嘉島・益城・甲佐・山都
  "43468","43482","43484",                           // 氷川・芦北・津奈木
  "43501","43505","43506","43507","43510","43511","43512","43513","43514", // 球磨郡
  "43531",                                           // 苓北
];
// type=1: 新築戸建て / codate_daiei=1: 大英産業の自社物件 / sort=1: 更新順
const LIST_URL = `${BASE}/list/?type=1&codate_daiei=1&city_cd=${KUMAMOTO_CITY_CODES.join("-")}&sort=1`;

const absUrl = (u) => { try { return new URL(String(u).replace(/&amp;/g, "&"), BASE).href; } catch (e) { return ""; } };
const clean = (s) => String(s || "").replace(/\r/g, "").replace(/[ \t 　]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
const oneLine = (s) => clean(s).replace(/\n+/g, " ");

/* 検索結果ページ: 物件ID(1577-1 等)の一覧・ページ送りリンク・サイト表示の件数 */
function parseListPage(html) {
  const $ = cheerio.load(html);
  const ids = [];
  $(".property-list article h3 a").each((_, a) => {
    const m = String($(a).attr("href") || "").match(/\/detail\/\?id=([\w-]+)/);
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  });
  const pages = [];
  $(".pager a").each((_, a) => {
    const u = absUrl($(a).attr("href"));
    if (u && u.startsWith(BASE + "/list/") && /[?&]page_num=\d+/.test(u) && !pages.includes(u)) pages.push(u);
  });
  const cm = $("p.count strong").first().text().match(/\d+/);
  return { ids, pages, siteCount: cm ? +cm[0] : null };
}

/* 周辺施設の種類(アプリのアイコン分け) */
function facCat(name) {
  if (/セブン|ローソン|ファミリーマート|デイリーヤマザキ|ミニストップ|ポプラ|コンビニ/.test(name)) return "conbini";
  if (/ドラッグ|薬局|コスモス|モリ薬品|ダイレックス/.test(name)) return "drug";
  if (/ゆめタウン|イオン|モール|ショッピングセンター/.test(name)) return "mall";
  if (/スーパー|マート|マルエイ|マルショク|サンリブ|マルキョウ|マルミヤ|マックスバリュ|ミスターマックス|トライアル|ロッキー|生鮮|鮮ど市場|あんじぇらす/.test(name)) return "super";
  if (/病院|クリニック|医院|診療所/.test(name)) return "hospital";
  if (/公園|広場/.test(name)) return "park";
  if (/駅/.test(name)) return "station";
  if (/バス|停$/.test(name)) return "bus";
  return "other";
}
/* 周辺環境の写真説明「ゆめマート 近見店まで徒歩6分」「松高小学校　徒歩6分(説明文)」を名前と徒歩分に分ける */
function splitFacCaption(cap) {
  const s = oneLine(cap);
  const m = s.match(/^(.+?)\s*(?:まで)?\s*約?\s*徒歩\s*(\d+)\s*分/);
  if (m) return { name: m[1].replace(/まで$/, "").trim(), min: m[2] };
  const d = s.match(/^(.+?)まで(約?\s*[\d,.]+\s*(?:m|ｍ|km|ｋｍ))/);   // 「公園まで約400m」
  if (d) return { name: `${d[1].trim()}(${d[2].replace(/\s+/g, "")})`, min: "" };
  return s ? { name: s.slice(0, 40), min: "" } : null;
}

/* 詳細ページ1件を解析 */
function parseDetail(html, url, warnings) {
  const $ = cheerio.load(html);
  const warn = (msg) => warnings.push(`${url}\n    → ${msg}`);
  const pid = (url.match(/[?&]id=([\w-]+)/) || [])[1] || "";

  // 物件概要(表示部分と「もっと見る」で開く部分の両方)を「項目名→値」に
  const outline = $(".block-detail-04").first();
  const kv = {};
  outline.find(".grid-list .item").each((_, it) => {
    const key = oneLine($(it).find(".title").first().text()).replace(/\s+/g, "");
    const txtEl = $(it).find(".txt").first();
    txtEl.find("br").replaceWith("\n");
    const val = clean(txtEl.text());
    if (key && val && !(key in kv)) kv[key] = val;
  });

  const name = oneLine(outline.find("h3").first().text() || $("h2").first().text());
  if (!name) { warn("物件名が取れませんでした → スキップ"); return null; }

  // 所在地「熊本県熊本市 南区平田２丁目20-8東側」→ 区切りの空白を詰める
  const address = oneLine(kv["所在地"] || "").replace(/(県|市|郡)\s+/g, "$1");
  if (address && !/^熊本県/.test(address)) {
    warn(`熊本県外の物件のためスキップ(${address})`);
    return null;
  }

  // 価格:物件概要の「価格」欄だけを見る(ご返済例の月々の金額や、別区画の価格は使わない)
  const priceText = oneLine(outline.find(".grid-list .item").filter((_, it) =>
    oneLine($(it).find(".title").first().text()) === "価格").find(".price").first().text());
  const price = pickPrice({ "価格": priceText || kv["価格"] || "" }, "", warn);

  // 間取り「4SLDK（駐車場2台）」→ 間取り 4SLDK / 駐車場 2台
  const madori = kv["間取り"] || "";
  const lm = madori.replace(/\s/g, "").match(/\d[SLDK]{1,5}/i);
  const layout = lm ? lm[0].toUpperCase() : "";
  const pm = madori.match(/駐車場?\s*(\d+)\s*台/);
  const parking = pm ? pm[1] + "台" : "";

  // 構造「木造 2階建」
  const kozo = kv["構造"] || "";
  const stories = /平屋|平家/.test(kozo) ? "平屋"
    : /3階/.test(kozo) ? "3階建て" : /2階/.test(kozo) ? "2階建て" : "";

  // 完成時期「2027年01月」→「2027年1月」
  let builtAt = "";
  const bm = (kv["建物完成時期/予定時期"] || kv["築年月"] || "").match(/(\d{4})年\s*0?(\d{1,2})月/);
  if (bm) builtAt = `${bm[1]}年${bm[2]}月`;

  // 学校区「小学校区／日吉東小学校 中学校区／日吉中学校」
  const gakku = oneLine(kv["学校区"] || "");
  const elementary = (gakku.match(/([^\s／/、,，]{1,15}小学校)/) || [])[1] || "";
  const junior = (gakku.match(/([^\s／/、,，]{1,15}中学校)/) || [])[1] || "";
  let elementaryMin = "", juniorMin = "";

  // 周辺施設 ①交通「豊肥本線「平成」駅徒歩23分」「産交バス 平田町停　徒歩3分」
  const facilities = [];
  for (const line of String(kv["交通"] || "").split(/\n+/)) {
    const s = oneLine(line);
    if (!s) continue;
    const min = (s.match(/徒歩\s*(\d+)\s*分/) || [])[1] || "";
    const nm = s.replace(/(?:まで)?\s*約?\s*徒歩\s*\d+\s*分/g, "").trim() || s;
    const cat = /駅/.test(nm) && !/バス/.test(nm) ? "station" : "bus";
    facilities.push({ name: nm, min, cat });
  }
  // 周辺施設 ②周辺環境の写真説明(学校は徒歩分だけ使う・駅は交通と重複するので除く)
  const seen = new Set(facilities.map((f) => f.name));
  $(".block-detail-06 figcaption").each((_, fc) => {
    const f = splitFacCaption($(fc).text());
    if (!f || !f.name) return;
    if (/小学校/.test(f.name)) { if (!elementaryMin && elementary && f.name.includes(elementary.replace(/小学校$/, ""))) elementaryMin = f.min; return; }
    if (/中学校/.test(f.name)) { if (!juniorMin && junior && f.name.includes(junior.replace(/中学校$/, ""))) juniorMin = f.min; return; }
    if (/駅/.test(f.name) && !/公園|広場/.test(f.name)) return;
    if (seen.has(f.name)) return;
    seen.add(f.name);
    facilities.push({ name: f.name, min: f.min, cat: facCat(f.name) });
  });

  // 写真:ページ上部のスライダーの中から、自物件の番号で始まる「番号_連番.jpg」だけ(最大5枚)
  let code = "";
  const favCls = $(".block-detail-02").first().find("[class*='favoriteH']").attr("class") || "";
  const cm = favCls.match(/favorite(H\d+)/);
  if (cm) code = cm[1];
  const slideSrcs = $(".block-detail-03 .slider img").toArray().map((el) => $(el).attr("src") || $(el).attr("data-src") || "");
  if (!code) {
    const fm = (slideSrcs[0] || "").split("/").pop().match(/^(H\d+)_/);
    if (fm) code = fm[1];
  }
  const photos = [];
  const used = new Set();
  for (const src of slideSrcs) {
    const fname = String(src).split("/").pop().split("?")[0];
    if (!code || !new RegExp("^" + code + "_\\d+\\.(?:jpe?g|png)$", "i").test(fname)) continue;
    const u = absUrl(src);
    if (!u || used.has(u)) continue;
    used.add(u);
    photos.push({ id: "p" + (photos.length + 1), url: u, main: photos.length === 0 });
    if (photos.length >= MAX_PHOTOS) break;
  }
  if (!photos.length) warn("写真が1枚も取れませんでした");

  // 緯度経度:HPの埋め込み地図(google.com/maps/embed/v1/place?…&q=緯度,経度)から直接取得
  let locText = "";
  const mapSrc = $(".block-detail-07 iframe").first().attr("src") || "";
  const locM = mapSrc.match(/[?&](?:amp;)?q=([0-9]{2}\.[0-9]{3,})\s*(?:,|%2C)\s*([0-9]{3}\.[0-9]{3,})/i)
            || html.match(/maps\/embed[^"']*?[?&](?:amp;)?q=([0-9]{2}\.[0-9]{3,})\s*(?:,|%2C)\s*([0-9]{3}\.[0-9]{3,})/i);
  if (locM) locText = `${locM[1]}, ${locM[2]}`;

  // 紹介文(一覧の見出し文)
  const leadEl = outline.find("p.lead").first();
  leadEl.find("br").replaceWith("\n");
  const hpText = clean(leadEl.text()).replace(/\n{2,}/g, "\n");

  return {
    id: `${SOURCE}-${pid}`,
    source: SOURCE,
    name, price, address,
    detailUrl: `${BASE}/detail/?id=${pid}`,
    layout, stories, builtAt,
    buildingArea: kv["建物面積"] || "", landArea: kv["土地面積"] || "",
    parking, units: "",
    elementary, elementaryMin, junior, juniorMin,
    facilities, photos, locText, locPrec: "",
    hpText,
    tags: [],
  };
}

async function main() {
  console.log("=== 大英産業(熊本県) 収集開始 ===");
  const warnings = [];

  // 0. robots.txt を確認(禁止されていれば収集しない)
  const robots = await fetchHtml(BASE + "/robots.txt");
  if (robots && (!robotsAllows(robots, "/list/") || !robotsAllows(robots, "/detail/"))) {
    console.error("[ERROR] robots.txt が対象ページの自動アクセスを禁止しているため、収集を行いません。");
    recordScrapeStatus(SOURCE, { count: 0, notFound: getFetchStats().notFound,
      fatal: "大英産業のHPが自動収集を禁止する設定に変わったため、収集を止めています" });
    return;
  }

  // 1. 検索結果を巡回(ページ送りは実物のリンクを辿る)
  const ids = [];
  const queue = [LIST_URL];
  const visited = new Set();
  let siteCount = null;
  while (queue.length && visited.size < MAX_PAGES) {
    const pageUrl = queue.shift();
    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);
    await sleep(WAIT_MS);
    const html = await fetchHtml(pageUrl);
    if (!html) { console.error(`[WARN] 検索結果ページを取得できませんでした: ${pageUrl}`); continue; }
    const r = parseListPage(html);
    if (siteCount == null && r.siteCount != null) siteCount = r.siteCount;
    r.ids.forEach((id) => { if (!ids.includes(id)) ids.push(id); });
    // 同じページ番号のリンクは1回だけ辿る
    for (const p of r.pages) {
      const n = (p.match(/[?&]page_num=(\d+)/) || [])[1];
      const already = [...visited, ...queue].some((v) => ((v.match(/[?&]page_num=(\d+)/) || [])[1] || "1") === n);
      if (!already) queue.push(p);
    }
  }
  console.log(`[件数診断] 検索結果 ${visited.size}ページ → 物件 ${ids.length}件(HP表示の件数: ${siteCount == null ? "不明" : siteCount + "件"})`);
  if (siteCount != null && siteCount !== ids.length) {
    console.log(`[件数診断] ※HP表示の件数と、見つけた物件数が一致しません(ページ送りの作りが変わった可能性)`);
  }

  // 2. 各詳細ページを解析
  const scraped = [];
  let outside = 0;
  for (const id of ids) {
    const url = `${BASE}/detail/?id=${id}`;
    await sleep(WAIT_MS);
    const html = await fetchHtml(url);
    if (!html) { warnings.push(`${url}\n    → ページ取得に失敗`); continue; }
    const item = parseDetail(html, url, warnings);
    if (item) scraped.push(item);
    else if (/熊本県外/.test(warnings[warnings.length - 1] || "")) outside++;
  }
  scraped.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  console.log(`解析完了: ${scraped.length}件` + (outside ? `(熊本県外 ${outside}件は除外)` : ""));

  // 位置情報: ①HPの地図から直接取得 ②取れなかった物件は前回値を引き継ぐ
  const fromMap = scraped.filter((s) => s.locText).length;
  const prev = loadData(DATA_FILE);
  const reused = reuseLocText(prev.listings, scraped);
  const noLoc = scraped.filter((s) => !s.locText).length;
  console.log(`[位置情報] HPの地図から直接取得: ${fromMap}件/${scraped.length}件 / 前回から引き継ぎ ${reused}件 / 未設定 ${noLoc}件`);
  if (scraped.length) {
    const total = scraped.reduce((n, s) => n + s.photos.length, 0);
    console.log(`[写真診断] 平均 ${(total / scraped.length).toFixed(1)}枚`);
    const noSchool = scraped.filter((s) => !s.elementary).length;
    console.log(`[学校診断] 小学校区が取れなかった物件: ${noSchool}件`);
  }

  // 3. 差分反映(大英産業分のみ更新。他社・手動データには触れない)
  const merged = mergeListings(prev.listings || [], { [SOURCE]: scraped }, [SOURCE], todayStr());
  saveData(DATA_FILE, merged);

  const ended = merged.filter((l) => l.source === SOURCE && l.status === "ended").length;
  const rep = getMergeReport(SOURCE);
  recordScrapeStatus(SOURCE, { count: scraped.length, badFields: countBadFields(scraped),
    kept: rep.kept, prevActive: rep.prevActive, notFound: getFetchStats().notFound });
  console.log(`=== 完了: 大英産業 掲載中 ${scraped.length}件 / 掲載終了 ${ended}件 ===`);
  if (warnings.length) {
    console.log(`\n[注意] ${warnings.length}件の警告:\n  - ` + warnings.join("\n  - "));
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[ERROR]", e);
    try {
      recordScrapeStatus(SOURCE, { count: 0, notFound: getFetchStats().notFound,
        fatal: `収集の処理が途中で止まりました(${e.message})` });
    } catch (e2) {}
    process.exit(1);
  });
}

module.exports = { parseListPage, parseDetail, splitFacCaption, facCat, LIST_URL };
