/* scraper/common.js
   3社共通の処理:ページ取得、価格の安全な解析、差分反映ルール
   ─────────────────────────────────────────────
   差分反映の原則(仕様書8-1):
   このスクレイパーが書き換えるのは data/listings.json(自動収集の層)だけ。
   営業担当者の手動編集はスマホの中(localStorage)にあり、ここからは一切触れない。
*/
const fs = require("fs");
const path = require("path");

const UA = "BukkenNaviBot/1.0 (shanai-riyou; contact via site form)";
const WAIT_MS = 1000; // ページごとに1秒待つ(相手サイトに負荷をかけない)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.ok) return await res.text();
      console.error(`[WARN] ${res.status} ${url}`);
    } catch (e) {
      console.error(`[WARN] 取得失敗(${attempt}回目) ${url}: ${e.message}`);
    }
    await sleep(2000 * attempt);
  }
  return null;
}

/* ---------- 価格の安全な解析(仕様書8-3対策) ---------- */
/* 「万円」表記 → 万円単位の数値。解釈できなければ null */
function priceMan(p) {
  if (!p) return null;
  const s = String(p).replace(/[,，\s]/g, "");
  let m = s.match(/(\d+)億(\d+)?万?円?/);
  if (m) return parseInt(m[1]) * 10000 + (m[2] ? parseInt(m[2]) : 0);
  m = s.match(/(\d+(?:\.\d+)?)万円/);
  if (m) return parseFloat(m[1]);
  return null;
}

const BAN_WORDS = /月々|月額|ボーナス|キャッシュバック|先着|プレゼント|割引|お借入|返済/;

/* 価格の3段階判定:
   1. 表の「価格」ラベル付きの値を最優先
   2. だめなら本文の「販売価格:」等ラベル直後のみ
   3. 500万円未満・宣伝ワード近接は不採用 → 価格未定扱い          */
function pickPrice(kv, fullText, warn) {
  for (const key of Object.keys(kv)) {
    if (/価格/.test(key) && !/価格帯/.test(key) && !BAN_WORDS.test(key)) {
      const v = kv[key];
      const man = priceMan(v);
      if (man != null) {
        if (man >= 500) {
          const m = String(v).match(/[\d,，]+(?:\.\d+)?万円/);
          return m ? m[0].replace(/，/g, ",") : v;
        }
        warn(`「${key}: ${v}」は500万円未満のため価格として採用しません`);
      }
    }
  }
  const re = /(販売価格|セット価格|物件価格)[^\d]{0,20}([\d,，]+(?:\.\d+)?万円)/g;
  let m;
  while ((m = re.exec(fullText))) {
    const before = fullText.slice(Math.max(0, m.index - 25), m.index);
    if (BAN_WORDS.test(before)) continue;
    const man = priceMan(m[2]);
    if (man != null && man >= 500) return m[2].replace(/，/g, ",");
  }
  warn("価格を特定できませんでした → 価格未定として登録します");
  return "";
}

/* ---------- 表(th/td)を「ラベル→値」に変換 ---------- */
const KNOWN_LABELS = [
  "所在地","住所","交通","物件種別","価格","販売価格","築年数","築年月","間取り",
  "構造","土地面積","建物面積","建物施工面積","駐車場","小学校区","中学校区","買い物",
];
function tablePairs($) {
  const kv = {};
  const hasManYen = (t) => /[\d,，]+(?:\.\d+)?万円/.test(t);
  $("table tr").each((_, tr) => {
    const cells = $(tr).children("th,td").toArray();
    let key = null;
    for (const c of cells) {
      const txt = $(c).text().replace(/\s+/g, " ").trim();
      if (c.tagName === "th") { key = txt; continue; }
      if (!key) continue;
      if (!(key in kv)) { if (txt) kv[key] = txt; }
      else if (/価格/.test(key) && hasManYen(txt) && !hasManYen(kv[key])) {
        // 「価格|(…)セット価格|2,180万円」のような3列構成では、
        // 説明文ではなく「万円」入りの数字セルを価格として採用する
        kv[key] = txt;
      }
      // 価格の行で、まだ数字が取れていなければ次のセルも同じ項目として見る
      if (!(/価格/.test(key) && !hasManYen(kv[key] || ""))) key = null;
    }
    // thが無い表(td,tdの2列)への保険
    if (!$(tr).children("th").length && cells.length >= 2) {
      const k = $(cells[0]).text().replace(/\s+/g, " ").trim();
      const v = $(cells[1]).text().replace(/\s+/g, " ").trim();
      if (KNOWN_LABELS.some((l) => k.startsWith(l)) && v && !(k in kv)) kv[k] = v;
    }
  });
  return kv;
}

/* ---------- 差分反映(前回JSON × 今回取得分) ---------- */
function mergeListings(prevList, scrapedBySource, sources, today) {
  const out = [];
  for (const src of sources) {
    const scraped = scrapedBySource[src] || [];
    const prevSrc = prevList.filter((l) => l.source === src);
    const prevActive = prevSrc.filter((l) => l.status !== "ended");

    // 安全弁:取得件数が前回の3割未満に激減したら、サイト側トラブルの
    // 可能性が高いので「全物件が掲載終了」にせず前回データを維持する
    if (prevActive.length >= 5 && scraped.length < prevActive.length * 0.3) {
      console.error(`[ERROR] ${src}: 取得件数が激減(${prevActive.length}件→${scraped.length}件)。` +
        `誤って全件を掲載終了にしないため、今回は前回データを維持します。`);
      out.push(...prevSrc);
      continue;
    }
    const prevById = Object.fromEntries(prevSrc.map((l) => [l.id, l]));
    const scrapedIds = new Set(scraped.map((s) => s.id));

    for (const s of scraped) {
      const p = prevById[s.id];
      if (!p) {
        // 新規
        out.push({ ...s, status: "active", endedAt: "",
          createdAt: new Date().toISOString(), lastSeen: today,
          priceChanges: [],
          priceSnapshots: s.price ? [{ date: today, price: s.price }] : [] });
      } else {
        // 既存:自動収集フィールドを更新。createdAt・価格履歴は引き継ぐ
        const merged = { ...p, ...s, status: "active", endedAt: "", lastSeen: today,
          createdAt: p.createdAt || new Date().toISOString(),
          priceChanges: p.priceChanges || [], priceSnapshots: p.priceSnapshots || [] };
        if (s.price && p.price && s.price !== p.price) {
          merged.priceChanges = [...merged.priceChanges, { date: today, from: p.price, to: s.price }];
          console.log(`[INFO] 価格変更 ${s.id} ${p.price} → ${s.price}`);
        }
        const snaps = merged.priceSnapshots;
        if (s.price && (!snaps.length || snaps[snaps.length - 1].price !== s.price)) {
          merged.priceSnapshots = [...snaps, { date: today, price: s.price }];
        }
        out.push(merged);
      }
    }
    // 今回サイトに無かった物件 → 掲載終了(データは消さない:仕様書8-1)
    for (const p of prevSrc) {
      if (!scrapedIds.has(p.id)) {
        out.push(p.status === "ended" ? p : { ...p, status: "ended", endedAt: today });
      }
    }
  }
  // 今回スクレイプ対象でないメーカーのデータはそのまま残す
  const covered = new Set(sources);
  out.push(...prevList.filter((l) => !covered.has(l.source)));
  return out;
}

/* ---------- JSONの読み書き ---------- */
function loadData(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return { updatedAt: null, listings: [] }; }
}
function saveData(file, listings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json = { updatedAt: new Date().toISOString(), count: listings.length, listings };
  fs.writeFileSync(file, JSON.stringify(json, null, 1));
}
function todayStr() {
  const d = new Date(Date.now() + 9 * 3600 * 1000); // JST
  return d.toISOString().slice(0, 10);
}

module.exports = { fetchHtml, sleep, priceMan, pickPrice, tablePairs,
  mergeListings, loadData, saveData, todayStr, WAIT_MS };
