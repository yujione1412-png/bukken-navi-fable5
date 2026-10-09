/* scraper/kyuken.js
   九建ホーム(kyukenhome.co.jp)の販売中の建売住宅(モデルハウス)を収集して
   data/listings.json の九建ホーム分を更新する。
   実行: node scraper/kyuken.js
   ─────────────────────────────────
   構造(2026年10月のHPリニューアル後の実ページを解析して確認済み):
   ・2026年10月9日にHPが作り替えられ、物件情報は「物件」ページ /property/◯◯/ に移った。
     旧ページ(/land/番号/・/modelhouse/番号/)は見出しだけの空ページになったので使わない
   ・物件の一覧は WordPress の公開API /wp-json/wp/v2/contents1(物件)から取る(100件ずつ)。
     「property-type」が モデルハウス(slug: modelhouse)= 建売、分譲地(slug: land)= 土地の団地ページ
   ・販売中の判定(建売=モデルハウスのうち、次のどれにも当たらないもの):
       ① 題名に「完売」「募集終了」「成約」がある(例「【完売・募集終了】東町中前 団地 1号地…」)、
          またはページ名(slug)が closed- で始まる
       ② 物件ページ上部の表の「見学状況」に「成約」「完売」「募集終了」がある
          (例「×（2026年10月3日掲載確認・現在の状況は確認中）／区画表：ご成約済」)
       ③ 親の分譲地ページの「区画情報」の表で、その号地の「掲載状況」が「ご成約済」になっている
     「見学状況」が「×」だけで成約の記載がない物件は、念のため取り込んで警告に出す
   ・物件ページ上部の表(.p-single-property-header-table-item の -h/-d):
     所在地「宇土市南段原町」/ 間取り「4LDK」「４LDK」/ 敷地面積「55.12坪」/ 建物面積「35.05坪」/ 見学状況。
     所在地は表の下の .c-address「熊本県宇土市南段原町」「熊本県益城町大字宮園字辻」を優先(郡がなければ補う)
   ・面積は坪だけなので㎡に換算して「182.21㎡（55.12坪）」の形にする。
     建物が100坪超、または敷地の1.2倍超かつ60坪超なら入力誤りとみなして採用しない(警告)
   ・物件名は親の分譲地の名前+号地(「宇土鶴城中前 3号地」)。物件ページの見出しは
     【新築分譲住宅】【40周年キャンペーン適用】などの宣伝文句が付いたり外れたりし、「Ⅱ」が抜けていることもあるので使わない
     (親の分譲地が分からない時だけ、見出しから宣伝文句・「団地」「モデルハウス」を外して使う)
   ・リニューアルで物件の番号(投稿番号)が変わったため、前回までのデータに同じ「分譲地名+号地」の
     物件があれば、その物件IDを引き継ぐ(★候補・手動編集・登録日・価格メモを保つため)。
     新しく見つかった物件は kyuken-<新しい投稿番号>
   ・写真は上部ギャラリー .js-gallery-sub-image の data-full を並び順に最大5枚(なければメイン画像)
   ・位置は「所在地・ルート案内」の地図(q=緯度, 経度)。分譲地の中心の地点なので locPrec: "area"
     (アプリで「分譲地のおおよその位置」表示)
   ・校区・学校までの距離・周辺施設は親の分譲地ページから:
       上部の表の「校区」(「宇土小／鶴城中」「飽田東・南小／飽田中」「西合志南小・西合志南中」→ 2校ある時は見出しの校区を使う)
       「区画情報」または「区画一覧」の表(区画 / 敷地面積 / 掲載状況・公開サイト上の状況)
       「周辺環境」の段落「【教育施設】宇土幼稚園約280m／ 宇土小学校約1000m／…【公共機関】…」
       (「【教育機関】西合志南小学校：約1,270m／…【交通機関】…」の書き方もある)
       距離は不動産広告の決まり(80m=1分・切り上げ)で徒歩分に直し、徒歩20分以内・最大8件。
       公共機関はバス停・駅だけ、金融施設・その他は載せない
   ・紹介文は上部のキャッチコピー(.p-single-property-header-tagline)。「【ZEH水準 省エネ住宅】」のような
     どの物件にも付く文句なら、ポイント表の「リアルな暮らし」(「鶴城中まで徒歩3分」)を使う
   ・平屋・2階建ての記載はなくなった。前回までに取れていた建て方(平屋など)は引き継ぐ
   ・価格はHPに載っていない(「価格はお問い合わせください」「全10区画、3,300万円台〜」だけ)ので取らない。
     アプリでは「価格は要確認」と表示し、平均価格の計算にも含めない
   ・1ページ=1区画(1棟)。完成時期・駐車場の記載はない
   ・実行のたびに robots.txt を確認し、禁止されていれば収集せずに終了する
*/
const cheerio = require("cheerio");
const { fetchHtml, sleep, robotsAllows, mergeListings,
  loadData, saveData, todayStr, WAIT_MS,
  getFetchStats, getMergeReport, recordScrapeStatus } = require("./common");

const BASE = "https://kyukenhome.co.jp";
const API = BASE + "/wp-json/wp/v2/contents1";
const DATA_FILE = __dirname + "/../data/listings.json";
const SOURCE = "kyuken";
const MAX_PHOTOS = 5;
const MAX_API_PAGES = 10;    // 物件APIのページ送り上限(100件×10=1000件。暴走防止)
const MAX_FACILITIES = 8;
const MAX_WALK_MIN = 20;     // 周辺施設は徒歩20分(1,600m)以内だけ
const TSUBO = 3.305785;      // 1坪 = 3.305785㎡
const SOLD_RE = /成約|完売|募集終了|販売終了|売約/;

// 熊本県内の市・郡(所在地に県名がない時に熊本県内かを判定する)
const KUMAMOTO_AREA_RE = /^(熊本市|八代市|人吉市|荒尾市|水俣市|玉名市|山鹿市|菊池市|宇土市|上天草市|宇城市|阿蘇市|天草市|合志市|下益城郡|玉名郡|菊池郡|阿蘇郡|上益城郡|八代郡|葦北郡|球磨郡|天草郡)/;
// 郡名を省いて町村名から書かれた時のための、熊本県内の町村名 → 郡名
const KUMAMOTO_TOWNS = {
  美里町: "下益城郡", 玉東町: "玉名郡", 南関町: "玉名郡", 長洲町: "玉名郡", 和水町: "玉名郡",
  大津町: "菊池郡", 菊陽町: "菊池郡", 南小国町: "阿蘇郡", 小国町: "阿蘇郡", 産山村: "阿蘇郡",
  高森町: "阿蘇郡", 西原村: "阿蘇郡", 南阿蘇村: "阿蘇郡", 御船町: "上益城郡", 嘉島町: "上益城郡",
  益城町: "上益城郡", 甲佐町: "上益城郡", 山都町: "上益城郡", 氷川町: "八代郡", 芦北町: "葦北郡",
  津奈木町: "葦北郡", 錦町: "球磨郡", 多良木町: "球磨郡", 湯前町: "球磨郡", 水上村: "球磨郡",
  相良村: "球磨郡", 五木村: "球磨郡", 山江村: "球磨郡", 球磨村: "球磨郡", あさぎり町: "球磨郡",
  苓北町: "天草郡",
};

const clean = (s) => String(s || "").replace(/\r/g, "").replace(/[ \t 　]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
const oneLine = (s) => clean(s).replace(/\n+/g, " ");
// 全角の英数字を半角に(「４LDK」「３号地」「約400ｍ」など)
const hankaku = (s) => String(s || "").replace(/[０-９Ａ-Ｚａ-ｚ＋－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
const absUrl = (u) => { try { return new URL(String(u).replace(/&amp;/g, "&").replace(/&#0?38;/g, "&").trim(), BASE).href; } catch (e) { return ""; } };
const decodeEnt = (s) => cheerio.load(`<p>${s || ""}</p>`)("p").text();
/* ページ名(slug)。「/property/◯◯」「/wp/property/◯◯/」のどちらの書き方でも同じ値になるようにする */
function slugOf(u) {
  try {
    const p = new URL(absUrl(u)).pathname.replace(/\/+$/, "");
    const last = p.split("/").pop() || "";
    return decodeURIComponent(last).toLowerCase();
  } catch (e) { return ""; }
}

/* 施設名から種類を判定(アプリのアイコン分け用) */
function facCat(name) {
  if (/バス|停留所|[^駅]停$/.test(name)) return "bus";
  if (/駅/.test(name)) return "station";
  if (/セブン|ローソン|ファミリーマート|デイリーヤマザキ|ミニストップ|ポプラ|コンビニ/.test(name)) return "conbini";
  if (/ドラッグ|薬局|コスモス|モリ薬品|ダイレックス|よかもんね/.test(name)) return "drug";
  if (/ゆめタウン|イオン|モール|ショッピングセンター/.test(name)) return "mall";
  if (/スーパー|マート|マルエイ|マルショク|サンリブ|マルキョウ|マルミヤ|マックスバリュ|ミスターマックス|トライアル|ロッキー|生鮮|鮮ど市場|あんじぇらす|ハローデイ|ロピア|キッド/.test(name)) return "super";
  if (/病院|クリニック|医院|診療所|歯科|眼科|内科|小児科|耳鼻/.test(name)) return "hospital";
  if (/公園|広場/.test(name)) return "park";
  return "other";
}

/* 「約1830m」「約400ｍ」「1.2km」→ メートル。読めなければ null */
function meters(s) {
  const t = hankaku(oneLine(s)).replace(/,/g, "");
  let m = t.match(/(\d+(?:\.\d+)?)\s*km/i);
  if (m) return Math.round(parseFloat(m[1]) * 1000);
  m = t.match(/(\d+(?:\.\d+)?)\s*m/i);
  return m ? Math.round(parseFloat(m[1])) : null;
}
/* 不動産広告の決まり(徒歩1分=80m、端数は切り上げ)で徒歩分に直す */
const walkMin = (m) => (m == null ? "" : String(Math.max(1, Math.ceil(m / 80))));

/* 分譲地の題名「【分譲地】宇土鶴城中前 （宇土小・鶴城中 校区）【40周年キャンペーン適用】」→「宇土鶴城中前」 */
function landNameOf(title) {
  return hankaku(oneLine(title)).replace(/【[^】]*】/g, "")
    .replace(/[（(][^（）()]*校区[^（）()]*[）)]/g, "")
    .replace(/\s*団地\s*/g, " ").replace(/\s+/g, " ").trim();
}

/* 物件の見出しから号地「3号地」「8-1号地」を取り出す */
function gochiOf(title) {
  const m = hankaku(oneLine(title)).replace(/\s+/g, "").match(/(\d+(?:[-ー]\d+)?号地)/);
  return m ? m[1].replace("ー", "-") : "";
}

/* 親の分譲地が分からない時の物件名(見出しから宣伝文句などを外す) */
function nameFromTitle(title) {
  return hankaku(oneLine(title)).replace(/【[^】]*】/g, "").replace(/モデルハウス/g, "")
    .replace(/\s*団地\s*/g, " ").replace(/\s+/g, " ").trim();
}

/* 前回のデータと照合するための名前のキー(空白・括弧書き・「団地」の違いを無視する) */
function nameKey(name) {
  return hankaku(String(name || "")).replace(/[（(][^（）()]*[）)]/g, "").replace(/団地|モデルハウス/g, "")
    .replace(/[\s　]+/g, "").toLowerCase();
}

/* 校区「宇土小／鶴城中」「宇土東／鶴城中」「飽田東・南小／飽田中」→ 学校名。
   「／」の前が小学校、後ろが中学校(「小」「中」が省かれていることがある)。
   小学校が「・」で2校書かれている時は、分譲地の題名「（飽田南小・飽田中 校区）」の小学校を使う */
function schoolsOf(dd, title) {
  const full = (s, kind) => {
    const t = String(s || "").replace(/\s+/g, "").replace(kind === "小" ? /小(学校)?$/ : /中(学校)?$/, "");
    return t ? t + (kind === "小" ? "小学校" : "中学校") : "";
  };
  const head = (oneLine(title).match(/[（(]([^（）()]*)校区[^（）()]*[）)]/) || [])[1] || "";
  const headE = (head.match(/([^\s・／/、,，]{1,15}小)(学校)?/) || [])[1] || "";
  const headJ = (head.match(/([^\s・／/、,，]{1,15}中)(学校)?/) || [])[1] || "";
  const parts = oneLine(dd).split(/[／\/]/).map((s) => s.trim()).filter(Boolean);
  let e = "", j = "";
  if (parts.length >= 2) { e = parts[0]; j = parts[1]; }
  else if (parts.length === 1) { if (/中(学校)?$/.test(parts[0]) && !/小/.test(parts[0])) j = parts[0]; else e = parts[0]; }
  if (!e || /[・、,，]/.test(e)) e = headE;
  if (!j || /[・、,，]/.test(j)) j = headJ;
  return { elementary: full(e, "小"), junior: full(j, "中") };
}

/* 所在地を整える。熊本県内と確認できなければ null(県外扱い) */
function normAddress(raw) {
  let a = hankaku(oneLine(raw)).replace(/〒?\s*\d{3}\s*[-‐－ー]\s*\d{4}/, "").replace(/\s+/g, "").trim();
  if (!a) return "";
  let rest = a.replace(/^熊本県/, "");
  const hadPref = rest !== a;
  if (KUMAMOTO_AREA_RE.test(rest)) return "熊本県" + rest;
  const town = Object.keys(KUMAMOTO_TOWNS).find((t) => rest.startsWith(t));
  if (town) return "熊本県" + KUMAMOTO_TOWNS[town] + rest;
  if (hadPref) return "熊本県" + rest;
  return null;
}

/* 坪 → 「223.01㎡（67.46坪）」 */
function tsuboText(tsubo) {
  if (!(tsubo > 0)) return "";
  return `${(tsubo * TSUBO).toFixed(2)}㎡（${tsubo.toFixed(2)}坪）`;
}
const tsuboNum = (s) => { const m = hankaku(oneLine(s)).replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*坪/); return m ? parseFloat(m[1]) : null; };

/* 地図の位置(q=緯度, 経度) */
function locOf(html) {
  const m = String(html || "").replace(/%2C/gi, ",").replace(/&#0?38;|&amp;/g, "&")
    .match(/maps(?:\/search\/|\?[^"']*?q=)\s*([0-9]{2}\.[0-9]{3,})\s*,\s*([0-9]{3}\.[0-9]{3,})/);
  return m ? `${(+m[1]).toFixed(6)}, ${(+m[2]).toFixed(6)}` : "";
}

/* 物件ページ上部の表(項目名 → 値) */
function headerTable($) {
  const t = {};
  $(".p-single-property-header-table-item").each((_, el) => {
    const k = oneLine($(el).find(".p-single-property-header-table-item-h").first().text());
    const v = oneLine($(el).find(".p-single-property-header-table-item-d").first().text());
    if (k && !(k in t)) t[k] = v;
  });
  return t;
}

/* 分譲地ページ: 名前・校区・区画の状況・周辺環境・位置 */
function parseLand(html, url) {
  const $ = cheerio.load(html);
  const title = oneLine($("h1").first().text());
  const name = landNameOf(title);
  const t = headerTable($);
  const { elementary, junior } = schoolsOf(t["校区"] || "", title);
  const body = $(".tcdce-body").first();

  // 区画情報の表:「区画 / 敷地面積 / 掲載状況」
  const parcels = [];
  body.find("h2").each((_, h2) => {
    if (!/区画(情報|一覧)/.test($(h2).text())) return;   // 分譲地によって「区画情報」「区画一覧」
    const table = $(h2).nextAll(".s_table, table").first();
    (table.is("table") ? table : table.find("table").first()).find("tr").each((__, tr) => {
      const tds = $(tr).children("td");
      if (tds.length < 2) return;
      const parcel = hankaku(oneLine(tds.eq(0).text())).replace(/\s+/g, "");
      const last = tds.eq(tds.length - 1);
      const status = oneLine(last.text());
      const link = last.find("a[href]").first().attr("href") || "";
      if (parcel) parcels.push({ parcel, status, slug: link ? slugOf(link) : "" });
    });
  });

  // 周辺環境:「【教育施設】宇土幼稚園約280m／ 宇土小学校約1000m／…【公共機関】…」
  let elementaryMin = "", juniorMin = "";
  const facs = [];
  body.find("h2").each((_, h2) => {
    if (!/周辺環境/.test($(h2).text())) return;
    let txt = "";
    let el = $(h2).next();
    while (el.length && !el.is("h2") && !el.is("section")) { txt += " " + el.text(); el = el.next(); }
    const re = /【([^】]+)】([^【]*)/g;
    let m;
    while ((m = re.exec(txt))) {
      const sec = m[1];
      for (const item of m[2].split(/[／\/]/)) {
        const it = oneLine(item);
        const mm = hankaku(it).match(/^(.*?)\s*約?\s*([\d.,]+\s*(?:km|ｍ|m|ｋｍ))\s*$/i);
        if (!mm) continue;
        const nm = oneLine(mm[1]).replace(/約$/, "").replace(/[:：]\s*$/, "").trim();   // 「西合志南小学校：約1,270m」の「：」を外す
        const dist = meters(mm[2]);
        if (!nm || dist == null) continue;
        if (/教育/.test(sec)) {
          const nmS = nm.replace(/\s+/g, "");
          if (elementary && !elementaryMin && nmS.includes(elementary.replace(/小学校$/, "") + "小")) elementaryMin = walkMin(dist);
          if (junior && !juniorMin && nmS.includes(junior.replace(/中学校$/, "") + "中")) juniorMin = walkMin(dist);
          continue;
        }
        if (!/公共|交通|ショッピング|買|商業|医療/.test(sec)) continue;   // 金融・その他は載せない
        const cat = facCat(nm);
        if (/公共|交通/.test(sec) && cat !== "bus" && cat !== "station") continue;
        const min = walkMin(dist);
        if (+min > MAX_WALK_MIN) continue;
        facs.push({ name: nm, min, cat });
      }
    }
  });
  const rank = (c) => (c === "station" ? 0 : c === "bus" ? 1 : 2);
  const seen = new Set();
  const facilities = facs.map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f.cat) - rank(b.f.cat) || (+a.f.min) - (+b.f.min) || a.i - b.i)
    .map((x) => x.f).filter((f) => !seen.has(f.name) && seen.add(f.name)).slice(0, MAX_FACILITIES);

  const address = oneLine($(".p-single-property-header-info .c-address").first().text()) || t["所在地"] || "";
  return { url, slug: slugOf(url), title, name, elementary, junior, elementaryMin, juniorMin,
    parcels, facilities, address, locText: locOf(html), sold: SOLD_RE.test(title) };
}

const GENERIC_TAG_RE = /ZEH|省エネ|ご見学はこちら|資料だけでも|お問い合わせ|確認中|テストサイト|完売/;

/* 建売(モデルハウス)の物件ページを解析 */
function parseHouse(html, item) {
  const $ = cheerio.load(html);
  const warns = [];
  const warn = (msg) => warns.push(msg);
  const title = oneLine($("h1").first().text()) || decodeEnt(item.title && item.title.rendered);
  if (!title) return { skip: "error", msg: "物件ページの見出しが取れませんでした(HPの作りが変わった可能性) → スキップ" };
  const t = headerTable($);
  const kengaku = t["見学状況"] || t["ご見学"] || "";

  // 親の分譲地(「親分譲地」の欄のカード)
  let parentUrl = "";
  $(".p-single-bottom").each((_, sec) => {
    if (!parentUrl && /親分譲地/.test($(sec).find(".p-single-bottom-title").first().text())) {
      parentUrl = absUrl($(sec).find(".p-property-cards-item-title a[href]").first().attr("href") || "");
    }
  });

  // 所在地(表の下の住所 → 表の所在地)
  const addrRaw = oneLine($(".p-single-property-header-info .c-address").first().text()) || t["所在地"] || "";
  const address = normAddress(addrRaw);

  // 面積(坪)・間取り
  const landT = tsuboNum(t["敷地面積"] || t["土地面積"] || "");
  let bldT = tsuboNum(t["建物面積"] || "");
  if (bldT != null && (bldT > 100 || (landT && bldT > landT * 1.2 && bldT > 60))) {
    warn(`建物面積「${bldT}坪」は敷地より大きく、HPの入力誤りの可能性が高いため採用しません`);
    bldT = null;
  }
  const lm = hankaku(t["間取り"] || "").replace(/\s/g, "").match(/\d[SLDK]{1,5}(?:\+\d*S)?/i);
  const layout = lm ? lm[0].toUpperCase() : "";

  // 紹介文: キャッチコピー → だめならポイント表の「リアルな暮らし」
  const tagline = oneLine($(".p-single-property-header-tagline").first().text());
  let real = "";
  $(".p-single-property-section").first().find("th").each((_, th) => {
    if (!real && /リアルな暮らし/.test($(th).text())) real = oneLine($(th).next("td").text());
  });
  const hpText = (tagline && !GENERIC_TAG_RE.test(tagline)) ? tagline : (real || "");

  // 平屋(物件の上部と物件詳細の欄だけを見る。「条件の近い物件」など他の物件の欄は見ない)
  const ownText = $(".p-single-property-header").text() + " " + $(".p-single-property-section").first().text();
  const stories = /平屋|平家/.test(ownText) ? "平屋" : "";

  // 写真: 上部ギャラリーの並び順に最大5枚(なければメイン画像)
  const photoUrls = [];
  $(".js-gallery-sub-image").each((_, el) => {
    const u = absUrl($(el).attr("data-full") || $(el).find("img").attr("src") || "");
    if (u && /\.(jpe?g|png|webp)(\?|$)/i.test(u) && !photoUrls.includes(u)) photoUrls.push(u);
  });
  if (!photoUrls.length) {
    const u = absUrl($("#js-gallery-main-image").attr("src") || "");
    if (u && /\.(jpe?g|png|webp)(\?|$)/i.test(u)) photoUrls.push(u);
  }

  return { title, kengaku, parentUrl, addrRaw, address, landT, bldT, layout, hpText, stories,
    photoUrls, locText: locOf(html), testNote: /テストサイト|確認用ページ/.test($(".p-single-property-header-note").text()), warns };
}

/* 物件APIを読む(JSON。100件ずつ、最後のページまで) */
async function fetchAllItems() {
  const items = [];
  for (let page = 1; page <= MAX_API_PAGES; page++) {
    await sleep(WAIT_MS);
    const txt = await fetchHtml(`${API}?per_page=100&page=${page}`);
    if (txt == null) { if (page === 1) return null; break; }
    let arr;
    try { arr = JSON.parse(txt); } catch (e) { if (page === 1) return null; break; }
    if (!Array.isArray(arr)) { if (page === 1) return null; break; }
    items.push(...arr);
    if (arr.length < 100) break;
  }
  return items;
}

async function main() {
  console.log("=== 九建ホーム(販売中の建売住宅・モデルハウス) 収集開始 ===");
  const warnings = [];

  // 0. robots.txt を確認(禁止されていれば収集しない)
  const robots = await fetchHtml(BASE + "/robots.txt");
  if (robots && (!robotsAllows(robots, "/property/") || !robotsAllows(robots, "/wp-json/wp/v2/contents1"))) {
    console.error("[ERROR] robots.txt が対象ページの自動アクセスを禁止しているため、収集を行いません。");
    recordScrapeStatus(SOURCE, { count: 0, notFound: getFetchStats().notFound,
      fatal: "九建ホームのHPが自動収集を禁止する設定に変わったため、収集を止めています" });
    return;
  }

  // 1. 物件の一覧(API)
  const items = await fetchAllItems();
  if (!items || !items.length) {
    console.error("[ERROR] 物件の一覧(API)を取得できなかったため、今回は反映しません");
    recordScrapeStatus(SOURCE, { count: 0, notFound: getFetchStats().notFound,
      fatal: "九建ホームの物件一覧を取得できませんでした(HPの作りが変わった可能性があります)" });
    return;
  }
  // 物件の種類(モデルハウス/分譲地)の番号を調べる
  let mhTerm = null, landTerm = null;
  const termTxt = await fetchHtml(BASE + "/wp-json/wp/v2/property-type?per_page=100");
  try {
    for (const tm of JSON.parse(termTxt || "[]")) {
      if (tm.slug === "modelhouse" || /モデルハウス|建売|新築/.test(tm.name)) mhTerm = mhTerm ?? tm.id;
      if (tm.slug === "land" || /分譲地|土地/.test(tm.name)) landTerm = landTerm ?? tm.id;
    }
  } catch (e) {}
  const typeOf = (it) => {
    const ids = it["property-type"] || [];
    const cls = (it.class_list || []).join(" ");
    if ((mhTerm != null && ids.includes(mhTerm)) || /property-type-modelhouse/.test(cls)) return "house";
    if ((landTerm != null && ids.includes(landTerm)) || /property-type-land/.test(cls)) return "land";
    return "other";
  };
  const houses = items.filter((it) => typeOf(it) === "house" && it.status === "publish");
  const lands = items.filter((it) => typeOf(it) === "land" && it.status === "publish");
  const others = items.filter((it) => typeOf(it) === "other");
  const closedRe = (it) => SOLD_RE.test(decodeEnt(it.title && it.title.rendered)) || /^closed-/i.test(it.slug || "");
  const housesClosed = houses.filter(closedRe);
  console.log(`[件数診断] 物件API ${items.length}件: モデルハウス ${houses.length}件(うち題名が完売・募集終了 ${housesClosed.length}件)` +
    ` / 分譲地 ${lands.length}件` + (others.length ? ` / 種類不明 ${others.length}件` : ""));
  if (!houses.length) warnings.push("物件APIにモデルハウスが1件もありません(物件の種類の付け方が変わった可能性)");

  // 2. 分譲地ページ(校区・周辺環境・区画の状況)。題名が完売のものも、区画表の照合のために読む
  const landBySlug = {};
  for (const it of lands) {
    await sleep(WAIT_MS);
    const html = await fetchHtml(it.link);
    if (!html) { warnings.push(`${it.link}\n    → 分譲地ページを取得できませんでした`); continue; }
    const land = parseLand(html, it.link);
    landBySlug[land.slug] = land;
    landBySlug[slugOf(it.link)] = land;
  }
  const building = Object.values(landBySlug).filter((l, i, a) => a.indexOf(l) === i)
    .flatMap((l) => l.parcels.filter((p) => /施工中|建築中/.test(p.status)).map((p) => `${l.name} ${p.parcel}`));
  if (building.length) console.log(`[件数診断] 施工中(まだ物件ページがないため取り込まない): ${building.join("、")}`);

  // 3. 建売の物件ページを解析し、販売中のものだけ残す
  const prev = loadData(DATA_FILE);
  const prevKy = (prev.listings || []).filter((l) => l.source === SOURCE);
  const scraped = [];
  const cnt = { closed: 0, kengakuSold: 0, landSold: 0, outside: 0 };
  const soldNames = [];
  for (const it of houses) {
    if (closedRe(it)) { cnt.closed++; continue; }
    await sleep(WAIT_MS);
    const url = it.link;
    const html = await fetchHtml(url);
    if (!html) { warnings.push(`${url}\n    → ページ取得に失敗`); continue; }
    const h = parseHouse(html, it);
    if (h.skip) { warnings.push(`${url}\n    → ${h.msg}`); continue; }
    if (SOLD_RE.test(h.title)) { cnt.closed++; continue; }
    const land = h.parentUrl ? landBySlug[slugOf(h.parentUrl)] : null;
    const gochi = gochiOf(h.title);
    const name = land && land.name && gochi ? `${land.name} ${gochi}` : nameFromTitle(h.title);
    if (SOLD_RE.test(h.kengaku)) { cnt.kengakuSold++; soldNames.push(`${name}(見学状況「${h.kengaku}」)`); continue; }
    // 親の分譲地の区画表で、この号地(またはこの物件へのリンク)の掲載状況を確かめる
    if (land) {
      const row = land.parcels.find((p) => p.slug && p.slug === slugOf(url)) || land.parcels.find((p) => gochi && p.parcel === gochi);
      if (row && SOLD_RE.test(row.status)) { cnt.landSold++; soldNames.push(`${name}(分譲地の区画表「${row.status}」)`); continue; }
      if (!row) warnings.push(`${url}\n    → 分譲地「${land.name}」の区画表に${gochi || "この区画"}が見つかりません(取り込みはします)`);
    } else {
      warnings.push(`${url}\n    → 親の分譲地が分からないため、校区・周辺施設は空欄です`);
    }
    if (h.kengaku && !/可能|○|〇|可/.test(h.kengaku)) warnings.push(`${url}\n    → 見学状況が「${h.kengaku}」です(成約の記載がないため取り込みます)`);
    if (h.testNote) warnings.push(`${url}\n    → HPに「テストサイトの確認用ページです」の注意書きがあります(取り込みます)`);
    h.warns.forEach((w) => warnings.push(`${url}\n    → ${w}`));

    const address = h.address === null ? null : (h.address || (land ? normAddress(land.address) : ""));
    if (address === null) { cnt.outside++; warnings.push(`${url}\n    → 熊本県外の物件のためスキップ(${h.addrRaw})`); continue; }
    if (!address) warnings.push(`${url}\n    → 所在地が取れませんでした`);
    if (!h.layout) warnings.push(`${url}\n    → 間取りが取れませんでした`);
    if (!h.photoUrls.length) warnings.push(`${url}\n    → 写真が1枚も取れませんでした`);
    const locText = h.locText || (land ? land.locText : "");

    scraped.push({
      id: `${SOURCE}-${it.id}`,
      source: SOURCE,
      name,
      price: "",   // HPに1区画ごとの価格がないため取らない(アプリで「価格は要確認」と表示)
      address: address || "",
      detailUrl: url,
      layout: h.layout, stories: h.stories, builtAt: "",
      buildingArea: tsuboText(h.bldT), landArea: tsuboText(h.landT),
      parking: "", units: "",
      elementary: land ? land.elementary : "", elementaryMin: land ? land.elementaryMin : "",
      junior: land ? land.junior : "", juniorMin: land ? land.juniorMin : "",
      facilities: land ? land.facilities.map((f) => ({ ...f })) : [],
      photos: h.photoUrls.slice(0, MAX_PHOTOS).map((u, i) => ({ id: "p" + (i + 1), url: u, main: i === 0 })),
      locText, locPrec: locText ? "area" : "",
      hpText: h.hpText,
      tags: [],
    });
  }

  // 4. 前回までの物件IDを引き継ぐ(HPリニューアルで投稿番号が変わったため、「分譲地名+号地」で照合)
  let inherited = 0, keptStories = 0;
  const usedPrev = new Set();
  for (const s of scraped) {
    const same = prevKy.find((p) => p.id === s.id);
    let p = same;
    if (!p) {
      const cands = prevKy.filter((x) => !usedPrev.has(x.id) && nameKey(x.name) === nameKey(s.name)
        && !scraped.some((o) => o !== s && o.id === x.id));
      const active = cands.filter((x) => x.status !== "ended");
      const pick = active.length === 1 ? active[0] : (!active.length && cands.length === 1 ? cands[0] : null);
      if (pick) { s.id = pick.id; p = pick; inherited++; }
    }
    if (p) {
      usedPrev.add(p.id);
      if (!s.stories && p.stories) { s.stories = p.stories; keptStories++; }   // 建て方は変わらないので前回の値を引き継ぐ
    }
  }
  scraped.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));

  console.log(`解析完了: ${scraped.length}件(販売中の建売)` +
    ` / 除外: 題名が完売・募集終了 ${cnt.closed}件・見学状況が成約 ${cnt.kengakuSold}件・分譲地の区画表で成約 ${cnt.landSold}件` +
    (cnt.outside ? `・熊本県外 ${cnt.outside}件` : ""));
  if (soldNames.length) console.log(`[件数診断] 成約のため取り込まなかった物件: ${soldNames.join("、")}`);
  if (inherited) console.log(`[件数診断] 前回までの物件ID(★候補・編集を保つため)を引き継いだ物件: ${inherited}件`);
  if (scraped.length) {
    console.log(`[位置情報] HPの地図から取得: ${scraped.filter((s) => s.locText).length}件/${scraped.length}件(分譲地の地点)`);
    const total = scraped.reduce((n, s) => n + s.photos.length, 0);
    console.log(`[写真診断] 平均 ${(total / scraped.length).toFixed(1)}枚 / 写真なし ${scraped.filter((s) => !s.photos.length).length}件`);
    console.log(`[学校診断] 小学校区が取れなかった物件: ${scraped.filter((s) => !s.elementary).length}件` +
      ` / 小学校までの距離が取れなかった物件: ${scraped.filter((s) => s.elementary && !s.elementaryMin).length}件`);
    if (keptStories) console.log(`[階数診断] HPに建て方の記載がないため、前回の建て方(平屋など)を引き継いだ物件: ${keptStories}件`);
    console.log(`[価格] 九建ホームのHPには区画ごとの価格の記載がないため、価格は取得していません(アプリでは「価格は要確認」と表示)`);
  }

  // 5. 差分反映(九建ホーム分のみ更新。他社・手動データには触れない)
  const merged = mergeListings(prev.listings || [], { [SOURCE]: scraped }, [SOURCE], todayStr());
  saveData(DATA_FILE, merged);

  const endedNow = merged.filter((l) => l.source === SOURCE && l.status === "ended").length;
  const activeNow = merged.filter((l) => l.source === SOURCE && l.status !== "ended").length;
  const rep = getMergeReport(SOURCE);
  // 価格はもともと載っていないので、「所在地が取れていない物件」だけを数える
  recordScrapeStatus(SOURCE, { count: scraped.length, badFields: scraped.filter((s) => !s.address).length,
    kept: rep.kept, prevActive: rep.prevActive, notFound: getFetchStats().notFound });
  console.log(`=== 完了: 九建ホーム 掲載中 ${activeNow}件 / 掲載終了 ${endedNow}件` +
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

module.exports = { parseLand, parseHouse, landNameOf, gochiOf, nameKey, schoolsOf, normAddress, meters, walkMin, facCat, slugOf, main };
