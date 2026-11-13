// 股票追蹤器・即時報價與新聞（Cloudflare Worker）
// 這個檔案由 scripts/build-worker.mjs 自動產生，請改 worker/handler.js 或 scripts/lib.mjs 後重新產生。
// 產生時間：2026-11-13T07:40:16.316Z

// 純函式：解析證交所／櫃買中心／Yahoo／RSS 回傳的資料，以及歷史資料庫的增修。
// 不連網，方便離線測試（scripts/test.mjs）。

const FIELDS = ["c", "o", "h", "l", "v", "f", "t", "m"]; // 收盤、開盤、最高、最低、成交量(張)、外資買賣超(股)、投信買賣超(股)、融資餘額(張)
const MAX_DAYS = 130;
/** 每次更新都抓收盤價的熱門美股與 ETF（下單紀錄打這些代號會自動帶入現價） */
const US_POPULAR = ["NVDA", "AMD", "MU", "AVGO", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "TSM", "NFLX", "INTC", "QCOM", "ARM", "SMCI", "ORCL", "CRM", "ADBE", "PLTR", "ASML", "AMAT", "LRCX", "KLAC", "MRVL", "DELL", "IBM", "COST", "WMT", "JPM", "BRK.B", "V", "MA", "KO", "PEP", "DIS", "NKE", "MCD", "XOM", "CVX", "LLY", "UNH", "JNJ", "PFE", "BA", "SPY", "QQQ", "VOO", "VTI", "DIA", "IWM", "SOXX", "SMH", "TQQQ", "SOXL"];
// 股票與 ETF：4 碼（可帶一個英文字，如特別股 2881A）或 00 開頭的 ETF（0050、00878、00679B）。
// 排除權證（6 碼數字）與可轉債（5 碼數字）。
const CODE_RE = /^(?:\d{4}[A-Z]?|00\d{2,4}[A-Z]?)$/;

const stripTags = (s) => String(s ?? "").replace(/<[^>]*>/g, "").trim();

/** 字串數字 → number；"--"、"X"、空白 → null。 */
function num(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = stripTags(v).replace(/,/g, "").replace(/^\+/, "").trim();
  if (s === "" || s === "-" || s === "--" || s === "---" || s === "X" || s === "除權息" || Number.isNaN(Number(s))) return null;
  return Number(s);
}

/** 民國日期 "1151105"、"115/11/05" 或西元 "20261105"、"2026-11-05" → "2026-11-05" */
function toISODate(s) {
  const t = String(s ?? "").trim();
  let m = t.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/);
  if (m && +m[1] > 1911) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{2,3})\/?(\d{2})\/?(\d{2})$/);
  if (m) return `${+m[1] + 1911}-${m[2]}-${m[3]}`;
  return null;
}

/** 依序用多個正規式找第一個符合的欄位值。 */
function pick(obj, ...patterns) {
  if (!obj || typeof obj !== "object") return undefined;
  const keys = Object.keys(obj);
  for (const re of patterns) {
    for (const k of keys) if (re.test(k)) return obj[k];
  }
  return undefined;
}

/** 證交所 rwd 回應裡所有表格（tables / fields+data / fieldsN+dataN 三種格式）。 */
function tablesOf(j) {
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
function findTable(j, ...need) {
  return tablesOf(j).find((t) => need.every((re) => t.fields.some((f) => re.test(stripTags(f))))) || null;
}

/** 表格列 → 物件；欄名重複時保留第一個（融資、融券都有「今日餘額」）。 */
function rowsOf(t) {
  const names = t.fields.map((f) => stripTags(f));
  return t.data.map((r) => {
    const o = {};
    names.forEach((n, i) => { if (!(n in o)) o[n] = r[i]; });
    return o;
  });
}

const codeOf = (o) => String(pick(o, /^Code$/i, /SecuritiesCompanyCode/i, /證券代號/, /股票代號/, /公司代號/, /^代號$/) ?? "").trim();

/** 證交所 openapi STOCK_DAY_ALL → { date, rows: {code: {name, close, change, vol}} } */
function parseTwseDayAll(arr) {
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
      open: num(pick(o, /OpeningPrice/i, /開盤價/)),
      high: num(pick(o, /HighestPrice/i, /最高價/)),
      low: num(pick(o, /LowestPrice/i, /最低價/)),
      change: num(pick(o, /^Change$/i, /漲跌價差/)),
      vol: lots(num(pick(o, /TradeVolume/i, /成交股數/))),
    };
  }
  return { date, rows };
}

/** 櫃買 openapi tpex_mainboard_daily_close_quotes → 同上格式 */
function parseTpexClose(arr) {
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
      open: num(pick(o, /^Open$/i, /開盤/)),
      high: num(pick(o, /^High$/i, /最高/)),
      low: num(pick(o, /^Low$/i, /最低/)),
      change: num(pick(o, /^Change$/i, /漲跌/)),
      vol: lots(num(pick(o, /TradingShares/i, /TradeVolume/i, /成交股數/))),
    };
  }
  return { date, rows };
}

const lots = (shares) => (shares == null ? null : Math.round(shares / 1000));

/** 證交所 rwd MI_INDEX（某一天全部個股收盤）→ {code: {close, vol}} */
function parseTwseHistDay(j) {
  if (!j || (j.stat && !/^ok$/i.test(j.stat))) return null;
  const t = findTable(j, /證券代號/, /收盤價/);
  if (!t) return null;
  const rows = {};
  for (const o of rowsOf(t)) {
    const code = String(o["證券代號"] ?? "").trim();
    const close = num(o["收盤價"]);
    if (!CODE_RE.test(code) || close == null) continue;
    rows[code] = { close, open: num(o["開盤價"]), high: num(o["最高價"]), low: num(o["最低價"]), vol: lots(num(o["成交股數"])) };
  }
  return rows;
}

/** 櫃買歷史日收盤（新版 tables 或舊版 aaData）→ {code: {close, vol}} */
function parseTpexHistDay(j) {
  if (!j || typeof j !== "object") return null;
  const rows = {};
  if (Array.isArray(j.aaData)) {
    for (const r of j.aaData) {
      const code = String(r[0] ?? "").trim();
      const close = num(r[2]);
      if (CODE_RE.test(code) && close != null) rows[code] = { close, open: num(r[4]), high: num(r[5]), low: num(r[6]), vol: lots(num(r[7])) };
    }
    return Object.keys(rows).length ? rows : null;
  }
  const t = findTable(j, /代號/, /收盤/);
  if (!t) return null;
  for (const o of rowsOf(t)) {
    const code = String(pick(o, /代號/) ?? "").trim();
    const close = num(pick(o, /收盤/));
    if (CODE_RE.test(code) && close != null) rows[code] = { close, open: num(pick(o, /開盤/)), high: num(pick(o, /最高/)), low: num(pick(o, /最低/)), vol: lots(num(pick(o, /成交股數/))) };
  }
  return Object.keys(rows).length ? rows : null;
}

/** 證交所 rwd T86 三大法人買賣超 → {code: {f, t}}（單位：股） */
function parseT86(j) {
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
function parseTpexInsti(data) {
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
function parseMargin(j) {
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
function parsePE(arr) {
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
function parseRevenue(arr) {
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
function parseTaiex(arr) {
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
function parseYahooChart(j) {
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
function parseRss(xml, fallbackSrc = "") {
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

// 「資訊趨勢」分頁：tw 台灣、us 美國、earn 財報、market 大盤、insti 三大法人、mem 記憶體、ai AI
const US_RE = /美股|黃仁勳|蘇姿丰|馬斯克|奧特曼|道瓊|那斯達克|那指|標普|費半|費城半導體|華爾街|美國|美債|美元指數|聯準會|Fed|FOMC|鮑爾|華許|川普|白宮|國會|非農|CPI|PCE|輝達|NVIDIA|美光|Micron|AMD|超微|博通|高通|蘋果|微軟|Google|谷歌|Meta|亞馬遜|特斯拉|OpenAI|CoreWeave|ADR|期中選舉/i;
const TW_RE = /台股|台灣|臺灣|台積電|加權|櫃買|上市|上櫃|央行|新台幣|台幣|鴻海|聯發科|廣達|緯創|緯穎|台達電|南亞科|華邦電|旺宏|國巨|外資|投信|金管會|國發會|經濟部|行政院|台指期|台廠/;
const CAT_RE = {
  earn: /財報|營收|EPS|每股盈餘|獲利|法說|財測|季報|年報|毛利率|配息|股利/i,
  market: /台股|加權|大盤|上市櫃|台指期|成交量|萬點|千點|百點|收盤|開盤|盤後|盤中/,
  insti: /外資|投信|自營商|三大法人|法人|籌碼|融資|融券|借券|買超|賣超/,
  mem: /記憶體|DRAM|NAND|HBM|美光|Micron|南亞科|華邦電|旺宏|威剛|群聯|十銓|宇瞻|晶豪科|三星|海力士|SK hynix|鎧俠|Kioxia/i,
  ai: /AI|人工智慧|伺服器|輝達|NVIDIA|GPU|資料中心|數據中心|算力|黃仁勳|奧特曼|OpenAI|CoWoS|ASIC|散熱|液冷|CPO|矽光子/i,
};
const PEOPLE = [["黃仁勳", /黃仁勳|Jensen Huang/i], ["蘇姿丰", /蘇姿丰|Lisa Su/i], ["馬斯克", /馬斯克|Musk/i], ["奧特曼", /奧特曼|Altman/i], ["川普", /川普|Trump/i], ["Fed 主席", /鮑爾|華許|聯準會主席|Fed主席|Powell|Warsh/i]];

/** 依標題關鍵字判斷利多(1)／利空(-1)／中性(0)、標籤、所屬分頁與提到的人物。hint 為抓取來源的分類。 */
function classify(title, hints = []) {
  const t = String(title ?? "");
  let s = 0;
  for (const w of BULL) if (t.includes(w)) s += 1;
  for (const w of BEAR) if (t.includes(w)) s -= 1;
  const tags = TAGS.filter(([, re]) => re.test(t)).map(([n]) => n).slice(0, 3);
  // 分類只看標題內容；抓取來源只用來判斷台灣或美國（同一則新聞常被多個搜尋條件抓到）
  const cats = new Set();
  for (const [k, re] of Object.entries(CAT_RE)) if (re.test(t)) cats.add(k);
  const onlyUsFeed = hints.length > 0 && hints.every((h) => h === "us");
  const isUs = US_RE.test(t) || onlyUsFeed;
  if (isUs) cats.add("us");
  if (TW_RE.test(t) || !isUs) cats.add("tw");
  const people = PEOPLE.filter(([, re]) => re.test(t)).map(([n]) => n);
  return { impact: s > 0 ? 1 : s < 0 ? -1 : 0, tags, cats: [...cats].sort(), people };
}

// ---------- 重大新聞評分 ----------
const MAJOR_WORDS = /重大訊息|重訊|漲停|跌停|暴跌|崩跌|重挫|大跌|大漲|飆漲|狂飆|創新高|歷史新高|創新低|熔斷|停牌|暫停交易|下市|併購|收購|合併|私有化|增資|減資|庫藏股|法說|財報|EPS|每股盈餘|營收創|財測|目標價|升評|降評|調升評等|調降評等|聯準會|Fed|FOMC|升息|降息|利率決議|非農|CPI|通膨|關稅|制裁|出口管制|禁令|地震|颱風|戰爭|衝突|斷頭|違約/gi;
const MOVERS = /台積電|加權|台股|大盤|外資|費半|那斯達克|道瓊|輝達|美光|聯發科|鴻海/;

/** 新聞重要度：事件關鍵字、是否牽動大盤、幾家媒體同時報導、漲跌幅度。3 分以上算「重大」。 */
function importance(title, sources = 1) {
  const t = String(title ?? "");
  let s = Math.min(2, (t.match(MAJOR_WORDS) || []).length) * 1.5;
  if (MOVERS.test(t)) s += 1;
  if (sources >= 2) s += 1;
  if (sources >= 4) s += 1;
  if ([...t.matchAll(/(\d+(?:\.\d+)?)\s*[%％]/g)].some((m) => +m[1] >= 3)) s += 1;
  if (/[千百]點|\d{3,}\s*點/.test(t)) s += 1;
  return Math.round(s * 10) / 10;
}

/** 合併多個來源的新聞：去重（重複的合併分類來源、計算幾家報導）、排序、限定天數與筆數。項目可帶 hints（抓取來源分類）。 */
function mergeNews(lists, { now = Date.now(), days = 3, limit = 220 } = {}) {
  const byKey = new Map();
  const norm = (t) => t.replace(/[\s「」『』"'“”：:，,。！!？?（）()【】\[\]｜|\-—–]/g, "").slice(0, 40);
  for (const it of lists.flat().sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")))) {
    const k = norm(it.t || "");
    if (!k) continue;
    if (it.time && now - Date.parse(it.time) > days * 864e5) continue;
    const hints = [...(it.hints || []), ...(it.cats || []).filter((c) => c === "us")];
    const srcs = new Set([...(it.srcs || []), it.src].filter(Boolean));
    const cur = byKey.get(k);
    if (cur) {
      cur.hints = [...new Set([...cur.hints, ...hints])];
      for (const x of srcs) cur.srcs.add(x);
      cur.n = Math.max(cur.n, it.n || 1, cur.srcs.size);
      if (it.codes) cur.codes = [...new Set([...(cur.codes || []), ...it.codes])];
      continue;
    }
    byKey.set(k, { t: it.t, u: it.u, src: it.src, time: it.time, hints, srcs, n: Math.max(it.n || 1, srcs.size), codes: it.codes });
  }
  const out = [];
  for (const it of byKey.values()) {
    const score = importance(it.t, it.n);
    const o = { t: it.t, u: it.u, src: it.src, time: it.time, ...classify(it.t, it.hints), n: it.n, score, major: score >= 3 };
    if (it.codes?.length) o.codes = it.codes;
    out.push(o);
    if (out.length >= limit) break;
  }
  return out;
}

/** 證交所 rwd BFI82U 三大法人買賣金額 → {foreign, trust, dealer, total}（億元） */
function parseBFI82U(j) {
  if (!j || (j.stat && !/^ok$/i.test(j.stat))) return null;
  const t = findTable(j, /單位名稱/, /買賣差額/);
  if (!t) return null;
  const r = { foreign: 0, trust: 0, dealer: 0, total: null };
  let any = false;
  for (const o of rowsOf(t)) {
    const name = String(o["單位名稱"] ?? "").trim();
    const v = num(o["買賣差額"]);
    if (v == null) continue;
    const yi = v / 1e8;
    any = true;
    if (/合計/.test(name)) r.total = yi;
    else if (/外資/.test(name)) r.foreign += yi;
    else if (/投信/.test(name)) r.trust += yi;
    else if (/自營商/.test(name)) r.dealer += yi;
  }
  if (!any) return null;
  for (const k of Object.keys(r)) if (r[k] != null) r[k] = Math.round(r[k] * 100) / 100;
  if (r.total == null) r.total = Math.round((r.foreign + r.trust + r.dealer) * 100) / 100;
  return r;
}

/** Yahoo chart API → 每日收盤序列 {d:[日期], c:[收盤]} */
function parseYahooSeries(j) {
  const r = j?.chart?.result?.[0];
  const ts = r?.timestamp, cl = r?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(cl)) return null;
  const tz = r?.meta?.exchangeTimezoneName || "Asia/Taipei";
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const d = [], c = [];
  ts.forEach((t, i) => { if (Number.isFinite(cl[i])) { d.push(f.format(new Date(t * 1000))); c.push(Math.round(cl[i] * 100) / 100); } });
  return d.length ? { d, c } : null;
}

/** Yahoo 日 K → 美股歷史 {d, c, o, h, l, v}（和台股的個股檔同格式，APP 可以直接畫 K 線、算指標） */
function parseYahooOHLC(j) {
  const r = j?.chart?.result?.[0];
  const ts = r?.timestamp, q = r?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q || !Array.isArray(q.close)) return null;
  const tz = r?.meta?.exchangeTimezoneName || "America/New_York";
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const R = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
  const out = { d: [], c: [], o: [], h: [], l: [], v: [] };
  ts.forEach((t, i) => {
    if (!Number.isFinite(q.close[i])) return;
    const d = f.format(new Date(t * 1000));
    if (out.d[out.d.length - 1] === d) out.d.pop(), out.c.pop(), out.o.pop(), out.h.pop(), out.l.pop(), out.v.pop();
    out.d.push(d); out.c.push(R(q.close[i])); out.o.push(R(q.open?.[i])); out.h.push(R(q.high?.[i])); out.l.push(R(q.low?.[i])); out.v.push(Number.isFinite(q.volume?.[i]) ? q.volume[i] : null);
  });
  return out.d.length ? out : null;
}
/** 美股代號 → 檔名（BRK.B → BRK-B） */
const usFile = (sym) => String(sym).replace(".", "-");

/** 歷史資料庫最後一個有資料的交易日，外資、投信買賣超前 10 名（張）。 */
function instiRanking(store, names = {}, n = 10) {
  const top = {};
  for (const [key, f] of [["f", "f"], ["t", "t"]]) {
    const col = store[f];
    let idx = -1;
    for (let i = store.days.length - 1; i >= 0 && idx < 0; i--) if (Object.values(col).some((a) => Number.isFinite(a[i]))) idx = i;
    if (idx < 0) { top[key] = null; continue; }
    const rows = Object.entries(col).filter(([, a]) => Number.isFinite(a[idx]) && a[idx] !== 0).map(([code, a]) => [code, names[code] || "", Math.round(a[idx] / 1000)]);
    rows.sort((a, b) => b[2] - a[2]);
    top[key] = { date: store.days[idx], buy: rows.slice(0, n), sell: rows.slice(-n).reverse().filter((r) => r[2] < 0) };
  }
  return top;
}

/** 每天成交張數合計（只算 only 裡的代號，例如上市股票） */
function volumeTotals(store, only = null) {
  const sums = store.days.map(() => 0);
  const has = store.days.map(() => false);
  for (const [code, a] of Object.entries(store.v)) if (!only || only.has(code)) a.forEach((x, i) => { if (Number.isFinite(x)) { sums[i] += x; has[i] = true; } });
  return { d: store.days.filter((_, i) => has[i]), v: sums.filter((_, i) => has[i]) };
}

// ---------- 歷史資料庫 ----------
function emptyStore() {
  const s = { days: [] };
  for (const f of FIELDS) s[f] = {};
  return s;
}

/** 修正長度不一的陣列、補齊缺少的欄位。 */
function normalizeStore(s) {
  if (!s || !Array.isArray(s.days)) return emptyStore();
  const n = s.days.length;
  for (const f of FIELDS) {
    if (!s[f] || typeof s[f] !== "object") s[f] = {};
    for (const code of Object.keys(s[f])) {
      if (!CODE_RE.test(code)) { delete s[f][code]; continue; } // 清掉舊版存進來的權證、可轉債
      const a = Array.isArray(s[f][code]) ? s[f][code].slice(0, n) : [];
      while (a.length < n) a.push(null);
      s[f][code] = a;
    }
  }
  return s;
}

/** 寫入某一天某欄位的資料；日期不存在就依序插入。 */
function upsertDay(store, date, field, map) {
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
function trimStore(store, max = MAX_DAYS) {
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
function shardOf(store, code) {
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
function storeCodes(store) {
  const set = new Set();
  for (const f of FIELDS) for (const c of Object.keys(store[f])) set.add(c);
  return [...set];
}

/** 把一天的 {code: {close, open, high, low, vol}} 寫進歷史資料庫的各欄。 */
function upsertQuotes(store, date, rows) {
  const col = (k) => Object.fromEntries(Object.entries(rows).map(([c, v]) => [c, v[k]]));
  upsertDay(store, date, "c", col("close"));
  upsertDay(store, date, "o", col("open"));
  upsertDay(store, date, "h", col("high"));
  upsertDay(store, date, "l", col("low"));
  upsertDay(store, date, "v", col("vol"));
}

/** 有開高低價的交易日數（用台積電判斷，決定是否需要補抓）。 */
function ohlcDays(store) {
  return (store.h["2330"] || []).filter((x) => Number.isFinite(x)).length;
}

/** 證交所基本市況報導（盤中）getStockInfo.jsp → {date, time, rows:{code:{last,prev,open,high,low,vol,time}}} */
function parseMis(j) {
  const rows = {};
  let date = null, at = null;
  for (const o of Array.isArray(j?.msgArray) ? j.msgArray : []) {
    const code = String(o.c ?? "").trim();
    if (!code) continue;
    const pos = (v) => { const x = num(v); return x != null && x > 0 ? x : null; };
    const prev = pos(o.y);
    const up = pos(o.u), dn = pos(o.w);
    const bids = String(o.b ?? "").split("_").filter(Boolean).map(num), asks = String(o.a ?? "").split("_").filter(Boolean).map(num);
    // 漲停／跌停鎖住時常沒有新成交（z 為 "-"），委託簿第一檔是「市價單」顯示 0，不能當成價格
    let last = pos(o.z);
    if (last == null && bids[0] === 0 && up) last = up;
    if (last == null && asks[0] === 0 && dn) last = dn;
    if (last == null) last = bids.find((x) => x > 0) ?? asks.find((x) => x > 0) ?? pos(o.pz) ?? null;
    if (last == null || prev == null) continue;
    const limit = up && last >= up ? 1 : dn && last <= dn ? -1 : 0;
    const d = toISODate(o.d);
    if (d && (!date || d > date)) date = d;
    if (o.t && (!at || o.t > at)) at = String(o.t);
    rows[code] = { last, prev, open: pos(o.o), high: pos(o.h), low: pos(o.l), vol: num(o.v), time: String(o.t || "") };
    if (limit) rows[code].limit = limit;
  }
  return { date, time: at, rows };
}

/** 現在是否為台股盤中（含盤前 5 分鐘與收盤後 15 分鐘）。now = {wd, hour, minute} */
function isMarketHours(now) {
  if (now.wd < 1 || now.wd > 5) return false;
  const m = now.hour * 60 + (now.minute || 0);
  return m >= 8 * 60 + 55 && m <= 13 * 60 + 45;
}


// ---------- Cloudflare Worker：即時報價與新聞 ----------
// 只接受 APP 網址來的請求，只轉送證交所盤中報價與新聞 RSS，不能拿來當成任意網址的代理。
const ALLOWED_ORIGINS = ["https://leearchi2024-design.github.io"];
const UA_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; stock-tracker-live/1.0)", Accept: "*/*" };
const SYMBOL_RE = /^(tse|otc):(\d{4}[A-Z]?|00\d{2,4}[A-Z]?|t00)$/;
const NAME_RE = /^(?:[0-9A-Z]{4,6}|[A-Z]{1,5}(?:[.-][A-Z]{1,2})?):[^\s"'<>&]{1,12}$/u;

function corsHeaders(origin) {
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "86400" };
}
function reply(data, status, origin, maxAge = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store", ...(origin ? corsHeaders(origin) : {}) },
  });
}

/** 以 Cloudflare 快取包住上游請求，ttl 秒內重複的查詢直接回快取。 */
async function cachedJson(key, ttl, ctx, produce) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const req = new Request("https://cache.stock-live/" + encodeURIComponent(key));
  if (cache) {
    const hit = await cache.match(req);
    if (hit) return hit.json();
  }
  const data = await produce();
  if (cache) ctx?.waitUntil?.(cache.put(req, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` } })));
  return data;
}
async function upstream(url, type = "json") {
  const r = await fetch(url, { headers: UA_HEADERS, cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error(`上游回應 ${r.status}`);
  const text = await r.text();
  if (type !== "json") return text;
  if (/^\s*</.test(text)) throw new Error("上游回傳 HTML");
  return JSON.parse(text);
}

/** /quote?s=tse:2330,otc:6488 → 盤中報價（最多 80 檔，快取 5 秒） */
async function handleQuote(url, ctx) {
  const syms = [...new Set((url.searchParams.get("s") || "").split(",").map((x) => x.trim()).filter((x) => SYMBOL_RE.test(x)))].slice(0, 80);
  if (!syms.includes("tse:t00")) syms.unshift("tse:t00");
  const key = "q:" + [...syms].sort().join(",");
  return cachedJson(key, 5, ctx, async () => {
    const rows = {};
    let date = null, time = null;
    for (let i = 0; i < syms.length; i += 50) {
      const ex = syms.slice(i, i + 50).map((x) => { const [m, c] = x.split(":"); return `${m}_${c}.tw`; }).join("|");
      const r = parseMis(await upstream(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${ex}&json=1&delay=0&_=${Date.now()}`));
      Object.assign(rows, r.rows);
      if (r.date && (!date || r.date > date)) date = r.date;
      if (r.time && (!time || r.time > time)) time = r.time;
    }
    return { at: new Date().toISOString(), date, time, q: Object.fromEntries(Object.entries(rows).map(([c, v]) => [c, [v.last, v.prev, v.open, v.high, v.low, v.vol, v.time, v.limit || 0]])) };
  });
}

/** /us?s=NVDA,AAPL → 美股最新價（Yahoo，最多 20 檔，快取 60 秒），附美元兌新台幣匯率 */
const US_SYM_RE = /^[A-Z]{1,5}(?:[.-][A-Z]{1,2})?$/;
async function handleUS(url, ctx) {
  const syms = [...new Set((url.searchParams.get("s") || "").split(",").map((x) => x.trim().toUpperCase()).filter((x) => US_SYM_RE.test(x)))].slice(0, 20);
  const one = (sym) => cachedJson("us:" + sym, 60, ctx, async () => {
    try { return parseYahooChart(await upstream(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym.replace(".", "-"))}?range=5d&interval=1d`)); } catch { return null; }
  });
  const [fx, ...rows] = await Promise.all([one("TWD=X"), ...syms.map(one)]);
  const q = {};
  syms.forEach((s, i) => { if (rows[i]) q[s] = rows[i]; });
  return { at: new Date().toISOString(), fx: fx?.close ?? null, q };
}

/** /ushist?s=NVDA → 單一美股 6 個月日 K（不在熱門清單的美股用，快取 1 小時） */
async function handleUSHist(url, ctx) {
  const sym = (url.searchParams.get("s") || "").trim().toUpperCase();
  if (!US_SYM_RE.test(sym)) return { error: "代號格式不對" };
  return cachedJson("ush:" + sym, 3600, ctx, async () => {
    const j = await upstream(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym.replace(".", "-"))}?range=6mo&interval=1d`);
    return { sym, name: j?.chart?.result?.[0]?.meta?.shortName || null, h: parseYahooOHLC(j), q: parseYahooChart(j) };
  });
}

const gnews = (q) => "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=zh-TW&gl=TW&ceid=TW:zh-Hant";
async function feed(url, src, hints, ctx) {
  return cachedJson("f:" + url, 120, ctx, async () => {
    try { return parseRss(await upstream(url, "text"), src).map((x) => ({ ...x, hints })); } catch { return []; }
  });
}

/** /news?w=2330:台積電,2317:鴻海 → 重大新聞＋追蹤股新聞（快取 2 分鐘） */
async function handleNews(url, ctx) {
  const watch = [...new Set((url.searchParams.get("w") || "").split(",").map((x) => x.trim()).filter((x) => NAME_RE.test(x)))].slice(0, 30)
    .map((x) => { const i = x.indexOf(":"); return { code: x.slice(0, i), name: x.slice(i + 1) }; });
  const jobs = [
    feed(gnews("台股 when:1d"), "", ["tw"], ctx),
    feed(gnews("(台積電 OR 加權指數 OR 台指期) when:1d"), "", ["tw"], ctx),
    feed(gnews("(美股 OR 費半 OR 聯準會 OR 關稅) when:1d"), "", ["us"], ctx),
    feed("https://tw.stock.yahoo.com/rss?category=tw-market", "Yahoo股市", ["tw"], ctx),
  ];
  for (let i = 0; i < watch.length; i += 6) {
    const g = watch.slice(i, i + 6);
    jobs.push(feed(gnews(`(${g.map((w) => `"${w.name}"`).join(" OR ")}) when:2d`), "", ["tw"], ctx));
  }
  const lists = await Promise.all(jobs);
  const items = mergeNews(lists, { limit: 160 }).map((n) => {
    const codes = watch.filter((w) => (w.name.length >= 2 && n.t.includes(w.name)) || (/^\d/.test(w.code) ? n.t.includes(w.code) : w.code.length >= 3 && new RegExp(`(?<![A-Za-z])${w.code.replace(".", "\\.")}(?![A-Za-z])`).test(n.t))).map((w) => w.code);
    return codes.length ? { ...n, codes } : n;
  });
  return { at: new Date().toISOString(), updatedAt: new Date().toISOString(), items };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = [...ALLOWED_ORIGINS, ...String(env?.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean)];
    if (url.pathname === "/" || url.pathname === "/health") return reply({ ok: true, name: "stock-live", time: new Date().toISOString() }, 200, allowed.includes(origin) ? origin : "");
    const ok = allowed.includes(origin);
    if (request.method === "OPTIONS") return new Response(null, { status: ok ? 204 : 403, headers: ok ? corsHeaders(origin) : {} });
    if (!ok) return reply({ error: "這個網址只接受股票追蹤器 APP 的請求" }, 403, "");
    if (request.method !== "GET") return reply({ error: "只支援 GET" }, 405, origin);
    try {
      if (url.pathname === "/quote") return reply(await handleQuote(url, ctx), 200, origin);
      if (url.pathname === "/us") return reply(await handleUS(url, ctx), 200, origin);
      if (url.pathname === "/ushist") return reply(await handleUSHist(url, ctx), 200, origin);
      if (url.pathname === "/news") return reply(await handleNews(url, ctx), 200, origin);
      return reply({ error: "找不到這個功能" }, 404, origin);
    } catch (e) {
      return reply({ error: String(e?.message || e).slice(0, 200) }, 502, origin);
    }
  },
};
