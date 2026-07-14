/* scraper/sumaiida-test.js
   すまいーだ(sumaiida.com)が自動収集を許可しているかの確認だけを行う。
   1. robots.txt(自動アクセスの可否を宣言するファイル)を取得して表示
   2. 熊本の一覧ページに1回だけアクセスして、結果(ステータス)を表示
   ※ 収集は行いません。判断材料を集めるだけのスクリプトです。
*/
const UA = "BukkenNaviBot/1.0 (shanai-riyou)";

async function check(url, label) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
    console.log(`\n=== ${label} ===`);
    console.log(`URL: ${url}`);
    console.log(`結果: HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`受信サイズ: ${text.length}文字`);
    console.log("--- 先頭部分 ---");
    console.log(text.slice(0, 1200));
    return { status: res.status, text };
  } catch (e) {
    console.log(`\n=== ${label} ===\n取得エラー: ${e.message}`);
    return { status: 0, text: "" };
  }
}

(async () => {
  const robots = await check("https://sumaiida.com/robots.txt", "robots.txt(自動アクセスの可否宣言)");
  const list = await check("https://sumaiida.com/ikkodate/area/kyushu/kumamoto/", "熊本の一覧ページ");

  console.log("\n=== 判定の目安 ===");
  if (robots.status === 200 && /disallow:\s*\/\s*$/im.test(robots.text)) {
    console.log("robots.txt が全ページの自動アクセスを禁止しています。収集は行わないことを推奨します。");
  } else if (list.status === 200) {
    console.log("一覧ページが取得できました。収集できる見込みがあります。");
  } else {
    console.log(`一覧ページが取得できません(HTTP ${list.status})。サイト側が自動アクセスを制限している可能性が高いです。`);
  }
})();
