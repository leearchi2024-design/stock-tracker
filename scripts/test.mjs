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
    { Date: "1151104", Code: "2330", Name: "台積電", TradeVolume: "45,123,000", OpeningPrice: "2,300.00", HighestPrice: "2310.00", LowestPrice: "2245.00", ClosingPrice: "2260.00", Change: "-35.0000" },
    { Date: "1151104", Code: "0050", Name: "元大台灣50", TradeVolume: "1000", ClosingPrice: "", Change: "0" },
    { Date: "1151104", Code: "03xxxP", Name: "權證", TradeVolume: "1", ClosingPrice: "1", Change: "0" },
  ]);
  assert.equal(r.date, "2026-11-04");
  assert.deepEqual(r.rows["2330"], { name: "台積電", close: 2260, open: 2300, high: 2310, low: 2245, change: -35, vol: 45123 });
  assert.equal(r.rows["0050"], undefined);
  assert.equal(Object.keys(r.rows).length, 1);
});

t("上櫃收盤（排除權證、可轉債）", () => {
  const row = (code, close) => ({ Date: "1151104", SecuritiesCompanyCode: code, CompanyName: "x", Close: close, Change: "+3.00", TradingShares: "1,234,000" });
  const r = L.parseTpexClose([{ ...row("6488", "512.00"), CompanyName: "環球晶" }, row("00679B", "28.5"), row("64881", "105"), row("703456", "1.2"), row("2881A", "60")]);
  assert.equal(r.date, "2026-11-04");
  assert.deepEqual(r.rows["6488"], { name: "環球晶", close: 512, open: null, high: null, low: null, change: 3, vol: 1234 });
  assert.deepEqual(Object.keys(r.rows).sort(), ["00679B", "2881A", "6488"]);
  for (const c of ["2330", "0050", "00878", "006208", "00679B", "2881A"]) assert.ok(L.CODE_RE.test(c), c);
  for (const c of ["64881", "703456", "03xxxP", "12"]) assert.ok(!L.CODE_RE.test(c), c);
  const s = L.normalizeStore({ days: ["2026-11-04"], c: { "2330": [1], "703456": [2] } });
  assert.deepEqual(Object.keys(s.c), ["2330"]);
});

t("rwd 表格（新舊格式）與歷史收盤", () => {
  const neu = { stat: "OK", tables: [{ title: "價格指數", fields: ["指數", "收盤指數"], data: [["加權", "1"]] }, { title: "每日收盤行情", fields: ["證券代號", "證券名稱", "成交股數", "成交筆數", "成交金額", "開盤價", "最高價", "最低價", "收盤價"], data: [["2330", "台積電", "45,000,000", "1", "1", "2300", "2310", "2250", "2,260.00"], ["2317", "鴻海", "--", "1", "1", "1", "1", "1", "--"]] }] };
  assert.deepEqual(L.parseTwseHistDay(neu), { "2330": { close: 2260, open: 2300, high: 2310, low: 2250, vol: 45000 } });
  const old = { stat: "OK", fields9: ["證券代號", "證券名稱", "成交股數", "收盤價"], data9: [["2454", "聯發科", "3,000,000", "3715"]] };
  assert.deepEqual(L.parseTwseHistDay(old), { "2454": { close: 3715, open: null, high: null, low: null, vol: 3000 } });
  assert.equal(L.parseTwseHistDay({ stat: "很抱歉，沒有符合條件的資料!" }), null);
  const tp = L.parseTpexHistDay({ aaData: [["6488", "環球晶", "512.00", "+3", "509", "515", "508", "1,234,000"]] });
  assert.deepEqual(tp, { "6488": { close: 512, open: 509, high: 515, low: 508, vol: 1234 } });
  const st = L.emptyStore();
  L.upsertQuotes(st, "2026-11-04", { "2330": { close: 2260, open: 2300, high: 2310, low: 2250, vol: 45000 } });
  assert.deepEqual([st.c["2330"][0], st.o["2330"][0], st.h["2330"][0], st.l["2330"][0], st.v["2330"][0]], [2260, 2300, 2310, 2250, 45000]);
  assert.equal(L.ohlcDays(st), 1);
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

t("資訊趨勢分類", () => {
  const a = L.classify("美光財報優於預期 南亞科、華邦電記憶體股大漲");
  assert.deepEqual(a.cats, ["earn", "mem", "tw", "us"]);
  assert.equal(a.impact, 1);
  const b = L.classify("外資賣超台股 300 億 加權指數跌破四萬兩千點");
  assert.ok(b.cats.includes("insti") && b.cats.includes("market") && b.cats.includes("tw") && !b.cats.includes("us"));
  assert.equal(b.impact, -1);
  const c = L.classify("黃仁勳：AI 需求仍強，資料中心建置不會放緩", ["us"]);
  assert.deepEqual(c.people, ["黃仁勳"]);
  assert.ok(c.cats.includes("ai") && c.cats.includes("us"));
  // 分類只看標題：從記憶體搜尋抓到、但標題無關的新聞不會被歸到記憶體
  const m = L.mergeNews([[{ t: "某公司舉辦尾牙", u: "https://a", time: "2026-11-05T01:00:00Z", hints: ["mem"] }], [{ t: "某公司舉辦尾牙", u: "https://b", time: "2026-11-05T01:00:00Z", hints: ["us"] }]], { now: Date.parse("2026-11-05T02:00:00Z") });
  assert.equal(m.length, 1);
  assert.ok(!m[0].cats.includes("mem"));
  assert.deepEqual(m[0].cats, ["tw"]);
  // 只出現在美國來源的新聞歸美國；再合併一次分類不變
  const us = L.mergeNews([[{ t: "某公司舉辦尾牙", u: "https://a", time: "2026-11-05T01:00:00Z", hints: ["us"] }]], { now: Date.parse("2026-11-05T02:00:00Z") });
  assert.deepEqual(us[0].cats, ["us"]);
  assert.deepEqual(L.mergeNews([us], { now: Date.parse("2026-11-05T02:00:00Z") })[0].cats, ["us"]);
});

t("三大法人金額、加權走勢、排行、成交量", () => {
  const j = { stat: "OK", fields: ["單位名稱", "買進金額", "賣出金額", "買賣差額"], data: [
    ["自營商(自行買賣)", "1", "1", "-1,200,000,000"], ["自營商(避險)", "1", "1", "300,000,000"], ["投信", "1", "1", "2,550,000,000"],
    ["外資及陸資(不含外資自營商)", "1", "1", "-45,612,340,000"], ["外資自營商", "1", "1", "12,000,000"], ["合計", "1", "1", "-43,950,340,000"]] };
  assert.deepEqual(L.parseBFI82U(j), { foreign: -456, trust: 25.5, dealer: -9, total: -439.5 });
  assert.equal(L.parseBFI82U({ stat: "很抱歉" }), null);
  const ys = L.parseYahooSeries({ chart: { result: [{ meta: { exchangeTimezoneName: "Asia/Taipei" }, timestamp: [Date.parse("2026-11-05T01:00:00Z") / 1000, Date.parse("2026-11-06T01:00:00Z") / 1000], indicators: { quote: [{ close: [42948.912, null] }] } }] } });
  assert.deepEqual(ys, { d: ["2026-11-05"], c: [42948.91] });
  const s = L.emptyStore();
  L.upsertDay(s, "2026-11-04", "f", { "2330": 5000000, "2317": -3000000, "2454": 1000 });
  L.upsertDay(s, "2026-11-05", "c", { "2330": 1 });
  L.upsertDay(s, "2026-11-04", "v", { "2330": 100, "6488": 50 });
  L.upsertDay(s, "2026-11-05", "v", { "2330": 80 });
  const r = L.instiRanking(s, { "2330": "台積電" }, 2);
  assert.equal(r.f.date, "2026-11-04");
  assert.deepEqual(r.f.buy, [["2330", "台積電", 5000], ["2454", "", 1]]);
  assert.deepEqual(r.f.sell, [["2317", "", -3000]]);
  assert.equal(r.t, null);
  assert.deepEqual(L.volumeTotals(s, new Set(["2330"])), { d: ["2026-11-04", "2026-11-05"], v: [100, 80] });
});

t("盤中報價（證交所基本市況報導）", () => {
  const j = { rtcode: "0000", msgArray: [
    { c: "2330", n: "台積電", z: "2,275.0000", y: "2260.0000", o: "2250.0000", h: "2280.0000", l: "2245.0000", v: "35021", t: "12:30:05", d: "20261106" },
    { c: "2317", n: "鴻海", z: "-", b: "241.5000_241.0000_", y: "240.0000", o: "239.0000", h: "242.0000", l: "238.5000", v: "40111", t: "12:30:00", d: "20261106" },
    { c: "t00", n: "發行量加權股價指數", z: "41800.12", y: "41574.00", t: "12:30:00", d: "20261106" },
    { c: "9999", z: "-", y: "-" },
    { c: "2344", n: "華邦電", z: "-", b: "0.0000_132.5000_132.0000_", a: "-", u: "132.5000", w: "108.5000", y: "120.5000", o: "125.0000", h: "132.5000", l: "124.5000", v: "88000", t: "10:40:00", d: "20261106" },
    { c: "2408", n: "南亞科", z: "-", b: "-", a: "0.0000_80.0000_", u: "97.9000", w: "80.1000", y: "89.0000", t: "10:40:00", d: "20261106" },
    { c: "2337", z: "0.0000", b: "0.0000_", a: "0.0000_", y: "30.0000" },
  ] };
  const r = L.parseMis(j);
  assert.equal(r.date, "2026-11-06");
  assert.equal(r.time, "12:30:05");
  assert.deepEqual(r.rows["2330"], { last: 2275, prev: 2260, open: 2250, high: 2280, low: 2245, vol: 35021, time: "12:30:05" });
  assert.equal(r.rows["2317"].last, 241.5);
  assert.equal(r.rows["t00"].last, 41800.12);
  assert.equal(r.rows["9999"], undefined);
  assert.equal(r.rows["2344"].last, 132.5); assert.equal(r.rows["2344"].limit, 1);
  assert.equal(r.rows["2408"].last, 80.1); assert.equal(r.rows["2408"].limit, -1);
  assert.equal(r.rows["2337"], undefined);
  assert.equal(r.rows["2330"].limit, undefined);
  assert.equal(L.isMarketHours({ wd: 5, hour: 12, minute: 30 }), true);
  assert.equal(L.isMarketHours({ wd: 5, hour: 14, minute: 0 }), false);
  assert.equal(L.isMarketHours({ wd: 6, hour: 10, minute: 0 }), false);
});

t("重大新聞評分", () => {
  assert.ok(L.importance("台積電法說會上調財測 股價大漲 5%") >= 3);
  assert.ok(L.importance("聯準會宣布降息 美股大漲") >= 3);
  assert.ok(L.importance("加權指數重挫 1,374 點") >= 3);
  assert.ok(L.importance("某公司舉辦員工旅遊") < 3);
  assert.ok(L.importance("鴻海參加展覽", 4) >= 3); // 多家媒體同時報導
  const now = Date.parse("2026-11-06T04:00:00Z");
  const a = { t: "台積電股價大漲", u: "https://a", src: "經濟日報", time: "2026-11-06T03:00:00Z" };
  const m = L.mergeNews([[a, { ...a, src: "鉅亨網", u: "https://b" }, { ...a, src: "工商時報", u: "https://c" }]], { now });
  assert.equal(m.length, 1);
  assert.equal(m[0].n, 3);
  assert.equal(m[0].major, true);
  // 上一次存的 n 會保留
  assert.equal(L.mergeNews([m], { now })[0].n, 3);
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
  const bad = L.normalizeStore({ days: ["a", "b"], c: { "2330": [1] } });
  assert.deepEqual(bad.c["2330"], [1, null]);
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
