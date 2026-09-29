/* scraper/takasugi.js
   タカスギ(TAKASUGI株式会社・分譲地・新築建売物件情報サイト home.takasugi.co.jp)の
   新築建売物件を収集して data/listings.json のタカスギ分を更新する。
   実行: node scraper/takasugi.js
   ─────────────────────────────────
   構造(2026年9月に実ページのHTMLを解析して確認済み):
   ・物件一覧 /house/ は12件ずつ。2ページ目以降は /house/page/2/ … の形。
     ページ送りは「次へ」(a.next.page-numbers)のリンクをたどる(上限15ページ)。
     物件がないページ(/house/page/6/ など)も 404 ではなく「0件」のページが返る
   ・件数は一覧上部の「該当件数 52 件」(.c-layout-property__head__num .-num)を[件数診断]で照合
   ・一覧の1物件は article.c-post-house。class の -status_open=見学できる物件、
     -status_close=完成前(着工前・建築中)の物件。完成前の物件も取り込む
     (成約した物件は一覧から消えるため、成約済みの判定は不要)
   ・詳細ページ /house/投稿番号/ の「取引形態」欄で取り込むかを決める:
       売主 … TAKASUGI自身が売主の物件 → 取り込む
       代理 … グループ会社(いいねホーム株式会社)の物件をTAKASUGIが販売代理 → 取り込む
       仲介・媒介 … 他社の物件 → 取り込まない(2026年9月時点では0件だが、今後出てきた時のため)
       それ以外・空欄 … 念のため取り込まず、警告に出す
   ・物件名は h1「【9/28価格改定】《熊本市西区中島》新築建売住宅｜6号地」。
     【】の宣伝文句は価格改定のたびに変わるので外し、「熊本市西区中島 6号地」の形にする
   ・価格は .c-single-property__price__num(販売価格)だけ。ローンの「月額」欄は使わない
   ・所在地は県名なしが多い(「熊本市西区中島町788番8」「〒860-0088 熊本県熊本市北区津浦町445-3」
     「熊本県 熊本市北区 鹿子木町138-2」)。郵便番号と空白を除き、熊本県内の市・郡・町村名で
     始まるか確認して「熊本県」を補う(該当しなければ県外としてスキップ)
   ・面積「敷地／209.13㎡（63.26坪） 建物／108.26㎡（32.74坪）」、校区「中島小学校・城西中学校」、
     間取り「3LDK」、駐車場「2台分」「3台可」は物件概要(.c-single-property__list)から
   ・階数の欄はない。タイトルの「平屋の新築建売住宅」で平屋、間取り図が2枚(1F・2F)なら2階建て
   ・完成時期はほとんど載っていない(「完成時期（築年月）令和9年1月予定」が1件だけ)。載っていれば使う
   ・小中学校の徒歩分は「近隣施設」の教育施設「熊本市立 中島小学校 徒歩10分（約800ｍ）」から
   ・周辺施設は「近隣施設」(交通機関・商業施設・医療機関・公共施設・レジャー施設)のうち
     「徒歩◯分」のものだけ(「車5分」の施設は徒歩圏ではないので載せない)。
     公共施設は駅・バス停だけを使う(役所・郵便局・銀行などは載せない)
   ・写真は物件ギャラリー(.c-single-gallery__main)の中の画像だけを、並び順に最大5枚
     (間取り図・注目ポイント・キャンペーンの画像は別の囲みなので混ざらない)
   ・位置は所在地の「Google マップで見る」リンク(maps/place/緯度, 経度)。
     住所しか入っていない物件は、同じ所在地の他の区画の位置 → 前回の位置 → 住所からの推定の順で補う
   ・1ページ=1区画(1棟)なので棟数の問題はない
   ・実行のたびに robots.txt を確認し、禁止されていれば収集せずに終了する
*/
const cheerio = require("cheerio");
const { fetchHtml, sleep, pickPrice, robotsAllows, mergeListings,
  loadData, saveData, todayStr, reuseLocText, geocode, WAIT_MS,
  getFetchStats, getMergeReport, recordScrapeStatus, countBadFields } = require("./common");

const BASE = "https://home.takasugi.co.jp";
const DATA_FILE = __dirname + "/../data/listings.json";
const SOURCE = "takasugi";
const MAX_PHOTOS = 5;
const MAX_PAGES = 15;     // 一覧のページ送り上限(暴走防止)
const MAX_FACILITIES = 8; // 周辺施設は多すぎると見づらいので上限を設ける
const GEO_LIMIT = 10;     // 住所からの位置推定は1回の実行でこの件数まで(無料サービスの利用ルール)
const LIST_PATH = "/house/";

// 熊本県内の市・郡(所在地に県名がないため、これで熊本県内かを判定する)
const KUMAMOTO_AREA_RE = /^(熊本市|八代市|人吉市|荒尾市|水俣市|玉名市|山鹿市|菊池市|宇土市|上天草市|宇城市|阿蘇市|天草市|合志市|下益城郡|玉名郡|菊池郡|阿蘇郡|上益城郡|八代郡|葦北郡|球磨郡|天草郡)/;
// 郡名を省いて町村名から書かれた時のための、熊本県内の町村名
const KUMAMOTO_TOWN_RE = /^(美里町|玉東町|南関町|長洲町|和水町|大津町|菊陽町|南小国町|小国町|産山村|高森町|西原村|南阿蘇村|御船町|嘉島町|益城町|甲佐町|山都町|氷川町|芦北町|津奈木町|錦町|多良木町|湯前町|水上村|相良村|五木村|山江村|球磨村|あさぎり町|苓北町)/;

const clean = (s) => String(s || "").replace(/\r/g, "").replace(/[ \t 　]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
// 全角の英数字を半角に(「１７４番７」「3LDK+2ｓ」など)
const hankaku = (s) => String(s || "").replace(/[０-９Ａ-Ｚａ-ｚ＋]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
const oneLine = (s) => clean(s).replace(/\n+/g, " ");
const absUrl = (u) => { try { return new URL(String(u).replace(/&amp;/g, "&").trim(), BASE).href; } catch (e) { return ""; } };
const idOf = (u) => (String(u || "").match(/\/house\/(\d+)\/?(?:[?#].*)?$/) || [])[1] || "";

/* 施設名から種類を判定(アプリのアイコン分け用) */
function facCat(name) {
  if (/駅/.test(name) && !/バス停|駅前$/.test(name)) return "station";
  if (/バス停|バス|停留所/.test(name)) return "bus";
  if (/セブン|ローソン|ファミリーマート|デイリーヤマザキ|ミニストップ|ポプラ|コンビニ/.test(name)) return "conbini";
  if (/ドラッグ|薬局|コスモス|モリ薬品|ダイレックス/.test(name)) return "drug";
  if (/ゆめタウン|イオン|モール|ショッピングセンター/.test(name)) return "mall";
  if (/スーパー|マート|マルエイ|マルショク|サンリブ|マルキョウ|マルミヤ|マックスバリュ|ミスターマックス|トライアル|ロッキー|生鮮|鮮ど市場|あんじぇらす|スーパー/.test(name)) return "super";
  if (/病院|クリニック|医院|診療所|歯科/.test(name)) return "hospital";
  if (/公園|広場/.test(name)) return "park";
  return "other";
}

/* 一覧ページ: 物件のID・完成前かどうか・次ページのURL・HP表示件数 */
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  $("article.c-post-house").each((_, el) => {
    const href = $(el).find("a.c-post-house__link").attr("href")
      || $(el).find("a[href*='/house/']").attr("href") || "";
    const id = idOf(absUrl(href));
    if (!id || items.some((x) => x.id === id)) return;
    const cls = $(el).attr("class") || "";
    items.push({ id, beforeComplete: /status_close/.test(cls) });
  });
  const nextHref = $("a.next.page-numbers").first().attr("href") || "";
  const cntTxt = $(".c-layout-property__head__num .-num").first().text().trim();
  const siteCount = /^\d+$/.test(cntTxt) ? +cntTxt : null;
  return { items, next: nextHref ? absUrl(nextHref) : "", siteCount };
}

/* タイトル「【9/28価格改定】《熊本市西区中島》新築建売住宅｜6号地」→「熊本市西区中島 6号地」 */
function makeName(title) {
  const t = oneLine(title).replace(/【[^】]*】/g, "").trim();
  const m = t.match(/《([^》]+)》[^｜|]*[｜|]\s*(.+)$/);
  if (m) return `${m[1].trim()} ${m[2].trim()}`;
  return t.replace(/[《》]/g, " ").replace(/\s+/g, " ").trim();
}

/* 所在地を整える。熊本県内と確認できなければ null(県外扱い) */
function normAddress(raw, place) {
  let a = hankaku(oneLine(raw)).replace(/〒?\s*\d{3}\s*[-‐－ー]\s*\d{4}/, "").replace(/\s+/g, "").trim();
  if (!a) return "";
  if (/^熊本県/.test(a)) return a;
  if (KUMAMOTO_AREA_RE.test(a) || KUMAMOTO_TOWN_RE.test(a)) return "熊本県" + a;
  // 他の都道府県名、または熊本県以外の市・郡で始まる所在地は県外
  if (/^.{2,3}?[都道府県]/.test(a) || /^[^\d、,]{1,5}?[市郡]/.test(a)) return null;
  // 所在地が町名から書かれている時は、一覧の地域表示(「熊本市 北区」「益城町」)で熊本県内か確かめる
  const p = oneLine(place).replace(/\s+/g, "");
  if (p && (KUMAMOTO_AREA_RE.test(p) || KUMAMOTO_TOWN_RE.test(p))) return "熊本県" + (a.startsWith(p) ? a : p + a);
  return null;
}

/* 完成時期「令和9年1月予定」「2027年1月」→「2027年1月」 */
function parseBuiltAt(s) {
  const t = oneLine(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  let m = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if (m) return `${m[1]}年${+m[2]}月`;
  m = t.match(/令和\s*(\d{1,2}|元)\s*年\s*(\d{1,2})\s*月/);
  if (m) return `${2018 + (m[1] === "元" ? 1 : +m[1])}年${+m[2]}月`;
  m = t.match(/(\d{4})\s*[\/.]\s*(\d{1,2})/);
  if (m) return `${m[1]}年${+m[2]}月`;
  return "";
}

/* 近隣施設の施設名。改行で2店舗が1つにまとめて書かれている時は分ける。
   ただし「熊本電鉄バス<br>「津の浦公民館前」バス停」のような1つの名前の折り返しはつなぐ */
function splitFacNames(dtHtml) {
  const lines = String(dtHtml || "").split(/<br\s*\/?>/i)
    .map((t) => oneLine(cheerio.load(`<p>${t}</p>`)("p").text())).filter(Boolean);
  const out = [];
  for (const ln of lines) {
    const prev = out[out.length - 1];
    if (prev && (/^[「『(（]/.test(ln) || /(バス|電鉄|鉄道|本線|線|市電)$/.test(prev))) out[out.length - 1] = prev + ln;
    else out.push(ln);
  }
  return out;
}

/* 詳細ページ1件を解析。取り込まない物件は { skip:"理由の種類", msg } を返す */
function parseDetail(html, url, listInfo) {
  const $ = cheerio.load(html);
  const pid = idOf(url);
  const skip = (kind, msg) => ({ skip: kind, msg });
  const warns = [];
  const warn = (msg) => warns.push(msg);

  // 物件情報の項目(所在地・敷地概要・建物の仕様・設備・取引形態)
  const detail = {};   // dt名 → 値(文字)
  const items = {};    // 小項目(構造・完成時期など) → 値
  let addrRaw = "", mapHref = "";
  $(".c-single-detailed__main").each((_, el) => {
    const key = oneLine($(el).children("dt").first().text());
    const dd = $(el).children("dd").first();
    if (!key || !dd.length) return;
    if (key === "所在地" && !addrRaw) {
      addrRaw = dd.find(".__txt").first().text() || dd.text();
      mapHref = dd.find("a[href*='google']").first().attr("href") || "";
    }
    dd.find("li").each((__, li) => {
      const k = oneLine($(li).find(".-ttl").first().text());
      const v = oneLine($(li).find(".-txt").first().text());
      if (k && v && !(k in items)) items[k] = v;
    });
    if (!(key in detail)) detail[key] = oneLine(dd.text());
  });

  // 取引形態:売主・代理は取り込む。仲介(媒介)は他社の物件なので取り込まない
  const torihiki = detail["取引形態"] || "";
  if (/仲介|媒介/.test(torihiki)) return skip("chukai", `取引形態が「${torihiki}」のためスキップ(仲介は取り込みません)`);
  if (!/売主|代理|事業主/.test(torihiki)) return skip("unknown", `取引形態が「${torihiki || "不明"}」のためスキップ(売主・代理のみ取り込み。HPの作りが変わった可能性)`);

  const title = oneLine($("h1").first().text());
  const name = makeName(title);
  if (!name) return skip("error", "物件名が取れませんでした → スキップ");

  // 所在地(県外は取り込まない)
  const place = oneLine($(".c-single-property__place__txt").first().text());
  const address = normAddress(addrRaw, place);
  if (address === null) return skip("outside", `熊本県外の物件のためスキップ(${oneLine(addrRaw)})`);
  if (!address) warn("所在地が取れませんでした");

  // 価格:販売価格の欄だけ(ローンの月額は使わない)
  const pnum = oneLine($(".c-single-property__price__num").first().text());
  const punit = oneLine($(".c-single-property__price__unit").first().text()).replace(/[(（].*$/, "");
  const price = pickPrice({ "価格": pnum ? pnum + (punit || "万円") : "" }, "", warn);

  // 物件概要(面積・校区・間取り・駐車場)
  const prop = {};
  $(".c-single-property__list__item").each((_, el) => {
    const k = oneLine($(el).find("dt").first().text());
    const dd = $(el).find("dd").first().clone();
    dd.find("br").replaceWith("\n");
    if (k && !(k in prop)) prop[k] = clean(dd.text());
  });
  const menseki = prop["面積"] || "";
  const areaOf = (label) => {
    const m = menseki.match(new RegExp(label + "\\s*[／/]\\s*([^\\n]+)"));
    // 「205.39㎡（ 62.13坪）」「206.21㎡(62.37坪 )」→「205.39㎡（62.13坪）」の形にそろえる
    return m ? oneLine(m[1]).replace(/\s*[（(]\s*/g, "（").replace(/\s*[）)]/g, "）") : "";
  };
  const landArea = areaOf("敷地") || areaOf("土地");
  const buildingArea = areaOf("建物");

  // 間取り「3LDK」「4LDK+S」「3LDK+2ｓ」
  const lm = hankaku(prop["間取り"] || "").replace(/\s/g, "").match(/\d[SLDK]{1,5}(?:\+\d*S)?/i);
  const layout = lm ? lm[0].toUpperCase() : "";

  const pk = String(prop["駐車場"] || "").match(/(\d+)\s*台/);
  const parking = pk ? pk[1] + "台" : "";

  // 階数:タイトルの「平屋」→ 平屋。間取り図が1F・2Fの2枚なら2階建て
  const plans = new Set($(".c-single-floorplan__main img").map((_, im) => $(im).attr("src") || "").get().filter(Boolean));
  const stories = /平屋|平家/.test(title) ? "平屋" : plans.size >= 2 ? "2階建て" : "";

  // 完成時期(載っている物件だけ)
  const builtKey = Object.keys(items).find((k) => /完成|竣工|築年/.test(k));
  const builtAt = builtKey ? parseBuiltAt(items[builtKey]) : "";

  // 学校区「中島小学校・城西中学校」「高平台小学校 京陵中学校」「木倉小学校／御船中学校」
  const kouku = oneLine(prop["校区"] || "");
  const elementary = (kouku.match(/([^\s・／/、,，]{1,15}小学校)/) || [])[1] || "";
  const junior = (kouku.match(/([^\s・／/、,，]{1,15}中学校)/) || [])[1] || "";
  let elementaryMin = "", juniorMin = "";

  // 近隣施設
  const facs = [];
  $(".c-single-facility__main").each((_, sec) => {
    const secName = oneLine($(sec).find(".c-single-facility__main__ttl").first().text());
    $(sec).find("dl").each((__, dl) => {
      const con = oneLine($(dl).find("dd").first().text());
      const wm = con.match(/徒歩\s*約?\s*(\d+)\s*分/);
      for (const nm of splitFacNames($(dl).find("dt").first().html())) {
        if (/教育/.test(secName) || /小学校|中学校/.test(nm)) {
          // 学校は徒歩分だけ使う(校区の学校名と一致するもの)
          if (!wm) continue;
          if (elementary && !elementaryMin && nm.includes(elementary.replace(/小学校$/, ""))) elementaryMin = wm[1];
          if (junior && !juniorMin && nm.includes(junior.replace(/中学校$/, ""))) juniorMin = wm[1];
          continue;
        }
        if (!wm) continue;   // 車で◯分の施設は徒歩圏ではないので載せない
        const cat = facCat(nm);
        if (/公共/.test(secName) && cat !== "station" && cat !== "bus") continue;
        facs.push({ name: nm, min: wm[1], cat });
      }
    });
  });
  // 駅・バス停を先に、同じ種類の中はHPの並び順のまま
  const rank = (c) => (c === "station" ? 0 : c === "bus" ? 1 : 2);
  const seen = new Set();
  const facilities = facs.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f.cat) - rank(b.f.cat) || a.i - b.i)
    .map((x) => x.f).filter((f) => !seen.has(f.name) && seen.add(f.name)).slice(0, MAX_FACILITIES);

  // 写真:物件ギャラリーの画像だけを並び順に最大5枚
  const photoUrls = [];
  $(".c-single-gallery__main img").each((_, im) => {
    const src = $(im).attr("src") || $(im).attr("data-src") || $(im).attr("data-splide-lazy") || "";
    const u = src ? absUrl(src) : "";
    if (u && /\.(jpe?g|png|webp)(\?|$)/i.test(u) && !photoUrls.includes(u)) photoUrls.push(u);
  });
  const photos = photoUrls.slice(0, MAX_PHOTOS).map((u, i) => ({ id: "p" + (i + 1), url: u, main: i === 0 }));
  if (!photos.length) warn("写真が1枚も取れませんでした");

  // 位置:「Google マップで見る」のリンク maps/place/緯度, 経度(なければ埋め込み地図の q=緯度,経度)
  let locText = "";
  const ll = (s) => String(s || "").replace(/%2C/gi, ",").replace(/\+/g, " ")
    .match(/maps(?:\/place\/|\?q=)\s*([0-9]{2}\.[0-9]{3,})\s*,\s*([0-9]{3}\.[0-9]{3,})/);
  const locM = ll(mapHref) || ll(html);
  if (locM) locText = `${(+locM[1]).toFixed(7)}, ${(+locM[2]).toFixed(7)}`;

  // 紹介文:物件のキャッチコピー
  const hpText = oneLine($(".c-layout-sp__pointtxt li").first().text());

  return {
    listing: {
      id: `${SOURCE}-${pid}`,
      source: SOURCE,
      name, price, address: address || "",
      detailUrl: `${BASE}/house/${pid}/`,
      layout, stories, builtAt,
      buildingArea, landArea,
      parking, units: "",
      elementary, elementaryMin, junior, juniorMin,
      facilities, photos, locText, locPrec: "",
      hpText,
      tags: [],
    },
    torihiki: /代理/.test(torihiki) ? "代理" : "売主",
    beforeComplete: !!(listInfo && listInfo.beforeComplete),
    warns,
  };
}

async function main() {
  console.log("=== タカスギ(TAKASUGI・新築建売・売主/代理の物件) 収集開始 ===");
  const warnings = [];

  // 0. robots.txt を確認(禁止されていれば収集しない)
  const robots = await fetchHtml(BASE + "/robots.txt");
  if (robots && (!robotsAllows(robots, LIST_PATH) || !robotsAllows(robots, "/house/1/"))) {
    console.error("[ERROR] robots.txt が対象ページの自動アクセスを禁止しているため、収集を行いません。");
    recordScrapeStatus(SOURCE, { count: 0, notFound: getFetchStats().notFound,
      fatal: "タカスギのHPが自動収集を禁止する設定に変わったため、収集を止めています" });
    return;
  }

  // 1. 一覧を巡回(「次へ」のリンクをたどる)
  const listed = [];
  let siteCount = null, pagesRead = 0, next = BASE + LIST_PATH;
  const visited = new Set();
  while (next && pagesRead < MAX_PAGES && !visited.has(next)) {
    visited.add(next);
    await sleep(WAIT_MS);
    const html = await fetchHtml(next);
    if (!html) { console.error(`[WARN] 一覧ページを取得できませんでした: ${next}`); break; }
    const r = parseListPage(html);
    pagesRead++;
    if (siteCount == null) siteCount = r.siteCount;
    r.items.forEach((it) => { if (!listed.some((x) => x.id === it.id)) listed.push(it); });
    if (!r.items.length) break;
    next = r.next;
  }
  if (next && pagesRead >= MAX_PAGES) console.log(`[件数診断] ※一覧が${MAX_PAGES}ページを超えたため、上限までしか読んでいません`);
  const before = listed.filter((x) => x.beforeComplete).length;
  console.log(`[件数診断] 一覧 ${pagesRead}ページ → ${listed.length}件(うち完成前 ${before}件)` +
    ` / HP表示の件数 ${siteCount == null ? "不明" : siteCount + "件"}`);
  if (siteCount != null && siteCount !== listed.length) {
    console.log(`[件数診断] ※HP表示の件数と一覧から拾えた件数が一致しません(ページ送りの作りが変わった可能性)`);
  }

  // 2. 各詳細ページを解析(売主・代理の物件だけ残す)
  const scraped = [];
  const cnt = { uri: 0, dairi: 0, chukai: 0, unknown: 0, outside: 0, before: 0 };
  for (const it of listed) {
    const url = `${BASE}/house/${it.id}/`;
    await sleep(WAIT_MS);
    const html = await fetchHtml(url);
    if (!html) { warnings.push(`${url}\n    → ページ取得に失敗`); continue; }
    const r = parseDetail(html, url, it);
    if (r.skip) {
      if (r.skip === "chukai") cnt.chukai++;          // 仲介物件は正常な除外なので警告に出さない
      else { if (r.skip in cnt) cnt[r.skip]++; warnings.push(`${url}\n    → ${r.msg}`); }
      continue;
    }
    r.warns.forEach((w) => warnings.push(`${url}\n    → ${w}`));
    if (r.torihiki === "代理") cnt.dairi++; else cnt.uri++;
    if (r.beforeComplete) cnt.before++;
    scraped.push(r.listing);
  }
  scraped.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  console.log(`解析完了: ${scraped.length}件(売主 ${cnt.uri}件 / 代理 ${cnt.dairi}件 / うち完成前 ${cnt.before}件)` +
    (cnt.chukai ? ` / 仲介 ${cnt.chukai}件は除外` : "") +
    (cnt.unknown ? ` / 取引形態が不明 ${cnt.unknown}件は除外` : "") +
    (cnt.outside ? ` / 熊本県外 ${cnt.outside}件は除外` : ""));

  // 位置情報: ①HPの地図リンク ②同じ所在地の他の区画 ③前回値 ④住所からの推定
  const fromMap = scraped.filter((s) => s.locText).length;
  let fromSibling = 0;
  for (const s of scraped) {
    if (s.locText || !s.address) continue;
    const sib = scraped.find((o) => o !== s && o.address === s.address && o.locText && !o.locPrec);
    if (sib) { s.locText = sib.locText; s.locPrec = "banchi"; fromSibling++; }
  }
  const prev = loadData(DATA_FILE);
  const reused = reuseLocText(prev.listings, scraped);
  let geocoded = 0, geoFail = 0;
  for (const s of scraped) {
    if (s.locText || !s.address) continue;
    if (geocoded + geoFail >= GEO_LIMIT) break;
    const g = await geocode(s.address);
    if (g.loc) { s.locText = g.loc; s.locPrec = g.prec; geocoded++; } else geoFail++;
    await sleep(1200);
  }
  const noLoc = scraped.filter((s) => !s.locText).length;
  console.log(`[位置情報] HPの地図から直接取得: ${fromMap}件/${scraped.length}件 / 同じ所在地の区画から ${fromSibling}件` +
    ` / 前回から引き継ぎ ${reused}件 / 住所から推定 ${geocoded}件 / 未設定 ${noLoc}件`);
  if (scraped.length) {
    const total = scraped.reduce((n, s) => n + s.photos.length, 0);
    console.log(`[写真診断] 平均 ${(total / scraped.length).toFixed(1)}枚 / 写真なし ${scraped.filter((s) => !s.photos.length).length}件`);
    const noSchool = scraped.filter((s) => !s.elementary).length;
    const noSchoolMin = scraped.filter((s) => s.elementary && !s.elementaryMin).length;
    console.log(`[学校診断] 小学校区が取れなかった物件: ${noSchool}件 / 小学校の徒歩分が取れなかった物件: ${noSchoolMin}件`);
    const noBuilt = scraped.filter((s) => !s.builtAt).length;
    console.log(`[完成時期診断] 完成時期が載っていない物件: ${noBuilt}件(タカスギのHPはほとんどの物件で完成時期を載せていません)`);
    const noStories = scraped.filter((s) => !s.stories).length;
    if (noStories) console.log(`[階数診断] 平屋・2階建てを判定できなかった物件: ${noStories}件`);
  }

  // 3. 差分反映(タカスギ分のみ更新。他社・手動データには触れない)
  // 一覧が1ページも読めなかった時は、全件を掲載終了にしないよう反映しない
  if (!pagesRead) {
    console.error("[ERROR] 物件一覧を1ページも取得できなかったため、今回は反映しません");
    recordScrapeStatus(SOURCE, { count: 0, notFound: getFetchStats().notFound,
      fatal: "タカスギの物件一覧ページを取得できませんでした" });
    return;
  }
  const merged = mergeListings(prev.listings || [], { [SOURCE]: scraped }, [SOURCE], todayStr());
  saveData(DATA_FILE, merged);

  const endedNow = merged.filter((l) => l.source === SOURCE && l.status === "ended").length;
  const activeNow = merged.filter((l) => l.source === SOURCE && l.status !== "ended").length;
  const rep = getMergeReport(SOURCE);
  recordScrapeStatus(SOURCE, { count: scraped.length, badFields: countBadFields(scraped),
    kept: rep.kept, prevActive: rep.prevActive, notFound: getFetchStats().notFound });
  console.log(`=== 完了: タカスギ 掲載中 ${activeNow}件 / 掲載終了 ${endedNow}件` +
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

module.exports = { parseListPage, parseDetail, makeName, normAddress, parseBuiltAt, splitFacNames, facCat };
