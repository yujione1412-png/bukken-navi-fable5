/* scraper/maemura.js
   マエムラ(熊本エリア)の物件を収集して data/listings.json を更新する。
   実行: node scraper/maemura.js
*/
const cheerio = require("cheerio");
const { fetchHtml, sleep, pickPrice, tablePairs, mergeListings,
  loadData, saveData, todayStr, WAIT_MS } = require("./common");

const BASE = "https://maemura-shinchiku.jp";
const TOP = BASE + "/kumamoto/";
const DATA_FILE = __dirname + "/../data/listings.json";
const SOURCE = "maemura";

/* エリア一覧・詳細ページのリンクをHTMLから拾う */
const DENY = /\/(news|voice|info|staff|staff01|pickup|tenjikai|inquiry|contact|wp-content|recruit|about)\b/;
function collectLinks(html) {
  const $ = cheerio.load(html);
  const areas = new Set(), posts = new Set(), pages = new Set();
  $("a[href]").each((_, a) => {
    let href = $(a).attr("href") || "";
    if (href.startsWith("/")) href = BASE + href;
    if (!href.startsWith(BASE + "/kumamoto/")) return;
    href = href.split("#")[0].split("?")[0].replace(/\/$/, "");
    if (DENY.test(href)) return;
    if (/\/post-\d+$/.test(href)) { posts.add(href); return; }
    if (/\/page\/\d+$/.test(href)) { pages.add(href); return; }
    // /kumamoto/グループ/エリア の2階層のみをエリアページとみなす
    const rest = href.slice((BASE + "/kumamoto/").length);
    if (/^[a-z0-9-]+\/[a-z0-9-]+$/.test(rest)) areas.add(href);
  });
  return { areas, posts, pages };
}

/* 詳細ページ1件を解析して物件データにする */
function parseDetail(html, url, warnings) {
  const $ = cheerio.load(html);
  const warn = (msg) => warnings.push(`${url}\n    → ${msg}`);
  const kv = tablePairs($);
  const fullText = $("body").text().replace(/\s+/g, " ");

  // 物件名:タイトルから宣伝文を除いた末尾部分(「◯◯モデル・2,080万円(税込)」→「◯◯モデル」)
  let rawTitle = ($("h1").first().text() || $('meta[property="og:title"]').attr("content") || "").trim();
  rawTitle = rawTitle.replace(/\s*\|\s*熊本の.*$/, "");
  let name = "";
  const segs = rawTitle.split(/[|｜／\/]/).map((s) => s.trim()).filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    if (/万円/.test(segs[i])) {
      name = segs[i].replace(/[・･]?\s*[\d,，]+(?:\.\d+)?万円.*$/, "").trim();
      if (name) break;
    }
  }
  if (!name) name = (segs[segs.length - 1] || rawTitle).replace(/[【】（）()]/g, "").trim();
  if (!name) { warn("物件名が取れませんでした → この物件はスキップ"); return null; }

  // 価格(3段階判定は common.js の pickPrice)
  const price = pickPrice(kv, fullText, warn);

  // 築年月「2024年3月完成」→「2024年3月」
  let builtAt = "";
  const bm = (kv["築年数"] || kv["築年月"] || "").match(/(\d{4})年\s*(\d{1,2})月/);
  if (bm) builtAt = `${bm[1]}年${bm[2]}月`;

  // 建て方:構造「木造2階建」→「2階建て」
  const kozo = kv["構造"] || "";
  const stories = /平屋|平家/.test(kozo) ? "平屋"
    : /3階/.test(kozo) ? "3階建て" : /2階/.test(kozo) ? "2階建て" : "";

  // 間取り(形式チェック:3LDKなど以外は捨てる)
  let layout = (kv["間取り"] || "").trim();
  if (layout && !/^\d[SLDK]{2,5}(\+\S+)?$/i.test(layout.replace(/\s/g, ""))) {
    const lm = layout.match(/\d[SLDK]{2,5}/i);
    layout = lm ? lm[0] : "";
  }

  // 学校区(「花園小学校・鶴城中学校」のような併記から正しく分離する)
  let elementary = (kv["小学校区"] || "").trim();
  let junior = (kv["中学校区"] || "").trim();
  if (/中学校/.test(elementary)) {
    if (!junior) {
      const jm0 = elementary.match(/([^\s、。,，！!・/／()（）]{1,6}中学校)/);
      if (jm0) junior = jm0[1];
    }
    const em = elementary.match(/([^\s、。,，！!・/／()（）]{1,8}小学校)/);
    elementary = em ? em[1] : "";
  }
  if (/小学校/.test(junior)) {
    const jm1 = junior.match(/([^\s、。,，！!・/／()（）]{1,6}中学校)/);
    junior = jm1 ? jm1[1] : "";
  }
  if (!junior) {
    const jm = ($('meta[name="description"]').attr("content") || "").match(/([^\s、。,，！!・/／()（）]{1,6}中学校)区?/);
    if (jm) junior = jm[1];
  }

  // 周辺施設(買い物・交通の行から)。名前から距離・徒歩表記を取り除く
  const facilities = [];
  for (const [label, cat] of [["買い物", "super"], ["交通", "bus"]]) {
    const v = kv[label];
    if (!v) continue;
    const min = (v.match(/徒歩\s*(\d+)\s*分/) || [])[1] || "";
    let nm = v
      .replace(/[（(]\s*徒歩\s*\d+\s*分\s*[)）]?/g, "")
      .replace(/徒歩\s*\d+\s*分/g, "")
      .replace(/約?\s*[\d,，]+(?:\.\d+)?\s*[mｍkKMｋｍ]+/g, "")
      .replace(/\s+/g, " ").trim();
    if (!nm) nm = v.trim();
    const c = label === "交通" ? (/駅/.test(nm) && !/バス/.test(nm) ? "station" : "bus") : cat;
    facilities.push({ name: nm, min, cat: c });
  }

  // 写真:この物件の「現在の」ギャラリー写真だけを集める
  //  仕組み: このサイトは写真を差し替えると「元名_202607071134-680x507.jpg」のように
  //  日時付きの新ファイルを作り、古いファイルもHTMLに残る。
  //  → 同じ写真のグループごとに、一番新しい日時のものだけを採用する。
  //  さらに「建物/設備の魅力(※画像はイメージです)」の設備写真、
  //  他物件へのリンク付きサムネイル、ロゴ・バナー類も除外する。
  const postIdForPhoto = (url.match(/post-(\d+)/) || [])[1] || "";

  // 写真の「もとの名前」(サイズ表記・日時表記・拡張子を全部むいた核の部分)
  const rootKey = (u) => {
    let f = u.split("/").pop().split("?")[0].toLowerCase();
    let prev;
    do { prev = f;
      f = f.replace(/\.(jpe?g|png|gif)$/i, "")
           .replace(/-\d+x\d+$/, "")
           .replace(/_\d{12}$/, "");
    } while (f !== prev);
    return f;
  };
  const stampOf = (u) => { const m = u.match(/_(\d{12})/); return m ? m[1] : ""; };

  // 設備セクション(※画像はイメージです)の写真を除外リストに入れる
  const setubiRoots = new Set();
  $('[id^="bkSetibi"], [id*="etubi"], [id*="etibi"]').find("img[src]").each((_, img) => {
    const s = $(img).attr("src"); if (s) setubiRoots.add(rootKey(s));
  });
  $('a[href*="bkSetibi"]').each((_, a) => {
    $(a).parent().find("img[src]").each((_, img) => {
      const s = $(img).attr("src"); if (s) setubiRoots.add(rootKey(s));
    });
  });

  // 候補を集めて、同じ写真グループごとに最新版だけ残す
  const groups = new Map(); // rootKey → {url, stamp, order}
  let order = 0;
  const consider = (u) => {
    if (!u || !/\/wp-content\/uploads\//.test(u)) return;
    if (!/\.(jpe?g|png)(\?|$)/i.test(u)) return;
    if (/(logo|bnr|banner|label|maina|selfevaluation|maemura-bath)/i.test(u)) return;
    const k = rootKey(u);
    if (setubiRoots.has(k)) return;
    const st = stampOf(u);
    const g = groups.get(k);
    if (!g) groups.set(k, { url: u, stamp: st, order: order++ });
    else if (st > g.stamp) { g.url = u; g.stamp = st; } // 日時が新しい方を採用
  };
  const ogImg = $('meta[property="og:image"]').attr("content");
  consider(ogImg);
  $("img[src]").each((_, img) => {
    const a = $(img).closest("a");
    const href = a.length ? (a.attr("href") || "") : "";
    const linkedPost = (href.match(/post-(\d+)/) || [])[1];
    if (linkedPost && linkedPost !== postIdForPhoto) return; // 他物件のサムネイル
    consider($(img).attr("src"));
  });
  const photos = [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .slice(0, 12)
    .map((g, i) => ({ id: "p" + (i + 1), url: g.url, main: i === 0 }));
  if (!photos.length) warn("写真が1枚も取れませんでした");

  // 緯度経度(Googleマップリンクから)
  const lm2 = html.match(/maps\.google\.com\/maps\?q=([\d.]+)\s*,\s*([\d.]+)/);
  const locText = lm2 ? `${lm2[1]}, ${lm2[2]}` : "";

  const postId = (url.match(/post-(\d+)/) || [])[1];
  return {
    id: `${SOURCE}-${postId}`,
    source: SOURCE,
    name,
    price,
    address: (kv["所在地"] || kv["住所"] || "").trim(),
    detailUrl: url,
    layout, stories, builtAt,
    buildingArea: (kv["建物施工面積"] || kv["建物面積"] || "").trim(),
    landArea: (kv["土地面積"] || "").trim(),
    parking: (kv["駐車場"] || "").trim(),
    elementary, elementaryMin: "", junior, juniorMin: "",
    facilities, photos, locText,
    hpText: ($('meta[name="description"]').attr("content") || "").trim(),
    tags: [],
  };
}

async function main() {
  console.log("=== マエムラ 収集開始 ===");
  const warnings = [];

  // 1. トップ+各エリアページから物件詳細URLを集める
  const topHtml = await fetchHtml(TOP);
  if (!topHtml) { console.error("[ERROR] トップページが取得できません。中止します。"); process.exit(1); }
  const { areas, posts } = collectLinks(topHtml);
  const postUrls = new Set(posts);
  const pageQueue = [...areas];
  const visited = new Set();
  while (pageQueue.length) {
    const pageUrl = pageQueue.shift();
    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);
    await sleep(WAIT_MS);
    const html = await fetchHtml(pageUrl);
    if (!html) continue;
    const found = collectLinks(html);
    found.posts.forEach((u) => postUrls.add(u));
    found.pages.forEach((u) => { if (!visited.has(u)) pageQueue.push(u); }); // ページ送り対応
  }
  console.log(`エリアページ ${visited.size}件を巡回、物件詳細 ${postUrls.size}件を発見`);

  // 2. 各詳細ページを解析
  const scraped = [];
  for (const url of postUrls) {
    await sleep(WAIT_MS);
    const html = await fetchHtml(url);
    if (!html) { warnings.push(`${url}\n    → ページ取得に失敗`); continue; }
    const item = parseDetail(html, url, warnings);
    if (item) scraped.push(item);
  }
  scraped.sort((a, b) => a.id.localeCompare(b.id));
  console.log(`解析完了: ${scraped.length}件`);

  // 3. 前回データと突き合わせて反映(掲載終了の判定・価格履歴の記録)
  const prev = loadData(DATA_FILE);
  const merged = mergeListings(prev.listings || [], { [SOURCE]: scraped }, [SOURCE], todayStr());
  saveData(DATA_FILE, merged);

  const ended = merged.filter((l) => l.source === SOURCE && l.status === "ended").length;
  console.log(`=== 完了: 掲載中 ${scraped.length}件 / 掲載終了 ${ended}件 ===`);
  if (warnings.length) {
    console.log(`\n[注意] ${warnings.length}件の警告:\n  - ` + warnings.join("\n  - "));
  }
}

main().catch((e) => { console.error("[ERROR]", e); process.exit(1); });
