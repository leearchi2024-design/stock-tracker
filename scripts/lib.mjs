// 純函式：解析證交所／櫃買中心／Yahoo／RSS 回傳的資料，以及歷史資料庫的增修。
// 不連網，方便離線測試（scripts/test.mjs）。

export const FIELDS = ["c", "v", "f", "t", "m"]; // 收盤價、成交量(張)、外資買賣超(股)、投信買賣超(股)、融資餘額(張)
export const MAX_DAYS = 130;
export const CODE_RE = /^[0-9]{4}[0-9A-Z]{0,2}$/;

const stripTags = (s) => String(s ?? "").replace(/<[^>]*>/g, "").trim();

/** 字串數字 → number；"--"、"X"、空白 → null。 */
export function num(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = stripTags(v).replace(/,/g, "").replace(/^\+/, "").trim();
  if (s === "" || s === "-" || s === "--" || s === "---" || s === "X" || s === "除權息" || Number.isNaN(Number(s))) return null;
  return Number(s);
}

/** 民國日期 "1151105"、"115/11/05" 或西元 "20261105"、"2026-11-05" → "2026-11-05" */
export function toISODate(s) {
  const t = String(s ?? "").trim();
  let m = t.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/);
  if (m && +m[1] > 1911) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{2,3})\/?(\d{2})\/?(\d{2})$/);
  if (m) return `${+m[1] + 1911}-${m[2]}-${m[3]}`;
  return null;
}

/** 依序用多個正規式找第一個符合的欄位值。 */
export function pick(obj, ...patterns) {
  if (!obj || typeof obj !== "object") return undefined;
  const keys = Object.keys(obj);
  for (const re of patterns) {
    for (const k of keys) if (re.test(k)) return obj[k];
  }
  return undefined;
}

/** 證交所 rwd 回應裡所有表格（tables / fields+data / fieldsN+dataN 三種格式）。 */
export function tablesOf(j) {
  const out = [];
  if (!j || typeof j !== "object") return out;
  if (Array.isArray(j.tables)) {
    for (const t of j.tables) if (t && Array.isArray(t.fields) && Array.isArray(t.data)) out.push({ title: t.title || "", fields: t.fields, data: t.data });
  }
  if (Array.isArray(j.fields) && Array.isArray(j.data)) out.push({ title: j.title || "", fields: j.fields, data: j.data });
  for (const k of Object.keys(j)) {
    const m = k.match(/^fields(\d+)$/);
    if (m && Array.isArray(j[k]) && Array.isArray(j["data" + m[1]])) out.push({ title: j["subtitle" + m[1]] || "", fields: j[k], data: j["data" + m[1]] });
  }
  return out;
}

/** 找出欄位名稱同時符合所有條件的表格。 */
export function findTable(j, ...need) {
  return tablesOf(j).find((t) => need.every((re) => t.fields.some((f) => re.test(stripTags(f))))) || null;
}

/** 表格列 → 物件；欄名重複時保留第一個（融資、融券都有「今日餘額」）。 */
export function rowsOf(t) {
  const names = t.fields.map((f) => stripTags(f));
  return t.data.map((r) => {
    const o = {};
    names.forEach((n, i) => { if (!(n in o)) o[n] = r[i]; });
    return o;
  });
}

const codeOf = (o) => String(pick(o, /^Code$/i, /SecuritiesCompanyCode/i, /證券代號/, /股票代號/, /公司代號/, /^代號$/) ?? "").trim();

/** 證交所 openapi STOCK_DAY_ALL → { date, rows: {code: {name, close, change, vol}} } */
export function parseTwseDayAll(arr) {
  const rows = {};
  let date = null;
  for (const o of Array.isArray(arr) ? arr : []) {
    const code = codeOf(o);
    if (!CODE_RE.test(code)) continue;
    date = date || toISODate(pick(o, /^Date$/i, /日期/));
    const close = num(pick(o, /ClosingPrice/i, /收盤價/));
    if (close == null) continue;
    rows[code] = {
      name: String(pick(o, /^Name$/i, /證券名稱/) ?? "").trim(),
      close,
      change: num(pick(o, /^Change$/i, /漲跌價差/)),
      vol: lots(num(pick(o, /TradeVolume/i, /成交股數/))),
    };
  }
  return { date, rows };
}

/** 櫃買 openapi tpex_mainboard_daily_close_quotes → 同上格式 */
export function parseTpexClose(arr) {
  const rows = {};
  let date = null;
  for (const o of Array.isArray(arr) ? arr : []) {
    const code = codeOf(o);
    if (!CODE_RE.test(code)) continue;
    date = date || toISODate(pick(o, /^Date$/i, /日期|資料日期/));
    const close = num(pick(o, /^Close$/i, /收盤/));
    if (close == null) continue;
    rows[code] = {
      name: String(pick(o, /CompanyName/i, /名稱/) ?? "").trim(),
      close,
      change: num(pick(o, /^Change$/i, /漲跌/)),
      vol: lots(num(pick(o, /TradingShares/i, /TradeVolume/i, /成交股數/))),
    };
  }
  return { date, rows };
}

const lots = (shares) => (shares == null ? null : Math.round(shares / 1000));

/** 證交所 rwd MI_INDEX（某一天全部個股收盤）→ {code: {close, vol}} */
export function parseTwseHistDay(j) {
  if (!j || (j.stat && !/^ok$/i.test(j.stat))) return null;
  const t = findTable(j, /證券代號/, /收盤價/);
  if (!t) return null;
  const rows = {};
  for (const o of rowsOf(t)) {
    const code = String(o["證券代號"] ?? "").trim();
    const close = num(o["收盤價"]);
    if (!CODE_RE.test(code) || close == null) continue;
    rows[code] = { close, vol: lots(num(o["成交股數"])) };
  }
  return rows;
}

/** 櫃買歷史日收盤（新版 tables 或舊版 aaData）→ {code: {close, vol}} */
export function parseTpexHistDay(j) {
  if (!j || typeof j !== "object") return null;
  const rows = {};
  if (Array.isArray(j.aaData)) {
    for (const r of j.aaData) {
      const code = String(r[0] ?? "").trim();
      const close = num(r[2]);
      if (CODE_RE.test(code) && close != null) rows[code] = { close, vol: lots(num(r[7])) };
    }
    return Object.keys(rows).length ? rows : null;
  }
  const t = findTable(j, /代號/, /收盤/);
  if (!t) return null;
  for (const o of rowsOf(t)) {
    const code = String(pick(o, /代號/) ?? "").trim();
    const close = num(pick(o, /收盤/));
    if (CODE_RE.test(code) && close != null) rows[code] = { close, vol: lots(num(pick(o, /成交股數/))) };
  }
  return Object.keys(rows).length ? rows : null;
}

/** 證交所 rwd T86 三大法人買賣超 → {code: {f, t}}（單位：股） */
export function parseT86(j) {
  if (!j || (j.stat && !/^ok$/i.test(j.stat))) return null;
  const t = findTable(j, /證券代號/, /投信買賣超/);
  if (!t) return null;
  const rows = {};
  for (const o of rowsOf(t)) {
    const code = String(o["證券代號"] ?? "").trim();
    if (!CODE_RE.test(code)) continue;
    rows[code] = {
      f: num(pick(o, /^外陸資買賣超股數/, /^外資.*買賣超股數/, /外.*資.*買賣超/)),
      t: num(pick(o, /^投信買賣超股數/, /投信.*買賣超/)),
    };
  }
  return rows;
}

/** 櫃買三大法人（欄名不固定，用關鍵字找）→ {code: {f, t}} */
export function parseTpexInsti(data) {
  const rows = {};
  const list = Array.isArray(data) ? data : (() => {
    const t = findTable(data, /代號/, /投信/);
    return t ? rowsOf(t) : [];
  })();
  for (const o of list) {
    const code = codeOf(o) || String(pick(o, /代號/) ?? "").trim();
    if (!CODE_RE.test(code)) continue;
    const f = num(pick(o, /外.*資.*買賣超/, /Foreign.*(Net|Difference)/i));
    const tr = num(pick(o, /投信.*買賣超/, /Investment.*Trust.*(Net|Difference)/i));
    if (f != null || tr != null) rows[code] = { f, t: tr };
  }
  return Object.keys(rows).length ? rows : null;
}

/** 證交所 rwd MI_MARGN（融資融券）→ {code: 融資今日餘額(張)} */
export function parseMargin(j) {
  if (!j || (j.stat && !/^ok$/i.test(j.stat))) return null;
  const t = findTable(j, /代號/, /今日餘額/);
  if (!t) return null;
  const rows = {};
  for (const o of rowsOf(t)) {
    const code = String(pick(o, /代號/) ?? "").trim();
    const bal = num(pick(o, /融資今日餘額/, /^今日餘額$/));
    if (CODE_RE.test(code) && bal != null) rows[code] = bal;
  }
  return Object.keys(rows).length ? rows : null;
}

/** 本益比、殖利率、淨值比（上市 BWIBBU_ALL／上櫃 peratio_analysis）→ {code: {pe, yld, pb}} */
export function parsePE(arr) {
  const rows = {};
  for (const o of Array.isArray(arr) ? arr : []) {
    const code = codeOf(o);
    if (!CODE_RE.test(code)) continue;
    rows[code] = {
      pe: num(pick(o, /^PEratio$/i, /PriceEarningRatio/i, /本益比/)),
      yld: num(pick(o, /DividendYield/i, /YieldRatio/i, /殖利率/)),
      pb: num(pick(o, /^PBratio$/i, /PriceBookRatio/i, /淨值比/)),
    };
  }
  return rows;
}

/** 月營收彙總表 → {ym:"2026-10", rows:{code:[yoy, mom]}} */
export function parseRevenue(arr) {
  const rows = {};
  let ym = null;
  for (const o of Array.isArray(arr) ? arr : []) {
    const code = codeOf(o);
    if (!CODE_RE.test(code)) continue;
    const y = String(pick(o, /資料年月/) ?? "").trim();
    const m = y.match(/^(\d{2,3})\/?(\d{1,2})$/);
    const thisYm = m ? `${+m[1] + 1911}-${String(+m[2]).padStart(2, "0")}` : null;
    if (thisYm && (!ym || thisYm > ym)) ym = thisYm;
    rows[code] = [num(pick(o, /去年同月增減/)), num(pick(o, /上月比較增減/)), thisYm];
  }
  return { ym, rows };
}

/** 證交所 openapi MI_INDEX → 加權指數 {close, chg, pct, date} */
export function parseTaiex(arr) {
  for (const o of Array.isArray(arr) ? arr : []) {
    if (!/^發行量加權股價指數$/.test(String(pick(o, /^指數$/) ?? "").trim())) continue;
    const close = num(pick(o, /收盤指數/));
    let chg = num(pick(o, /漲跌點數/));
    const sign = stripTags(pick(o, /^漲跌$/) ?? "");
    if (chg != null && sign.includes("-")) chg = -Math.abs(chg);
    let pct = num(pick(o, /漲跌百分比/));
    if (pct != null && chg != null && chg < 0) pct = -Math.abs(pct);
    if (close != null) return { close, chg, pct, date: toISODate(pick(o, /日期/)) };
  }
  return null;
}

/** Yahoo chart API → {close, chg, pct, date}（取最後兩個有效收盤） */
export function parseYahooChart(j) {
  const r = j?.chart?.result?.[0];
  const ts = r?.timestamp, cl = r?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(cl)) return null;
  const pts = ts.map((t, i) => [t, cl[i]]).filter(([, c]) => Number.isFinite(c));
  if (!pts.length) return null;
  const [t1, c1] = pts[pts.length - 1];
  const c0 = pts.length > 1 ? pts[pts.length - 2][1] : null;
  const tz = r?.meta?.exchangeTimezoneName || "America/New_York";
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t1 * 1000));
  const round = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
  return { close: round(c1, 4), chg: c0 == null ? null : round(c1 - c0, 4), pct: c0 ? round(((c1 - c0) / c0) * 100) : null, date };
}

// ---------- 新聞 ----------
const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };
const decode = (s) => String(s ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENT[m]).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).trim();
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i")); return m ? decode(m[1]) : ""; };

/** RSS 2.0 → [{t, u, src, time}] */
export function parseRss(xml, fallbackSrc = "") {
  const out = [];
  for (const m of String(xml ?? "").matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const b = m[0];
    let t = stripTags(tag(b, "title"));
    let src = stripTags(tag(b, "source")) || fallbackSrc;
    const u = tag(b, "link");
    const d = new Date(tag(b, "pubDate"));
    if (src && t.endsWith(" - " + src)) t = t.slice(0, -(src.length + 3)).trim();
    if (!t || !/^https?:\/\//i.test(u)) continue;
    out.push({ t, u, src, time: Number.isNaN(d.getTime()) ? null : d.toISOString() });
  }
  return out;
}

const BULL = ["創新高", "新高", "大漲", "勁揚", "飆", "噴", "漲停", "買超", "上調", "調升", "上修", "成長", "增長", "受惠", "樂觀", "利多", "看好", "旺", "強勁", "回升", "反彈", "優於預期", "超預期", "降息", "加碼", "擴產", "接單", "轉盈", "翻紅", "站上", "攻上"];
const BEAR = ["重挫", "大跌", "暴跌", "崩", "急殺", "跌停", "賣超", "下修", "調降", "衰退", "下滑", "減少", "利空", "疑慮", "擔憂", "憂", "恐", "示警", "拋售", "賣壓", "砍", "虧損", "轉虧", "不如預期", "升息", "制裁", "管制", "關稅", "失守", "跌破", "翻黑", "殺"];
const TAGS = [
  ["大盤", /台股|加權|大盤|上市櫃/], ["半導體", /半導體|晶圓|台積電|費半|封測|IC設計/], ["AI", /AI|人工智慧|伺服器|輝達|NVIDIA|GPU/i],
  ["記憶體", /記憶體|DRAM|NAND|南亞科|華邦電/i], ["美股", /美股|道瓊|那斯達克|標普|費城/], ["總經", /Fed|聯準會|央行|利率|降息|升息|CPI|通膨|非農|PMI|GDP|匯率|新台幣/i],
  ["政策", /關稅|管制|制裁|政策|法案|監管|選舉|川普/], ["財報", /財報|營收|EPS|獲利|法說/i], ["航運", /航運|貨櫃|長榮|陽明|萬海/], ["金融", /金控|銀行|壽險|證券/],
];

/** 依標題關鍵字判斷利多(1)／利空(-1)／中性(0)與標籤。 */
export function classify(title) {
  const t = String(title ?? "");
  let s = 0;
  for (const w of BULL) if (t.includes(w)) s += 1;
  for (const w of BEAR) if (t.includes(w)) s -= 1;
  const tags = TAGS.filter(([, re]) => re.test(t)).map(([n]) => n).slice(0, 3);
  return { impact: s > 0 ? 1 : s < 0 ? -1 : 0, tags };
}

/** 合併多個來源的新聞：去重、排序、限定天數與筆數。 */
export function mergeNews(lists, { now = Date.now(), days = 3, limit = 60 } = {}) {
  const seen = new Set();
  const out = [];
  const norm = (t) => t.replace(/[\s「」『』"'“”：:，,。！!？?（）()【】\[\]｜|-]/g, "").slice(0, 40);
  for (const it of lists.flat().sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")))) {
    const k = norm(it.t);
    if (!k || seen.has(k)) continue;
    if (it.time && now - Date.parse(it.time) > days * 864e5) continue;
    seen.add(k);
    out.push({ ...it, ...classify(it.t) });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- 歷史資料庫 ----------
export function emptyStore() {
  const s = { days: [] };
  for (const f of FIELDS) s[f] = {};
  return s;
}

/** 修正長度不一的陣列、補齊缺少的欄位。 */
export function normalizeStore(s) {
  if (!s || !Array.isArray(s.days)) return emptyStore();
  const n = s.days.length;
  for (const f of FIELDS) {
    if (!s[f] || typeof s[f] !== "object") s[f] = {};
    for (const code of Object.keys(s[f])) {
      const a = Array.isArray(s[f][code]) ? s[f][code].slice(0, n) : [];
      while (a.length < n) a.push(null);
      s[f][code] = a;
    }
  }
  return s;
}

/** 寫入某一天某欄位的資料；日期不存在就依序插入。 */
export function upsertDay(store, date, field, map) {
  if (!date || !map) return;
  let i = store.days.indexOf(date);
  if (i < 0) {
    i = store.days.findIndex((d) => d > date);
    if (i < 0) i = store.days.length;
    store.days.splice(i, 0, date);
    for (const f of FIELDS) for (const code of Object.keys(store[f])) store[f][code].splice(i, 0, null);
  }
  const col = store[field];
  for (const [code, v] of Object.entries(map)) {
    if (v == null) continue;
    if (!col[code]) col[code] = new Array(store.days.length).fill(null);
    col[code][i] = v;
  }
}

/** 只保留最近 max 天。 */
export function trimStore(store, max = MAX_DAYS) {
  const drop = store.days.length - max;
  if (drop <= 0) return;
  store.days.splice(0, drop);
  for (const f of FIELDS) {
    for (const code of Object.keys(store[f])) {
      store[f][code].splice(0, drop);
      if (store[f][code].every((x) => x == null)) delete store[f][code];
    }
  }
}

/** 單一股票的分片檔。 */
export function shardOf(store, code) {
  const o = { code, d: store.days };
  let any = false;
  for (const f of FIELDS) {
    const a = store[f][code];
    o[f] = a || null;
    if (a) any = true;
  }
  return any ? o : null;
}

/** 所有出現過的股票代號。 */
export function storeCodes(store) {
  const set = new Set();
  for (const f of FIELDS) for (const c of Object.keys(store[f])) set.add(c);
  return [...set];
}
