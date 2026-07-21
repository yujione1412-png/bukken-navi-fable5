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
          const m = String(v).match(/[\d,，]+(?:\.\d+)?万円(?:\s*[～〜~]\s*[\d,，]+(?:\.\d+)?万円)?/);
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

    // 安全弁:取得件数が前回の6割未満に減ったら、サイト側トラブルの
    // 可能性が高いので「全物件が掲載終了」にせず前回データを維持する
    if (prevActive.length >= 5 && scraped.length < prevActive.length * 0.6) {
      console.error(`[ERROR] ${src}: 取得件数が大幅に減少(${prevActive.length}件→${scraped.length}件、6割未満)。` +
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
          relistedAt: (p.status === "ended" && p.endedAt
              && (new Date(today) - new Date(p.endedAt)) >= 3 * 24 * 3600 * 1000)
            ? today : (p.relistedAt || ""),
          priceChanges: p.priceChanges || [], priceSnapshots: p.priceSnapshots || [] };
        if (p.status === "ended") {
          console.log(merged.relistedAt === today
            ? `  [再掲載] ${s.name}(掲載終了→再掲載)`
            : `  [復帰] ${s.name}(短期間の消失から復帰。再掲載扱いにはしません)`);
        }
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
  stripOldEndedPhotos(out);   // 掲載終了3ヶ月経過の物件から写真情報を削除
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

/* ---------- 定義リスト(dt/dd)を「ラベル→値」に変換(すまいーだ等) ---------- */
function dlPairs($) {
  const kv = {};
  $("dl").each((_, dl) => {
    const dts = $(dl).find("dt").toArray();
    for (const dt of dts) {
      const key = $(dt).text().replace(/\s+/g, " ").trim();
      const dd = $(dt).next("dd");
      if (!key || !dd.length) continue;
      const val = dd.text().replace(/\s+/g, " ").trim();
      if (val && !(key in kv)) kv[key] = val;
    }
  });
  return kv;
}

/* ---------- 住所 → 緯度経度(OpenStreetMapの無料ジオコーディング) ----------
   利用ポリシー: 1秒1リクエスト以下・連絡先入りUA。ここでは1.2秒間隔で使う。 */
async function geocode(address) {
  const tryOnce = async (q) => {
    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=jp&q="
      + encodeURIComponent(q);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) return "";
      const j = await res.json();
      if (j && j[0] && j[0].lat) return `${(+j[0].lat).toFixed(6)}, ${(+j[0].lon).toFixed(6)}`;
    } catch (e) {}
    return "";
  };
  // 3段階で挑戦: ①住所そのまま(exact) → ②番地を外す(banchi) → ③丁目まで外す(town)
  // 戻り値: { loc:"緯度, 経度", prec:"exact"|"banchi"|"town" }。見つからなければ loc:""
  const attempts = [[String(address).trim(), "exact"]];
  const noBanchi = attempts[0][0].replace(/[0-9０-９][0-9０-９\-‐−ー番地号の]*$/, "").trim();
  if (noBanchi && noBanchi !== attempts[0][0]) attempts.push([noBanchi, "banchi"]);
  const townOnly = noBanchi.replace(/[0-9０-９]+丁目.*$/, "").trim();
  if (townOnly && townOnly !== noBanchi && townOnly.length >= 6) attempts.push([townOnly, "town"]);
  for (const [q, prec] of attempts) {
    const loc = await tryOnce(q);
    if (loc) return { loc, prec };
    await sleep(1200);
  }
  return { loc: "", prec: "" };
}

/* 前回データの緯度経度を引き継ぐ(毎回ジオコーディングし直さないため) */
function reuseLocText(prevList, scraped) {
  const prevLoc = {};
  for (const l of prevList || []) if (l.locText) prevLoc[l.id] = { loc: l.locText, prec: l.locPrec || "" };
  let reused = 0;
  for (const s of scraped) {
    if (!s.locText && prevLoc[s.id]) {
      s.locText = prevLoc[s.id].loc;
      s.locPrec = prevLoc[s.id].prec;
      reused++;
    }
  }
  return reused;
}

/* ---------- robots.txt の User-agent:* ルールで path が許可されているか ---------- */
function robotsAllows(robotsText, path) {
  const lines = String(robotsText || "").split(/\r?\n/);
  let applies = false;
  const rules = [];
  for (const line of lines) {
    const m = line.match(/^\s*(user-agent|disallow|allow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const k = m[1], v = m[2].trim();
    if (/user-agent/i.test(k)) applies = (v === "*");
    else if (applies) rules.push({ allow: /^allow$/i.test(k), path: v });
  }
  let verdict = true, matchLen = -1;
  for (const r of rules) {
    if (!r.path) continue;
    if (path.startsWith(r.path) && r.path.length > matchLen) {
      matchLen = r.path.length; verdict = r.allow;
    }
  }
  return verdict;
}

/* ---------- 掲載終了から一定期間たった物件の写真情報を消す(物件情報は残す) ----------
   縮小写真ファイル自体は photos.js が「どの物件からも参照されないもの」を削除する */
function stripOldEndedPhotos(listings, months = 3, now = Date.now()) {
  let stripped = 0;
  for (const l of listings) {
    if (l.status !== "ended" || !l.endedAt) continue;
    if (!(l.photos || []).length) continue;
    const age = now - new Date(l.endedAt).getTime();
    if (age >= months * 31 * 24 * 3600 * 1000) { l.photos = []; stripped++; }
  }
  if (stripped) console.log(`[整理] 掲載終了${months}ヶ月経過の${stripped}件から写真情報を削除しました(物件情報は保持)`);
  return listings;
}

module.exports = { fetchHtml, sleep, priceMan, pickPrice, tablePairs, dlPairs, robotsAllows, geocode, reuseLocText, stripOldEndedPhotos,
  mergeListings, loadData, saveData, todayStr, WAIT_MS };
