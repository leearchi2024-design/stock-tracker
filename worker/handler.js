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
