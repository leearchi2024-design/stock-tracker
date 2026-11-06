// 離線測試：node scripts/test.mjs
import assert from "node:assert/strict";
import * as L from "./lib.mjs";
import { indicators, feeOf, taxOf, ledgerOf, normalizeState, mergeState, canon } from "../core.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("✓", name); };

t("數字與日期解析", () => {
  assert.equal(L.num("1,234.5"), 1234.5);
  assert.equal(L.num("--"), null);
  assert.equal(L.num("-3.2"), -3.2);
  assert.equal(L.num("+15"), 15);
  assert.equal(L.num("<p style=color:red>+</p>"), null);
  assert.equal(L.toISODate("1151105"), "2026-11-05");
  assert.equal(L.toISODate("115/11/05"), "2026-11-05");
  assert.equal(L.toISODate("20261105"), "2026-11-05");
  assert.equal(L.toISODate("2026-11-05"), "2026-11-05");
});

t("上市 STOCK_DAY_ALL", () => {
  const r = L.parseTwseDayAll([
    { Date: "1151104", Code: "2330", Name: "台積電", TradeVolume: "45,123,000", ClosingPrice: "2260.00", Change: "-35.0000" },
    { Date: "1151104", Code: "0050", Name: "元大台灣50", TradeVolume: "1000", ClosingPrice: "", Change: "0" },
    { Date: "1151104", Code: "03xxxP", Name: "權證", TradeVolume: "1", ClosingPrice: "1", Change: "0" },
  ]);
  assert.equal(r.date, "2026-11-04");
  assert.deepEqual(r.rows["2330"], { name: "台積電", close: 2260, change: -35, vol: 45123 });
  assert.equal(r.rows["0050"], undefined);
  assert.equal(Object.keys(r.rows).length, 1);
});

t("上櫃收盤", () => {
  const r = L.parseTpexClose([{ Date: "1151104", SecuritiesCompanyCode: "6488", CompanyName: "環球晶", Close: "512.00", Change: "+3.00", TradingShares: "1,234,000" }]);
  assert.equal(r.date, "2026-11-04");
  assert.deepEqual(r.rows["6488"], { name: "環球晶", close: 512, change: 3, vol: 1234 });
});

t("rwd 表格（新舊格式）與歷史收盤", () => {
  const neu = { stat: "OK", tables: [{ title: "價格指數", fields: ["指數", "收盤指數"], data: [["加權", "1"]] }, { title: "每日收盤行情", fields: ["證券代號", "證券名稱", "成交股數", "成交筆數", "成交金額", "開盤價", "最高價", "最低價", "收盤價"], data: [["2330", "台積電", "45,000,000", "1", "1", "2300", "2310", "2250", "2,260.00"], ["2317", "鴻海", "--", "1", "1", "1", "1", "1", "--"]] }] };
  assert.deepEqual(L.parseTwseHistDay(neu), { "2330": { close: 2260, vol: 45000 } });
  const old = { stat: "OK", fields9: ["證券代號", "證券名稱", "成交股數", "收盤價"], data9: [["2454", "聯發科", "3,000,000", "3715"]] };
  assert.deepEqual(L.parseTwseHistDay(old), { "2454": { close: 3715, vol: 3000 } });
  assert.equal(L.parseTwseHistDay({ stat: "很抱歉，沒有符合條件的資料!" }), null);
  const tp = L.parseTpexHistDay({ aaData: [["6488", "環球晶", "512.00", "+3", "509", "515", "508", "1,234,000"]] });
  assert.deepEqual(tp, { "6488": { close: 512, vol: 1234 } });
});

t("三大法人 T86", () => {
  const j = { stat: "OK", fields: ["證券代號", "證券名稱", "外陸資買進股數(不含外資自營商)", "外陸資賣出股數(不含外資自營商)", "外陸資買賣超股數(不含外資自營商)", "外資自營商買賣超股數", "投信買進股數", "投信賣出股數", "投信買賣超股數"], data: [["2330", "台積電", "1", "1", "-5,000,000", "10", "1", "1", "200,000"]] };
  assert.deepEqual(L.parseT86(j)["2330"], { f: -5000000, t: 200000 });
});

t("融資餘額（欄名重複取第一組）", () => {
  const j = { stat: "OK", tables: [{ title: "信用交易統計", fields: ["項目", "今日餘額"], data: [["融資(交易單位)", "1"]] }, { title: "融資融券彙總", fields: ["代號", "名稱", "買進", "賣出", "現金償還", "前日餘額", "今日餘額", "限額", "買進", "賣出", "現券償還", "前日餘額", "今日餘額"], data: [["2330", "台積電", "1", "1", "0", "20,000", "21,000", "0", "1", "1", "0", "500", "480"]] }] };
  assert.deepEqual(L.parseMargin(j), { "2330": 21000 });
});

t("本益比、月營收、加權指數", () => {
  assert.deepEqual(L.parsePE([{ Code: "2330", Name: "台積電", PEratio: "25.30", DividendYield: "0.85", PBratio: "7.10" }])["2330"], { pe: 25.3, yld: 0.85, pb: 7.1 });
  assert.deepEqual(L.parsePE([{ SecuritiesCompanyCode: "6488", PriceEarningRatio: "N/A", YieldRatio: "2.1", PriceBookRatio: "1.9" }])["6488"], { pe: null, yld: 2.1, pb: 1.9 });
  const rv = L.parseRevenue([{ "資料年月": "11510", "公司代號": "2330", "營業收入-上月比較增減(%)": "8.12", "營業收入-去年同月增減(%)": "35.4" }]);
  assert.equal(rv.ym, "2026-10");
  assert.deepEqual(rv.rows["2330"], [35.4, 8.12, "2026-10"]);
  const tx = L.parseTaiex([{ "日期": "1151104", "指數": "發行量加權股價指數", "收盤指數": "42,948.91", "漲跌": "-", "漲跌點數": "358.63", "漲跌百分比": "0.83" }]);
  assert.deepEqual(tx, { close: 42948.91, chg: -358.63, pct: -0.83, date: "2026-11-04" });
});

t("Yahoo 圖表", () => {
  const j = { chart: { result: [{ meta: { exchangeTimezoneName: "America/New_York" }, timestamp: [1762180200, 1762266600, 1762353000], indicators: { quote: [{ close: [10600.4, null, 10268.66] }] } }] } };
  const r = L.parseYahooChart(j);
  assert.equal(r.close, 10268.66);
  assert.equal(r.chg, -331.74);
  assert.equal(r.pct, -3.13);
});

t("RSS 與新聞分類", () => {
  const xml = `<rss><channel><item><title><![CDATA[費半重挫逾3%！台股開盤跌逾400點 - 壹蘋新聞網]]></title><link>https://example.com/a</link><pubDate>Thu, 05 Nov 2026 01:10:00 GMT</pubDate><source url="x">壹蘋新聞網</source></item>
    <item><title>超微上調展望 台廠受惠 &amp; 樂觀</title><link>https://example.com/b</link><pubDate>Thu, 05 Nov 2026 00:10:00 GMT</pubDate></item>
    <item><title>壞連結</title><link>javascript:alert(1)</link></item></channel></rss>`;
  const items = L.parseRss(xml, "Yahoo股市");
  assert.equal(items.length, 2);
  assert.equal(items[0].t, "費半重挫逾3%！台股開盤跌逾400點");
  assert.equal(items[0].src, "壹蘋新聞網");
  assert.equal(items[1].t, "超微上調展望 台廠受惠 & 樂觀");
  const m = L.mergeNews([items, [{ ...items[0], t: "費半重挫逾3%!台股開盤跌逾400點" }]], { now: Date.parse("2026-11-05T02:00:00Z") });
  assert.equal(m.length, 2);
  assert.equal(m[0].impact, -1);
  assert.ok(m[0].tags.includes("半導體"));
  assert.equal(m[1].impact, 1);
});

t("歷史資料庫：插入、補洞、裁切", () => {
  const s = L.emptyStore();
  L.upsertDay(s, "2026-11-04", "c", { "2330": 2260 });
  L.upsertDay(s, "2026-11-02", "c", { "2330": 2280, "2317": 245 });
  L.upsertDay(s, "2026-11-03", "f", { "2330": -100 });
  L.upsertDay(s, "2026-11-04", "c", { "2330": 2261 });
  assert.deepEqual(s.days, ["2026-11-02", "2026-11-03", "2026-11-04"]);
  assert.deepEqual(s.c["2330"], [2280, null, 2261]);
  assert.deepEqual(s.c["2317"], [245, null, null]);
  assert.deepEqual(s.f["2330"], [null, -100, null]);
  L.trimStore(s, 2);
  assert.deepEqual(s.days, ["2026-11-03", "2026-11-04"]);
  assert.equal(s.c["2317"], undefined);
  assert.deepEqual(L.shardOf(s, "2330").c, [null, 2261]);
  const bad = L.normalizeStore({ days: ["a", "b"], c: { x: [1] } });
  assert.deepEqual(bad.c.x, [1, null]);
  assert.deepEqual(bad.v, {});
});

t("技術指標", () => {
  const up = Array.from({ length: 70 }, (_, i) => 100 + i);
  const r = indicators(up, up.map(() => 1000));
  assert.equal(r.ma5, 167);
  assert.equal(r.ma20, 159.5);
  assert.ok(r.k > 80);
  assert.ok(r.volRatio === 1);
  const dip = [...Array.from({ length: 33 }, () => 100), 101, 103];
  assert.equal(indicators(dip).cross, "golden");
});

t("手續費、證交稅、帳務", () => {
  assert.equal(feeOf({ disc: 1, minFee: 20 }, 10000), 20);
  assert.equal(feeOf({ disc: 0.28, minFee: 1 }, 1000000), 399);
  assert.equal(taxOf("2330", 100000), 300);
  assert.equal(taxOf("0050", 100000), 100);
  const st = { trades: [
    { id: "a", acct: "m", code: "2317", side: "buy", qty: 2000, price: 232, fee: 661, tax: 0, time: "2026-10-14T09:35" },
    { id: "b", acct: "m", code: "2317", side: "sell", qty: 1000, price: 251, fee: 357, tax: 753, time: "2026-10-29T13:05" },
  ], cash: [{ id: "c", acct: "m", type: "deposit", amt: 1000000, time: "2026-10-01T09:00" }] };
  const l = ledgerOf(st, "m", () => 240);
  assert.equal(Math.round(l.cash), 1000000 - 464661 + 249890);
  assert.equal(l.holdings[0].qty, 1000);
  assert.equal(Math.round(l.holdings[0].avg * 100) / 100, 232.33);
  assert.equal(Math.round(l.realized), Math.round(249890 - 464661 / 2));
  assert.equal(l.holdings[0].mv, 240000);
});

t("兩台裝置合併：新增、修改、刪除", () => {
  const starter = () => ({ watch: [{ code: "2330", name: "台積電", ts: 0 }], accounts: [{ id: "main", name: "主帳戶", ts: 0 }], trades: [], cash: [], notes: [], tomb: {} });
  const phone = normalizeState({ ...starter(), trades: [{ id: "t1", acct: "main", code: "2330", side: "buy", qty: 1, price: 1, time: "2026-11-05T09:00", ts: 10 }], accounts: [{ id: "main", name: "手機改名", ts: 50 }] }, starter);
  const pc = normalizeState({ ...starter(), watch: [{ code: "2330", name: "台積電", ts: 0 }, { code: "2454", name: "聯發科", ts: 20 }], trades: [{ id: "t2", acct: "main", code: "2454", side: "buy", qty: 1, price: 1, time: "2026-11-05T10:00", ts: 30 }], accounts: [{ id: "main", name: "電腦改名", ts: 40 }] }, starter);
  let m = mergeState(phone, pc);
  assert.deepEqual(m.trades.map((x) => x.id).sort(), ["t1", "t2"]);
  assert.equal(m.accounts[0].name, "手機改名");
  assert.deepEqual(m.watch.map((w) => w.code), ["2330", "2454"]);
  // 電腦刪除 t1 與 2330，手機之後合併
  const pc2 = { ...m, trades: m.trades.filter((x) => x.id !== "t1"), watch: m.watch.filter((w) => w.code !== "2330"), tomb: { "t:t1": Date.now(), "w:2330": Date.now() } };
  m = mergeState(phone, pc2);
  assert.deepEqual(m.trades.map((x) => x.id), ["t2"]);
  assert.deepEqual(m.watch.map((w) => w.code), ["2454"]);
  // 刪除後重新加入（較新的 ts）會保留
  const again = { ...m, watch: [...m.watch, { code: "2330", name: "台積電", ts: Date.now() + 1000 }] };
  assert.ok(mergeState(again, pc2).watch.some((w) => w.code === "2330"));
  // 順序不同但內容相同 → canon 相同
  assert.equal(canon({ ...m, trades: [...m.trades].reverse() }), canon(m));
  assert.equal(canon(mergeState(m, m)), canon(m));
  // 壞資料會被丟掉
  const z = normalizeState({ trades: [{ id: "x" }, null, "a"], accounts: [] }, starter);
  assert.equal(z.trades.length, 0);
  assert.equal(z.accounts[0].id, "main");
});

console.log(`\n全部 ${n} 項測試通過`);
