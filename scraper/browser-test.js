/* scraper/browser-test.js
   ブラウザ取得テスト(調査用。本番の収集は行いません)
   ─────────────────────────────────
   すまいーだ・ナカジツは、GitHubの作業場所からの通常のアクセスを
   403(お断り)で返すことがあります。そこで「GitHubの作業場所に
   最初から入っている本物のブラウザ(Chrome)で開けば通るか」を
   確かめるためのテストです。

   行うこと:
   1. 比較用に、今までどおりの方法(直接取得)でも開いてみる
   2. Chromeで対象ページを少数だけ開き、結果(状態・ページの題名・
      物件らしい中身が入っているか)を記録に残す
      ・開き方A: Chromeのいつもの名乗り(自動ブラウザ用)のまま
      ・開き方B: 名乗りを通常のパソコン版Chromeのものに変える
   3. 開けたページのHTMLと画面写真を browser-test-sample/ に保存
      (ワークフローが「Artifacts」としてまとめるので、後から見られます)
   アクセスは各ページの間に2秒以上あけ、ページ数も最小限にしています。
*/
const fs = require("fs");
const { execSync } = require("child_process");

const UA_BOT = "BukkenNaviBot/1.0 (shanai-riyou; contact via site form)";
const OUT = "browser-test-sample";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NAKA_LIST = "https://nakajitsu.com/kumamoto/prpsearch/?SYUMOKU%5B%5D=NEWHOUSE&OWN_FLG="
  + encodeURIComponent("仲介手数料無料物件") + "&searchCommand=on";

/* テスト対象: [名前, URL, 中身の目印(正規表現), 目印の説明] */
const TARGETS = [
  ["すまいーだ県ページ", "https://sumaiida.com/ikkodate/area/kyushu/kumamoto/",
   /\/ikkodate\/list\/area\/kyushu\/kumamoto\/\d{5}\//g, "市区町村ページへのリンク"],
  ["すまいーだ詳細ページ", "https://sumaiida.com/ikkodate/kyushu/kumamoto/1012401010815PJ-054228-2/",
   /所在地/g, "「所在地」の項目"],
  ["ナカジツ検索一覧", NAKA_LIST,
   /prpwrap/g, "物件の囲い(prpwrap)"],
  ["ナカジツ詳細ページ", "https://nakajitsu.com/prpsearch/prpdetail/OBJ_MNG_NO/5482368/",
   /prpdetailPage/g, "物件詳細の囲い(prpdetailPage)"],
];

const results = [];
function report(method, name, status, title, markerCount, markerLabel, note) {
  results.push({ method, name, status, markerCount });
  console.log(`[${method}] ${name}: HTTP ${status} / 題名「${title || "?"}」 / ${markerLabel} ${markerCount}件${note ? " / " + note : ""}`);
}

/* ---------- 1. 今までどおりの方法(直接取得) ---------- */
async function testDirect() {
  for (const [name, url, markerRe, markerLabel] of TARGETS) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA_BOT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en;q=0.5" } });
      const text = await res.text();
      const title = (text.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
      const n = (text.match(markerRe) || []).length;
      report("直接取得", name, res.status, title, n, markerLabel, `${text.length}文字`);
    } catch (e) {
      report("直接取得", name, "エラー", "", 0, markerLabel, e.message);
    }
    await sleep(2000);
  }
}

/* ---------- 2. Chromeで開く ---------- */
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  try {
    const w = execSync("which google-chrome google-chrome-stable chromium chromium-browser 2>/dev/null | head -1")
      .toString().trim();
    if (w) return w;
  } catch (e) {}
  return "";
}

async function testBrowser() {
  let puppeteer;
  try {
    puppeteer = require("puppeteer-core");
  } catch (e) {
    console.log("[Chrome] puppeteer-core が入っていないため、ブラウザのテストはできませんでした");
    return;
  }
  const chromePath = findChrome();
  if (!chromePath) {
    console.log("[Chrome] この作業場所にChromeが見つからないため、ブラウザのテストはできませんでした");
    return;
  }
  console.log(`[Chrome] 使用するChrome: ${chromePath}`);

  const modes = [
    ["Chrome・名乗りそのまま", null],
    ["Chrome・通常の名乗り", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"],
  ];
  for (const [modeLabel, ua] of modes) {
    let browser;
    try {
      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--lang=ja-JP"],
      });
      console.log(`[Chrome] バージョン: ${await browser.version()}`);
      const page = await browser.newPage();
      await page.setExtraHTTPHeaders({ "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.5" });
      if (ua) await page.setUserAgent(ua);
      for (const [name, url, markerRe, markerLabel] of TARGETS) {
        const tag = `${modeLabel === modes[0][0] ? "chromeA" : "chromeB"}-${name}`;
        try {
          const res = await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
          await sleep(2000);   // 表示の仕上げ待ち＋相手サイトへの間隔
          const content = await page.content();
          const title = await page.title();
          const n = (content.match(markerRe) || []).length;
          report(modeLabel, name, res ? res.status() : "?", title, n, markerLabel, `${content.length}文字`);
          fs.writeFileSync(`${OUT}/${tag}.html`, content);
          try { await page.screenshot({ path: `${OUT}/${tag}.png` }); } catch (e) {}
        } catch (e) {
          report(modeLabel, name, "エラー", "", 0, markerLabel, e.message.slice(0, 120));
        }
        await sleep(2000);
      }
    } catch (e) {
      console.log(`[Chrome] 起動または実行に失敗: ${e.message}`);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.log("=== ブラウザ取得テスト 開始 ===");
  await testDirect();
  await testBrowser();
  console.log("\n=== まとめ(目印が1件以上あれば「中身が取れている」可能性が高いです) ===");
  for (const r of results) {
    console.log(`  ${r.method} / ${r.name}: HTTP ${r.status} / 目印 ${r.markerCount}件`);
  }
  console.log("=== 完了: 開けたページは Artifacts(browser-test-sample)からダウンロードできます ===");
})().catch((e) => { console.error("[ERROR]", e); /* テストなので失敗扱いにはしない */ });
