/* scraper/kokubu.js
   国分ハウジング(かえるホーム・kaeruhome.jp)の熊本県内の建売物件のうち、
   取引態様が「専属専任媒介」の物件(国分ハウジンググループが自社で建てた物件)だけを収集して
   data/listings.json の国分ハウジング分を更新する。
   実行: node scraper/kokubu.js
   ─────────────────────────────────
   構造(2026年9月に実ページのHTMLを解析して確認済み):
   ・熊本県の販売物件検索 /search/kumamoto/ は「POST送信」の検索フォーム。
     pref_sel[]=43(熊本県)を付けて送ると、熊本県の全物件が24件ずつ出る。
     2ページ目以降は同じ条件に page=2,3… を付けて送る(総ページ数は「◯ページ中」の表示から)
   ・件数は「該当件数75件」の表示([件数診断]で照合)
   ・一覧には「会員限定 非公開物件」(ログインしないと中身が見られない物件)が混ざる。
     会員限定の物件は詳細ページへのリンクがなく、取引態様も分からないため取り込まない(件数だけ数える)
   ・詳細ページ /search/detail/kumamoto/?p=物件コード は th/td 表。
     同じ項目(所在地・間取りなど)がページ上部の概要にも出るため、「最初に出てきた値」を使う
     (ページ下部のお問い合わせフォームの表は項目名が違うので混ざらない)
   ・「取引態様」が「専属専任媒介」の物件だけを取り込む。「仲介」は他社の物件なので取り込まない
   ・所在地は「熊本県上益城郡御船町大字木倉381-5」+ 地図リンク「Map」。
     地図リンク google.com/maps/search/緯度,経度 から位置を取る。ただしHP自身が
     「ピンは町名・丁目の位置で実際の場所ではない」と書いているため、「おおよそ」(town)扱いにする
   ・表の「駐車場」「物件構造(階数)」は空・「木造」だけのことが多いため、
     写真の説明「駐車場　2台」や紹介文・写真説明の「平屋」から補う
   ・沿線情報は「熊本市電Ａ系統　健軍町　バス24分　徒歩 約500m　徒歩 約6分<br>落合」の形
     (路線・駅・バスの乗車時間・バス停までの徒歩・<br>の後ろがバス停名)
   ・学校区は「木倉小学校　御船中学校」。徒歩分の記載はない(写真説明は距離のみ)
   ・写真は /photo/property/物件コード/img_物件コード_01.jpg の形(.photoBox の一覧)。自物件の番号の写真だけを番号順に最大5枚
   ・1ページ=1区画(1棟)なので棟数の問題はない
   ・実行のたびに robots.txt を確認し、禁止されていれば収集せずに終了する
*/
const cheerio = require("cheerio");
const { fetchHtml, sleep, pickPrice, robotsAllows, mergeListings,
  loadData, saveData, todayStr, reuseLocText, WAIT_MS,
  getFetchStats, getMergeReport, recordScrapeStatus, countBadFields } = require("./common");

const BASE = "https://www.kaeruhome.jp";
const DATA_FILE = __dirname + "/../data/listings.json";
const SOURCE = "kokubu";
const MAX_PHOTOS = 5;
const MAX_PAGES = 15;   // 検索結果のページ送り上限(暴走防止)
const LIST_PATH = "/search/kumamoto/";
const DETAIL_PATH = "/search/detail/kumamoto/";
const UA = "BukkenNaviBot/1.0 (shanai-riyou; contact via site form)";

const clean = (s) => String(s || "").replace(/\r/g, "").replace(/[ \t 　]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
const oneLine = (s) => clean(s).replace(/\n+/g, " ");
const idOf = (u) => (String(u || "").replace(/&amp;/g, "&").match(/\/search\/detail\/[a-z]+\/\?(?:[^"'#]*&)?p=(\d+)/) || [])[1] || "";

/* 検索フォームの送信内容(熊本県・条件指定なし)。page だけを変えて送る */
function searchForm(page) {
  const f = new URLSearchParams();
  f.append("pref_sel[]", "43");
  for (const k of ["city_sel[]", "town_sel[]", "line_sel[]", "station_sel[]"]) f.append(k, "0");
  for (const k of ["MAN_REQ_SCHL_SYO", "MAN_REQ_SCHL_TYU", "MAN_REQ_PRICE_L", "MAN_REQ_PRICE_U",
    "MAN_REQ_LAND_MEN_L", "MAN_REQ_LAND_MEN_U", "MAN_REQ_BLD_MEN_L", "MAN_REQ_BLD_MEN_U", "sort_mob", "sort"]) f.append(k, "0");
  f.append("page", String(page));
  f.append("order", "2");
  f.append("property_id", "");
  f.append("search_flag", "1");
  f.append("type_sel_map", "1");
  return f.toString();
}

/* 検索結果はPOSTでしか出ないため、共通のfetchHtml(GET専用)とは別に取得する */
const postStats = { failed: 0 };
async function fetchSearchPage(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(BASE + LIST_PATH, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: searchForm(page),
      });
      if (res.ok) return await res.text();
      console.error(`[WARN] ${res.status} 検索結果 ${page}ページ目`);
    } catch (e) {
      console.error(`[WARN] 検索結果 ${page}ページ目の取得失敗(${attempt}回目): ${e.message}`);
    }
    await sleep(2000 * attempt);
  }
  postStats.failed++;
  return null;
}

/* 検索結果ページ: 公開物件のID・会員限定の件数・総ページ数・HP表示件数 */
function parseListPage(html) {
  const $ = cheerio.load(html);
  const ids = [];
  $(".prpitemList li.prpItem a[href]").each((_, a) => {
    const id = idOf($(a).attr("href"));
    if (id && !ids.includes(id)) ids.push(id);
  });
  const text = oneLine($("body").text());
  // 会員限定の物件(li.prpItem.member)は詳細ページへのリンクがなく、取り込めない
  const memberOnly = $(".prpitemList li.prpItem.member").length;
  const cm = text.match(/該当件数\s*(\d+)\s*件/);
  const pm = text.match(/(\d+)\s*ページ中\s*\d+\s*ページ目/);
  const noResult = /該当の物件情報はございません/.test(text);
  return { ids, memberOnly, siteCount: cm ? +cm[1] : (noResult ? 0 : null),
    totalPages: pm ? +pm[1] : null, noResult };
}

/* 沿線情報「熊本市電Ａ系統　健軍町　バス24分　徒歩 約500m　徒歩 約6分<br>落合」→ 駅・バス停
   バスで駅まで行く形のときは駅の徒歩分は空にし、バス停(<br>の後ろ)に徒歩分を付ける */
function splitTraffic(tdHtml) {
  const lines = String(tdHtml || "").split(/<br\s*\/?>/i)
    .map((t) => cheerio.load(`<p>${t}</p>`)("p").text().replace(/[ \t 　]+/g, " ").trim());
  const first = lines[0] || "";
  // <br>の後ろはバス停名。駅もバス停もない物件は「徒歩 約2200m　徒歩 約28分」だけが入るので除く
  const busStop = (lines[1] || "").replace(/徒歩.*$/, "").trim();
  // 徒歩分は1行目(駅まで)か2行目(バス停まで)のどちらかにある
  const walk = (lines.join(" ").match(/徒歩\s*約?\s*(\d+)\s*分/) || [])[1] || "";
  const busMin = (first.match(/バス\s*(\d+)\s*分/) || [])[1] || "";
  const words = first.replace(/バス\s*\d+\s*分.*$/, "").replace(/徒歩.*$/, "").trim().split(" ").filter(Boolean);
  const out = [];
  if (words.length >= 2) {
    const [line, ...st] = words;
    out.push({ name: `${line} ${st.join(" ")}`, min: busMin ? "" : walk, cat: "station" });
  }
  if (busStop && !/^[\d\s約m分]*$/.test(busStop)) out.push({ name: /停|バス/.test(busStop) ? busStop : busStop + "バス停", min: busMin ? walk : "", cat: "bus" });
  return out;
}

/* 学校区「木倉小学校 御船中学校」→ 小学校・中学校 */
function splitSchools(text) {
  const s = oneLine(text);
  const es = (s.match(/([^\s　、,，／/]{1,15}小学校)/) || [])[1] || "";
  const js = (s.match(/([^\s　、,，／/]{1,15}中学校)/) || [])[1] || "";
  return { es, js };
}

/* 詳細ページ1件を解析 */
function parseDetail(html, url, warnings) {
  const $ = cheerio.load(html);
  const warn = (msg) => warnings.push(`${url}\n    → ${msg}`);
  const pid = idOf(url);

  // 表(th/td)を「項目名→値」に。同じ項目が2回出るので最初の値を採用
  const kv = {};
  const rawTd = {};
  let mapHref = "";
  $("table tr").each((_, tr) => {
    $(tr).children("th").each((__, th) => {
      const key = oneLine($(th).text()).replace(/\s+/g, "");
      const td = $(th).next("td");
      if (!key || !td.length) return;
      const c = td.clone();
      c.find("a").each((___, a) => {
        const h = $(a).attr("href") || "";
        if (/google\.[a-z.]+\/maps/.test(h)) { if (!mapHref) mapHref = h; $(a).remove(); }
      });
      c.find("script").remove();
      c.find("br").replaceWith("\n");
      const val = clean(c.text());
      if (val && !(key in kv)) { kv[key] = val; rawTd[key] = td.html() || ""; }
      // 面積は上の概要「218.05㎡」より、下の表の「218.05㎡ （65.96坪）」(坪つき)を優先
      else if (val && /面積/.test(key) && /坪/.test(val) && !/坪/.test(kv[key])) kv[key] = val;
    });
  });

  // 写真の説明文(駐車台数・平屋の補完に使う)
  const captions = $(".photoBox .caption").map((_, el) => oneLine($(el).text())).get();

  // 取引態様:専属専任媒介(自社で建てた物件)だけ。「仲介」は取り込まない
  const torihiki = oneLine(kv["取引態様"] || "");
  if (!/専属専任/.test(torihiki)) { warn(`取引態様が「${torihiki || "不明"}」のためスキップ(専属専任媒介のみ取り込み)`); return null; }

  const name = oneLine(kv["物件名"] || $("h1.titPart1").first().text()).replace(/\s+/g, " ");
  if (!name) { warn("物件名が取れませんでした → スキップ"); return null; }

  // 所在地(県外は取り込まない)
  const address = oneLine(kv["所在地"] || "").replace(/\s*Map\s*$/i, "").replace(/\s+/g, "");
  if (address && !/^熊本県/.test(address)) { warn(`熊本県外の物件のためスキップ(${address})`); return null; }

  // 価格:表の「価格」欄だけ(返済例の月々の金額は使わない)
  const price = pickPrice({ "価格": kv["価格"] || "" }, "", warn);

  // 間取り「4LDK」
  const lm = String(kv["間取り"] || "").replace(/\s/g, "").match(/\d[SLDK]{1,5}/i);
  const layout = lm ? lm[0].toUpperCase() : "";

  // 構造「木造」「木造2階建」(階数が書かれている時だけ)
  // 表は「木造」だけのことが多いので、紹介文・写真説明の「平屋」「2階建」でも判定する
  const kozo = oneLine(kv["物件構造"] || kv["構造"] || "");
  const prText = oneLine($(".salePointBox p").first().text());
  const descText = [name, prText, ...captions].join(" ");
  // 写真説明の「かえるホームの新築平屋建築予定地」「新築2階建て」を最優先で見る
  const sm = descText.match(/新築\s*(平屋|平家|[1-3１-３]階建)/);
  const fromDesc = (t) => /平屋|平家|[1１]階建/.test(t) ? "平屋" : /[3３]階建/.test(t) ? "3階建て" : /[2２]階建/.test(t) ? "2階建て" : "";
  const stories = /平屋|平家|(^|[^\d])1階建/.test(kozo) ? "平屋"
    : /3階/.test(kozo) ? "3階建て" : /2階/.test(kozo) ? "2階建て"
    : sm ? fromDesc(sm[1]) : fromDesc(descText);

  // 完成時期「2027年2月」
  const bm = String(kv["築年月"] || "").match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  const builtAt = bm ? `${bm[1]}年${+bm[2]}月` : "";

  // 面積「218.05㎡ （65.96坪）」→「218.05㎡（65.96坪）」
  const area = (v) => oneLine(v).replace(/\s*（/g, "（").replace(/\s*\(/g, "(");

  // 駐車場「2台」
  const pm = String(kv["駐車場"] || "").match(/(\d+)\s*台/)
    || captions.map((c) => c.match(/駐車(?:場|スペース)\s*(\d+)\s*台/)).find(Boolean);
  const parking = pm ? pm[1] + "台" : "";

  // 学校区「木倉小学校 御船中学校」(徒歩分の記載はない)
  const sc = splitSchools(kv["学校区"] || "");

  // 写真:/photo/property/物件コード/img_物件コード_NN.jpg だけを番号順に最大5枚
  const found = new Map();
  const re = new RegExp(`/photo/property/${pid}/img_${pid}_(\\d+)\\.(?:jpe?g|png)`, "gi");
  let m;
  while ((m = re.exec(html))) {
    const n = +m[1];
    if (!found.has(n)) found.set(n, BASE + m[0]);
  }
  const photos = [...found.keys()].sort((a, b) => a - b).slice(0, MAX_PHOTOS)
    .map((n, i) => ({ id: "p" + (i + 1), url: found.get(n), main: i === 0 }));
  if (!photos.length) warn("写真が1枚も取れませんでした");

  // 緯度経度:所在地の地図リンク google.com/maps/search/緯度,経度
  let locText = "";
  const locM = (mapHref || html).match(/google\.[a-z.]+\/maps\/search\/\s*([0-9]{2}\.[0-9]{3,})\s*,\s*([0-9]{3}\.[0-9]{3,})/);
  if (locM) locText = `${(+locM[1]).toFixed(7)}, ${(+locM[2]).toFixed(7)}`;
  // 周辺施設:沿線情報の駅・バス停
  const facilities = splitTraffic(rawTd["沿線情報"] || "");

  // 紹介文(PRポイント)
  const pr = $(".salePointBox p").first().clone();
  pr.find("br").replaceWith("\n");
  const hpText = clean(pr.text());

  return {
    id: `${SOURCE}-${pid}`,
    source: SOURCE,
    name, price, address,
    detailUrl: `${BASE}${DETAIL_PATH}?p=${pid}`,
    layout, stories, builtAt,
    buildingArea: area(kv["建物面積"] || ""), landArea: area(kv["土地面積"] || ""),
    parking, units: "",
    elementary: sc.es, elementaryMin: "", junior: sc.js, juniorMin: "",
    facilities, photos, locText, locPrec: locText ? "town" : "",
    hpText,
    tags: [],
  };
}

async function main() {
  console.log("=== 国分ハウジング(かえるホーム・熊本県・専属専任媒介の物件) 収集開始 ===");
  const warnings = [];

  // 0. robots.txt を確認(禁止されていれば収集しない)
  const robots = await fetchHtml(BASE + "/robots.txt");
  if (robots && (!robotsAllows(robots, LIST_PATH) || !robotsAllows(robots, DETAIL_PATH))) {
    console.error("[ERROR] robots.txt が対象ページの自動アクセスを禁止しているため、収集を行いません。");
    recordScrapeStatus(SOURCE, { count: 0, notFound: getFetchStats().notFound,
      fatal: "かえるホームのHPが自動収集を禁止する設定に変わったため、収集を止めています" });
    return;
  }

  // 1. 検索結果を巡回(総ページ数は1ページ目の「◯ページ中」から)
  const ids = [];
  let siteCount = null, totalPages = 1, memberOnly = 0, pagesRead = 0;
  for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page++) {
    await sleep(WAIT_MS);
    const html = await fetchSearchPage(page);
    if (!html) { console.error(`[WARN] 検索結果 ${page}ページ目を取得できませんでした`); continue; }
    const r = parseListPage(html);
    pagesRead++;
    if (page === 1) {
      siteCount = r.siteCount;
      if (r.totalPages) totalPages = r.totalPages;
    }
    memberOnly += r.memberOnly;
    r.ids.forEach((id) => { if (!ids.includes(id)) ids.push(id); });
  }
  if (totalPages > MAX_PAGES) console.log(`[件数診断] ※検索結果が${totalPages}ページあり、上限の${MAX_PAGES}ページまでしか読んでいません`);
  console.log(`[件数診断] 検索結果 ${pagesRead}ページ → 公開物件 ${ids.length}件 / 会員限定 ${memberOnly}件(中身が見られないため取り込めません)` +
    ` / HP表示の件数 ${siteCount == null ? "不明" : siteCount + "件"}`);
  if (siteCount != null && siteCount !== ids.length + memberOnly) {
    console.log(`[件数診断] ※HP表示の件数と、公開物件+会員限定の合計が一致しません(ページ送りや検索の作りが変わった可能性)`);
  }

  // 2. 各詳細ページを解析(専属専任媒介の物件だけ残す)
  const scraped = [];
  let chukai = 0, outside = 0;
  for (const id of ids) {
    const url = `${BASE}${DETAIL_PATH}?p=${id}`;
    await sleep(WAIT_MS);
    const html = await fetchHtml(url);
    if (!html) { warnings.push(`${url}\n    → ページ取得に失敗`); continue; }
    const item = parseDetail(html, url, warnings);
    if (item) { scraped.push(item); continue; }
    const last = warnings[warnings.length - 1] || "";
    if (/取引態様/.test(last)) { chukai++; warnings.pop(); }   // 仲介物件は正常な除外なので警告に出さない
    if (/熊本県外/.test(last)) outside++;
  }
  scraped.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  console.log(`解析完了: 専属専任媒介 ${scraped.length}件` +
    (chukai ? ` / 仲介など ${chukai}件は除外` : "") + (outside ? ` / 熊本県外 ${outside}件は除外` : ""));

  // 位置情報: ①HPの地図リンクから直接取得 ②取れなかった物件は前回値を引き継ぐ
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

  // 3. 差分反映(国分ハウジング分のみ更新。他社・手動データには触れない)
  // 検索結果が1ページも読めなかった時は、全件を掲載終了にしないよう反映しない
  if (!pagesRead) {
    console.error("[ERROR] 検索結果を1ページも取得できなかったため、今回は反映しません");
    recordScrapeStatus(SOURCE, { count: 0, notFound: getFetchStats().notFound,
      fatal: "かえるホームの検索結果ページを取得できませんでした" });
    return;
  }
  const merged = mergeListings(prev.listings || [], { [SOURCE]: scraped }, [SOURCE], todayStr());
  saveData(DATA_FILE, merged);

  const endedNow = merged.filter((l) => l.source === SOURCE && l.status === "ended").length;
  const rep = getMergeReport(SOURCE);
  recordScrapeStatus(SOURCE, { count: scraped.length, badFields: countBadFields(scraped),
    kept: rep.kept, prevActive: rep.prevActive, notFound: getFetchStats().notFound });
  console.log(`=== 完了: 国分ハウジング 掲載中 ${scraped.length}件 / 掲載終了 ${endedNow}件 ===`);
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

module.exports = { parseListPage, parseDetail, searchForm, splitSchools, splitTraffic };
