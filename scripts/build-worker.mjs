// 產生 worker/stock-live.js：把 scripts/lib.mjs（純函式）與 worker/handler.js 合成單一檔案，
// 方便直接貼到 Cloudflare 的線上編輯器。用法：node scripts/build-worker.mjs
import { readFile, writeFile } from "node:fs/promises";

const lib = (await readFile(new URL("./lib.mjs", import.meta.url), "utf8")).replace(/^export (const|function|async function) /gm, "$1 ");
const handler = await readFile(new URL("../worker/handler.js", import.meta.url), "utf8");
const out = `// 股票追蹤器・即時報價與新聞（Cloudflare Worker）
// 這個檔案由 scripts/build-worker.mjs 自動產生，請改 worker/handler.js 或 scripts/lib.mjs 後重新產生。
// 產生時間：${new Date().toISOString()}

${lib}

${handler}`;
await writeFile(new URL("../worker/stock-live.js", import.meta.url), out);
console.log("已產生 worker/stock-live.js", (out.length / 1024).toFixed(1) + " KB");
