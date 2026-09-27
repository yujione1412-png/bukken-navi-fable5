/* scraper/nakajitsu.js
   ナカジツ(nakajitsu.com・不動産SHOPナカジツ)の熊本県内の新築一戸建てのうち、
   ナカジツが自ら売主の物件(Asobi-創家)だけを収集して
   data/listings.json のナカジツ分を更新する。
   実行: node scraper/nakajitsu.js
   ─────────────────────────────────
   構造(2026年9月に実ページのHTMLを解析して確認済み):
   ・熊本版の物件検索 /kumamoto/prpsearch/ に
       SYUMOKU[]=NEWHOUSE(新築戸建て)+ OWN_FLG=仲介手数料無料物件(ナカジツ施工・売主)
     を付けて検索する。ナカジツが仲介(媒介)で扱う他社の物件はこの条件で除かれる。
     念のため詳細ページの「取引態様」が「売主」でない物件は取り込まない
   ・検索結果は <div class="estatelist"> の <div class="prpwrap …"> が1物件。
       prp_own … ナカジツ自社物件 / bgb … 公開中 / bgend … 成約済(掲載終了)
       bgr … 会員限定(ログインが必要・リンクなし → 取り込めない)
     ページ送りは <div class="prpPaging"> の pageID=2,3… リンクを辿る
   ・件数は <div class="list_topCountBox"> の p.count strong(公開中の件数)。
     会員限定の件数は .count_sub_member(「＋4件」)に出る([件数診断]で表示)
   ・検索結果ページの地図用スクリプト(adddept)の吹き出しに「築年月：2026/10」と
     緯度経度があるため、完成時期と位置の予備として使う(詳細ページには完成時期がない)
   ・詳細ページ /prpsearch/prpdetail/OBJ_MNG_NO/◯◯◯◯◯◯◯/ は th/td 表。
     ページ内には同じ項目(所在地・交通・校区)の表が地図の下にもう一度あるため、
     「最初に出てきた値」を使う。ページ下部のログイン欄の表は <div class="prpdetailPage"> の外なので読まない
   ・所在地は「熊本市北区室園町」のように県名なし → 熊本県内の市町村名で始まるか確認して「熊本県」を補う
   ・価格は「物件価格」欄(#karte_price)だけを見る(月々の支払例は使わない)
   ・写真は <div class="prpdetailimageBox"> の ul.main → ul.sub01 → ul.sub02 の順に、
     /common/file/?FILECD=番号 の画像を最大5枚(スタッフ写真や他物件の小さな写真は対象外)
   ・位置はページ内の地図スクリプト new google.maps.LatLng(緯度, 経度) から直接取得
   ・1ページ=1区画(1棟)なので棟数の問題はない
   ・実行のたびに robots.txt を確認し、禁止されていれば収集せずに終了する
*/
const cheerio = require("cheerio");
const { fetchHtml, sleep, pickPrice, robotsAllows, mergeListings,
  loadData, saveData, todayStr, reuseLocText, WAIT_MS,
  getFetchStats, getMergeReport, recordScrapeStatus, countBadFields } = require("./common");

const BASE = "https://nakajitsu.com";
const DATA_FILE = __dirname + "/../data/listings.json";
const SOURCE = "nakajitsu";
const MAX_PHOTOS = 5;
const MAX_PAGES = 15;   // 検索結果のページ送り上限(暴走防止。成約済の物件も後ろのページに並ぶ)

// SYUMOKU[]=NEWHOUSE: 新築戸建て / OWN_FLG=仲介手数料無料物件: ナカジツが施工・売主の物件
const LIST_PATH = "/kumamoto/prpsearch/";
const LIST_URL = `${BASE}${LIST_PATH}?SYUMOKU%5B%5D=NEWHOUSE&OWN_FLG=${encodeURIComponent("仲介手数料無料物件")}&searchCommand=on`;

// 熊本県内の市・郡(所在地に県名がないため、これで熊本県内かを判定する)
const KUMAMOTO_AREA_RE = /^(熊本市|八代市|人吉市|荒尾市|水俣市|玉名市|山鹿市|菊池市|宇土市|上天草市|宇城市|阿蘇市|天草市|合志市|下益城郡|玉名郡|菊池郡|阿蘇郡|上益城郡|八代郡|葦北郡|球磨郡|天草郡)/;

const absUrl = (u) => { try { return new URL(String(u).replace(/&amp;/g, "&"), BASE).href; } catch (e) { return ""; } };
const clean = (s) => String(s || "").replace(/\r/g, "").replace(/[ \t 　]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
const oneLine = (s) => clean(s).replace(/\n+/g, " ");
const idOf = (u) => (String(u || "").match(/prpdetail\/OBJ_MNG_NO\/(\d+)/) || [])[1] || "";

/* 検索結果ページの地図用スクリプトから、物件ごとの「築年月」と緯度経度を拾う
   content = '<div …>'; content += "<h3 class='gmap_ttl01'><a href='…/OBJ_MNG_NO/5540434/'>…</a></h3>";
   … 築年月：</strong>2026/10 … adddept(32.82, 130.72, content, …)
   同じ地点の物件は1つの吹き出しに h3 が複数並ぶため、h3 ごとに区切って読む */
function parseMapPopups(html) {
  const out = {};
  const blocks = String(html).split(/content\s*=\s*'<div/);
  for (const b of blocks.slice(1)) {
    const lm = b.match(/adddept\(\s*([0-9]{2}\.[0-9]{3,})\s*,\s*([0-9]{3}\.[0-9]{3,})/);
    for (const seg of b.split(/<h3 class='gmap_ttl01'>/).slice(1)) {
      const id = idOf(seg);
      if (!id) continue;
      const info = {};
      const bm = seg.match(/築年月：<\/strong>\s*(\d{4})\s*[\/年]\s*(\d{1,2})/);
      if (bm) info.builtAt = `${bm[1]}年${+bm[2]}月`;
      if (lm) info.locText = `${lm[1]}, ${lm[2]}`;
      out[id] = info;
    }
  }
  return out;
}

/* 検索結果ページ: 掲載中の自社物件ID・ページ送りリンク・件数など */
function parseListPage(html) {
  const $ = cheerio.load(html);
  const ids = [];
  let ended = 0, memberOnly = 0, other = 0;
  $(".estatelist .prpwrap").each((_, w) => {
    const cls = String($(w).attr("class") || "");
    const a = $(w).find(".prptitle01 a").first();
    const id = idOf(a.attr("href"));
    const title = oneLine($(w).find(".prptitle01").first().text());
    if (!id) { if (/\bbgr\b/.test(cls)) memberOnly++; return; }   // 会員限定(リンクなし)
    if (/\bbgend\b/.test(cls) || /成約済|掲載終了/.test(title)) { ended++; return; }
    if (!/\bprp_own\b/.test(cls)) { other++; return; }          // 自社物件の印がないもの(媒介)は取らない
    if (!ids.includes(id)) ids.push(id);
  });
  const pages = [];
  $(".prpPaging a").each((_, a) => {
    const u = absUrl($(a).attr("href")).replace(/#.*$/, "");
    if (u && u.startsWith(BASE + LIST_PATH) && /[?&]pageID=\d+/.test(u) && !pages.includes(u)) pages.push(u);
  });
  const cm = $(".list_topCountBox p.count strong").first().text().match(/\d+/);
  const mm = $(".list_topCountBox .count_sub_member").first().text().match(/\d+/);
  return { ids, pages, ended, memberOnly, other,
    siteCount: cm ? +cm[0] : null, siteMemberCount: mm ? +mm[0] : null,
    popups: parseMapPopups(html) };
}

/* 交通「電車：熊本電気鉄道 北熊本駅 徒歩3分、… バス：北熊本 徒歩2分」を駅・バス停に分ける */
function splitTraffic(text) {
  const out = [];
  const s = oneLine(text);
  for (const part of s.split(/(?=電車：|バス：)/)) {
    const kind = part.startsWith("バス：") ? "bus" : "station";
    for (const seg of part.replace(/^(電車|バス)：/, "").split(/[、,，]/)) {
      const t = seg.trim();
      if (!t) continue;
      const min = (t.match(/徒歩\s*(\d+)\s*分/) || [])[1] || "";
      let name = t.replace(/約?\s*徒歩\s*\d+\s*分.*$/, "").replace(/\s*(?:バス|車)\s*\d+\s*分.*$/, "").trim() || t;
      if (kind === "bus" && !/停|バス/.test(name)) name += "バス停";
      out.push({ name, min, cat: kind });
    }
  }
  return out;
}

/* 校区「清水小学校 徒歩11分 835m」→ 学校名と徒歩分 */
function splitSchool(text, re) {
  const s = oneLine(text);
  const name = (s.match(re) || [])[1] || "";
  const min = name ? ((s.match(/徒歩\s*(\d+)\s*分/) || [])[1] || "") : "";
  return { name, min };
}

/* 詳細ページ1件を解析。popup は検索結果の地図吹き出しの情報(築年月・位置の予備) */
function parseDetail(html, url, warnings, popup) {
  const $ = cheerio.load(html);
  const warn = (msg) => warnings.push(`${url}\n    → ${msg}`);
  const pid = idOf(url);
  const page = $(".prpdetailPage").first();
  if (!page.length) { warn("物件詳細の囲い(prpdetailPage)が見つかりません → スキップ"); return null; }

  // 物件名「新築一戸建て Asobi-創家 熊本市中央区島崎第一 1号棟」から種別の表示を除く
  const h1 = page.find("h1.page_title01").first().clone();
  h1.find(".prptitle01_type").remove();
  const name = oneLine(h1.text());
  if (!name) { warn("物件名が取れませんでした → スキップ"); return null; }
  if (/成約済|掲載終了/.test(name)) { warn("成約済・掲載終了の物件のためスキップ"); return null; }

  // 表(th/td)を「項目名→値」に。同じ項目が2回出るので最初の値を採用
  const kv = {};
  page.find("table tr").each((_, tr) => {
    $(tr).children("th").each((__, th) => {
      const key = oneLine($(th).text()).replace(/\s+/g, "");
      const td = $(th).next("td");
      if (!key || !td.length) return;
      const c = td.clone();
      c.find(".btn, script").remove();
      c.find("br").replaceWith("\n");
      const val = clean(c.text());
      if (val && !(key in kv)) kv[key] = val;
    });
  });

  // ナカジツが売主の新築物件だけ(媒介物件・中古は取り込まない)
  const torihiki = oneLine(kv["取引態様"] || "");
  if (!/売主/.test(torihiki)) { warn(`取引態様が「${torihiki || "不明"}」でナカジツ売主ではないためスキップ`); return null; }
  const syumoku = oneLine(kv["種目"] || "");
  if (syumoku && !/新築/.test(syumoku)) { warn(`種目が「${syumoku}」で新築ではないためスキップ`); return null; }

  // 所在地「熊本市中央区島崎１丁目 1号棟」→ 号棟の表記を除き、熊本県を補う
  let address = oneLine(kv["所在地"] || "").replace(/\s*\d+\s*号棟\s*$/, "").replace(/\s+/g, "");
  if (address && !/^熊本県/.test(address)) {
    if (!KUMAMOTO_AREA_RE.test(address)) { warn(`熊本県外の物件のためスキップ(${address})`); return null; }
    address = "熊本県" + address;
  }

  // 価格:「物件価格」欄だけ(月々の支払例は使わない)
  const priceBox = page.find(".loanBox li.price dd").first();
  const priceText = oneLine(priceBox.text()).replace(/\s+/g, "");
  const price = pickPrice({ "価格": priceText }, "", warn);

  // 間取り「4LDK」
  const lm = String(kv["間取り"] || "").replace(/\s/g, "").match(/\d[SLDK]{1,5}/i);
  const layout = lm ? lm[0].toUpperCase() : "";

  // 構造「木造 2階建」「木造 1階建」(1階建=平屋)
  const kozo = oneLine(kv["建物構造規模"] || kv["建物構造"] || "");
  const stories = /平屋|平家|(^|[^\d])1階建/.test(kozo) ? "平屋"
    : /3階/.test(kozo) ? "3階建て" : /2階/.test(kozo) ? "2階建て" : "";

  // 駐車場「空有・2台」「3台」
  const pm = String(kv["駐車場備考"] || kv["駐車場"] || "").match(/(\d+)\s*台/);
  const parking = pm ? pm[1] + "台" : "";

  // 完成時期:詳細ページにはないので、検索結果の地図吹き出しの「築年月」を使う
  const builtAt = (popup && popup.builtAt) || "";

  // 学校区「清水小学校 徒歩11分 835m」
  const es = splitSchool(kv["小学校校区"] || "", /([^\s　、,，／/]{1,15}小学校)/);
  const js = splitSchool(kv["中学校校区"] || "", /([^\s　、,，／/]{1,15}中学校)/);

  // 周辺施設:交通欄の駅・バス停
  const facilities = splitTraffic(kv["交通"] || "");

  // 写真:メイン → サブの順に /common/file/?FILECD=番号 だけを最大5枚
  const photos = [];
  const used = new Set();
  page.find(".prpdetailimageBox ul.main img, .prpdetailimageBox ul.sub01 img, .prpdetailimageBox ul.sub02 img").each((_, el) => {
    if (photos.length >= MAX_PHOTOS) return;
    const src = $(el).attr("data-src") || $(el).attr("src") || "";
    const fm = String(src).match(/\/common\/file\/\?FILECD=(\d+)/);
    if (!fm || used.has(fm[1])) return;
    used.add(fm[1]);
    photos.push({ id: "p" + (photos.length + 1), url: `${BASE}/common/file/?FILECD=${fm[1]}`, main: photos.length === 0 });
  });
  if (!photos.length) warn("写真が1枚も取れませんでした");

  // 緯度経度:ページ内の地図 new google.maps.LatLng(緯度, 経度) → だめなら検索結果の地図
  let locText = "";
  const locM = html.match(/new\s+google\.maps\.LatLng\(\s*([0-9]{2}\.[0-9]{3,})\s*,\s*([0-9]{3}\.[0-9]{3,})\s*\)/);
  if (locM) locText = `${locM[1]}, ${locM[2]}`;
  else if (popup && popup.locText) locText = popup.locText;

  // 紹介文(キャッチコピー)
  const cc = page.find("p.catchcopy").first().clone();
  cc.find("br").replaceWith("\n");
  const hpText = clean(cc.text());

  return {
    id: `${SOURCE}-${pid}`,
    source: SOURCE,
    name, price, address,
    detailUrl: `${BASE}/prpsearch/prpdetail/OBJ_MNG_NO/${pid}/`,
    layout, stories, builtAt,
    buildingArea: kv["建物面積"] || "", landArea: kv["土地面積"] || "",
    parking, units: "",
    elementary: es.name, elementaryMin: es.min, junior: js.name, juniorMin: js.min,
    facilities, photos, locText, locPrec: "",
    hpText,
    tags: [],
  };
}

async function main() {
  console.log("=== ナカジツ(熊本県・自社売主の新築) 収集開始 ===");
  const warnings = [];

  // 0. robots.txt を確認(禁止されていれば収集しない)
  const robots = await fetchHtml(BASE + "/robots.txt");
  if (robots && (!robotsAllows(robots, LIST_PATH) || !robotsAllows(robots, "/prpsearch/prpdetail/"))) {
    console.error("[ERROR] robots.txt が対象ページの自動アクセスを禁止しているため、収集を行いません。");
    recordScrapeStatus(SOURCE, { count: 0, notFound: getFetchStats().notFound,
      fatal: "ナカジツのHPが自動収集を禁止する設定に変わったため、収集を止めています" });
    return;
  }

  // 1. 検索結果を巡回(ページ送りは実物のリンクを辿る)
  const ids = [];
  const popups = {};
  const queue = [LIST_URL];
  const visited = new Set();
  let siteCount = null, siteMemberCount = null, ended = 0, memberOnly = 0, other = 0;
  const pageNo = (u) => (u.match(/[?&]pageID=(\d+)/) || [])[1] || "1";
  while (queue.length && visited.size < MAX_PAGES) {
    const pageUrl = queue.shift();
    if ([...visited].some((v) => pageNo(v) === pageNo(pageUrl))) continue;
    visited.add(pageUrl);
    await sleep(WAIT_MS);
    const html = await fetchHtml(pageUrl);
    if (!html) { console.error(`[WARN] 検索結果ページを取得できませんでした: ${pageUrl}`); continue; }
    const r = parseListPage(html);
    if (siteCount == null && r.siteCount != null) siteCount = r.siteCount;
    if (siteMemberCount == null && r.siteMemberCount != null) siteMemberCount = r.siteMemberCount;
    ended += r.ended; memberOnly += r.memberOnly; other += r.other;
    r.ids.forEach((id) => { if (!ids.includes(id)) ids.push(id); });
    Object.assign(popups, r.popups);
    for (const p of r.pages) {
      const n = pageNo(p);
      const already = [...visited, ...queue].some((v) => pageNo(v) === n);
      if (!already) queue.push(p);
    }
  }
  console.log(`[件数診断] 検索結果 ${visited.size}ページ → 掲載中の自社物件 ${ids.length}件` +
    `(HP表示の公開件数: ${siteCount == null ? "不明" : siteCount + "件"})` +
    ` / 会員限定 ${memberOnly}件(HP表示 ${siteMemberCount == null ? "不明" : "＋" + siteMemberCount + "件"}・取り込めません)` +
    ` / 成約済 ${ended}件` + (other ? ` / 自社印なし ${other}件(除外)` : ""));
  if (siteCount != null && siteCount !== ids.length) {
    console.log(`[件数診断] ※HP表示の件数と、見つけた物件数が一致しません(ページ送りや検索の作りが変わった可能性)`);
  }

  // 2. 各詳細ページを解析
  const scraped = [];
  let outside = 0, notOwn = 0;
  for (const id of ids) {
    const url = `${BASE}/prpsearch/prpdetail/OBJ_MNG_NO/${id}/`;
    await sleep(WAIT_MS);
    const html = await fetchHtml(url);
    if (!html) { warnings.push(`${url}\n    → ページ取得に失敗`); continue; }
    const item = parseDetail(html, url, warnings, popups[id]);
    if (item) { scraped.push(item); continue; }
    const last = warnings[warnings.length - 1] || "";
    if (/熊本県外/.test(last)) outside++;
    if (/ナカジツ売主ではない/.test(last)) notOwn++;
  }
  scraped.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  console.log(`解析完了: ${scraped.length}件` + (outside ? `(熊本県外 ${outside}件は除外)` : "") +
    (notOwn ? `(売主でない ${notOwn}件は除外)` : ""));

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
    const noBuilt = scraped.filter((s) => !s.builtAt).length;
    console.log(`[完成時期診断] 完成時期(築年月)が取れなかった物件: ${noBuilt}件`);
  }

  // 3. 差分反映(ナカジツ分のみ更新。他社・手動データには触れない)
  const merged = mergeListings(prev.listings || [], { [SOURCE]: scraped }, [SOURCE], todayStr());
  saveData(DATA_FILE, merged);

  const endedNow = merged.filter((l) => l.source === SOURCE && l.status === "ended").length;
  const rep = getMergeReport(SOURCE);
  recordScrapeStatus(SOURCE, { count: scraped.length, badFields: countBadFields(scraped),
    kept: rep.kept, prevActive: rep.prevActive, notFound: getFetchStats().notFound });
  console.log(`=== 完了: ナカジツ 掲載中 ${scraped.length}件 / 掲載終了 ${endedNow}件 ===`);
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

module.exports = { parseListPage, parseDetail, parseMapPopups, splitTraffic, LIST_URL };
