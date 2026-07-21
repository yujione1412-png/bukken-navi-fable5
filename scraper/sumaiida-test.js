/* scraper/sumaiida-test.js (v2)
   すまいーだの調査用スクリプト。以下を行います。
   1. robots.txt を取得して全文表示し、収集対象パスが禁止されていないか確認
   2. 熊本の一覧ページを取得し、物件詳細ページのリンクを数える
   3. 詳細ページを1件だけ取得
   4. 取得したHTMLを sumaiida-sample/ に保存(ワークフローがArtifactsとしてまとめます)
   ※ 本格的な収集はまだ行いません。ページ2〜4枚だけの最小限のアクセスです。
*/
const fs = require("fs");
const UA = "BukkenNaviBot/1.0 (shanai-riyou)";
const OUT = "sumaiida-sample";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, label) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
  const text = await res.text();
  console.log(`\n=== ${label} ===\nURL: ${url}\n結果: HTTP ${res.status} / ${text.length}文字`);
  return { status: res.status, text };
}

/* robots.txt の User-agent:* ルールで path が禁止されていないか簡易判定 */
function robotsAllows(robotsText, path) {
  const lines = robotsText.split(/\r?\n/);
  let applies = false;
  const rules = [];
  for (const line of lines) {
    const m = line.match(/^\s*(user-agent|disallow|allow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, k, vRaw] = m;
    const v = vRaw.trim();
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

const DETAIL_RE = /href="([^"]*\/ikkodate\/[a-z0-9_-]+\/[a-z0-9_-]+\/\d{8,}[-\d]*\/?)"/g;
function pickLinks(html, re) {
  return [...new Set(
    (html.match(re) || []).map((h) => h.replace(/^href="/, "").replace(/"$/, ""))
  )].map((u) => (u.startsWith("http") ? u : "https://sumaiida.com" + u));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // 1. robots.txt
  const robots = await get("https://sumaiida.com/robots.txt", "robots.txt");
  console.log("--- robots.txt 全文 ---\n" + robots.text.slice(0, 3000));
  fs.writeFileSync(`${OUT}/robots.txt`, robots.text);
  const allowed = robots.status !== 200 || robotsAllows(robots.text, "/ikkodate/");
  console.log(`\n/ikkodate/(一戸建てページ)の自動アクセス: ${allowed ? "禁止されていません" : "robots.txtで禁止されています"}`);
  if (!allowed) {
    console.log("robots.txt が対象ページの自動アクセスを禁止しているため、ここで中止します。");
    return;
  }

  // 2. 一覧ページ(件数が合わない市区の調査用に東区・西区を保存)
  await sleep(1000);
  const higashi = await get("https://sumaiida.com/ikkodate/list/area/kyushu/kumamoto/43102/", "東区一覧ページ");
  fs.writeFileSync(`${OUT}/list-43102.html`, higashi.text);
  await sleep(1000);
  const nishi = await get("https://sumaiida.com/ikkodate/list/area/kyushu/kumamoto/43103/", "西区一覧ページ");
  fs.writeFileSync(`${OUT}/list-43103.html`, nishi.text);
  const list = higashi;
  fs.writeFileSync(`${OUT}/list.html`, list.text);
  const detailLinks = pickLinks(list.text, DETAIL_RE);
  console.log(`物件詳細らしきリンク: ${detailLinks.length}件`);
  detailLinks.slice(0, 5).forEach((u) => console.log("  -", u));

  // 一覧に詳細リンクがなければ、市区町村の一覧ページを1つたどる
  let detailUrl = detailLinks[0];
  if (!detailUrl) {
    const cityLinks = pickLinks(list.text, /href="([^"]*\/ikkodate\/list\/[^"]+)"/g);
    console.log(`市区町村一覧ページ: ${cityLinks.length}件`);
    if (cityLinks[0]) {
      await sleep(1000);
      const cityList = await get(cityLinks[0], "市区町村の一覧ページ(1つ目)");
      fs.writeFileSync(`${OUT}/list2.html`, cityList.text);
      const links2 = pickLinks(cityList.text, DETAIL_RE);
      console.log(`物件詳細らしきリンク(市区町村ページ): ${links2.length}件`);
      detailUrl = links2[0];
    }
  }

  // 3. 詳細ページを1件
  if (detailUrl) {
    await sleep(1000);
    const detail = await get(detailUrl, "物件詳細ページ(サンプル1件)");
    fs.writeFileSync(`${OUT}/detail.html`, detail.text);
    fs.writeFileSync(`${OUT}/detail-url.txt`, detailUrl);
  } else {
    console.log("[注意] 物件詳細のリンクが見つかりませんでした。list.html の中身の確認が必要です。");
  }

  // ---- よかタウンの検索まわりの調査(検索リニューアル対応用) ----
  console.log("\n===== よかタウン調査 =====");
  const yokaTargets = [
    ["yokatown-search-min.html",
     "https://bukken.yoka-town.com/search/index/?class%5B%5D=b2&address%5B%5D=43102&lmt=30&orderby=new",
     "旧形式の検索URL(東区のみ)"],
    ["yokatown-search-top.html",
     "https://bukken.yoka-town.com/search/index/",
     "検索ページそのもの"],
    ["yokatown-top.html",
     "https://bukken.yoka-town.com/",
     "トップページ"],
    ["yokatown-room.html",
     "https://bukken.yoka-town.com/room105541738.html",
     "物件ページ(比較用)"],
  ];
  for (const [file, url, label] of yokaTargets) {
    await sleep(1000);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
      const text = await res.text();
      console.log(`\n[${label}]`);
      console.log(`  要求URL: ${url}`);
      console.log(`  最終URL: ${res.url}`);
      console.log(`  結果: HTTP ${res.status} / ${text.length}文字`);
      const rooms = (text.match(/room\d+\.html/g) || []).length;
      console.log(`  物件リンクの数: ${rooms}`);
      fs.writeFileSync(`${OUT}/${file}`, `<!-- 最終URL: ${res.url} / HTTP ${res.status} -->\n` + text);
    } catch (e) {
      console.log(`[${label}] 取得エラー: ${e.message}`);
    }
  }

  console.log("\n=== 完了: 取得したページは Artifacts(sumaiida-sample)からダウンロードできます ===");
})().catch((e) => { console.error("[ERROR]", e); process.exit(1); });
