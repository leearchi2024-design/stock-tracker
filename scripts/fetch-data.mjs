// 由 GitHub Actions 執行：抓公開股市資料，輸出到網站的 data/ 資料夾。
// 用法：node scripts/fetch-data.mjs <輸出資料夾>
// 環境變數：SITE_URL（已部署網站，用來接續上次的歷史資料）、BACKFILL（補抓天數）
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import * as L from "./lib.mjs";

const OUT = path.resolve(process.argv[2] || "_site/data");
const SITE = (process.env.SITE_URL || "").replace(/\/$/, "");
const BACKFILL = Math.max(0, Math.min(120, parseInt(process.env.BACKFILL || "0", 10) || 0));
const UA = "Mozilla/5.0 (compatible; stock-tracker/1.0; +https://github.com)";
const TPE = "Asia/Taipei";

const status = {};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (k, msg = "") => (status[k] = { ok: true, at: new Date().toISOString(), msg });
const fail = (k, e) => { status[k] = { ok: false, at: new Date().toISOString(), msg: String(e?.message || e).slice(0, 160) }; log("⚠", k, status[k].msg); };

function tpeNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TPE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
const ymd = (iso) => iso.replace(/-/g, "");
const slashDate = (iso) => iso.replace(/-/g, "/");
const rocSlash = (iso) => `${+iso.slice(0, 4) - 1911}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`;

async function get(url, { type = "json", timeout = 30000, tries = 2 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: type === "json" ? "application/json,*/*" : "*/*" }, signal: AbortSignal.timeout(timeout) });
      if (r.status === 404) { const e = new Error("404"); e.status = 404; throw e; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      if (type !== "json") return text;
      if (/^\s*</.test(text)) throw new Error("回傳 HTML，不是 JSON（可能被擋或網站維護）");
      return JSON.parse(text);
    } catch (e) {
      last = e;
      if (e.status === 404) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}

/** 讀上一次部署的檔案；404 代表第一次執行。其他錯誤就中止，避免把歷史資料蓋掉。 */
async function prev(name) {
  if (!SITE) return null;
  try { return await get(`${SITE}/data/${name}?t=${Date.now()}`, { tries: 3 }); }
  catch (e) {
    if (e.status === 404) return null;
    throw new Error(`讀不到上次的 ${name}（${e.message}），這次先不更新，避免覆蓋歷史資料`);
  }
}

function weekdaysBack(fromIso, n) {
  const out = [];
  const d = new Date(fromIso + "T00:00:00Z");
  while (out.length < n) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

// ---------- 各資料來源 ----------
const TWSE_OPEN = "https://openapi.twse.com.tw/v1";
const TPEX_OPEN = "https://www.tpex.org.tw/openapi/v1";
const TWSE_RWD = "https://www.twse.com.tw/rwd/zh";

async function fetchT86(date) {
  return L.parseT86(await get(`${TWSE_RWD}/fund/T86?date=${ymd(date)}&selectType=ALLBUT0999&response=json`));
}
async function fetchMargin(date) {
  return L.parseMargin(await get(`${TWSE_RWD}/marginTrading/MI_MARGN?date=${ymd(date)}&selectType=ALL&response=json`));
}
async function fetchTpexHist(date) {
  const urls = [
    `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${encodeURIComponent(slashDate(date))}&type=EW&response=json`,
    `https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d=${rocSlash(date)}&se=EW&o=json`,
  ];
  for (const u of urls) {
    try { const r = L.parseTpexHistDay(await get(u, { tries: 1 })); if (r) return r; } catch {}
  }
  return null;
}
async function fetchTpexInsti(date) {
  const cands = [
    () => get(`${TPEX_OPEN}/tpex_3insti_daily_trading`),
    () => get(`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${encodeURIComponent(slashDate(date))}&response=json`),
  ];
  for (const c of cands) {
    try { const r = L.parseTpexInsti(await c()); if (r) return r; } catch {}
  }
  return null;
}

async function backfill(store, days, today) {
  log(`補抓歷史：最近 ${days} 個工作天`);
  const dates = weekdaysBack(today, days);
  let twFail = 0, tpexOk = true, got = 0;
  for (const [i, d] of dates.entries()) {
    if (twFail >= 6) { log("證交所連續失敗，停止補抓"); break; }
    try {
      const rows = L.parseTwseHistDay(await get(`${TWSE_RWD}/afterTrading/MI_INDEX?date=${ymd(d)}&type=ALLBUT0999&response=json`, { timeout: 60000 }));
      if (rows) {
        L.upsertDay(store, d, "c", Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.close])));
        L.upsertDay(store, d, "v", Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.vol])));
        twFail = 0; got++;
        if (tpexOk) {
          const t = await fetchTpexHist(d);
          if (t) {
            L.upsertDay(store, d, "c", Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.close])));
            L.upsertDay(store, d, "v", Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.vol])));
          } else if (i < 3) { tpexOk = false; log("櫃買歷史抓不到，上櫃股改為每天累積"); }
        }
        if (got <= 6) {
          await sleep(2300);
          try { const r = await fetchT86(d); if (r) { L.upsertDay(store, d, "f", Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.f]))); L.upsertDay(store, d, "t", Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.t]))); } } catch {}
          await sleep(2300);
          try { const m = await fetchMargin(d); if (m) L.upsertDay(store, d, "m", m); } catch {}
        }
      }
    } catch (e) { twFail++; log("補抓失敗", d, e.message); }
    await sleep(2600); // 證交所每 5 秒超過 3 次會暫時封鎖
  }
  log(`補抓完成：${got} 天`);
  return got;
}

// ---------- 主程式 ----------
async function main() {
  const now = tpeNow();
  log("台灣時間", now.date, now.hour + " 點", "SITE_URL=", SITE || "(未設定)");

  const [pStore, pMarket, pQuotes, pRevenue, pNews, pStatus] = await Promise.all(["store.json", "market.json", "quotes.json", "revenue.json", "news.json", "status.json"].map(prev));
  const store = L.normalizeStore(pStore || L.emptyStore());
  Object.assign(status, pStatus?.sources || {});

  // 1. 第一次執行或手動要求時補抓歷史
  const need = BACKFILL || (store.days.length < 20 ? 70 : 0);
  if (need) {
    // 14 點前今天還沒收盤，從昨天開始往回補
    const from = now.hour >= 14 ? now.date : new Date(Date.parse(now.date + "T00:00:00Z") - 864e5).toISOString().slice(0, 10);
    try { const n = await backfill(store, need, from); n ? ok("backfill", `補抓 ${n} 天`) : fail("backfill", "沒有抓到任何一天"); }
    catch (e) { fail("backfill", e); }
  }

  // 2. 最新收盤（上市＋上櫃）
  const quotes = { date: pQuotes?.date || null, q: pQuotes?.q || {} };
  let tradeDate = null;
  try {
    const tw = L.parseTwseDayAll(await get(`${TWSE_OPEN}/exchangeReport/STOCK_DAY_ALL`));
    const n = Object.keys(tw.rows).length;
    if (n < 300) throw new Error(`只有 ${n} 檔，資料不完整`);
    tradeDate = tw.date;
    if (!tradeDate) {
      // 舊版沒有日期欄：平日 14 點後視為今天，並用成交量判斷是否跟上次同一天
      const fp = ["2330", "2317", "2454"].map((c) => tw.rows[c]?.vol).join(",");
      const last = store.days[store.days.length - 1];
      const lastFp = last ? ["2330", "2317", "2454"].map((c) => store.v[c]?.[store.days.length - 1]).join(",") : "";
      tradeDate = fp === lastFp ? last : now.wd >= 1 && now.wd <= 5 && now.hour >= 14 ? now.date : null;
    }
    if (tradeDate) {
      L.upsertDay(store, tradeDate, "c", Object.fromEntries(Object.entries(tw.rows).map(([k, v]) => [k, v.close])));
      L.upsertDay(store, tradeDate, "v", Object.fromEntries(Object.entries(tw.rows).map(([k, v]) => [k, v.vol])));
    }
    for (const [k, v] of Object.entries(tw.rows)) quotes.q[k] = [v.name, v.close, v.change, v.vol, null, null, null, "上市"];
    quotes.date = tradeDate || quotes.date;
    ok("twse_quotes", `${n} 檔・${tradeDate || "日期未知"}`);
  } catch (e) { fail("twse_quotes", e); }

  try {
    const tp = L.parseTpexClose(await get(`${TPEX_OPEN}/tpex_mainboard_daily_close_quotes`));
    const n = Object.keys(tp.rows).length;
    if (n < 200) throw new Error(`只有 ${n} 檔，資料不完整`);
    const d = tp.date || tradeDate;
    if (d) {
      L.upsertDay(store, d, "c", Object.fromEntries(Object.entries(tp.rows).map(([k, v]) => [k, v.close])));
      L.upsertDay(store, d, "v", Object.fromEntries(Object.entries(tp.rows).map(([k, v]) => [k, v.vol])));
    }
    for (const [k, v] of Object.entries(tp.rows)) quotes.q[k] = [v.name, v.close, v.change, v.vol, null, null, null, "上櫃"];
    tradeDate = tradeDate || d;
    quotes.date = tradeDate || quotes.date;
    ok("tpex_quotes", `${n} 檔・${d || "日期未知"}`);
  } catch (e) { fail("tpex_quotes", e); }

  // 3. 本益比、殖利率、淨值比
  const peAll = {};
  try { Object.assign(peAll, L.parsePE(await get(`${TWSE_OPEN}/exchangeReport/BWIBBU_ALL`))); ok("twse_pe"); } catch (e) { fail("twse_pe", e); }
  try { Object.assign(peAll, L.parsePE(await get(`${TPEX_OPEN}/tpex_mainboard_peratio_analysis`))); ok("tpex_pe"); } catch (e) { fail("tpex_pe", e); }
  for (const [k, v] of Object.entries(peAll)) if (quotes.q[k]) { quotes.q[k][4] = v.pe; quotes.q[k][5] = v.pb; quotes.q[k][6] = v.yld; }
  // 本次沒抓到本益比時，沿用上次
  for (const [k, row] of Object.entries(quotes.q)) if (row[4] == null && pQuotes?.q?.[k]) { row[4] = pQuotes.q[k][4]; row[5] = pQuotes.q[k][5]; row[6] = pQuotes.q[k][6]; }

  // 4. 三大法人（約 15:00–16:00 公布）
  const instiDate = tradeDate || store.days[store.days.length - 1];
  if (instiDate && (instiDate < now.date || now.hour >= 15)) {
    try {
      const r = await fetchT86(instiDate);
      if (!r) throw new Error("尚未公布或當天休市");
      L.upsertDay(store, instiDate, "f", Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.f])));
      L.upsertDay(store, instiDate, "t", Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.t])));
      ok("twse_insti", `${Object.keys(r).length} 檔・${instiDate}`);
    } catch (e) { fail("twse_insti", e); }
    try {
      const r = await fetchTpexInsti(instiDate);
      if (!r) throw new Error("抓不到上櫃三大法人");
      L.upsertDay(store, instiDate, "f", Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.f])));
      L.upsertDay(store, instiDate, "t", Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.t])));
      ok("tpex_insti", `${Object.keys(r).length} 檔`);
    } catch (e) { fail("tpex_insti", e); }
  }

  // 5. 融資餘額（約 21:00 後公布）
  if (instiDate && (instiDate < now.date || now.hour >= 21)) {
    await sleep(2300);
    try {
      const m = await fetchMargin(instiDate);
      if (!m) throw new Error("尚未公布或當天休市");
      L.upsertDay(store, instiDate, "m", m);
      ok("twse_margin", `${Object.keys(m).length} 檔・${instiDate}`);
    } catch (e) { fail("twse_margin", e); }
  }

  // 6. 大盤與美股
  const market = { updatedAt: new Date().toISOString(), tradeDate: quotes.date, taiex: pMarket?.taiex || null, us: { ...(pMarket?.us || {}) } };
  try {
    const t = L.parseTaiex(await get(`${TWSE_OPEN}/exchangeReport/MI_INDEX`));
    if (!t) throw new Error("找不到加權指數");
    market.taiex = { ...t, date: t.date || quotes.date };
    ok("taiex");
  } catch (e) { fail("taiex", e); }
  const YH = { TWII: "^TWII", SOX: "^SOX", IXIC: "^IXIC", GSPC: "^GSPC", DJI: "^DJI", TSM: "TSM", TWD: "TWD=X" };
  let yOk = 0;
  for (const [k, sym] of Object.entries(YH)) {
    try {
      const r = L.parseYahooChart(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=10d&interval=1d`));
      if (r) { market.us[k] = r; yOk++; }
    } catch (e) { log("Yahoo", sym, e.message); }
    await sleep(400);
  }
  yOk ? ok("us_market", `${yOk}/${Object.keys(YH).length}`) : fail("us_market", "Yahoo 全部失敗，沿用上次資料");
  if (!market.taiex && market.us.TWII) market.taiex = market.us.TWII;

  // 7. 月營收（每月 10 日前公布）
  let revenue = pRevenue || { ym: null, r: {} };
  try {
    const a = L.parseRevenue(await get(`${TWSE_OPEN}/opendata/t187ap05_L`));
    const b = L.parseRevenue(await get(`${TPEX_OPEN}/mopsfin_t187ap05_O`).catch(() => []));
    const n = Object.keys(a.rows).length + Object.keys(b.rows).length;
    if (n < 300) throw new Error(`只有 ${n} 家`);
    revenue = { ym: [a.ym, b.ym].filter(Boolean).sort().pop() || null, r: { ...revenue.r, ...a.rows, ...b.rows } };
    ok("revenue", `${n} 家・${revenue.ym}`);
  } catch (e) { fail("revenue", e); }

  // 8. 新聞（Google 新聞 RSS＋Yahoo 股市 RSS）
  const feeds = [
    ["https://news.google.com/rss/search?q=" + encodeURIComponent("台股 when:1d") + "&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", ""],
    ["https://news.google.com/rss/search?q=" + encodeURIComponent("(台積電 OR 半導體 OR AI伺服器 OR 法說會) when:1d") + "&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", ""],
    ["https://news.google.com/rss/search?q=" + encodeURIComponent("(美股 OR 費半 OR 聯準會 OR 關稅) when:1d") + "&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", ""],
    ["https://tw.stock.yahoo.com/rss?category=tw-market", "Yahoo股市"],
  ];
  const lists = [];
  for (const [u, src] of feeds) {
    try { lists.push(L.parseRss(await get(u, { type: "text" }), src)); } catch (e) { log("RSS", e.message); }
  }
  let news = pNews || { updatedAt: null, items: [] };
  const fresh = lists.flat();
  if (fresh.length) {
    news = { updatedAt: new Date().toISOString(), items: L.mergeNews([fresh, news.items || []]) };
    ok("news", `${news.items.length} 則`);
  } else fail("news", "所有新聞來源都失敗，沿用上次");

  // 9. 輸出
  L.trimStore(store);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, "h"), { recursive: true });
  const w = (name, obj) => writeFile(path.join(OUT, name), JSON.stringify(obj));
  await w("store.json", store);
  await w("quotes.json", quotes);
  await w("market.json", market);
  await w("revenue.json", revenue);
  await w("news.json", news);
  await w("status.json", { updatedAt: new Date().toISOString(), days: store.days.length, firstDay: store.days[0] || null, lastDay: store.days[store.days.length - 1] || null, sources: status });
  let shards = 0;
  for (const code of L.storeCodes(store)) {
    const s = L.shardOf(store, code);
    if (s) { await writeFile(path.join(OUT, "h", code + ".json"), JSON.stringify(s)); shards++; }
  }
  log(`完成：歷史 ${store.days.length} 天（${store.days[0]} ~ ${store.days[store.days.length - 1]}），${shards} 檔個股`);
  console.table(Object.fromEntries(Object.entries(status).map(([k, v]) => [k, `${v.ok ? "✓" : "✗"} ${v.msg}`])));
}

main().catch((e) => { console.error("✗", e.message); process.exit(1); });
