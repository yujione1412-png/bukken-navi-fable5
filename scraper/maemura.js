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
let lastPhotoDebug = null;   // 写真が取れないときの構造調査用

/* 写真の「もとの名前」(サイズ表記・日時表記・拡張子をむいた核の部分) */
function photoRoot(u) {
  let f = u.split("/").pop().split("?")[0].toLowerCase();
  let prev;
  do { prev = f;
    f = f.replace(/\.(jpe?g|png|gif)$/i, "")
         .replace(/-\d+x\d+$/, "")
         .replace(/_\d{12}$/, "");
  } while (f !== prev);
  return f;
}

/* 複数の物件で使い回されている画像(キャンペーンバナー・成約済み画像など)を
   物件写真から除外する。threshold件以上の物件に登場する画像は使い回しと判断。
   除外の結果0枚になる物件は、空にしないため元の1枚目だけ残す。 */
function removeSharedPhotos(scraped, threshold = 4) {
  const freq = new Map();
  for (const s of scraped) {
    for (const k of new Set(s.photos.map((p) => photoRoot(p.url)))) {
      freq.set(k, (freq.get(k) || 0) + 1);
    }
  }
  const sharedKeys = new Set([...freq].filter(([, n]) => n >= threshold).map(([k]) => k));
  let removed = 0;
  for (const s of scraped) {
    const kept = s.photos.filter((p) => !sharedKeys.has(photoRoot(p.url)));
    if (kept.length && kept.length !== s.photos.length) {
      removed += s.photos.length - kept.length;
      kept.forEach((p, i) => { p.id = "p" + (i + 1); p.main = i === 0; });
      s.photos = kept;
    }
  }
  if (sharedKeys.size) {
    console.log(`[写真診断] 複数物件で使い回されている画像 ${sharedKeys.size}種類を検出し、のべ${removed}枚を除外しました`);
  }
  return scraped;
}

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

  // 物件名:タイトルの「｜」区切りの末尾側から、価格部分を取り除いて残った文字を名前にする
  //   例1「…｜花園7丁目1号地モデル・2,080万円(税込)」→「花園7丁目1号地モデル」
  //   例2「…｜中原町2号地／2,180万円（税込）」      →「中原町2号地」
  //   例3「…｜中原町3号地｜2,280万円（税込）」      → 末尾は価格だけ→空になるので一つ前の「中原町3号地」
  let rawTitle = ($("h1").first().text() || $('meta[property="og:title"]').attr("content") || "").trim();
  rawTitle = rawTitle.replace(/\s*\|\s*熊本の.*$/, "");
  let name = "";
  const segs = rawTitle.split(/[|｜【】]/).map((s) => s.trim()).filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const cand = segs[i]
      .replace(/[・･/／]?\s*[\d,，]+(?:\.\d+)?万円.*$/, "")  // 価格とそれ以降を除去
      .replace(/[【】]/g, "")
      .trim();
    if (cand) { name = cand; break; }
  }
  if (!name) name = rawTitle.replace(/[【】（）()]/g, "").trim();
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

  // 写真:ページ全体から拾うのをやめ、「物件写真の囲い」の中だけから取る。
  //   実ページのHTML解析の結果:
  //     ・メイン写真   → <div class="bkSingle_mainphoto"> / <div class="bkMainphoto">
  //     ・ギャラリー   → <ul class="bkSlider2"> の中の <li>
  //     ・設備の使い回し写真 → <ul class="bkSetubi_list">(完全に別の囲い) → 対象外
  //   同じ写真の差し替え(元名_202607071134-680x507.jpg 形式)は最新版だけ採用。
  const MAX_PHOTOS = 5;

  const rootKey = photoRoot;
  const stampOf = (u) => { const m = u.match(/_(\d{12})/); return m ? m[1] : ""; };

  // 画像URLの取得:遅延読み込みでは実URLが data-lazy / data-src など
  // サイトによって違う属性に入るため、属性名を決め打ちせず、
  // 「全属性の中から画像URLらしい値」を探す。
  const looksImg = (v) => !!v && !v.startsWith("data:") && /\.(jpe?g|png)([?#][^ ]*)?$/i.test(v.trim());
  const abs = (v) => { try { return new URL(v.trim(), url).href; } catch (e) { return ""; } };
  const imgUrl = (el) => {
    const at = el.attribs || {};
    if (looksImg(at.src)) return abs(at.src);
    for (const k of Object.keys(at)) {
      if (k === "alt" || k === "class" || k === "id" || k === "style" || k === "srcset") continue;
      if (looksImg(at[k])) return abs(at[k]);
    }
    return "";
  };

  // 設備欄の写真(※画像はイメージです)を除外リストへ
  const setubiRoots = new Set();
  $('.bkSetubi_list img, [id^="bkSetibi"] img, .bkSetibi_lity_box img, .bkSetubi_img img').each((_, el) => {
    const u = imgUrl(el); if (u) setubiRoots.add(rootKey(u));
  });
  $('.bkSetubi_list a[href], [id^="bkSetibi"] a[href]').each((_, a) => {
    const h = $(a).attr("href"); if (looksImg(h)) setubiRoots.add(rootKey(abs(h)));
  });

  const BAN_IMG = /(logo|bnr|banner|label|maina|selfevaluation|maemura-bath|transparent|spotlight)/i;
  const postIdForPhoto = (url.match(/post-(\d+)/) || [])[1] || "";
  const groups = new Map(); // rootKey → {url, stamp, order}
  let order = 0;
  const consider = (u, toFront) => {
    if (!u) return;
    if (!/\.(jpe?g|png)([?#]|$)/i.test(u)) return;    // gif等は対象外
    if (BAN_IMG.test(u)) return;
    const k = rootKey(u);
    if (setubiRoots.has(k)) return;
    const st = stampOf(u);
    const g = groups.get(k);
    if (!g) groups.set(k, { url: u, stamp: st, order: toFront ? -1 : order++ });
    else {
      if (st > g.stamp) { g.url = u; g.stamp = st; }   // 差し替え後(日時が新しい方)を採用
      if (toFront) g.order = -1;
    }
  };
  // 他物件へのリンクに包まれた画像かどうか(おすすめ物件のサムネイル除外)
  const isOtherPost = (el) => {
    const a = $(el).closest("a");
    const href = a.length ? (a.attr("href") || "") : "";
    const linked = (href.match(/post-(\d+)/) || [])[1];
    return !!(linked && linked !== postIdForPhoto);
  };

  // 1. メイン写真(class名に mainphoto を含む囲い)→ 必ず先頭
  $('.bkSingle_mainphoto, .bkMainphoto, [class*="ainphoto"]').find("img").each((_, el) => {
    if (!isOtherPost(el)) consider(imgUrl(el), true);
  });
  // 2. class名に「bkSlider」を含む囲いすべて(名前の細部が違っても取れる)
  //    ページに載っている並び順のまま、img・拡大リンクの両方から拾う
  $('[class*="bkSlider"]').each((_, box) => {
    $(box).find("img, a[href]").each((_, el) => {
      if (el.tagName === "img") {
        if (!isOtherPost(el)) consider(imgUrl(el), false);
      } else {
        const h = $(el).attr("href"); if (looksImg(h)) consider(abs(h), false);
      }
    });
  });
  // 3. 拡大表示(ライトボックス)リンクの画像
  $('a[data-lity][href], a[data-fancybox][href], a[rel*="lightbox"][href]').each((_, a) => {
    const h = $(a).attr("href"); if (looksImg(h)) consider(abs(h), false);
  });
  // 4. ここまでで1枚以下なら、ページ全体からuploads配下の画像を厳しめ条件で拾う保険
  if (groups.size <= 1) {
    $("img").each((_, el) => {
      if (isOtherPost(el)) return;
      const u = imgUrl(el);
      if (u && /\/wp-content\/uploads\//.test(u)) consider(u, false);
    });
    $("a[href]").each((_, a) => {
      const h = $(a).attr("href");
      if (looksImg(h) && /\/wp-content\/uploads\//.test(h)) consider(abs(h), false);
    });
  }
  // 5. それでも0枚なら og:image の1枚だけ
  if (!groups.size) {
    const og = $('meta[property="og:image"]').attr("content");
    if (og) consider(og, true);
  }
  const photos = [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .slice(0, MAX_PHOTOS)
    .map((g, i) => ({ id: "p" + (i + 1), url: g.url, main: i === 0 }));
  if (!photos.length) warn("写真が1枚も取れませんでした");

  // 写真が取れないときの構造調査用の情報(main側でログに出す)
  lastPhotoDebug = {
    url,
    photos: photos.length,
    sliders: $('[class*="bkSlider"]').length,
    mainboxes: $('.bkSingle_mainphoto, .bkMainphoto, [class*="ainphoto"]').length,
    lity: $("a[data-lity][href]").length,
    imgs: $("img").length,
    excerpt: (() => {
      if (photos.length > 1) return "";
      const m = html.match(/.{0,250}wp-content\/uploads[^"'\s)]{5,120}\.jpe?g.{0,250}/i);
      return m ? m[0].replace(/\s+/g, " ") : "(uploads画像がHTML内に見当たりません)";
    })(),
  };

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
    if (item) {
      scraped.push(item);
      if (item.photos.length <= 1 && !main._dbg) main._dbg = lastPhotoDebug;
    }
  }
  scraped.sort((a, b) => a.id.localeCompare(b.id));
  console.log(`解析完了: ${scraped.length}件`);
  removeSharedPhotos(scraped);

  // 写真の取得状況(問題調査用の診断ログ)
  if (scraped.length) {
    const total = scraped.reduce((n, s) => n + s.photos.length, 0);
    const one = scraped.filter((s) => s.photos.length <= 1);
    console.log(`[写真診断] 平均 ${(total / scraped.length).toFixed(1)}枚 / 1枚以下の物件 ${one.length}件/${scraped.length}件`);
    scraped.slice(0, 3).forEach((s) =>
      console.log(`[写真診断] 例: ${s.name} → ${s.photos.length}枚`));
    if (one.length > scraped.length * 0.7 && main._dbg) {
      const d = main._dbg;
      console.log(`[写真診断] 大半の物件で写真が1枚以下です。ページ構造の調査情報:`);
      console.log(`[写真診断] 対象: ${d.url}`);
      console.log(`[写真診断] bkSlider系の囲い:${d.sliders}個 / メイン写真の囲い:${d.mainboxes}個 / 拡大リンク:${d.lity}個 / imgタグ:${d.imgs}個`);
      console.log(`[写真診断] HTML抜粋(写真周辺): ${d.excerpt}`);
    }
  }

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
