/* scraper/kyuken.js
   九建ホーム(kyukenhome.co.jp)の販売中の建売住宅(モデルハウス)を収集して
   data/listings.json の九建ホーム分を更新する。
   実行: node scraper/kyuken.js
   ─────────────────────────────────
   構造(2026年9月に実ページのHTMLを解析して確認済み):
   ・「モデルハウス/建売住宅」一覧 /modelhouse/ には売れた物件も並んでいる。
     売れた物件の「SOLD」は写真そのものに描かれていて、HTMLには目印がない。
     詳細へのリンクの有無も当てにならない(売れた後もリンクが残っている物件、
     売れていないのにリンクがない古い物件がある)
   ・そこで、各分譲地のページ /land/番号/ の「区画情報」の表を正とする:
       tr.link  … 「モデルハウス情報」(詳細ページへのリンク)= 販売中の建売 → 取り込む
       tr.sold  … 「ご成約済」 → 取り込まない
       tr.build … 「モデルハウス施工中」(まだ詳細ページがない) → 取り込まない
       tr.sale  … 「分譲中」(土地だけの販売) → 取り込まない
       それ以外の表記 … 念のため取り込まず、警告に出す
   ・分譲地一覧 /land/ は10件ずつ、「次へ」(a.next.page-numbers)をたどる。
     後ろのページは分譲地が0件の空ページになる(2026年9月は5ページ中3ページ目以降が空)ので、
     0件のページが出たらそこで止める(上限10ページ)
   ・モデルハウス一覧は件数の照合([件数診断])のためだけに読む(取り込みの判定には使わない)
   ・価格はHPの文字としてどこにも載っていない(チラシ画像の中にだけ書かれていることがある)。
     画像の読み取りは誤読の危険があるため行わず、価格は空欄のままにする。
     アプリでは「価格は要確認」と表示し、平均価格の計算にも含めない
   ・物件名は分譲地名と号地から作る(「【分譲地】宇土鶴城中前　団地（宇土小・鶴城中 校区）」の
     「３号地」→「宇土鶴城中前 3号地」)。詳細ページの見出しは【40周年キャンペーン】などの
     宣伝文句が付いたり外れたりするので使わない
   ・所在地は詳細ページの分譲地欄「益城町大字宮園字辻」「熊本市南区八分字町」「熊本県宇土市新松原」。
     番地まではほぼ載っていない。熊本県内の市・郡・町村名で始まるか確認して「熊本県」を補う
   ・面積は坪だけ(「敷地 67.46坪／建物 35.06坪」)なので㎡に換算して「223.01㎡（67.46坪）」の形にする。
     建物の坪数に敷地の㎡を入れ間違えている物件がある(建物 223.03坪)ため、
     建物が100坪を超える・敷地より大きい時は採用しない
   ・間取り「４LDK」は全角を半角に。階数の欄はないので、紹介文に「平屋」とあれば平屋にする
   ・完成時期・駐車場は載っていない
   ・校区は分譲地の「宇土小／鶴城中」、学校までの距離は分譲地の周辺環境「宇土小学校 約1000m」。
     周辺施設(バス停・駅・買い物・病院)も周辺環境の距離から。距離は不動産広告の決まり
     (徒歩1分=80m、端数は切り上げ)で徒歩分に直し、徒歩20分以内のものだけ載せる
   ・写真は詳細ページの上部スライダー(.slider-image)の画像を並び順に最大5枚
   ・位置は詳細ページの地図(q=緯度, 経度)。分譲地の中心の地点で、同じ分譲地の区画はすべて同じ位置になる
     ため、アプリでは「分譲地のおおよその位置」と表示する(locPrec: "area")
   ・1ページ=1区画(1棟)なので棟数の問題はない
   ・実行のたびに robots.txt を確認し、禁止されていれば収集せずに終了する
*/
const cheerio = require("cheerio");
const { fetchHtml, sleep, robotsAllows, mergeListings,
  loadData, saveData, todayStr, WAIT_MS,
  getFetchStats, getMergeReport, recordScrapeStatus } = require("./common");

const BASE = "https://kyukenhome.co.jp";
const DATA_FILE = __dirname + "/../data/listings.json";
const SOURCE = "kyuken";
const MAX_PHOTOS = 5;
const MAX_LAND_PAGES = 10;   // 分譲地一覧のページ送り上限(暴走防止)
const MAX_LIST_PAGES = 20;   // モデルハウス一覧(件数照合用)のページ送り上限
const MAX_FACILITIES = 8;
const MAX_WALK_MIN = 20;     // 周辺施設は徒歩20分(1,600m)以内だけ
const TSUBO = 3.305785;      // 1坪 = 3.305785㎡

// 熊本県内の市・郡(所在地に県名がないため、これで熊本県内かを判定する)
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
const absUrl = (u) => { try { return new URL(String(u).replace(/&amp;/g, "&").trim(), BASE).href; } catch (e) { return ""; } };
const landIdOf = (u) => (String(u || "").match(/\/land\/(\d+)\/?(?:[?#].*)?$/) || [])[1] || "";
const mhIdOf = (u) => (String(u || "").match(/\/modelhouse\/(\d+)\/?(?:[?#].*)?$/) || [])[1] || "";

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

/* 分譲地の見出し「【分譲地】宇土鶴城中前　団地（宇土小・鶴城中 校区）」→「宇土鶴城中前」 */
function landNameOf(h2) {
  return oneLine(h2).replace(/【[^】]*】/g, "")
    .replace(/[（(][^（）()]*校区[^（）()]*[）)]\s*$/, "")
    .replace(/\s*団地\s*/g, " ").replace(/\s+/g, " ").trim();
}

/* 校区「宇土小／鶴城中」「宇土東／鶴城中」「飽田東・南小／飽田中」→ 学校名。
   「／」の前が小学校、後ろが中学校(「小」「中」が省かれていることがある)。
   小学校が「・」で2校書かれている時(一部の区画だけ選べる緩衝地区など)は、
   分譲地の見出し「（飽田南小・飽田中 校区）」の小学校を使う */
function schoolsOf(dd, h2) {
  const full = (s, kind) => {
    const t = String(s || "").replace(/\s+/g, "").replace(kind === "小" ? /小(学校)?$/ : /中(学校)?$/, "");
    return t ? t + (kind === "小" ? "小学校" : "中学校") : "";
  };
  const head = (oneLine(h2).match(/[（(]([^（）()]*)校区[^（）()]*[）)]\s*$/) || [])[1] || "";
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
  if (/^熊本県/.test(a)) return a;
  if (KUMAMOTO_AREA_RE.test(a)) return "熊本県" + a;
  const town = Object.keys(KUMAMOTO_TOWNS).find((t) => a.startsWith(t));
  if (town) return "熊本県" + KUMAMOTO_TOWNS[town] + a;
  return null;
}

/* 坪 → 「223.01㎡（67.46坪）」 */
function tsuboText(tsubo) {
  if (!(tsubo > 0)) return "";
  return `${(tsubo * TSUBO).toFixed(2)}㎡（${tsubo.toFixed(2)}坪）`;
}

/* 分譲地一覧ページ: 分譲地の番号・次ページ */
function parseLandList(html) {
  const $ = cheerio.load(html);
  const ids = [];
  $("main a[href]").each((_, a) => {
    const id = landIdOf(absUrl($(a).attr("href")));
    if (id && !ids.includes(id)) ids.push(id);
  });
  const nextHref = $("a.next.page-numbers").first().attr("href") || "";
  return { ids, next: nextHref ? absUrl(nextHref) : "" };
}

/* モデルハウス一覧ページ(件数照合用): 物件カードの数・詳細リンクのある物件・次ページ */
function parseModelList(html) {
  const $ = cheerio.load(html);
  const cards = $(".p-modelhouse-index-list > ul > li");
  const linked = [];
  cards.each((_, li) => {
    const id = mhIdOf(absUrl($(li).find("a").first().attr("href") || ""));
    if (id && !linked.includes(id)) linked.push(id);
  });
  const nextHref = $("a.next.page-numbers").first().attr("href") || "";
  return { cards: cards.length, linked, next: nextHref ? absUrl(nextHref) : "" };
}

/* 分譲地ページ: 区画の状況・校区・周辺環境・所在地・位置 */
function parseLand(html, landId) {
  const $ = cheerio.load(html);
  const h2 = $(".p-land-single-title h2").first().text();
  const name = landNameOf(h2);
  const { elementary, junior } = schoolsOf($(".p-land-single-point dl.school dd").first().text(), h2);

  const parcels = [];
  $(".p-land-single-parcel table tr").each((_, tr) => {
    const $tr = $(tr);
    if ($tr.children("th").length) return;   // 見出し行
    const parcel = hankaku(oneLine($tr.find(".parcel").first().text())).replace(/\s+/g, "");
    if (!parcel) return;
    const cls = ($tr.attr("class") || "").trim();
    const statusTd = $tr.find(".status").first();
    const status = oneLine(statusTd.text());
    const mhId = mhIdOf(absUrl(statusTd.find("a[href]").first().attr("href") || ""));
    let kind;
    if (/\blink\b/.test(cls) && mhId) kind = "onsale";
    else if (/\bsold\b/.test(cls) || /成約/.test(status)) kind = "sold";
    else if (/\bbuild\b/.test(cls) || /施工中|建築中/.test(status)) kind = "build";
    else if (/\bsale\b/.test(cls) || /^分譲中$/.test(status)) kind = "land";
    else if (mhId) kind = "onsale";   // 目印のclassが変わっても、詳細へのリンクがあれば販売中とみなす
    else kind = "unknown";
    parcels.push({ parcel, cls, status, mhId, kind, area: oneLine($tr.find(".area").first().text()) });
  });

  let address = "";
  $(".p-land-single-about dl").each((_, dl) => {
    if (!address && /所在地/.test($(dl).find("dt").first().text())) address = oneLine($(dl).find("dd").first().text());
  });

  // 周辺環境: 教育施設は学校までの距離に、公共機関・買い物・医療は周辺施設に
  let elementaryMin = "", juniorMin = "";
  const facs = [];
  $(".p-land-single-around .text dl").each((_, dl) => {
    const sec = oneLine($(dl).children("dt").first().text());
    $(dl).find("li").each((__, li) => {
      const spans = $(li).find("span");
      const nm = oneLine(spans.eq(0).text());
      const m = meters(spans.eq(1).text() || $(li).text());
      if (!nm || m == null) return;
      if (/教育/.test(sec)) {
        // 学校名そのもので照合する(「宇土」だけで照合すると「宇土幼稚園」を拾ってしまう)
        const nmS = nm.replace(/\s+/g, "");
        if (elementary && !elementaryMin && nmS.includes(elementary.replace(/小学校$/, "") + "小")) elementaryMin = walkMin(m);
        if (junior && !juniorMin && nmS.includes(junior.replace(/中学校$/, "") + "中")) juniorMin = walkMin(m);
        return;
      }
      if (!/公共|交通|ショッピング|買|商業|医療/.test(sec)) return;   // 金融・郵便局などは載せない
      const cat = facCat(nm);
      if (/公共|交通/.test(sec) && cat !== "bus" && cat !== "station") return;   // 役所などは載せない
      const min = walkMin(m);
      if (+min > MAX_WALK_MIN) return;
      facs.push({ name: nm, min, cat });
    });
  });
  const rank = (c) => (c === "station" ? 0 : c === "bus" ? 1 : 2);
  const seen = new Set();
  const facilities = facs.map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f.cat) - rank(b.f.cat) || (+a.f.min) - (+b.f.min) || a.i - b.i)
    .map((x) => x.f).filter((f) => !seen.has(f.name) && seen.add(f.name)).slice(0, MAX_FACILITIES);

  const locM = html.replace(/%2C/gi, ",").match(/maps(?:\/search\/|\?[^"']*?q=)\s*([0-9]{2}\.[0-9]{3,})\s*,\s*([0-9]{3}\.[0-9]{3,})/);
  const locText = locM ? `${(+locM[1]).toFixed(6)}, ${(+locM[2]).toFixed(6)}` : "";

  return { landId, name, elementary, junior, elementaryMin, juniorMin, parcels, address, facilities, locText };
}

/* 詳細ページ1件を解析 */
function parseDetail(html, mhId, land, parcel) {
  const $ = cheerio.load(html);
  const warns = [];
  const warn = (msg) => warns.push(msg);

  const title = oneLine($(".p-modelhouse-single-title h2").first().text());
  if (!title) return { skip: "error", msg: "物件ページの見出しが取れませんでした(HPの作りが変わった可能性) → スキップ" };
  const name = `${land.name} ${parcel.parcel}`.trim();

  // 所在地(詳細の分譲地欄 → 分譲地ページの物件概要)
  const addrRaw = oneLine($(".p-modelhouse-single-land .address").first().text()) || land.address;
  const address = normAddress(addrRaw);
  if (address === null) return { skip: "outside", msg: `熊本県外の物件のためスキップ(${addrRaw})` };
  if (!address) warn("所在地が取れませんでした");

  // 面積・間取り・見学(「面積 敷地 67.46坪／建物 35.06坪」「間取りプラン ４LDK」「ご見学 ○」)
  const block = {};
  $(".p-modelhouse-single-point .block dl").each((_, dl) => {
    const k = oneLine($(dl).children("dt").first().text());
    if (k && !(k in block)) block[k] = oneLine($(dl).children("dd").first().text());
  });
  const menseki = hankaku(block["面積"] || "");
  const tsuboOf = (label) => { const m = menseki.match(new RegExp(label + "\\s*([\\d.]+)\\s*坪")); return m ? parseFloat(m[1]) : null; };
  const landT = tsuboOf("敷地") ?? tsuboOf("土地");
  let bldT = tsuboOf("建物");
  if (bldT != null && (bldT > 100 || (landT && bldT > landT * 1.2 && bldT > 60))) {
    warn(`建物面積「${bldT}坪」は敷地より大きく、HPの入力誤りの可能性が高いため採用しません`);
    bldT = null;
  }
  const landArea = tsuboText(landT);
  const buildingArea = tsuboText(bldT);
  const lm = hankaku(block["間取りプラン"] || block["間取り"] || "").replace(/\s/g, "").match(/\d[SLDK]{1,5}(?:\+\d*S)?/i);
  const layout = lm ? lm[0].toUpperCase() : "";
  if (!layout) warn("間取りが取れませんでした");
  const kengaku = oneLine(block["ご見学"] || "");

  // 紹介文: ポイントのうち、省エネ性能の数値の行以外の最初のもの
  const points = $(".p-modelhouse-single-point ul li").map((_, li) => oneLine($(li).text())).get().filter(Boolean);
  const hpText = points.find((p) => !/省エネ|ZEH|エネルギー|等級|断熱|UA値|光熱費|BEI/.test(p)) || "";
  const stories = /平屋|平家/.test(points.join(" ") + " " + title) ? "平屋" : "";

  // 写真: 上部スライダーの画像だけ、並び順に最大5枚
  const photoUrls = [];
  $(".p-modelhouse-single-images .slider-image img").each((_, im) => {
    const src = $(im).attr("src") || $(im).attr("data-src") || "";
    const u = src ? absUrl(src) : "";
    if (u && /\.(jpe?g|png|webp)(\?|$)/i.test(u) && !photoUrls.includes(u)) photoUrls.push(u);
  });
  const photos = photoUrls.slice(0, MAX_PHOTOS).map((u, i) => ({ id: "p" + (i + 1), url: u, main: i === 0 }));
  if (!photos.length) warn("写真が1枚も取れませんでした");

  // 位置: 詳細ページの地図(分譲地の地点)→ だめなら分譲地ページの地図
  const locM = html.replace(/%2C/gi, ",").match(/maps(?:\/search\/|\?[^"']*?q=)\s*([0-9]{2}\.[0-9]{3,})\s*,\s*([0-9]{3}\.[0-9]{3,})/);
  const locText = locM ? `${(+locM[1]).toFixed(6)}, ${(+locM[2]).toFixed(6)}` : land.locText;

  return {
    listing: {
      id: `${SOURCE}-${mhId}`,
      source: SOURCE,
      name,
      price: "",   // HPに文字としての価格がないため取らない(アプリで「価格は要確認」と表示)
      address: address || "",
      detailUrl: `${BASE}/modelhouse/${mhId}/`,
      layout, stories, builtAt: "",
      buildingArea, landArea,
      parking: "", units: "",
      elementary: land.elementary, elementaryMin: land.elementaryMin,
      junior: land.junior, juniorMin: land.juniorMin,
      facilities: land.facilities.map((f) => ({ ...f })),
      photos, locText, locPrec: locText ? "area" : "",
      hpText,
      tags: [],
    },
    kengaku,
    warns,
  };
}

async function main() {
  console.log("=== 九建ホーム(販売中の建売住宅・モデルハウス) 収集開始 ===");
  const warnings = [];

  // 0. robots.txt を確認(禁止されていれば収集しない)
  const robots = await fetchHtml(BASE + "/robots.txt");
  if (robots && (!robotsAllows(robots, "/land/") || !robotsAllows(robots, "/modelhouse/1/"))) {
    console.error("[ERROR] robots.txt が対象ページの自動アクセスを禁止しているため、収集を行いません。");
    recordScrapeStatus(SOURCE, { count: 0, notFound: getFetchStats().notFound,
      fatal: "九建ホームのHPが自動収集を禁止する設定に変わったため、収集を止めています" });
    return;
  }

  // 1. 分譲地一覧を巡回(0件のページが出たら止める)
  const landIds = [];
  let landPages = 0, next = BASE + "/land/";
  const visited = new Set();
  while (next && landPages < MAX_LAND_PAGES && !visited.has(next)) {
    visited.add(next);
    await sleep(WAIT_MS);
    const html = await fetchHtml(next);
    if (!html) { console.error(`[WARN] 分譲地一覧を取得できませんでした: ${next}`); break; }
    const r = parseLandList(html);
    landPages++;
    const fresh = r.ids.filter((id) => !landIds.includes(id));
    landIds.push(...fresh);
    if (!fresh.length) break;
    next = r.next;
  }
  console.log(`[件数診断] 分譲地一覧 ${landPages}ページ → 分譲地 ${landIds.length}か所`);

  // 2. 各分譲地の区画表から販売中の建売を拾う
  const lands = [];
  const kinds = { onsale: 0, sold: 0, build: 0, land: 0, unknown: 0 };
  for (const id of landIds) {
    await sleep(WAIT_MS);
    const html = await fetchHtml(`${BASE}/land/${id}/`);
    if (!html) { warnings.push(`${BASE}/land/${id}/\n    → 分譲地ページを取得できませんでした`); continue; }
    const land = parseLand(html, id);
    if (!land.parcels.length) warnings.push(`${BASE}/land/${id}/\n    → 区画情報の表が見つかりませんでした(HPの作りが変わった可能性)`);
    land.parcels.forEach((p) => {
      kinds[p.kind]++;
      if (p.kind === "unknown") warnings.push(`${BASE}/land/${id}/ ${land.name} ${p.parcel}\n    → 状況「${p.status || "空欄"}」(class: ${p.cls || "なし"})が分からないため取り込みません`);
    });
    lands.push(land);
  }
  const building = lands.flatMap((l) => l.parcels.filter((p) => p.kind === "build").map((p) => `${l.name} ${p.parcel}`));
  console.log(`[件数診断] 区画 ${Object.values(kinds).reduce((a, b) => a + b, 0)}区画: 販売中の建売 ${kinds.onsale} / ご成約済 ${kinds.sold}` +
    ` / モデルハウス施工中 ${kinds.build} / 土地の分譲中 ${kinds.land}` + (kinds.unknown ? ` / 状況不明 ${kinds.unknown}` : ""));
  if (building.length) console.log(`[件数診断] 施工中(まだ物件ページがないため取り込まない): ${building.join("、")}`);

  // 3. モデルハウス一覧(件数の照合のためだけに読む)
  let listPages = 0, cards = 0;
  const listLinked = [];
  next = BASE + "/modelhouse/";
  visited.clear();
  while (next && listPages < MAX_LIST_PAGES && !visited.has(next)) {
    visited.add(next);
    await sleep(WAIT_MS);
    const html = await fetchHtml(next);
    if (!html) { console.error(`[WARN] モデルハウス一覧を取得できませんでした: ${next}`); break; }
    const r = parseModelList(html);
    listPages++;
    cards += r.cards;
    r.linked.forEach((id) => { if (!listLinked.includes(id)) listLinked.push(id); });
    if (!r.cards) break;
    next = r.next;
  }
  const onsaleIds = new Set(lands.flatMap((l) => l.parcels.filter((p) => p.kind === "onsale").map((p) => p.mhId)));
  const linkedNotOnSale = listLinked.filter((id) => !onsaleIds.has(id));
  const onSaleNotLinked = [...onsaleIds].filter((id) => !listLinked.includes(id));
  console.log(`[件数診断] モデルハウス一覧 ${listPages}ページ → ${cards}件(うち詳細へのリンクあり ${listLinked.length}件)`);
  if (linkedNotOnSale.length) console.log(`[件数診断] 一覧ではリンクがあるが、分譲地の表で販売中ではない物件(取り込まない): ${linkedNotOnSale.map((id) => "/modelhouse/" + id + "/").join(" ")}`);
  if (onSaleNotLinked.length) console.log(`[件数診断] 分譲地の表では販売中だが、一覧にリンクがない物件(取り込む): ${onSaleNotLinked.map((id) => "/modelhouse/" + id + "/").join(" ")}`);

  // 4. 販売中の区画の詳細ページを解析
  const scraped = [];
  let outside = 0;
  const noKengaku = [];
  for (const land of lands) {
    for (const p of land.parcels.filter((x) => x.kind === "onsale")) {
      if (scraped.some((s) => s.id === `${SOURCE}-${p.mhId}`)) continue;
      const url = `${BASE}/modelhouse/${p.mhId}/`;
      await sleep(WAIT_MS);
      const html = await fetchHtml(url);
      if (!html) { warnings.push(`${url}\n    → ページ取得に失敗`); continue; }
      const r = parseDetail(html, p.mhId, land, p);
      if (r.skip) { if (r.skip === "outside") outside++; warnings.push(`${url}\n    → ${r.msg}`); continue; }
      r.warns.forEach((w) => warnings.push(`${url}\n    → ${w}`));
      if (r.kengaku && !/○|〇|可/.test(r.kengaku)) noKengaku.push(r.listing.name);
      scraped.push(r.listing);
    }
  }
  scraped.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  console.log(`解析完了: ${scraped.length}件(販売中の建売)` + (outside ? ` / 熊本県外 ${outside}件は除外` : ""));
  if (noKengaku.length) console.log(`[件数診断] ※「ご見学 ×」の販売中物件: ${noKengaku.join("、")}(取り込みはします)`);
  if (scraped.length) {
    console.log(`[位置情報] HPの地図から取得: ${scraped.filter((s) => s.locText).length}件/${scraped.length}件(分譲地の地点)`);
    const total = scraped.reduce((n, s) => n + s.photos.length, 0);
    console.log(`[写真診断] 平均 ${(total / scraped.length).toFixed(1)}枚 / 写真なし ${scraped.filter((s) => !s.photos.length).length}件`);
    console.log(`[学校診断] 小学校区が取れなかった物件: ${scraped.filter((s) => !s.elementary).length}件` +
      ` / 小学校までの距離が取れなかった物件: ${scraped.filter((s) => s.elementary && !s.elementaryMin).length}件`);
    console.log(`[価格] 九建ホームのHPには価格の記載がないため、価格は取得していません(アプリでは「価格は要確認」と表示)`);
  }

  // 5. 差分反映(九建ホーム分のみ更新。他社・手動データには触れない)
  // 分譲地一覧が読めなかった時は、全件を掲載終了にしないよう反映しない
  if (!landPages || !lands.length) {
    console.error("[ERROR] 分譲地のページを1つも取得できなかったため、今回は反映しません");
    recordScrapeStatus(SOURCE, { count: 0, notFound: getFetchStats().notFound,
      fatal: "九建ホームの分譲地ページを取得できませんでした" });
    return;
  }
  const prev = loadData(DATA_FILE);
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

module.exports = { parseLandList, parseModelList, parseLand, parseDetail, landNameOf, schoolsOf, normAddress, meters, walkMin, facCat, main };
