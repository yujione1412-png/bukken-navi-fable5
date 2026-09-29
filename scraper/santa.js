/* scraper/santa.js
   サンタ不動産(santa-estate.jp・自社ブランド「i-passo(アイパッソ)の家」)の
   熊本県内の新築建売住宅を収集して data/listings.json のサンタ不動産分を更新する。
   実行: node scraper/santa.js
   ─────────────────────────────────
   構造(2026年9月に実ページのHTMLを解析して確認済み):
   ・物件検索 /estates/ に「新築一戸建て」(estate_tab=new_house)と「熊本県」(prefecture_codes[0]=43)
     の条件を付けると、新築一戸建てだけが10件ずつ出る(土地・中古は出ない)。
     2ページ目以降は同じ条件に &_page=2,3… を付ける(総ページ数は「◯ページ中」から。上限15ページ)
   ・件数は検索結果の「一般公開 ◯件」(.list_countbox01 dl.general)を[件数診断]で照合。
     「会員限定」(li.bgr・物件名もリンクもない予告広告)と「店舗公開」の物件はHPで見られないので取り込まない
   ・一覧の1物件は li.estateItem。詳細 /estates/物件番号/ の「物件概要」(table.estatedetail_tbl01 の th/td)を読む
   ・取り込むのは「種目」が新築一戸建ての物件のうち、次のどちらか:
       取引態様が「売主」… サンタ不動産自身が売主
       自社ブランド「i-passoの家」のアイコンが付いた物件 … 取引態様が「媒介」でもサンタ不動産の家として取り込む
     ブランドのない「媒介」「仲介」の物件(他社の家)は取り込まない。
     ※「＼新築未使用／」の物件は種目が「中古一戸建て」なので取り込まない(検索条件でも除かれる)
   ・価格は物件概要の「価格」欄だけ(一覧の「返済例 月々◯円」やローンのシミュレーションは使わない)
   ・所在地「熊本県熊本市東区山ノ内３丁目７−２９」「熊本県合志市上庄97付近」は全角数字を半角にする。
     「熊本県」で始まらなければ県外としてスキップ
   ・面積「106.63㎡（32.25坪）（実測）」の（実測）（公簿）（壁芯）は外す
   ・構造「木造 1階建 軸組工法」で1階建=平屋、2階建=2階建て。完成年月「2026年 9月」、駐車場「有 (2台)」
   ・校区「熊本市立向山小学校」は「熊本市立」などを外して「向山小学校」にする。
     学校までの徒歩分は「周辺環境」(.surroundingsList_item「【小学校】熊本市立 向山小学校まで183m」)の距離を
     不動産広告の決まり(80m=1分・切り上げ)で換算
   ・交通「ＪＲ豊肥本線 武蔵塚駅 徒歩18分 (1400m)<br>電鉄・産交バス 「武蔵ヶ丘車庫前」 徒歩3分 (180m)」を
     <br>ごとに駅・バス停に分ける。駅は徒歩30分以内だけ載せる(遠い駅は載せず、最寄り駅の自動設定に任せる)。
     「その他交通」(乗合タクシー等)も、交通と重ならない乗り場だけ足す
   ・周辺施設は「周辺環境」のスーパー・コンビニ・ドラッグストア・病院・公園・保育園などを、徒歩20分以内だけ
     (銀行・郵便局・役所は載せない)。最大8件
   ・写真はページ上部のスライダー(.mainImgList_item)の画像を並び順に最大5枚。
     「同仕様写真」(他の家の設備写真)・「省エネ性能ラベル」・「周辺環境マップ」の画像は使わない。区画図は1枚まで
   ・位置はページ内の地図スクリプト const latitude = … / const longitude = …。
     所在地が「◯◯付近」や番地なしの物件は、HP自身が「実際の場所ではない場合がある」と書いているので「おおよそ」扱い
   ・紹介文は「セールスポイント」の1行目(【小学校まで徒歩7分！】…)
   ・1ページ=1区画(1棟)なので棟数の問題はない
   ・robots.txt はサイトにない(404)が、実行のたびに確認し、禁止されていれば収集せずに終了する
*/
const cheerio = require("cheerio");
const { fetchHtml, sleep, pickPrice, robotsAllows, mergeListings,
  loadData, saveData, todayStr, reuseLocText, geocode, WAIT_MS,
  getFetchStats, getMergeReport, recordScrapeStatus, countBadFields } = require("./common");

const BASE = "https://santa-estate.jp";
const DATA_FILE = __dirname + "/../data/listings.json";
const SOURCE = "santa";
const MAX_PHOTOS = 5;
const MAX_PAGES = 15;       // 一覧のページ送り上限(暴走防止)
const MAX_FACILITIES = 8;   // 周辺施設は多すぎると見づらいので上限を設ける
const MAX_STATION_MIN = 30; // これより遠い駅は「徒歩圏の駅」として載せない
const MAX_FAC_MIN = 20;     // 周辺施設は徒歩20分以内だけ
const GEO_LIMIT = 10;       // 住所からの位置推定は1回の実行でこの件数まで(無料サービスの利用ルール)
const LIST_PATH = "/estates/";
const SEARCH = "/estates/?estate_tab=new_house&prefecture_codes%5B0%5D=43";
const BRAND_RE = /i-passo|アイパッソ/i;

const clean = (s) => String(s || "").replace(/\r/g, "").replace(/[ \t 　]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
const oneLine = (s) => clean(s).replace(/\n+/g, " ");
// 全角の英数字・記号を半角に(「３丁目７−２９」「ＪＲ」など)
const hankaku = (s) => String(s || "")
  .replace(/[０-９Ａ-Ｚａ-ｚ＋]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/[−－‐]/g, "-");
const absUrl = (u) => { try { return new URL(String(u).replace(/&amp;/g, "&").trim(), BASE).href; } catch (e) { return ""; } };
const idOf = (u) => (String(u || "").match(/\/estates\/(\d+)\/?(?:[?#].*)?$/) || [])[1] || "";
// 距離(m) → 徒歩分(不動産広告の決まり:80mを1分とし、端数は切り上げ)
const walkMin = (m) => (m > 0 ? String(Math.ceil(m / 80)) : "");
const listUrl = (p) => BASE + SEARCH + (p > 1 ? "&_page=" + p : "");

/* 施設名・周辺環境の種類から、アプリのアイコン分けを判定 */
function facCat(name, kind) {
  const k = kind || "";
  if (/スーパー/.test(k)) return "super";
  if (/コンビニ/.test(k)) return "conbini";
  if (/ドラッグ|薬局/.test(k)) return "drug";
  if (/ショッピング|百貨店|モール/.test(k)) return "mall";
  if (/病院|医院|クリニック|診療所/.test(k)) return "hospital";
  if (/公園/.test(k)) return "park";
  if (/駅/.test(name) && !/バス|駅前$/.test(name)) return "station";
  if (/バス停|バス|停留所|乗合|タクシー/.test(name)) return "bus";
  if (/セブン|ローソン|ファミリーマート|デイリーヤマザキ|ミニストップ|ポプラ/.test(name)) return "conbini";
  if (/ドラッグ|薬局|コスモス|モリ薬品|ダイレックス/.test(name)) return "drug";
  if (/ゆめタウン|イオン|モール|ショッピングセンター/.test(name)) return "mall";
  if (/スーパー|マート|マルエイ|マルショク|サンリブ|マルキョウ|マックスバリュ|ミスターマックス|トライアル|ロッキー/.test(name)) return "super";
  if (/病院|クリニック|医院|診療所|歯科/.test(name)) return "hospital";
  if (/公園|広場/.test(name)) return "park";
  return "other";
}

/* 一覧ページ: 物件ID・会員限定の数・総ページ数・HP表示件数 */
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  let member = 0;
  $("li.estateItem").each((_, el) => {
    // 会員限定(li.bgr・物件名なし・「会員登録かログインが必要」の案内)はHPで見られないので数えるだけ
    if (/\bbgr\b/.test($(el).attr("class") || "") || $(el).find(".memberItem__txt").length) { member++; return; }
    const href = $(el).find(".estateItem_title_text a[href*='/estates/']").attr("href")
      || $(el).find("a[href*='/estates/']").attr("href") || "";
    const id = idOf(absUrl(href));
    if (!id) return;
    if (items.some((x) => x.id === id)) return;
    const icons = $(el).find(".iconWrap .icon_txt").map((__, s) => oneLine($(s).text())).get();
    items.push({ id, icons });
  });
  const tm = oneLine($(".paging_total").first().text()).match(/(\d+)\s*ページ中/);
  const num = (sel) => { const t = oneLine($(sel).first().text()); return /^\d+$/.test(t) ? +t : null; };
  return {
    items, member,
    totalPages: tm ? +tm[1] : null,
    siteCount: num(".list_countbox01 dl.general dd span"),
    memberCount: num(".list_countbox01 dl.private dd span"),
    shopCount: num(".list_countbox01 dl.shop dd span"),
  };
}

/* 物件概要の表(th/td)を「項目名→値」に。同じ項目は最初の値を使う */
function detailPairs($) {
  const kv = {};
  $("table.estatedetail_tbl01 th").each((_, th) => {
    const td = $(th).next("td");
    const k = oneLine($(th).text());
    if (!k || !td.length || k in kv) return;
    const c = td.clone();
    c.find("br").replaceWith("\n");
    kv[k] = clean(c.text());
  });
  return kv;
}

/* 所在地を整える。熊本県内と確認できなければ null(県外扱い) */
function normAddress(raw) {
  const a = hankaku(oneLine(raw)).replace(/\s+/g, "").trim();
  if (!a) return "";
  if (/^熊本県/.test(a)) return a;
  return null;
}

/* 完成年月「2026年 9月」→「2026年9月」 */
function parseBuiltAt(s) {
  const m = hankaku(oneLine(s)).match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  return m ? `${m[1]}年${+m[2]}月` : "";
}

/* 面積「106.63㎡（32.25坪）（実測）」→「106.63㎡（32.25坪）」 */
function normArea(s) {
  const t = hankaku(oneLine(s)).replace(/\s*[（(]\s*/g, "（").replace(/\s*[）)]/g, "）");
  const m = t.match(/[\d.]+㎡(?:（[\d.]+坪）)?/);
  return m ? m[0] : "";
}

/* 学校名「熊本市立向山小学校」「合志市立 合志小学校」→「向山小学校」 */
function schoolName(s) {
  const t = clean(s).split(/\n/)[0].replace(/\s+/g, "")
    .replace(/^.{1,8}?[市町村]立/, "").replace(/^(?:国立|県立|私立)/, "");
  const m = t.match(/^([^、,，・／/]{1,15}?(?:小学校|中学校|義務教育学校))/);
  return m ? m[1] : "";
}

/* 交通欄を駅・バス停に分ける。
   「ＪＲ豊肥本線 武蔵塚駅 徒歩18分 (1400m)」「電鉄・産交バス 「武蔵ヶ丘車庫前」 徒歩3分 (180m)」
   「産交バス「護藤郵便局前」バス停 徒歩4分 (250m)」「田端集落センター(乗合タクシー) 徒歩3分 (190m)」 */
function parseTraffic(text) {
  const out = [];
  for (const raw of String(text || "").split(/\n+/)) {
    const s = hankaku(oneLine(raw));
    if (!s) continue;
    const wm = s.match(/徒歩\s*約?\s*(\d+)\s*分/);
    const min = wm ? wm[1] : "";
    const body = s.replace(/徒歩.*$/, "").replace(/車\s*\d+.*$/, "").trim();
    if (!body) continue;
    const q = body.match(/^(.*?)\s*「([^」]+)」\s*(?:バス停|停留所)?$/);
    if (q) {
      const stop = q[2].trim();
      const co = q[1].trim();
      out.push({ name: `${co}「${stop}」${/タクシー/.test(co) ? "乗り場" : "バス停"}`.trim(), stop, min, cat: "bus" });
      continue;
    }
    const eki = body.match(/^(.*?)\s*([^\s]+駅)$/);
    if (eki && !/バス|タクシー/.test(body)) {
      out.push({ name: `${eki[1].trim()} ${eki[2]}`.trim(), stop: eki[2], min, cat: "station" });
      continue;
    }
    // 乗合タクシーなど「乗り場名(種類)」の形
    const tx = body.match(/^(.+?)[(（]([^)）]+)[)）]$/);
    out.push({ name: tx ? `${tx[1]}(${tx[2]})` : body, stop: tx ? tx[1] : body, min, cat: "bus" });
  }
  return out;
}

/* 周辺環境「【小学校】熊本市立 向山小学校まで183m」→ { kind, name, meters } */
function parseSurrounding(t) {
  const s = hankaku(oneLine(t));
  const m = s.match(/^【([^】]+)】\s*(.+?)まで\s*約?\s*([\d,.]+)\s*(k?m)/i);
  if (!m) return null;
  let meters = parseFloat(m[3].replace(/,/g, ""));
  if (/km/i.test(m[4])) meters *= 1000;
  return { kind: m[1], name: m[2].trim(), meters: Math.round(meters) };
}

/* 詳細ページ1件を解析。取り込まない物件は { skip:"理由の種類", msg } を返す */
function parseDetail(html, url, listInfo) {
  const $ = cheerio.load(html);
  const pid = idOf(url);
  const skip = (kind, msg) => ({ skip: kind, msg });
  const warns = [];
  const warn = (msg) => warns.push(msg);

  const kv = detailPairs($);
  if (!Object.keys(kv).length) {
    if (/ログイン/.test(oneLine($("h1").first().text()))) return skip("member", "会員限定の物件のためスキップ");
    return skip("error", "物件概要の表が見つかりません(HPの作りが変わった可能性)");
  }

  // 種目:新築一戸建てのみ
  const shumoku = kv["種目"] || "";
  if (!/新築/.test(shumoku) || !/戸建|一戸建/.test(shumoku)) return skip("notNew", `種目が「${shumoku || "不明"}」のためスキップ`);

  // 取引態様:売主、または自社ブランド「i-passoの家」の物件だけ
  const icons = $(".ttlWrap .iconWrap .icon_txt").map((_, s) => oneLine($(s).text())).get()
    .concat((listInfo && listInfo.icons) || []);
  const brand = icons.some((t) => BRAND_RE.test(t));
  const torihiki = oneLine(kv["取引態様"] || "");
  const isUri = /売主|事業主/.test(torihiki);
  if (!isUri && !brand) {
    if (/媒介|仲介|代理/.test(torihiki)) return skip("chukai", `取引態様が「${torihiki}」で自社ブランドの物件ではないためスキップ`);
    return skip("unknown", `取引態様が「${torihiki || "不明"}」のためスキップ(HPの作りが変わった可能性)`);
  }

  const name = hankaku(oneLine($("h1.mainTtl").first().text() || $("h1").first().text()))
    .replace(/^[＼\\][^／/]*[／/]\s*/, "").replace(/\s+/g, " ").trim();
  if (!name) return skip("error", "物件名が取れませんでした → スキップ");

  // 所在地(県外は取り込まない)
  const address = normAddress(kv["所在地"]);
  if (address === null) return skip("outside", `熊本県外の物件のためスキップ(${oneLine(kv["所在地"])})`);
  if (!address) warn("所在地が取れませんでした");

  // 価格:物件概要の「価格」欄だけ
  const price = pickPrice({ "価格": oneLine(kv["価格"]) }, "", warn);

  const lm = hankaku(kv["間取り"] || "").replace(/\s/g, "").match(/\d[SLDK]{1,5}(?:\+\d*S)?/i);
  const layout = lm ? lm[0].toUpperCase() : "";
  const kozo = hankaku(kv["建物構造規模"] || "");
  const fm = kozo.match(/(\d+)\s*階建/);
  const stories = /平屋|平家/.test(kozo) || (fm && fm[1] === "1") ? "平屋" : fm ? `${fm[1]}階建て` : "";
  const builtAt = parseBuiltAt(kv["完成年月"] || "");
  const landArea = normArea(kv["土地面積"] || "");
  const buildingArea = normArea(kv["建物面積"] || "");
  const pk = hankaku(kv["駐車場"] || "").match(/(\d+)\s*台/);
  const parking = pk ? pk[1] + "台" : "";

  const elementary = schoolName(kv["小学校校区"] || "");
  const junior = schoolName(kv["中学校校区"] || "");
  let elementaryMin = "", juniorMin = "";

  // 周辺施設 ①交通(駅・バス停)
  const traffic = parseTraffic(kv["交通"]);
  const others = parseTraffic(kv["その他交通"]);
  for (const o of others) {
    if (!traffic.some((t) => t.stop === o.stop)) traffic.push(o);
  }
  const facilities = [];
  for (const t of traffic) {
    if (t.cat === "station" && (!t.min || +t.min > MAX_STATION_MIN)) continue;
    facilities.push({ name: t.name, min: t.min, cat: t.cat });
  }
  // 周辺施設 ②周辺環境(学校は徒歩分だけ使う)
  // 学校名は「武蔵ヶ丘」「武蔵ケ丘」のように表記が揺れるので、そろえてから照合する
  const sameName = (s) => String(s || "").replace(/\s+/g, "").replace(/[ヶヵケが]/g, "ケ");
  const around = [];
  $(".surroundingsList_item").each((_, li) => {
    const f = parseSurrounding($(li).find(".surroundingsList_item_caption").text() || $(li).text());
    if (f) around.push(f);
  });
  // HPの入力ミスで別の物件の周辺環境が載っていることがある(校区の小学校と周辺環境の小学校が食い違う)。
  // その時は周辺環境を使わない(学校の徒歩分も周辺施設も載せない)
  const aroundEs = around.filter((f) => /小学校/.test(f.kind) || /小学校$/.test(f.name));
  const mismatch = elementary && aroundEs.length
    && !aroundEs.some((f) => sameName(f.name).endsWith(sameName(elementary)));
  if (mismatch) {
    warn(`周辺環境の小学校(${aroundEs.map((f) => f.name).join("・")})が校区(${elementary})と違うため、` +
      `周辺環境の情報は使いません(HPの入力ミスの可能性)`);
  }
  const nearby = [];
  for (const f of mismatch ? [] : around) {
    const nm = sameName(f.name);
    const min = walkMin(f.meters);
    if (/小学校/.test(f.kind) || /小学校$/.test(nm)) {
      if (elementary && !elementaryMin && nm.endsWith(sameName(elementary))) elementaryMin = min;
      continue;
    }
    if (/中学校/.test(f.kind) || /中学校$/.test(nm)) {
      if (junior && !juniorMin && nm.endsWith(sameName(junior))) juniorMin = min;
      continue;
    }
    if (/銀行|郵便|役所|役場|金融/.test(f.kind)) continue;
    if (!min || +min > MAX_FAC_MIN) continue;
    const cat = facCat(f.name, f.kind);
    if (/その他/.test(f.kind) && cat === "other") continue;
    if (cat === "station" || cat === "bus") continue;   // 駅・バス停は交通欄から載せているので重ねない   // 「その他」はスーパー等と分かるものだけ
    nearby.push({ name: f.name, min, cat });
  }
  nearby.sort((a, b) => +a.min - +b.min);
  const seen = new Set(facilities.map((f) => f.name));
  for (const f of nearby) if (!seen.has(f.name)) { seen.add(f.name); facilities.push(f); }
  facilities.splice(MAX_FACILITIES);

  // 写真:スライダーの画像を並び順に(同仕様写真・省エネ性能ラベル・周辺環境マップは除く、区画図は1枚まで)
  const photoUrls = [];
  let kukaku = 0;
  $(".mainImgList .mainImgList_item").each((_, it) => {
    if (photoUrls.length >= MAX_PHOTOS) return;
    const cap = oneLine($(it).find(".mainImgList_item_caption").text() || $(it).find("a").attr("title") || "");
    if (/同仕様|省エネ性能ラベル|周辺環境|周辺マップ/.test(cap)) return;
    if (/区画図/.test(cap) && kukaku++ >= 1) return;
    const im = $(it).find("img").first();
    const src = im.attr("data-src") || $(it).find("a").attr("href") || im.attr("src") || "";
    if (!src || /^data:/.test(src)) return;
    const u = absUrl(src);
    if (/\/estate%2Fimages%2F/i.test(u) && !photoUrls.includes(u)) photoUrls.push(u);
  });
  const photos = photoUrls.map((u, i) => ({ id: "p" + (i + 1), url: u, main: i === 0 }));
  if (!photos.length) warn("写真が1枚も取れませんでした");

  // 位置:地図スクリプトの const latitude = … / const longitude = …
  let locText = "", locPrec = "";
  const la = html.match(/const\s+latitude\s*=\s*['"]?([0-9]{2}\.[0-9]{3,})/);
  const lo = html.match(/const\s+longitude\s*=\s*['"]?([0-9]{3}\.[0-9]{3,})/);
  if (la && lo) {
    locText = `${(+la[1]).toFixed(7)}, ${(+lo[1]).toFixed(7)}`;
    // 「◯◯付近」「番地なし」の所在地は地図の位置もおおよそ
    if (/付近/.test(address)) locPrec = "banchi";
    else if (address && !/\d+(?:-\d+)*(?:[,、]\d+)*(?:の一部)?$/.test(address.replace(/番地?|号/g, "-").replace(/-+$/, ""))) locPrec = "town";
  }

  // 紹介文:セールスポイントの1行目
  const sp = $(".estateDetail_onepoint_content").first().clone();
  sp.find("br").replaceWith("\n");
  // 「＼松高小徒歩5分／」のような飾りの記号は外す
  const hpText = (clean(sp.text()).split("\n").map((x) => x.trim()).find(Boolean) || "")
    .replace(/[＼\\]\s*/g, "").replace(/\s*[／]\s*/g, " ").trim();

  const status = oneLine(kv["現況"] || "");
  return {
    listing: {
      id: `${SOURCE}-${pid}`,
      source: SOURCE,
      name, price, address: address || "",
      detailUrl: `${BASE}/estates/${pid}/`,
      layout, stories, builtAt,
      buildingArea, landArea,
      parking, units: "",
      elementary, elementaryMin, junior, juniorMin,
      facilities, photos, locText, locPrec,
      hpText,
      tags: [],
    },
    kind: isUri ? "売主" : "媒介(自社ブランド)",
    status,
    warns,
  };
}

async function main() {
  console.log("=== サンタ不動産(新築一戸建て・売主/自社ブランドの物件) 収集開始 ===");
  const warnings = [];

  // 0. robots.txt を確認(禁止されていれば収集しない。サイトに robots.txt が無い=制限なし)
  const robots = await fetchHtml(BASE + "/robots.txt");
  if (robots && (!robotsAllows(robots, LIST_PATH) || !robotsAllows(robots, "/estates/1/"))) {
    console.error("[ERROR] robots.txt が対象ページの自動アクセスを禁止しているため、収集を行いません。");
    recordScrapeStatus(SOURCE, { count: 0, notFound: getFetchStats().notFound,
      fatal: "サンタ不動産のHPが自動収集を禁止する設定に変わったため、収集を止めています" });
    return;
  }
  const nf0 = getFetchStats().notFound;   // robots.txt の404(もともと無い)は数えない

  // 1. 検索結果(新築一戸建て・熊本県)を巡回
  const listed = [];
  let siteCount = null, memberCount = null, shopCount = null, member = 0;
  let totalPages = 1, pagesRead = 0;
  for (let p = 1; p <= Math.min(totalPages, MAX_PAGES); p++) {
    await sleep(WAIT_MS);
    const url = listUrl(p);
    const html = await fetchHtml(url);
    if (!html) { console.error(`[WARN] 一覧ページを取得できませんでした: ${url}`); break; }
    const r = parseListPage(html);
    pagesRead++;
    if (p === 1) {
      totalPages = r.totalPages || 1;
      siteCount = r.siteCount; memberCount = r.memberCount; shopCount = r.shopCount;
    }
    member += r.member;
    r.items.forEach((it) => { if (!listed.some((x) => x.id === it.id)) listed.push(it); });
    if (!r.items.length && !r.member) break;
  }
  if (totalPages > MAX_PAGES) console.log(`[件数診断] ※一覧が${MAX_PAGES}ページを超えたため、上限までしか読んでいません`);
  console.log(`[件数診断] 一覧 ${pagesRead}ページ(HP上は${totalPages}ページ) → ${listed.length}件` +
    ` / HP表示の件数 一般公開 ${siteCount == null ? "不明" : siteCount + "件"}` +
    ` / 会員限定 ${memberCount == null ? "不明" : memberCount + "件"}(一覧で見えたのは${member}件・取り込み対象外)` +
    (shopCount ? ` / 店舗公開 ${shopCount}件(HPに載らないので対象外)` : ""));
  if (siteCount != null && siteCount !== listed.length) {
    console.log(`[件数診断] ※HP表示の件数と一覧から拾えた件数が一致しません(ページ送りの作りが変わった可能性)`);
  }

  // 2. 各詳細ページを解析
  const scraped = [];
  const cnt = { uri: 0, brand: 0, chukai: 0, unknown: 0, outside: 0, notNew: 0, member: 0 };
  const genkyo = {};
  for (const it of listed) {
    const url = `${BASE}/estates/${it.id}/`;
    await sleep(WAIT_MS);
    const html = await fetchHtml(url);
    if (!html) { warnings.push(`${url}\n    → ページ取得に失敗`); continue; }
    const r = parseDetail(html, url, it);
    if (r.skip) {
      if (r.skip in cnt) cnt[r.skip]++;
      if (r.skip !== "chukai" && r.skip !== "notNew" && r.skip !== "member") warnings.push(`${url}\n    → ${r.msg}`);
      continue;
    }
    r.warns.forEach((w) => warnings.push(`${url}\n    → ${w}`));
    if (r.kind === "売主") cnt.uri++; else cnt.brand++;
    if (r.status) genkyo[r.status] = (genkyo[r.status] || 0) + 1;
    scraped.push(r.listing);
  }
  scraped.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  console.log(`解析完了: ${scraped.length}件(売主 ${cnt.uri}件 / 媒介だが自社ブランド ${cnt.brand}件)` +
    (Object.keys(genkyo).length ? ` 現況: ${Object.entries(genkyo).map(([k, v]) => `${k}${v}件`).join("・")}` : "") +
    (cnt.chukai ? ` / 他社物件(媒介) ${cnt.chukai}件は除外` : "") +
    (cnt.notNew ? ` / 新築以外 ${cnt.notNew}件は除外` : "") +
    (cnt.member ? ` / 会員限定 ${cnt.member}件は除外` : "") +
    (cnt.unknown ? ` / 取引態様が不明 ${cnt.unknown}件は除外` : "") +
    (cnt.outside ? ` / 熊本県外 ${cnt.outside}件は除外` : ""));

  // 位置情報: ①HPの地図 ②前回値 ③住所からの推定
  const fromMap = scraped.filter((s) => s.locText).length;
  const approx = scraped.filter((s) => s.locText && s.locPrec).length;
  const prev = loadData(DATA_FILE);
  const reused = reuseLocText(prev.listings, scraped);
  let geocoded = 0, geoFail = 0;
  for (const s of scraped) {
    if (s.locText || !s.address) continue;
    if (geocoded + geoFail >= GEO_LIMIT) break;
    const g = await geocode(s.address);
    if (g.loc) { s.locText = g.loc; s.locPrec = g.prec === "exact" ? "banchi" : g.prec; geocoded++; } else geoFail++;
    await sleep(1200);
  }
  const noLoc = scraped.filter((s) => !s.locText).length;
  console.log(`[位置情報] HPの地図から直接取得: ${fromMap}件/${scraped.length}件(うち所在地が「付近」等でおおよそ扱い ${approx}件)` +
    ` / 前回から引き継ぎ ${reused}件 / 住所から推定 ${geocoded}件 / 未設定 ${noLoc}件`);
  if (scraped.length) {
    const total = scraped.reduce((n, s) => n + s.photos.length, 0);
    console.log(`[写真診断] 平均 ${(total / scraped.length).toFixed(1)}枚 / 写真なし ${scraped.filter((s) => !s.photos.length).length}件`);
    const noSchool = scraped.filter((s) => !s.elementary).length;
    const noSchoolMin = scraped.filter((s) => s.elementary && !s.elementaryMin).length;
    console.log(`[学校診断] 小学校区が取れなかった物件: ${noSchool}件 / 小学校の徒歩分が取れなかった物件: ${noSchoolMin}件`);
    const noBuilt = scraped.filter((s) => !s.builtAt).length;
    console.log(`[完成時期診断] 完成時期が載っていない物件: ${noBuilt}件`);
    const noStories = scraped.filter((s) => !s.stories).length;
    if (noStories) console.log(`[階数診断] 平屋・2階建てを判定できなかった物件: ${noStories}件`);
  }

  // 3. 差分反映(サンタ不動産分のみ更新。他社・手動データには触れない)
  // 一覧が1ページも読めなかった時は、全件を掲載終了にしないよう反映しない
  if (!pagesRead) {
    console.error("[ERROR] 物件一覧を1ページも取得できなかったため、今回は反映しません");
    recordScrapeStatus(SOURCE, { count: 0, notFound: getFetchStats().notFound - nf0,
      fatal: "サンタ不動産の物件一覧ページを取得できませんでした" });
    return;
  }
  const merged = mergeListings(prev.listings || [], { [SOURCE]: scraped }, [SOURCE], todayStr());
  saveData(DATA_FILE, merged);

  const endedNow = merged.filter((l) => l.source === SOURCE && l.status === "ended").length;
  const activeNow = merged.filter((l) => l.source === SOURCE && l.status !== "ended").length;
  const rep = getMergeReport(SOURCE);
  recordScrapeStatus(SOURCE, { count: scraped.length, badFields: countBadFields(scraped),
    kept: rep.kept, prevActive: rep.prevActive, notFound: getFetchStats().notFound - nf0 });
  console.log(`=== 完了: サンタ不動産 掲載中 ${activeNow}件 / 掲載終了 ${endedNow}件` +
    (rep.kept ? `(今回取れた${scraped.length}件ではなく前回の内容を維持)` : "") + " ===");
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

module.exports = { parseListPage, parseDetail, normAddress, parseBuiltAt, normArea, schoolName,
  parseTraffic, parseSurrounding, facCat, main };
