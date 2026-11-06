import { indicators, feeOf, taxOf, ledgerOf, normalizeState, mergeState, canon, tombKey } from "./core.js?v=dev";
import * as Sync from "./sync.js?v=dev";

/* ---------- 工具 ---------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "#");
const fmt = (n, d = 0) => (n == null || !isFinite(n) ? "—" : Number(n).toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtP = (n) => (n == null || !isFinite(n) ? "—" : (n > 0 ? "+" : "") + n.toFixed(2) + "%");
const cls = (n) => (n > 0 ? "up" : n < 0 ? "down" : "flat");
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const numOr = (v) => (v === "" || v == null || !isFinite(+v) ? null : +v);
const pad = (n) => String(n).padStart(2, "0");
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); return true; } catch { return false; } };
const CODE_RE = /^(?:\d{4}[A-Z]?|00\d{2,4}[A-Z]?)$/;
const TZ = "Asia/Taipei";

function tpeParts(date = new Date()) {
  const o = {};
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(date).forEach((x) => (o[x.type] = x.value));
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday) };
}
const localInputNow = () => { const t = tpeParts(); return `${t.y}-${pad(t.m)}-${pad(t.d)}T${pad(t.h)}:${pad(t.mi)}`; };
const todayStr = () => { const t = tpeParts(); return `${t.y}-${pad(t.m)}-${pad(t.d)}`; };
const hm = (ms) => { const t = tpeParts(new Date(ms)); return `${pad(t.h)}:${pad(t.mi)}`; };
const mdhm = (iso) => { if (!iso) return "—"; const t = tpeParts(new Date(iso)); return `${t.m}/${t.d} ${pad(t.h)}:${pad(t.mi)}`; };
const md = (iso) => (iso ? `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}` : "—");

/* ---------- 自動資料（GitHub Actions 每天產生） ---------- */
const AUTO = { market: null, news: null, quotes: null, revenue: null, status: null, intraday: null, live: null, liveNews: null, hist: {}, loadedAt: 0 };
const bust = () => Math.floor(Date.now() / 60000);
async function getJson(p) {
  const r = await fetch(`${p}?t=${bust()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
async function loadAuto() {
  const names = ["market", "news", "quotes", "revenue", "status", "intraday"];
  let got = 0;
  const res = await Promise.allSettled(names.map((n) => getJson(`data/${n}.json`).finally(() => splashProgress(++got))));
  res.forEach((r, i) => { if (r.status === "fulfilled") AUTO[names[i]] = r.value; });
  AUTO.loadedAt = Date.now();
  AUTO.hist = {};
  await loadHist(S.watch.map((w) => w.code));
  splashProgress(7);
  renderAll();
}
async function loadHist(codes) {
  await Promise.all(codes.filter((c) => CODE_RE.test(c) && !(c in AUTO.hist)).map(async (c) => {
    AUTO.hist[c] = null;
    try { AUTO.hist[c] = await getJson(`data/h/${c}.json`); } catch {}
  }));
}

/* ---------- 我的資料：本機＋Google 雲端 ---------- */
const DEFAULT_WATCH = [
  ["2330", "台積電", 2260], ["2454", "聯發科", 3715], ["2317", "鴻海", 240], ["2382", "廣達", 302.5], ["2603", "長榮", 268],
];
const newStock = (code, name, price = null, ts = Date.now()) => ({ code, name, price, livePrice: "", closes: [], f: {}, c: {}, news: 0, stop: 8, take: 20, pe: { lo: "", hi: "" }, upd: "", ts });
const starterState = () => ({
  v: 2,
  watch: DEFAULT_WATCH.map(([c, n, p]) => newStock(c, n, p, 0)),
  accounts: [{ id: "main", name: "主帳戶", disc: 1, minFee: 20, ts: 0 }],
  trades: [], cash: [], notes: [], tomb: {},
});
const LS_KEY = "st.state.v2";
let S = starterState();
try { const raw = lsGet(LS_KEY); if (raw) S = normalizeState(JSON.parse(raw), starterState); } catch {}

function saveLocal() {
  const ok = lsSet(LS_KEY, JSON.stringify(S));
  $("#saveState").textContent = ok ? "已存在這台裝置" : "這台裝置無法儲存（可能是無痕模式）";
}
/** 每次修改資料後呼叫。 */
function commit() { saveLocal(); scheduleSync(); }
const stamp = (o) => ((o.ts = Date.now()), o);
const bury = (col, item) => { S.tomb[tombKey(col, item)] = Date.now(); };

/* ---------- 同步 ---------- */
let sync = { state: "signedOut", msg: "" };
let syncing = false, syncAgain = false, syncTimer = null, forceUpload = false;
let lastSync = +lsGet("st.lastSync") || 0;
let memPass = null;
const getPass = () => memPass ?? lsGet("st.pass") ?? "";
function setPass(p, remember) {
  memPass = p || "";
  lsSet("st.pass", p && remember ? p : null);
}
function initialSyncState() {
  if (!Sync.clientId()) return "off";
  return Sync.hasToken() ? "ok" : Sync.wasSignedIn() ? "needTap" : "signedOut";
}
function setSync(state, msg = "") { sync = { state, msg }; renderSync(); }
function scheduleSync() {
  clearTimeout(syncTimer);
  if (Sync.hasToken()) syncTimer = setTimeout(syncNow, 1500);
  else if (Sync.wasSignedIn()) setSync("needTap");
}
async function syncNow() {
  if (!Sync.hasToken()) { setSync(initialSyncState()); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setSync("syncing");
  try {
    const txt = await Sync.download();
    let remote = null, remoteEnc = false;
    if (txt) {
      remoteEnc = Sync.isEncrypted(txt);
      remote = normalizeState(await Sync.open(txt, getPass()), starterState);
      if (!forceUpload && !remoteEnc && getPass()) setPass("", false); // 另一台裝置已關閉加密
    }
    const merged = remote ? mergeState(S, remote) : S;
    if (canon(merged) !== canon(S)) {
      S = merged; saveLocal();
      await loadHist(S.watch.map((w) => w.code));
      renderAll();
    }
    if (!remote || forceUpload || canon(merged) !== canon(remote)) await Sync.upload(await Sync.seal(S, getPass()));
    forceUpload = false;
    lastSync = Date.now(); lsSet("st.lastSync", String(lastSync));
    setSync("ok");
  } catch (e) {
    if (e.code === "auth_expired") setSync("needTap");
    else if (e.code === "need_pass" || e.code === "bad_pass") setSync("needPass", e.message);
    else setSync("error", e.message || "同步失敗");
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(); }
  }
}
function signIn() {
  // 必須在點擊當下直接呼叫
  Sync.signIn().then(syncNow).catch((e) => setSync(Sync.wasSignedIn() ? "needTap" : "signedOut", e.message));
}

/* ---------- 盤中報價（今天的才算數） ---------- */
// 先用即時轉送（Worker，約 10 秒一次），沒有的話用 GitHub 每 5 分鐘的盤中資料
const liveSrc = (code) => [AUTO.live, AUTO.intraday].find((it) => it && it.date === todayStr() && (code == null ? it.time : it.q?.[code])) || null;
const liveQ = (code) => liveSrc(code)?.q?.[code] || null;
const liveTime = () => { const it = liveSrc(); return it ? it.time.slice(0, 5) : null; };
const isRealtime = () => !!(AUTO.live && AUTO.live.date === todayStr() && Date.now() - Date.parse(AUTO.live.at) < 90000);

/* ---------- 新聞：GitHub 資料＋即時轉送的新聞合併 ---------- */
const normT = (t) => String(t || "").replace(/[\s「」『』"'“”：:，,。！!？?（）()【】\[\]｜|\-—–]/g, "").slice(0, 40);
let newsCache = { a: null, b: null, items: [] };
function allNews() {
  const a = AUTO.news?.items || [], b = AUTO.liveNews?.items || [];
  if (newsCache.a === a && newsCache.b === b) return newsCache.items;
  const map = new Map();
  for (const n of [...b, ...a]) {
    const k = normT(n.t);
    if (!k) continue;
    const cur = map.get(k);
    if (!cur) { map.set(k, { ...n }); continue; }
    if (n.codes) cur.codes = [...new Set([...(cur.codes || []), ...n.codes])];
    if ((n.score || 0) > (cur.score || 0)) { cur.score = n.score; cur.major = n.major; }
  }
  const items = [...map.values()].sort((x, y) => String(y.time || "").localeCompare(String(x.time || "")));
  newsCache = { a, b, items };
  return items;
}
const newsUpdatedAt = () => [AUTO.liveNews?.updatedAt, AUTO.news?.updatedAt].filter(Boolean).sort().pop() || null;
const hasNews = () => !!(AUTO.news || AUTO.liveNews);

/* ---------- 每檔股票的有效數據（自動優先，缺的才用手動） ---------- */
function eff(st) {
  const q = AUTO.quotes?.q?.[st.code];
  const h = AUTO.hist[st.code];
  const rv = AUTO.revenue?.r?.[st.code];
  const e = { src: {}, q, rv };
  const live = numOr(st.livePrice), lq = liveQ(st.code);
  if (live != null) { e.price = live; e.src.price = "manual"; }
  else if (lq) { e.price = lq[0]; e.src.price = "intraday"; }
  else if (q && q[1] != null) { e.price = q[1]; e.src.price = "auto"; }
  else { e.price = numOr(st.price); e.src.price = e.price != null ? "manual" : null; }
  if (lq) { e.prev = lq[1]; e.chg = +(e.price - lq[1]).toFixed(2); }
  else {
    e.chg = q && q[1] != null && q[2] != null ? q[2] : null;
    e.prev = e.chg != null ? +(q[1] - q[2]).toFixed(2) : numOr(st.prev);
    if (e.chg != null && e.src.price === "manual" && e.prev != null) e.chg = e.price - e.prev;
  }
  if (e.chg == null && e.price != null && e.prev != null) e.chg = e.price - e.prev;
  // 收盤價與成交量
  const hc = [], hv = [], ho = [], hh = [], hl = [], hd = [];
  const fin = (x) => (Number.isFinite(x) ? x : null);
  if (h && Array.isArray(h.c)) h.c.forEach((c, i) => { if (Number.isFinite(c)) { hc.push(c); hv.push(h.v?.[i] ?? null); ho.push(fin(h.o?.[i])); hh.push(fin(h.h?.[i])); hl.push(fin(h.l?.[i])); hd.push(h.d?.[i] || ""); } });
  const mc = st.closes || [];
  if (hc.length && hc.length >= mc.length) {
    e.closes = hc; e.vols = hv.every((x) => Number.isFinite(x)) ? hv : []; e.src.closes = "auto"; e.histFrom = h.d?.[h.c.findIndex((x) => Number.isFinite(x))];
    e.opens = ho; e.highs = hh; e.lows = hl; e.dates = hd; e.rawVols = hv;
    const it = AUTO.intraday;
    if (lq && it.date > (hd[hd.length - 1] || "")) {
      e.closes = [...hc, lq[0]]; e.opens = [...ho, lq[2]]; e.highs = [...hh, lq[3]]; e.lows = [...hl, lq[4]]; e.dates = [...hd, it.date]; e.rawVols = [...hv, lq[5]];
      e.vols = e.vols.length ? [...e.vols, lq[5]] : []; e.liveBar = true;
    }
  } else { e.closes = mc; e.vols = []; e.src.closes = mc.length ? "manual" : null; e.opens = e.highs = e.lows = null; e.dates = null; e.rawVols = null; }
  // 籌碼：最近 5 個交易日
  const last5 = (a) => { if (!Array.isArray(a)) return null; const s = a.slice(-5).filter((x) => Number.isFinite(x)); return s.length ? s.reduce((x, y) => x + y, 0) : null; };
  const pickAuto = (key, autoVal, manual) => { if (autoVal != null) { e.src[key] = "auto"; return autoVal; } const m = numOr(manual); if (m != null) e.src[key] = "manual"; return m; };
  const f5 = last5(h?.f), t5 = last5(h?.t);
  e.foreign = pickAuto("foreign", f5 == null ? null : Math.round(f5 / 1000), st.c?.foreign);
  e.trust = pickAuto("trust", t5 == null ? null : Math.round(t5 / 1000), st.c?.trust);
  let mg = null;
  if (Array.isArray(h?.m)) {
    const idx = h.m.map((x, i) => (Number.isFinite(x) ? i : -1)).filter((i) => i >= 0);
    if (idx.length >= 2) { const a = h.m[idx[Math.max(0, idx.length - 6)]], b = h.m[idx[idx.length - 1]]; if (a > 0) mg = +(((b - a) / a) * 100).toFixed(1); }
  }
  e.margin = pickAuto("margin", mg, st.c?.margin);
  e.yoy = pickAuto("yoy", rv ? rv[0] : null, st.f?.yoy);
  e.mom = pickAuto("mom", rv ? rv[1] : null, st.f?.mom);
  e.revYm = rv ? rv[2] : null;
  e.pe = pickAuto("pe", q ? q[4] : null, st.f?.pe);
  e.eps = numOr(st.f?.eps);
  return e;
}
const priceOf = (code) => { const w = S.watch.find((x) => x.code === code); if (w) return eff(w).price; const q = AUTO.quotes?.q?.[code]; return q ? q[1] : null; };

/* ---------- 四面向評分 ---------- */
function newsFor(st) {
  const now = Date.now();
  const auto = allNews().filter((n) => (n.t.includes(st.name) || n.t.includes(st.code)) && (!n.time || now - Date.parse(n.time) < 3 * 864e5));
  const mine = S.notes.filter((n) => (n.codes || []).includes(st.code));
  return [...mine.map((n) => ({ impact: +n.impact, t: n.title })), ...auto.map((n) => ({ impact: n.impact, t: n.t }))];
}
function analyze(st) {
  const e = eff(st);
  const out = { e, tech: { s: 0, r: [], ok: false }, chip: { s: 0, r: [], ok: false }, fund: { s: 0, r: [], ok: false }, news: { s: 0, r: [], ok: false } };
  const px = e.price, ind = indicators(e.closes, e.vols, e.highs, e.lows);
  out.ind = ind;
  const add = (g, v, txt) => { g.s += v; g.r.push({ v, txt }); g.ok = true; };
  const T = out.tech;
  if (ind.n < 20) T.r.push({ v: 0, txt: `收盤價資料 ${ind.n} 筆，至少需要 20 筆才能計算月線${e.src.closes === "auto" ? "（每天會自動累積）" : ""}` });
  if (px != null && ind.ma20 != null) {
    if (px > ind.ma20 && ind.ma5 > ind.ma20) add(T, 1, "股價站上月線，且 5 日線在月線之上（多頭排列）");
    else if (px < ind.ma20 && ind.ma5 < ind.ma20) add(T, -1, "股價跌破月線，且 5 日線在月線之下（空頭排列）");
    else add(T, 0, "股價在月線附近整理");
  }
  if (px != null && ind.ma60 != null) px > ind.ma60 ? add(T, 0.5, "股價在季線之上，中期趨勢偏多") : add(T, -0.5, "股價在季線之下，中期趨勢偏弱");
  if (ind.cross === "golden") add(T, 1, "近 3 日 5 日線向上穿越月線（黃金交叉）");
  if (ind.cross === "death") add(T, -1, "近 3 日 5 日線向下跌破月線（死亡交叉）");
  if (ind.k != null && ind.kp != null) {
    const up = ind.kp <= ind.dp && ind.k > ind.d, dn = ind.kp >= ind.dp && ind.k < ind.d;
    if (up && ind.k < 30) add(T, 1, `KD 低檔黃金交叉（K=${ind.k.toFixed(1)}）`);
    else if (dn && ind.k > 70) add(T, -1, `KD 高檔死亡交叉（K=${ind.k.toFixed(1)}）`);
    else if (ind.k < 20) add(T, 0.5, `KD 進入超賣區（K=${ind.k.toFixed(1)}），留意止跌訊號`);
    else if (ind.k > 80) add(T, -0.5, `KD 進入超買區（K=${ind.k.toFixed(1)}），追高風險升高`);
    else add(T, 0, `KD 中性（K=${ind.k.toFixed(1)}、D=${ind.d.toFixed(1)}）`);
  }
  if (ind.hist != null) {
    if (ind.histp <= 0 && ind.hist > 0) add(T, 1, "MACD 柱狀體由負轉正，動能轉強");
    else if (ind.histp >= 0 && ind.hist < 0) add(T, -1, "MACD 柱狀體由正轉負，動能轉弱");
    else add(T, ind.hist > 0 ? 0.3 : -0.3, ind.hist > 0 ? "MACD 柱狀體為正" : "MACD 柱狀體為負");
  }
  if (ind.volRatio != null) {
    const x = ind.volRatio.toFixed(1);
    if (ind.volRatio >= 1.5 && ind.dayChg > 0) add(T, 0.5, `價漲量增：成交量是 20 日均量的 ${x} 倍`);
    else if (ind.volRatio >= 1.5 && ind.dayChg < 0) add(T, -0.5, `價跌量增：成交量是 20 日均量的 ${x} 倍，賣壓沉重`);
    else if (ind.volRatio <= 0.6) add(T, 0, `量縮：成交量只有 20 日均量的 ${x} 倍`);
  }
  // 籌碼面
  const C = out.chip;
  if (e.foreign != null) e.foreign > 0 ? add(C, 1, `外資近 5 日買超 ${fmt(e.foreign)} 張`) : e.foreign < 0 ? add(C, -1, `外資近 5 日賣超 ${fmt(-e.foreign)} 張`) : add(C, 0, "外資近 5 日買賣持平");
  if (e.trust != null) e.trust > 0 ? add(C, 0.7, `投信近 5 日買超 ${fmt(e.trust)} 張`) : e.trust < 0 ? add(C, -0.7, `投信近 5 日賣超 ${fmt(-e.trust)} 張`) : add(C, 0, "投信近 5 日持平");
  if (e.margin != null) {
    const n = ind.n, chg5 = n >= 6 ? e.closes[n - 1] - e.closes[n - 6] : e.chg || 0;
    if (e.margin > 5 && chg5 <= 0) add(C, -0.7, `融資 5 日增加 ${e.margin}% 但股價沒漲，散戶槓桿偏高`);
    else if (e.margin < -5 && chg5 >= 0) add(C, 0.5, `融資 5 日減少 ${-e.margin}%，籌碼沉澱`);
    else add(C, 0, `融資 5 日變化 ${e.margin}%`);
  }
  if (!C.ok) C.r.push({ v: 0, txt: "還沒有三大法人或融資資料（每天約 15:00 後公布）" });
  // 基本面
  const F = out.fund;
  if (e.yoy != null) e.yoy >= 20 ? add(F, 1, `月營收年增 ${e.yoy}%，成長強勁`) : e.yoy > 0 ? add(F, 0.4, `月營收年增 ${e.yoy}%`) : add(F, -1, `月營收年減 ${Math.abs(e.yoy)}%`);
  if (e.mom != null && Math.abs(e.mom) >= 10) e.mom > 0 ? add(F, 0.3, `月營收月增 ${e.mom}%`) : add(F, -0.3, `月營收月減 ${-e.mom}%`);
  if (e.eps != null) e.eps > 0 ? add(F, 1, `EPS 年增 ${e.eps}%`) : add(F, -1, `EPS 年減 ${-e.eps}%`);
  const lo = numOr(st.pe?.lo), hi = numOr(st.pe?.hi);
  if (e.pe != null && (lo != null || hi != null)) {
    if (lo != null && e.pe <= lo) add(F, 1, `本益比 ${e.pe} 倍，低於你設定的便宜區（${lo} 倍）`);
    else if (hi != null && e.pe >= hi) add(F, -1, `本益比 ${e.pe} 倍，高於你設定的昂貴區（${hi} 倍）`);
    else add(F, 0, `本益比 ${e.pe} 倍，在合理區間`);
  } else if (e.pe != null) F.r.push({ v: 0, txt: `本益比 ${e.pe} 倍（設定便宜／昂貴區間後才會評分）` });
  if (!F.ok && !F.r.length) F.r.push({ v: 0, txt: "還沒有月營收或財報資料（月營收每月 10 日前公布）" });
  // 消息面
  const N = out.news;
  if (st.news) add(N, st.news, st.news > 0 ? "你判斷消息面偏多" : "你判斷消息面偏空");
  newsFor(st).slice(0, 4).forEach((n) => add(N, n.impact * 0.5, (n.impact > 0 ? "利多：" : n.impact < 0 ? "利空：" : "消息：") + n.t));
  if (!N.ok) N.r.push({ v: 0, txt: "近 3 天沒有相關新聞" });
  // 綜合
  const clamp = (v) => Math.max(-2, Math.min(2, v));
  const W = { tech: 0.35, chip: 0.25, fund: 0.25, news: 0.15 };
  let tot = 0, wsum = 0;
  for (const k in W) if (out[k].ok) { tot += clamp(out[k].s) * W[k]; wsum += W[k]; }
  out.score = wsum ? tot / wsum : 0;
  // 持倉風控
  const pos = ledgerOf(S, null, priceOf).holdings.find((h) => h.code === st.code) || null;
  out.pos = pos;
  if (pos && px != null) {
    const pct = ((px - pos.avg) / pos.avg) * 100;
    out.posPct = pct;
    if (pct <= -Math.abs(st.stop || 8)) out.risk = { k: "bear", t: `已跌破停損線（${fmt(pct, 1)}%），依紀律考慮停損` };
    else if (pct >= Math.abs(st.take || 20)) out.risk = { k: "bull", t: `已達停利目標（+${fmt(pct, 1)}%），考慮分批停利` };
  }
  const s = out.score;
  out.verdict = wsum < 0.3 ? { k: "", t: "資料不足", d: "等自動資料累積，或手動補上收盤價與籌碼、基本面資料" }
    : s >= 0.6 ? { k: "bull", t: "偏多・可考慮分批買進", d: "多數面向支持，建議分批進場並先設好停損" }
    : s >= 0.2 ? { k: "bull", t: "略偏多・等拉回再買", d: "訊號偏正面但不夠一致，可等回測均線再布局" }
    : s <= -0.6 ? { k: "bear", t: "偏空・考慮減碼或停利", d: "多數面向轉弱，持有者留意風險，未持有先觀望" }
    : s <= -0.2 ? { k: "bear", t: "略偏空・暫不加碼", d: "訊號偏負面，等止跌訊號出現再評估" }
    : { k: "", t: "中性・觀望", d: "多空訊號互相抵銷，等待方向明確" };
  return out;
}

/* ---------- 日程 ---------- */
function usDST(y, m, d) {
  const nth = (mm, k) => { const f = new Date(Date.UTC(y, mm - 1, 1)).getUTCDay(); return 1 + ((7 - f) % 7) + (k - 1) * 7; };
  const t = Date.UTC(y, m - 1, d), s = Date.UTC(y, 2, nth(3, 2)), e = Date.UTC(y, 10, nth(11, 1));
  return t >= s && t < e;
}
function dayline() {
  const t = tpeParts(), now = t.h * 60 + t.mi, dst = usDST(t.y, t.m, t.d), wk = t.wd > 0 && t.wd < 6;
  const L = [
    [480, 510, "開盤前", "美股收盤、費半、台積電 ADR，判斷今日開盤方向"],
    [510, 540, "08:30–09:00", "盤前委託、試撮，預估開盤價"],
    [540, 810, "09:00–13:30", "台股盤中交易，觀察價量變化"],
    [840, 870, "14:00–14:30", "盤後定價交易（以收盤價成交）"],
    [900, 960, "15:00–16:00", "三大法人買賣超、期貨未平倉公布"],
    [1260, 1350, "21:00–22:30", "融資融券、借券賣出餘額公布"],
    [dst ? 1290 : 1350, dst ? 1680 : 1740, dst ? "21:30–04:00" : "22:30–05:00", `美股交易（${dst ? "夏令" : "冬令"}），影響隔天台股`],
  ];
  return { L, now, wk, dst };
}
function phaseLabel() {
  const { now, wk, dst } = dayline();
  if (!wk) return { t: "休市・週末", live: false };
  if (now >= 540 && now < 810) return { t: "台股盤中", live: true };
  if (now >= 510 && now < 540) return { t: "盤前試撮", live: true };
  if (now >= 840 && now < 870) return { t: "盤後定價", live: true };
  if (now < 480) return { t: "盤前・美股剛收", live: false };
  if (now >= (dst ? 1290 : 1350)) return { t: "美股交易中", live: true };
  return { t: "台股已收盤", live: false };
}
function upcoming(days = 45) {
  const t = tpeParts();
  const start = Date.UTC(t.y, t.m - 1, t.d);
  const ev = [];
  const push = (ms, title, note) => { if (ms >= start && ms <= start + days * 864e5) ev.push({ ms, title, note }); };
  const bizShift = (ms) => { let d = new Date(ms); while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() + 864e5); return d.getTime(); };
  for (let k = 0; k < 3; k++) {
    const dt = new Date(Date.UTC(t.y, t.m - 1 + k, 1));
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth();
    const D = (dd) => Date.UTC(y, m, dd);
    const f = new Date(D(1)).getUTCDay();
    push(bizShift(D(1)), "台灣製造業 PMI", "50 為景氣擴張／收縮分界");
    push(D(1 + ((5 - f + 7) % 7)), "美國非農就業（台灣晚間）", "影響 Fed 利率預期");
    push(bizShift(D(10)), `${m === 0 ? 12 : m} 月營收公布期限`, "看月增率 MoM、年增率 YoY");
    push(D(12), "美國 CPI（約 10–15 日）", "通膨與降息預期");
    push(D(1 + ((3 - f + 7) % 7) + 14), `${m + 1} 月台指期結算`, "結算前後波動較大");
    push(D(20), "外銷訂單統計（約 20 日）", "未來出口與接單動能");
    push(D(27), "景氣對策信號（約 27 日）", "紅綠燈看整體景氣位置");
    const q = { 4: [15, "第一季財報期限"], 7: [14, "第二季財報期限"], 10: [14, "第三季財報期限"], 2: [31, "年度財報期限"] }[m];
    if (q) push(D(q[0]), q[1], "金融股期限不同，需另外確認");
    if ([1, 4, 7, 10].includes(m)) push(D(28), "MSCI 季度調整（約月底）", "被納入／剔除的個股有外資被動買賣");
    if ([2, 5, 8, 11].includes(m)) push(D(18), "台灣央行理監事會（約中旬）", "利率、房市與信用管制");
    if ([0, 3, 6, 9].includes(m)) push(D(16), "台積電法說會（約中旬）", "下一季營收、毛利率指引");
  }
  push(Date.UTC(2026, 11, 10), "FOMC 12 月利率決議（台灣凌晨）", "Fed 降息或維持，影響全球資金");
  return ev.sort((a, b) => a.ms - b.ms).map((e) => ({ ...e, diff: Math.round((e.ms - start) / 864e5) }));
}

/* ---------- 渲染：市場列與新聞 ---------- */
function tick(label, o, digits = 2, extra = "", key = "") {
  const attr = key ? ` data-tick="${key}" aria-haspopup="dialog" aria-label="${esc(label.replace(/<[^>]*>/g, ""))}，點開看走勢與相關新聞"` : "";
  if (!o || o.close == null) return `<button type="button" class="tick"${attr}><span>${label}</span><b>—</b><small class="flat">尚無資料</small></button>`;
  return `<button type="button" class="tick"${attr}><span>${label}・${md(o.date)}</span><b class="${cls(o.chg)}">${fmt(o.close, digits)}</b><small class="${cls(o.chg)}">${o.chg != null ? (o.chg > 0 ? "▲" : o.chg < 0 ? "▼" : "") + fmt(Math.abs(o.chg), digits) + "　" + fmtP(o.pct) : ""}</small>${extra}<i class="more" aria-hidden="true">▶</i></button>`;
}
function renderTape() {
  const m = AUTO.market;
  if (!m) { $("#tape").innerHTML = `<div class="notice full">還沒有自動資料。GitHub Actions 第一次跑完（約 10 分鐘）後，這裡會顯示加權指數、費半與台積電 ADR。</div>`; return; }
  const us = m.us || {};
  const tq = liveQ("t00");
  const taiex = tq ? { close: tq[0], chg: +(tq[0] - tq[1]).toFixed(2), pct: +(((tq[0] - tq[1]) / tq[1]) * 100).toFixed(2), date: AUTO.intraday.date, live: true } : m.taiex;
  let adr = "";
  if (us.TSM?.close && us.TWD?.close) {
    const conv = (us.TSM.close * us.TWD.close) / 5;
    const tw = AUTO.quotes?.q?.["2330"]?.[1];
    adr = `<small class="sub">折台股 ${fmt(conv, 0)} 元${tw ? `，溢價 ${fmtP(((conv - tw) / tw) * 100)}` : ""}</small>`;
  }
  $("#tape").innerHTML = tick(taiex?.live ? `加權指數・盤中 ${liveTime() || ""}` : "加權指數", taiex, 2, "", "TWII") + tick("費城半導體", us.SOX, 2, "", "SOX") + tick("那斯達克", us.IXIC, 2, "", "IXIC") + tick("標普 500", us.GSPC, 2, "", "GSPC") + tick("台積電 ADR（美元）", us.TSM, 2, adr, "TSM");
}
function newsItem(n, mine) {
  const k = n.impact > 0 ? "bull" : n.impact < 0 ? "bear" : "", lab = n.impact > 0 ? "利多" : n.impact < 0 ? "利空" : "中性";
  const tags = (n.tags || []).filter((t) => t !== "我的筆記").map((t) => esc(t)).join("・");
  const codes = mine ? (n.codes || []).map((c) => `<span class="chip info">${esc(c)} ${esc(S.watch.find((w) => w.code === c)?.name || "")}</span>`).join("")
    : relatedCodes(n).map((c) => `<span class="chip info">${esc(c)} ${esc(myCodes().get(c) || "")}</span>`).join("");
  const title = mine ? esc(n.t) : `<a href="${esc(safeUrl(n.u))}" target="_blank" rel="noopener noreferrer">${esc(n.t)}</a>`;
  return `<article>
    <div class="meta">${n.major ? `<span class="stamp major">重大</span>` : ""}<span class="stamp ${k}">${lab}</span>${tags ? `<span>${tags}</span>` : ""}${mine ? `<span>我的筆記</span>` : ""}${codes}</div>
    <h3>${title}</h3>
    <div class="meta">${mine ? `<span class="num">${esc(n.when)}</span><button class="ghost danger" data-delnote="${esc(n.id)}">刪除筆記</button>` : `${esc(n.src || "")}<span class="num">${esc(n.when)}</span>`}</div>
  </article>`;
}
function leadStory(n, section) {
  const k = n.impact > 0 ? "bull" : n.impact < 0 ? "bear" : "";
  return `<article class="lead"><div class="kicker"><span>HEADLINE</span>${n.major ? `<span class="stamp major">重大</span>` : ""}<span class="stamp ${k}">${n.impact > 0 ? "利多" : n.impact < 0 ? "利空" : "中性"}</span><span class="num sub">${mdhm(n.time)}</span></div>
    <h2><a href="${esc(safeUrl(n.u))}" target="_blank" rel="noopener noreferrer">${esc(n.t)}</a></h2><span class="byline">${esc(n.src || "")}・${esc(section)}</span></article>`;
}
/* ---------- 資訊趨勢 ---------- */
const TREND = [
  ["watch", "追蹤股新聞"], ["tw", "台灣重大新聞"], ["us", "美國重大新聞"], ["earn", "財報"], ["bull", "利多資訊"], ["bear", "利空資訊"],
  ["market", "大盤資訊"], ["insti", "三大法人走向"], ["mem", "記憶體資訊"], ["ai", "AI 資訊"],
];
let trendTab = TREND.some(([k]) => k === lsGet("st.trend")) ? lsGet("st.trend") : "tw";
const MEM_STOCKS = [["2408", "南亞科"], ["2344", "華邦電"], ["2337", "旺宏"], ["3260", "威剛"], ["8299", "群聯"], ["4967", "十銓"], ["3006", "晶豪科"]];
const AI_STOCKS = [["2330", "台積電"], ["2317", "鴻海"], ["2382", "廣達"], ["3231", "緯創"], ["6669", "緯穎"], ["2376", "技嘉"], ["3017", "奇鋐"], ["2308", "台達電"], ["2383", "台光電"], ["3661", "世芯-KY"], ["3443", "創意"]];
// 舊版新聞沒有 cats 時，用標籤推算
const LEGACY = { tw: () => true, us: (n) => (n.tags || []).includes("美股"), earn: (n) => (n.tags || []).includes("財報"), market: (n) => (n.tags || []).includes("大盤"), insti: (n) => /外資|投信|法人/.test(n.t), mem: (n) => (n.tags || []).includes("記憶體"), ai: (n) => (n.tags || []).includes("AI") };
let onlyMajor = lsGet("st.major") === "1";
/** 這則新聞跟我追蹤或持有的哪幾檔有關 */
function myCodes() {
  const m = new Map(S.watch.map((w) => [w.code, w.name]));
  for (const t of S.trades) if (!m.has(t.code)) m.set(t.code, t.name || "");
  return m;
}
function relatedCodes(n, mine = myCodes()) {
  const out = new Set((n.codes || []).filter((c) => mine.has(c)));
  for (const [c, name] of mine) if (n.t.includes(c) || (name && name.length >= 2 && n.t.includes(name))) out.add(c);
  return [...out];
}
function newsOf(cat, { all = false } = {}) {
  let items = allNews();
  if (cat === "watch") { const mine = myCodes(); items = items.filter((n) => relatedCodes(n, mine).length); }
  else if (cat === "bull") items = items.filter((n) => n.impact > 0);
  else if (cat === "bear") items = items.filter((n) => n.impact < 0);
  else items = items.filter((n) => (Array.isArray(n.cats) ? n.cats.includes(cat) : LEGACY[cat]?.(n)));
  return onlyMajor && !all ? items.filter((n) => n.major) : items;
}
function newsList(items, limit = 20, empty = "這個分類目前沒有新聞", lead = "") {
  if (!hasNews()) return `<div class="empty"><span>還沒有自動新聞，資料下載後就會出現。</span></div>`;
  if (!items.length) return `<div class="empty"><span>${esc(onlyMajor ? "目前沒有重大新聞。關掉「只看重大」可看全部。" : empty)}</span></div>`;
  const list = items.slice(0, limit);
  let head = "";
  if (lead) { const i = Math.max(0, list.findIndex((n) => n.major)); head = leadStory(list.splice(i, 1)[0], lead); }
  return head + (list.length ? `<div class="news cols2">${list.map((n) => newsItem({ ...n, when: mdhm(n.time) }, false)).join("")}</div>` : "");
}
function newsPanel(title, items, limit = 20, sub = "", lead = false) {
  return `<div class="panel"><div class="sec-head"><h2>${esc(title)}</h2><span class="label">${esc(sub || (newsUpdatedAt() ? `${items.length} 則・${mdhm(newsUpdatedAt())} 更新` : ""))}</span></div>${newsList(items, limit, undefined, lead ? title : "")}</div>`;
}
const usq = (k) => AUTO.market?.us?.[k] || null;
const TICK_KEY = { "道瓊": "DJI", "標普 500": "GSPC", "那斯達克": "IXIC", "費城半導體": "SOX", "台積電 ADR": "TSM", "VIX 恐慌指數": "VIX", "10 年期美債殖利率": "TNX", "美元指數": "DXY", "美元兌新台幣": "TWD", "WTI 原油": "WTI", "布蘭特原油": "BRENT" };
function miniTick(label, o, digits = 2, note = "", unit = "") {
  const k = TICK_KEY[label] || "";
  const attr = k ? ` data-tick="${k}" aria-haspopup="dialog" aria-label="${esc(label)}，點開看走勢與相關新聞"` : "";
  if (!o || o.close == null) return `<button type="button" class="tick"${attr}><span>${esc(label)}</span><b>—</b><small class="flat">尚無資料</small></button>`;
  return `<button type="button" class="tick"${attr}><span>${esc(label)}・${md(o.date)}</span><b class="${cls(o.chg)}">${fmt(o.close, digits)}${unit}</b><small class="${cls(o.chg)}">${o.chg != null ? (o.chg > 0 ? "▲" : o.chg < 0 ? "▼" : "") + fmt(Math.abs(o.chg), digits) + "　" + fmtP(o.pct) : ""}</small>${note ? `<em>${note}</em>` : ""}<i class="more" aria-hidden="true">▶</i></button>`;
}
/** 上漲紅、下跌綠的長條圖（0 在中間） */
function barChart(vals, labels = []) {
  const v = vals.map((x) => (Number.isFinite(x) ? x : 0));
  if (!v.length) return `<div class="empty" style="padding:12px">尚無資料</div>`;
  const W = 600, H = 84, P = 4, mx = Math.max(1e-9, ...v.map(Math.abs));
  const bw = (W - 2 * P) / v.length, mid = H / 2;
  const bars = v.map((x, i) => { const h = (Math.abs(x) / mx) * (mid - P); return `<rect x="${(P + i * bw + bw * 0.15).toFixed(1)}" y="${(x >= 0 ? mid - h : mid).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(h, 0.8).toFixed(1)}" fill="${x >= 0 ? "var(--up)" : "var(--down)"}"><title>${esc(labels[i] || "")} ${fmt(x, 1)}</title></rect>`; }).join("");
  return `<svg class="barchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="每日買賣超"><line x1="0" x2="${W}" y1="${mid}" y2="${mid}" stroke="var(--ink)" stroke-width="2" vector-effect="non-scaling-stroke"/>${bars}</svg>`;
}
/** 加權指數走勢（含月線、季線） */
function indexChart(s) {
  if (!s || s.c.length < 2) return `<div class="empty" style="padding:14px">還沒有加權指數走勢資料</div>`;
  const c = s.c, n = c.length, W = 600, H = 150, P = 8;
  const mas = (k) => c.map((_, i) => (i >= k - 1 ? c.slice(i - k + 1, i + 1).reduce((a, b) => a + b, 0) / k : null));
  const m20 = mas(20), m60 = mas(60);
  const all = [...c, ...m20.filter(Boolean), ...m60.filter(Boolean)];
  const mn = Math.min(...all), mx = Math.max(...all), rg = mx - mn || 1;
  const x = (i) => P + (i * (W - 2 * P)) / (n - 1), y = (v) => H - P - ((v - mn) / rg) * (H - 2 * P);
  const path = (arr) => arr.map((v, i) => (v == null ? "" : `${arr.slice(0, i).some((z) => z != null) ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join("");
  const col = c[n - 1] >= c[0] ? "var(--up)" : "var(--down)";
  return `<svg class="spark" style="height:150px" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="加權指數近 ${n} 日走勢">
    <path d="${path(c)} L${x(n - 1)},${H} L${x(0)},${H} Z" fill="${col}" opacity=".08"/>
    <path d="${path(m60)}" fill="none" stroke="var(--sky)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <path d="${path(m20)}" fill="none" stroke="var(--ink)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <path d="${path(c)}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <circle cx="${x(n - 1)}" cy="${y(c[n - 1])}" r="3.5" fill="${col}"/></svg>
    <div class="row sub" style="justify-content:space-between"><span>${md(s.d[0])}～${md(s.d[n - 1])}　最低 <span class="num">${fmt(Math.min(...c))}</span>　最高 <span class="num">${fmt(Math.max(...c))}</span></span><span><span style="color:var(--ink)">━</span> 月線　<span style="color:var(--sky)">━</span> 季線</span></div>`;
}
/** 族群個股表（記憶體、AI） */
function stockTable(list) {
  const rows = list.map(([code, nm]) => {
    const st = S.watch.find((w) => w.code === code) || newStock(code, AUTO.quotes?.q?.[code]?.[0] || nm, null, 0);
    const a = analyze(st), e = a.e;
    const pv = e.price != null && e.chg != null ? e.price - e.chg : null;
    const inList = S.watch.some((w) => w.code === code);
    return `<tr><td><span class="num sub">${esc(code)}</span> ${esc(st.name)}</td><td class="r num ${cls(e.chg)}">${e.price != null ? fmt(e.price, e.price < 100 ? 2 : 1) : "—"}</td><td class="r num ${cls(e.chg)}">${pv ? fmtP((e.chg / pv) * 100) : "—"}</td>
      <td class="r num ${cls(e.foreign)}">${e.foreign != null ? fmt(e.foreign) : "—"}</td><td class="r num">${e.yoy != null ? fmtP(e.yoy) : "—"}</td><td class="r num">${e.pe != null ? fmt(e.pe, 1) : "—"}</td>
      <td><span class="chip ${sigClass(a)}">${esc(sigLabel(a))}</span></td><td>${inList ? `<span class="sub">觀察中</span>` : `<button type="button" class="add" data-addwatch="${esc(code)}" data-name="${esc(st.name)}">＋觀察</button>`}</td></tr>`;
  }).join("");
  return `<div class="tbl"><table><thead><tr><th>股票</th><th class="r">收盤</th><th class="r">漲跌</th><th class="r">外資 5 日（張）</th><th class="r">營收 YoY</th><th class="r">本益比</th><th>訊號</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function usStockTable(keys) {
  const names = { NVDA: "輝達", AMD: "AMD", MU: "美光", AVGO: "博通", AAPL: "蘋果", MSFT: "微軟", TSM: "台積電 ADR" };
  return `<div class="tbl"><table><thead><tr><th>美股</th><th class="r">收盤（美元）</th><th class="r">漲跌</th><th>日期</th></tr></thead><tbody>${keys.map((k) => { const o = usq(k); return `<tr><td><span class="num sub">${k}</span> ${names[k] || k}</td><td class="r num ${cls(o?.chg)}">${o ? fmt(o.close, 2) : "—"}</td><td class="r num ${cls(o?.chg)}">${o ? fmtP(o.pct) : "—"}</td><td class="num sub">${o ? md(o.date) : ""}</td></tr>`; }).join("")}</tbody></table></div>`;
}
function peoplePanel(filterAi = false) {
  const items = allNews().filter((n) => (n.people || []).length && (!filterAi || (n.cats || []).includes("ai")));
  const P = ["黃仁勳", "蘇姿丰", "馬斯克", "奧特曼", "川普", "Fed 主席"];
  const roles = { "黃仁勳": "輝達執行長", "蘇姿丰": "AMD 執行長", "馬斯克": "特斯拉、xAI", "奧特曼": "OpenAI 執行長", "川普": "美國總統", "Fed 主席": "聯準會" };
  const body = P.map((p) => { const hit = items.filter((n) => n.people.includes(p)).slice(0, 2); return `<div class="who"><div class="av" aria-hidden="true"><span>${esc(p.slice(0, 1))}</span></div><div><b>${esc(p)}<small>${esc(roles[p])}</small></b>${hit.length ? hit.map((n) => `<div><a href="${esc(safeUrl(n.u))}" target="_blank" rel="noopener noreferrer">${esc(n.t)}</a><small>${esc(n.src || "")}・${mdhm(n.time)}</small></div>`).join("") : `<span class="sub">近 3 天沒有相關新聞</span>`}</div></div>`; }).join("");
  return `<div class="panel"><div class="sec-head"><h2>名人發言追蹤</h2><span class="sub">AI 與政策風向球</span></div><div class="people">${body}</div></div>`;
}
const instiRows = () => AUTO.market?.insti || [];
function preOpen() {
  const sox = usq("SOX"), tsm = usq("TSM"), twd = usq("TWD");
  const tw2330 = AUTO.quotes?.q?.["2330"]?.[1];
  const conv = tsm?.close && twd?.close ? (tsm.close * twd.close) / 5 : null;
  const avg = sox?.pct != null && tsm?.pct != null ? (sox.pct + tsm.pct) / 2 : sox?.pct ?? tsm?.pct ?? null;
  const dir = avg == null ? ["", "尚無美股資料"] : avg >= 1 ? ["bull", "電子股偏多開出"] : avg <= -1 ? ["bear", "電子股偏空開出"] : ["", "電子股方向不明顯"];
  const usNews = newsOf("us").slice(0, 3);
  const today = upcoming(0).filter((e) => e.diff === 0);
  const last = instiRows().at(-1);
  return `<div class="panel"><div class="sec-head"><h2>判斷台股開盤</h2><span class="sub">依 Notion「美股與台股影響相關資訊」第七節</span></div>
    <ol class="steps5">
      <li class="${dir[0]}"><div><b>費半 ${fmtP(sox?.pct)}、台積電 ADR ${fmtP(tsm?.pct)} → ${esc(dir[1])}</b>
        <p>${conv ? `ADR 折合台股約 <span class="num">${fmt(conv, 1)}</span> 元${tw2330 ? `，比台積電收盤 ${fmt(tw2330, 0)} 元${conv >= tw2330 ? "溢價" : "折價"} ${fmtP(((conv - tw2330) / tw2330) * 100)}` : ""}（1 單位 ADR = 5 股）。` : "等美股資料更新後計算 ADR 折合台股價。"}</p></div></li>
      <li><div><b>看台指期夜盤，估算開盤點數</b><p>夜盤是最直接的開盤預估，這個 APP 抓不到，請看看盤軟體或 <a href="https://www.taifex.com.tw" target="_blank" rel="noopener noreferrer">期交所</a>。</p></div></li>
      <li><div><b>查美股漲跌的原因：單一事件還是趨勢改變？</b>${usNews.length ? `<p>${usNews.map((n) => `<a href="${esc(safeUrl(n.u))}" target="_blank" rel="noopener noreferrer">${esc(n.t)}</a>`).join("<br>")}</p>` : `<p>還沒有美國新聞。</p>`}</div></li>
      <li><div><b>今天台灣、美國有沒有重要數據或財報</b><p>${today.length ? today.map((e) => esc(e.title)).join("、") : "今天沒有排定的固定數據，仍請留意個股法說會。"}</p></div></li>
      <li class="${last ? (last.foreign > 0 ? "bull" : last.foreign < 0 ? "bear" : "") : ""}"><div><b>收盤後看三大法人：外資有沒有跟著美股方向操作</b><p>${last ? `最新（${md(last.date)}）外資 ${last.foreign > 0 ? "買超" : "賣超"} <span class="num">${fmt(Math.abs(last.foreign), 1)}</span> 億、投信 ${last.trust >= 0 ? "買超" : "賣超"} <span class="num">${fmt(Math.abs(last.trust), 1)}</span> 億。` : "每天約 15:00 後公布。"}</p></div></li>
    </ol></div>`;
}
function usEconTable() {
  const { dst } = dayline();
  const tp = (h, m, nextDay = false) => { const t = (h + (dst ? 12 : 13)) * 60 + m; const hh = Math.floor(t / 60) % 24; return `${nextDay || t >= 1440 ? "隔天 " : ""}${pad(hh)}:${pad(t % 60)}`; };
  const R = [["非農就業報告", "每月第一個週五", tp(8, 30), "就業與薪資強，升息預期升高"], ["CPI 消費者物價指數", "每月中旬", tp(8, 30), "通膨高於預期，利空股市"], ["PCE 物價指數", "每月下旬", tp(8, 30), "Fed 最重視的通膨指標"], ["初領失業救濟金", "每週四", tp(8, 30), "就業市場即時溫度"], ["ISM 製造業 PMI", "每月第一個工作日", tp(10, 0), "50 以上代表擴張"], ["FOMC 利率決議", "每年 8 次（下次 12/9）", tp(14, 0), "升降息與主席談話"]];
  return `<div class="panel"><div class="sec-head"><h2>美國重要經濟數據</h2><span class="sub">台灣時間・目前為${dst ? "夏令" : "冬令"}</span></div>
    <div class="tbl"><table><thead><tr><th>數據</th><th>公布日</th><th>台灣時間</th><th>解讀重點</th></tr></thead><tbody>${R.map((r) => `<tr><td><b>${r[0]}</b></td><td>${r[1]}</td><td class="num">${r[2]}</td><td class="wrapcell">${r[3]}</td></tr>`).join("")}</tbody></table></div></div>`;
}
function breadth(mkt) {
  const q = Object.values(AUTO.quotes?.q || {}).filter((r) => r[7] === mkt && r[2] != null);
  if (!q.length) return "";
  const u = q.filter((r) => r[2] > 0).length, d = q.filter((r) => r[2] < 0).length, f = q.length - u - d;
  return `<div class="bars"><div class="lab"><span>${mkt}</span><span><b class="up">漲 ${u}</b>　<b class="down">跌 ${d}</b>　<span class="sub">平 ${f}</span></span></div>
    <div class="breadth" role="img" aria-label="${mkt}上漲 ${u} 家、下跌 ${d} 家、平盤 ${f} 家"><i class="u" style="width:${(u / q.length) * 100}%"></i><i class="f" style="width:${(f / q.length) * 100}%"></i><i class="d" style="width:${(d / q.length) * 100}%"></i></div></div>`;
}
function rankTable(title, rows, unit = "張") {
  if (!rows || !rows.length) return `<div class="box"><h3>${esc(title)}</h3><p class="sub" style="margin:0">尚無資料</p></div>`;
  return `<div class="box"><h3>${esc(title)}</h3><div class="tbl"><table><tbody>${rows.map(([c, n, v], i) => `<tr><td class="num sub">${i + 1}</td><td><span class="num sub">${esc(c)}</span> ${esc(n || AUTO.quotes?.q?.[c]?.[0] || "")}</td><td class="r num ${cls(v)}">${v > 0 ? "+" : ""}${fmt(v)} ${unit}</td></tr>`).join("")}</tbody></table></div></div>`;
}
const sumLast = (arr, k, n) => arr.slice(-n).reduce((s, x) => s + (x[k] || 0), 0);

const TREND_RENDER = {
  watch: () => {
    const mine = myCodes();
    if (!mine.size) return `<div class="panel"><div class="empty"><span>還沒有追蹤或持有的股票。到「股票追蹤」加入後，這裡會整理它們的新聞。</span></div></div>`;
    const items = newsOf("watch");
    const by = [...mine].map(([c, name]) => [c, name, items.filter((n) => relatedCodes(n, mine).includes(c)).length]);
    return `<div class="panel"><div class="sec-head"><h2>追蹤股新聞</h2><span class="sub">觀察清單與持股・${AUTO.liveNews ? "即時搜尋每 3 分鐘" : "依標題比對股名與代號"}</span></div>
      <div class="row" style="gap:6px;flex-wrap:wrap">${by.map(([c, name, k]) => `<span class="chip${k ? " info" : ""}">${esc(c)} ${esc(name)}・${k}</span>`).join("")}</div></div>`
      + newsPanel("追蹤股新聞", items, 30, "", true);
  },
  tw: () => newsPanel("台灣重大新聞", newsOf("tw"), 25, "", true),
  us: () => {
    const vix = usq("VIX");
    const vixNote = vix ? (vix.close > 30 ? "高度恐慌（> 30）" : vix.close > 20 ? "偏緊張（> 20）" : "平穩（< 20）") : "";
    return newsPanel("美國重大新聞", newsOf("us"), 13, "", true) + preOpen() + `<div class="panel"><div class="sec-head"><h2>開盤前必看清單</h2><span class="sub">美股收盤、ADR、利率、匯率、油價</span></div>
      <div class="minitick">${miniTick("道瓊", usq("DJI"))}${miniTick("標普 500", usq("GSPC"))}${miniTick("那斯達克", usq("IXIC"))}${miniTick("費城半導體", usq("SOX"))}${miniTick("台積電 ADR", usq("TSM"))}${miniTick("VIX 恐慌指數", vix, 2, vixNote)}${miniTick("10 年期美債殖利率", usq("TNX"), 3, "上升時壓抑科技股", "%")}${miniTick("美元指數", usq("DXY"))}${miniTick("美元兌新台幣", usq("TWD"), 3, "台幣升值利外資匯入")}${miniTick("WTI 原油", usq("WTI"))}${miniTick("布蘭特原油", usq("BRENT"))}</div></div>
      <div class="panel"><div class="sec-head"><h2>重要科技股</h2><span class="sub">財報與財測直接影響台灣半導體族群</span></div>${usStockTable(["NVDA", "AMD", "MU", "AVGO", "AAPL", "MSFT"])}</div>`
      + peoplePanel() + usEconTable();
  },
  earn: () => {
    const t = tpeParts(), y = t.y;
    const dl = [[`${y}-03-31`, "年度財報"], [`${y}-05-15`, "第一季財報"], [`${y}-08-14`, "第二季財報"], [`${y}-11-14`, "第三季財報"], [`${y + 1}-03-31`, "年度財報"]];
    const today = todayStr(), next = dl.find(([d]) => d >= today);
    const days = next ? Math.round((Date.parse(next[0]) - Date.parse(today)) / 864e5) : null;
    const rev10 = upcoming(40).find((e) => e.title.includes("營收公布期限"));
    const rows = S.watch.map((w) => { const e = eff(w); return `<tr><td><span class="num sub">${esc(w.code)}</span> ${esc(w.name)}</td><td class="num sub">${esc(e.revYm || "—")}</td><td class="r num ${cls(e.yoy)}">${e.yoy != null ? fmtP(e.yoy) : "—"}</td><td class="r num ${cls(e.mom)}">${e.mom != null ? fmtP(e.mom) : "—"}</td><td>${e.yoy == null ? "" : e.yoy >= 20 ? `<span class="chip bull">成長強勁</span>` : e.yoy > 0 ? `<span class="chip">成長</span>` : `<span class="chip bear">衰退</span>`}</td></tr>`; }).join("");
    return `<div class="grid2"><div class="panel"><span class="sub">下一個財報期限</span><div class="big">${next ? md(next[0]) : "—"}</div><span>${next ? `${esc(next[1])}・還有 ${days} 天` : ""}</span><p class="sub" style="margin:0">金控、銀行、證券、保險期限不同，約差兩週。</p></div>
      <div class="panel"><span class="sub">下一次月營收公布期限</span><div class="big">${rev10 ? md(new Date(rev10.ms).toISOString().slice(0, 10)) : "—"}</div><span>${rev10 ? `${esc(rev10.title)}・還有 ${rev10.diff} 天` : ""}</span><p class="sub" style="margin:0">看月增率 MoM、年增率 YoY。</p></div></div>
      <div class="panel"><div class="sec-head"><h2>觀察清單月營收</h2><span class="sub">每天自動更新，公布後就會出現</span></div>${S.watch.length ? `<div class="tbl"><table><thead><tr><th>股票</th><th>資料月份</th><th class="r">年增 YoY</th><th class="r">月增 MoM</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">觀察清單是空的</div>`}</div>`
      + newsPanel("財報與法說會新聞", newsOf("earn"), 25);
  },
  bull: () => newsPanel("利多資訊", newsOf("bull"), 30, "") + `<p class="sub" style="margin:0">利多／利空由標題關鍵字自動判斷，只是初步分類，請點進原文確認。</p>`,
  bear: () => newsPanel("利空資訊", newsOf("bear"), 30, "") + `<p class="sub" style="margin:0">利多／利空由標題關鍵字自動判斷，只是初步分類，請點進原文確認。</p>`,
  market: () => {
    const tx = AUTO.market?.taiex, s = AUTO.market?.twiiSeries;
    const c = s?.c || [], n = c.length;
    const ma = (k) => (n >= k ? c.slice(-k).reduce((a, b) => a + b, 0) / k : null);
    const m20 = ma(20), m60 = ma(60), last = tx?.close ?? c[n - 1];
    const vol = AUTO.market?.volume, vv = vol?.v || [];
    const v20 = vv.length >= 21 ? vv.slice(-21, -1).reduce((a, b) => a + b, 0) / 20 : null;
    return `<div class="panel"><div class="sec-head"><h2>加權指數</h2><span class="sub">${tx ? md(tx.date) + " 收盤" : ""}</span></div>
        <div class="row" style="gap:16px;align-items:baseline"><span class="big ${cls(tx?.chg)}">${fmt(last, 2)}</span><span class="num ${cls(tx?.chg)}">${tx?.chg != null ? (tx.chg > 0 ? "▲" : "▼") + fmt(Math.abs(tx.chg), 2) + "　" + fmtP(tx.pct) : ""}</span></div>
        ${indexChart(s)}
        <dl class="kv"><dt>月線（20 日）</dt><dd>${fmt(m20, 0)}${m20 && last ? `（距 ${fmtP(((last - m20) / m20) * 100)}）` : ""}</dd><dt>季線（60 日）</dt><dd>${fmt(m60, 0)}${m60 && last ? `（距 ${fmtP(((last - m60) / m60) * 100)}）` : ""}</dd></dl>
        <p class="sub" style="margin:0">${m20 && m60 && last ? (last > m20 && m20 > m60 ? "指數在月線、季線之上，多頭排列。" : last < m20 && m20 < m60 ? "指數在月線、季線之下，空頭排列。" : "指數在均線之間整理，方向還不明確。") : ""}台積電權重高，漲跌常直接左右大盤。</p></div>
      <div class="grid2"><div class="panel"><h3>漲跌家數</h3>${breadth("上市") || `<p class="sub">尚無資料</p>`}${breadth("上櫃")}</div>
        <div class="panel"><div class="bars"><div class="lab"><h3>上市成交量</h3><span>${vv.length ? `<b>${fmt(vv.at(-1) / 1e4, 1)}</b> 萬張${v20 ? `・20 日均 ${fmt(v20 / 1e4, 1)} 萬張（${fmtP(((vv.at(-1) - v20) / v20) * 100)}）` : ""}` : "尚無資料"}</span></div>${vv.length ? barChart(vv.slice(-30).map((x, i, a) => (v20 ? x - v20 : x)), vol.d.slice(-30)) : ""}<p class="sub" style="margin:0">長條為與 20 日均量的差距，紅色代表量增。</p></div></div></div>`
      + newsPanel("大盤新聞", newsOf("market"), 20);
  },
  insti: () => {
    const R = instiRows(), last = R.at(-1), top = AUTO.market?.instiTop || {};
    const tile = (lab, v) => `<div class="stat"><span>${lab}</span><b class="${cls(v)}">${v == null ? "—" : (v > 0 ? "+" : "") + fmt(v, 1)} 億</b></div>`;
    const series = (k, lab) => `<div class="bars"><div class="lab"><span>${lab}・近 ${Math.min(20, R.length)} 日</span><span>5 日 <b class="${cls(sumLast(R, k, 5))}">${fmt(sumLast(R, k, 5), 1)}</b> 億　20 日 <b class="${cls(sumLast(R, k, 20))}">${fmt(sumLast(R, k, 20), 1)}</b> 億</span></div>${barChart(R.slice(-20).map((x) => x[k]), R.slice(-20).map((x) => md(x.date)))}</div>`;
    return `<div class="panel"><div class="sec-head"><h2>三大法人買賣超</h2><span class="sub">${last ? `上市・${md(last.date)}・每天約 15:00 後更新` : "每天約 15:00 後公布"}</span></div>
        <div class="stats">${tile("外資", last?.foreign)}${tile("投信", last?.trust)}${tile("自營商", last?.dealer)}${tile("合計", last?.total)}</div>
        ${R.length ? series("foreign", "外資") + series("trust", "投信") + series("dealer", "自營商") : ""}
        <p class="sub" style="margin:0">紅色買超、綠色賣超。外資連續買超通常代表資金回流；投信在季底、年底常有作帳買盤。</p></div>
      <div class="panel"><div class="sec-head"><h2>個股買賣超排行</h2><span class="sub">${top.f ? md(top.f.date) : ""}・上市＋上櫃</span></div>
        <div class="grid2">${rankTable("外資買超", top.f?.buy)}${rankTable("外資賣超", top.f?.sell)}${rankTable("投信買超", top.t?.buy)}${rankTable("投信賣超", top.t?.sell)}</div></div>`
      + newsPanel("法人動向新聞", newsOf("insti"), 20);
  },
  mem: () => `<div class="panel"><div class="sec-head"><h2>記憶體族群</h2><span class="sub">DRAM、NAND、模組與控制 IC</span></div>${stockTable(MEM_STOCKS)}${usStockTable(["MU"])}</div>` + newsPanel("記憶體新聞", newsOf("mem"), 25),
  ai: () => `<div class="panel"><div class="sec-head"><h2>AI 供應鏈</h2><span class="sub">晶圓代工、伺服器、散熱、電源、PCB、ASIC</span></div>${stockTable(AI_STOCKS)}${usStockTable(["NVDA", "AMD", "AVGO", "MSFT"])}</div>`
    + peoplePanel(true) + newsPanel("AI 新聞", newsOf("ai"), 25),
};
async function ensureGroupHist() {
  const codes = trendTab === "mem" ? MEM_STOCKS.map((x) => x[0]) : trendTab === "ai" ? AI_STOCKS.map((x) => x[0]) : [];
  const missing = codes.filter((c) => !(c in AUTO.hist));
  if (!missing.length) return;
  await loadHist(missing);
  renderTrend();
}
function renderTrend() {
  { const t = tpeParts(); $("#mastDate").textContent = `${t.y} 年 ${t.m} 月 ${t.d} 日　星期${"日一二三四五六"[t.wd]}`;
    const u = newsUpdatedAt() || AUTO.status?.updatedAt; $("#mastStamp").textContent = (isRealtime() || AUTO.liveNews ? "● 即時・" : "") + (u ? `${mdhm(u)} 更新` : "尚未取得自動資料"); }
  $("#trendTabs").innerHTML = TREND.map(([k, l]) => {
    const n = k === "us" || k === "market" || k === "insti" ? "" : newsOf(k).length;
    return `<button type="button" role="tab" data-trend="${k}" aria-selected="${trendTab === k}">${esc(l)}${n ? `<span class="n">${n}</span>` : ""}</button>`;
  }).join("");
  const majors = allNews().filter((n) => n.major).length;
  $("#trendMain").innerHTML = `<div class="filterbar"><button type="button" class="toggle" data-major aria-pressed="${onlyMajor}"><i aria-hidden="true"></i>只看重大新聞</button><span class="sub">${majors ? `目前 ${majors} 則重大：多家媒體報導、或大漲大跌、法說、政策等` : "重大＝多家媒體報導、或大漲大跌、法說、政策等"}</span></div>` + TREND_RENDER[trendTab]();
  ensureGroupHist();
  const notes = S.notes.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  $("#myNotes").innerHTML = notes.length ? notes.map((n) => newsItem({ id: n.id, impact: +n.impact, when: md(n.date), t: n.title, codes: n.codes, tags: ["我的筆記"] }, true)).join("")
    : `<div class="empty">還沒有筆記。標註相關代號後，「股票追蹤」的消息面會一併計分。</div>`;
  const { L, now, wk, dst } = dayline();
  $("#usNote").textContent = wk ? (dst ? "美股夏令時間" : "美股冬令時間") : "今日休市";
  $("#todayTl").innerHTML = L.map(([a, b, t, x]) => { const st = !wk ? "" : now >= a && now < b ? "now" : now >= b ? "past" : ""; return `<li class="${st}"><span class="t">${esc(t)}</span><span>${esc(x)}</span></li>`; }).join("");
  $("#events").innerHTML = upcoming().map((e) => {
    const d = new Date(e.ms);
    return `<div class="ev ${e.diff <= 3 ? "soon" : ""}"><div class="d"><small>${d.getUTCMonth() + 1} 月</small><b>${d.getUTCDate()}</b><small>週${"日一二三四五六"[d.getUTCDay()]}</small></div>
      <div class="x">${esc(e.title)}<small>${e.diff === 0 ? "今天" : e.diff === 1 ? "明天" : e.diff + " 天後"}・${esc(e.note)}</small></div></div>`;
  }).join("");
  renderStatus();
}
const SRC_NAMES = { intraday: "盤中報價", insti_total: "三大法人買賣金額", twse_quotes: "上市收盤價", tpex_quotes: "上櫃收盤價", twse_pe: "上市本益比", tpex_pe: "上櫃本益比", twse_insti: "上市三大法人", tpex_insti: "上櫃三大法人", twse_margin: "融資餘額", taiex: "加權指數", us_market: "美股與 ADR", revenue: "月營收", news: "新聞", backfill: "歷史補抓" };
function renderStatus() {
  const st = AUTO.status;
  if (!st) { $("#srcStatus").innerHTML = `<p class="sub" style="margin:0">讀不到自動資料。若剛建立 GitHub 專案，請等 Actions 第一次跑完。</p>`; return; }
  $("#srcStatus").innerHTML = `<p class="sub" style="margin:0 0 6px">最後執行 ${mdhm(st.updatedAt)}・歷史 ${st.days} 個交易日（${md(st.firstDay)}～${md(st.lastDay)}）</p>
    <ul class="srcs">${Object.entries(st.sources || {}).map(([k, v]) => `<li><span class="${v.ok ? "k" : "x"}">${v.ok ? "✓" : "✗"}</span><span>${esc(SRC_NAMES[k] || k)}<br><small class="sub">${esc(v.msg || "")}</small></span><span class="sub num">${mdhm(v.at)}</span></li>`).join("")}</ul>`;
}


/* ---------- 行情列點開：走勢、相關新聞、TradingView ---------- */
const TICKS = {
  TWII: { name: "加權指數", tv: "TWSE:IX0001", re: /加權|台股|大盤|台指|萬點|千點/, tab: "market", note: "台積電權重高，漲跌常直接左右大盤。" },
  SOX: { name: "費城半導體指數", tv: "NASDAQ:SOX", re: /費半|費城半導體|半導體|晶片|晶圓/, note: "台股權重以半導體為主，費半大漲大跌，台股電子股通常同方向反應。" },
  IXIC: { name: "那斯達克指數", tv: "NASDAQ:IXIC", re: /那斯達克|那指|科技股|七巨頭/, note: "AI 資本支出的主要買家集中在那斯達克，巨頭擴大支出時台灣 AI 供應鏈受惠。" },
  GSPC: { name: "標普 500 指數", tv: "SP:SPX", re: /標普|S&P|美股/, note: "美國大型股整體表現。" },
  DJI: { name: "道瓊工業指數", tv: "DJ:DJI", re: /道瓊|美股/, note: "美國傳統產業與藍籌股表現。" },
  TSM: { name: "台積電 ADR", tv: "NYSE:TSM", re: /台積電|ADR/, note: "1 單位 ADR = 5 股台股；ADR 溢價或折價會影響台積電隔天開盤。" },
  VIX: { name: "VIX 恐慌指數", tv: "TVC:VIX", re: /VIX|恐慌/, note: "大於 20 偏緊張，大於 30 屬高度恐慌。" },
  TNX: { name: "10 年期美債殖利率", tv: "TVC:US10Y", re: /美債|殖利率/, note: "代表資金成本，殖利率上升通常壓抑高本益比科技股。", unit: "%" },
  DXY: { name: "美元指數", tv: "TVC:DXY", re: /美元/, note: "美元走弱時，外資較可能匯入台股。" },
  TWD: { name: "美元兌新台幣", tv: "FX_IDC:USDTWD", re: /新台幣|台幣|匯率/, note: "數字下降代表台幣升值，通常吸引外資匯入。" },
  WTI: { name: "WTI 原油", tv: "TVC:USOIL", re: /油價|原油|WTI/, note: "油價大漲推升通膨與升息壓力，不利股市。" },
  BRENT: { name: "布蘭特原油", tv: "TVC:UKOIL", re: /油價|原油|布蘭特/, note: "國際油價基準之一。" },
};
function tickData(k) {
  if (k === "TWII") {
    const tq = liveQ("t00");
    if (tq) return { close: tq[0], chg: +(tq[0] - tq[1]).toFixed(2), pct: +(((tq[0] - tq[1]) / tq[1]) * 100).toFixed(2), date: todayStr(), live: true };
    return AUTO.market?.taiex || usq("TWII");
  }
  return usq(k);
}
function openTick(k) {
  const meta = TICKS[k]; if (!meta) return;
  const o = tickData(k), sr = AUTO.market?.series?.[k] || (k === "TWII" ? AUTO.market?.twiiSeries : null);
  const news = allNews().filter((n) => meta.re.test(n.t)).slice(0, 6);
  const c = sr?.c || [], n = c.length, ma = (p) => (n >= p ? c.slice(-p).reduce((a, b) => a + b, 0) / p : null);
  const last = o?.close ?? c[n - 1], m20 = ma(20), m60 = ma(60);
  const unit = meta.unit || "";
  $("#sheetBody").innerHTML = `
    <div class="sheet-head"><h2 id="sheetTitle">${esc(meta.name)}</h2><button type="button" class="ghost" data-sheetclose aria-label="關閉">✕ 關閉</button></div>
    <div class="row" style="gap:14px;align-items:baseline"><span class="big ${cls(o?.chg)}">${o ? fmt(o.close, 2) + unit : "—"}</span>
      <span class="num ${cls(o?.chg)}">${o?.chg != null ? (o.chg > 0 ? "▲" : o.chg < 0 ? "▼" : "") + fmt(Math.abs(o.chg), 2) + "　" + fmtP(o.pct) : ""}</span>
      <span class="sub">${o ? (o.live ? `盤中 ${esc(liveTime() || "")}` : md(o.date) + " 收盤") : ""}</span></div>
    ${sr ? `<div class="chart">${indexChart(sr)}</div>
      <dl class="kv"><dt>月線（20 日）</dt><dd>${fmt(m20, 2)}${m20 && last ? `（距 ${fmtP(((last - m20) / m20) * 100)}）` : ""}</dd><dt>季線（60 日）</dt><dd>${fmt(m60, 2)}${m60 && last ? `（距 ${fmtP(((last - m60) / m60) * 100)}）` : ""}</dd></dl>`
      : `<p class="sub" style="margin:0">走勢圖會在下一次完整更新後出現。</p>`}
    <p class="notice info" style="margin:0">${esc(meta.note)}</p>
    <div class="row">
      <a class="tvlink" href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(meta.tv)}" target="_blank" rel="noopener noreferrer">在 TradingView 開啟 ↗<small>分時、技術指標</small></a>
      ${meta.tab ? `<button type="button" data-sheetgo="${meta.tab}">看大盤資訊 ▶</button>` : ""}
    </div>
    <h3>相關新聞</h3>
    ${news.length ? `<div class="news">${news.map((x) => newsItem({ ...x, when: mdhm(x.time) }, false)).join("")}</div>` : `<div class="empty"><span>近 3 天沒有相關新聞</span></div>`}`;
  const d = $("#sheet");
  if (typeof d.showModal === "function") { if (!d.open) d.showModal(); } else d.setAttribute("open", "");
  d.querySelector("[data-sheetclose]")?.focus();
}
function closeSheet() { const d = $("#sheet"); if (d.open) { if (typeof d.close === "function") d.close(); else d.removeAttribute("open"); } }

/* ---------- 渲染：股票追蹤 ---------- */
let openCode = null;
function spark(closes) {
  const c = closes.slice(-60);
  if (c.length < 2) return `<div class="empty" style="padding:14px">累積到 2 天以上收盤價後顯示走勢圖</div>`;
  const W = 600, H = 110, P = 6;
  const mn = Math.min(...c), mx = Math.max(...c), rg = mx - mn || 1;
  const x = (i) => P + (i * (W - 2 * P)) / (c.length - 1), y = (v) => H - P - ((v - mn) / rg) * (H - 2 * P);
  const line = c.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const ma = [];
  for (let i = 19; i < c.length; i++) ma.push([i, c.slice(i - 19, i + 1).reduce((s, v) => s + v, 0) / 20]);
  const maP = ma.map(([i, v], j) => `${j ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = c[c.length - 1], col = last >= c[0] ? "var(--up)" : "var(--down)";
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="近 ${c.length} 日收盤走勢">
    <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="var(--soft)" stroke-dasharray="3 4" />
    <path d="${line} L${x(c.length - 1)},${H} L${x(0)},${H} Z" fill="${col}" opacity=".1"/>
    ${maP ? `<path d="${maP}" fill="none" stroke="var(--ink)" stroke-width="2" vector-effect="non-scaling-stroke"/>` : ""}
    <path d="${line}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <circle cx="${x(c.length - 1)}" cy="${y(last)}" r="3.5" fill="${col}"/></svg>
    <div class="row sub" style="justify-content:space-between"><span>近 ${c.length} 日　最低 <span class="num">${fmt(mn, 2)}</span>　最高 <span class="num">${fmt(mx, 2)}</span></span><span><span style="color:var(--ink)">━</span> 月線 MA20</span></div>`;
}
const reasonsHtml = (g) => `<ul class="reasons">${g.r.map((r) => `<li class="${r.v > 0 ? "p" : r.v < 0 ? "n" : ""}">${esc(r.txt)}</li>`).join("")}</ul>`;
const grpScore = (g) => (!g.ok ? `<span class="chip">無資料</span>` : `<span class="chip ${g.s > 0.2 ? "bull" : g.s < -0.2 ? "bear" : ""}">${g.s > 0 ? "+" : ""}${g.s.toFixed(1)}</span>`);
const sigLabel = (a) => (a.risk ? (a.risk.k === "bear" ? "觸及停損" : "達停利") : a.verdict.t.split("・")[0]);
const sigClass = (a) => (a.risk ? "warn" : a.verdict.k);

/** 綜合分數 -2～+2 → 10 格血條（中間為 0，偏空亮綠、偏多亮紅） */
function meterHtml(score, cls = "") {
  const n = Math.max(-5, Math.min(5, Math.round(score * 2.5)));
  const cells = Array.from({ length: 10 }, (_, i) => {
    const on = n < 0 ? i >= 5 + n && i < 5 : n > 0 ? i >= 5 && i < 5 + n : false;
    const cur = n < 0 ? i === 5 + n : n > 0 ? i === 4 + n : false;
    return `<i class="${on ? (n < 0 ? "b" : "u") : ""}${cur ? " cur" : ""}"></i>`;
  }).join("");
  return `<div class="meter ${cls}" role="img" aria-label="綜合分數 ${score.toFixed(2)}（-2 偏空到 +2 偏多）">${cells}</div>`;
}
/** 單一面向分數 -2～+2 → 8 格能力值條 */
function statHtml(g) {
  if (!g.ok) return `<div class="statbar" aria-hidden="true">${"<i></i>".repeat(8)}</div>`;
  const v = Math.max(-2, Math.min(2, g.s)), k = Math.round(Math.abs(v) * 4);
  return `<div class="statbar" role="img" aria-label="分數 ${v.toFixed(1)}">${Array.from({ length: 8 }, (_, i) => `<i class="${i < k ? (v < 0 ? "b" : "u") : ""}"></i>`).join("")}</div>`;
}
function renderWatch() {
  const d = AUTO.quotes?.date;
  const lt = liveTime();
  $("#refNote").textContent = lt && isRealtime() ? `● 即時報價 ${lt}（約每 10 秒更新，證交所盤中資料約有 5 秒延遲）。收盤後 14:43 換成正式收盤價。` : lt ? `盤中報價 ${lt}（盤中約每 5 分鐘更新，不是逐筆即時）。收盤後 14:43 換成正式收盤價。` : d ? `股價為 ${md(d)} 收盤。平日 09:00–13:45 會改顯示盤中報價，約每 5 分鐘更新。` : "還沒有自動資料，目前顯示的是 11/4 收盤參考價。";
  $("#partyCount").textContent = `PARTY・${S.watch.length}`;
  const el = $("#watch");
  if (!S.watch.length) { el.innerHTML = `<div class="empty"><span>觀察清單是空的，從下方加入第一檔股票。</span></div>`; return; }
  el.innerHTML = S.watch.map((st) => {
    const a = analyze(st), e = a.e;
    const pv = e.price != null && e.chg != null ? e.price - e.chg : null;
    const pct = pv ? (e.chg / pv) * 100 : null;
    const open = openCode === st.code;
    return `<div class="stock${open ? " open" : ""}">
      <button class="head" type="button" data-toggle="${esc(st.code)}" aria-expanded="${open}">
        <div class="nm"><span>${esc(st.code)}</span><b>${esc(st.name)}</b>${a.pos ? ` <span class="chip info">持有 ${fmt(a.pos.qty)} 股</span>` : ""}</div>
        <div class="px"><b class="${cls(e.chg)}">${e.price != null ? fmt(e.price, e.price < 100 ? 2 : 1) : "—"}</b><small class="${cls(e.chg)}">${e.chg != null ? (e.chg > 0 ? "▲" : e.chg < 0 ? "▼" : "") + fmt(Math.abs(e.chg), 2) + "　" + fmtP(pct) : e.src.price === "manual" ? "參考價" : ""}</small></div>
        <div class="sig"><span class="chip ${sigClass(a)}">${esc(sigLabel(a))}</span>${meterHtml(a.score)}</div>
      </button>
      ${open ? detailHtml(st, a) : ""}
    </div>`;
  }).join("");
  $("#codeList").innerHTML = S.watch.map((w) => `<option value="${esc(w.code)}">${esc(w.name)}</option>`).join("");
}
function autoChip(e, k) { return e.src[k] === "auto" ? ` <span class="chip auto">自動</span>` : ""; }
function detailHtml(st, a) {
  const i = a.ind, e = a.e;
  const v = (n) => (n == null ? "" : esc(n));
  const ph = (val, unit = "") => (val != null ? `placeholder="自動：${esc(fmt(val, Math.abs(val) < 100 && val % 1 ? 1 : 0))}${unit}"` : "");
  const histNote = e.src.closes === "auto" ? `自動收盤價 ${e.closes.length} 天（自 ${md(e.histFrom)}）` : e.src.closes === "manual" ? `手動收盤價 ${e.closes.length} 筆` : "沒有收盤價資料";
  return `<div class="detail">
    <div class="scorebar"><div class="ends"><span>BEAR -2</span><span>SCORE ${a.score > 0 ? "+" : ""}${a.score.toFixed(2)}</span><span>BULL +2</span></div>${meterHtml(a.score)}</div>
    <div class="dialog ${a.verdict.k}"><strong>▶ ${esc(a.verdict.t)}</strong><span style="font-size:13.5px">${esc(a.verdict.d)}</span></div>
    ${a.risk ? `<div class="notice">${esc(a.risk.t)}</div>` : ""}
    ${a.pos ? `<div class="notice info">持有 ${fmt(a.pos.qty)} 股，平均成本 <span class="num">${fmt(a.pos.avg, 2)}</span>，損益 <b class="num ${cls(a.posPct)}">${fmtP(a.posPct)}</b>。停損 -${esc(st.stop)}%／停利 +${esc(st.take)}%</div>` : ""}
    ${candleHtml(st, e)}
    <div class="actions"><button type="button" class="buy" data-trade="buy" data-code="${esc(st.code)}">買入</button><button type="button" class="sell" data-trade="sell" data-code="${esc(st.code)}">賣出</button></div>
    <div class="cols">
      <div class="box"><div class="row" style="justify-content:space-between"><h3>技術面 <small class="sub">35%</small></h3>${grpScore(a.tech)}</div>${statHtml(a.tech)}${reasonsHtml(a.tech)}
        <dl class="kv"><dt>MA5／20／60</dt><dd>${fmt(i.ma5, 1)}／${fmt(i.ma20, 1)}／${fmt(i.ma60, 1)}</dd><dt>K／D</dt><dd>${fmt(i.k, 1)}／${fmt(i.d, 1)}</dd><dt>MACD 柱</dt><dd>${fmt(i.hist, 2)}</dd>${i.vol != null ? `<dt>成交量／20日均</dt><dd>${fmt(i.vol)}／${fmt(i.vol20)} 張</dd>` : ""}</dl>
        <p class="sub" style="margin:0">${esc(histNote)}</p></div>
      <div class="box"><div class="row" style="justify-content:space-between"><h3>籌碼面 <small class="sub">25%</small></h3>${grpScore(a.chip)}</div>${statHtml(a.chip)}${reasonsHtml(a.chip)}</div>
      <div class="box"><div class="row" style="justify-content:space-between"><h3>基本面 <small class="sub">25%</small></h3>${grpScore(a.fund)}</div>${statHtml(a.fund)}${reasonsHtml(a.fund)}${e.revYm ? `<p class="sub" style="margin:0">月營收資料：${esc(e.revYm)}</p>` : ""}</div>
      <div class="box"><div class="row" style="justify-content:space-between"><h3>消息面 <small class="sub">15%</small></h3>${grpScore(a.news)}</div>${statHtml(a.news)}${reasonsHtml(a.news)}</div>
    </div>
    <form class="form" data-edit="${esc(st.code)}">
      <label>盤中價（選填，蓋過收盤價）<input name="livePrice" type="number" step="0.01" min="0" value="${v(st.livePrice)}" placeholder="留空用收盤價"></label>
      <label>EPS 年增（%）<input name="eps" type="number" step="0.1" value="${v(st.f?.eps)}" placeholder="看季報填入"></label>
      <label>便宜本益比 ≤<input name="pelo" type="number" step="0.1" value="${v(st.pe?.lo)}"></label>
      <label>昂貴本益比 ≥<input name="pehi" type="number" step="0.1" value="${v(st.pe?.hi)}"></label>
      <label>我的消息面判斷<select name="news"><option value="1" ${st.news > 0 ? "selected" : ""}>偏多</option><option value="0" ${!st.news ? "selected" : ""}>中性</option><option value="-1" ${st.news < 0 ? "selected" : ""}>偏空</option></select></label>
      <label>停損（%）<input name="stop" type="number" step="0.5" min="0" value="${v(st.stop)}"></label>
      <label>停利（%）<input name="take" type="number" step="0.5" min="0" value="${v(st.take)}"></label>
      <details class="full"><summary>手動補資料（自動資料缺漏時才會使用）</summary>
        <div class="form">
          <label>外資近 5 日（張）${autoChip(e, "foreign")}<input name="foreign" type="number" step="1" value="${v(st.c?.foreign)}" ${ph(e.src.foreign === "auto" ? e.foreign : null, " 張")}></label>
          <label>投信近 5 日（張）${autoChip(e, "trust")}<input name="trust" type="number" step="1" value="${v(st.c?.trust)}" ${ph(e.src.trust === "auto" ? e.trust : null, " 張")}></label>
          <label>融資 5 日增減（%）${autoChip(e, "margin")}<input name="margin" type="number" step="0.1" value="${v(st.c?.margin)}" ${ph(e.src.margin === "auto" ? e.margin : null, "%")}></label>
          <label>月營收 YoY（%）${autoChip(e, "yoy")}<input name="yoy" type="number" step="0.1" value="${v(st.f?.yoy)}" ${ph(e.src.yoy === "auto" ? e.yoy : null, "%")}></label>
          <label>月營收 MoM（%）${autoChip(e, "mom")}<input name="mom" type="number" step="0.1" value="${v(st.f?.mom)}" ${ph(e.src.mom === "auto" ? e.mom : null, "%")}></label>
          <label>本益比（倍）${autoChip(e, "pe")}<input name="pe" type="number" step="0.1" value="${v(st.f?.pe)}" ${ph(e.src.pe === "auto" ? e.pe : null, " 倍")}></label>
          <label class="full">每日收盤價（舊→新，逗號分隔；自動資料較多時不會使用）<textarea name="closes" rows="2">${esc((st.closes || []).join(", "))}</textarea></label>
        </div>
      </details>
      <button class="primary" type="submit">儲存並重新判斷</button>
      <span data-rm="${esc(st.code)}" class="confirm"><button type="button" class="ghost danger" data-rmask>移出觀察清單</button></span>
    </form>
    <p class="sub" style="margin:0">${i.realKD ? "KD 以每日最高、最低價計算。" : "KD 暫以收盤價近似計算（開高低價資料累積後會自動改用），會比看盤軟體略鈍。"}${st.upd ? `最後修改：${esc(st.upd)}` : ""}</p>
  </div>`;
}


/* ---------- 像素 K 線 ---------- */
const chartRange = { n: (() => { const v = +lsGet("st.krange"); return [20, 60, 120].includes(v) ? v : 60; })() };
const chartSel = {}; // code → 選取的 K 棒（從右邊數第幾根）
function tvUrl(code) {
  const mkt = AUTO.quotes?.q?.[code]?.[7] === "上櫃" ? "TPEX" : "TWSE";
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(mkt + ":" + code)}`;
}
function candleHtml(st, e) {
  const tv = `<a class="tvlink" href="${esc(tvUrl(st.code))}" target="_blank" rel="noopener noreferrer">在 TradingView 開啟 ↗<small>分時、週 K、更多指標</small></a>`;
  const all = e.closes.length;
  if (all < 2) return `<div class="chart"><div class="empty" style="padding:14px"><span>累積到 2 天以上收盤價後顯示 K 線</span></div></div>${tv}`;
  const n = Math.min(chartRange.n, all), off = all - n;
  const C = e.closes.slice(off), O = e.opens?.slice(off), H = e.highs?.slice(off), Lw = e.lows?.slice(off), V = (e.rawVols || e.vols || []).slice(off), D = e.dates?.slice(off);
  const hasOHLC = O && O.some((x) => x != null);
  const hi = (i) => Math.max(C[i], H?.[i] ?? C[i], O?.[i] ?? C[i]), lo = (i) => Math.min(C[i], Lw?.[i] ?? C[i], O?.[i] ?? C[i]);
  // 均線用完整資料計算，再切出顯示範圍
  const maFull = (k) => e.closes.map((_, i) => (i >= k - 1 ? e.closes.slice(i - k + 1, i + 1).reduce((a, b) => a + b, 0) / k : null)).slice(off);
  const m5 = maFull(5), m20 = maFull(20);
  const vals = [...C.map((_, i) => hi(i)), ...C.map((_, i) => lo(i)), ...m5.filter(Boolean), ...m20.filter(Boolean)];
  let mx = Math.max(...vals), mn = Math.min(...vals); const pad = (mx - mn) * 0.06 || 1; mx += pad; mn -= pad;
  const W = 600, PH = 170, VH = 46, GAP = 8, H_ = PH + GAP + VH, P = 4;
  const bw = (W - 2 * P) / n, x = (i) => P + i * bw + bw / 2, y = (v) => P + ((mx - v) / (mx - mn)) * (PH - 2 * P);
  const body = Math.max(1, Math.floor(bw * 0.62)), r1 = (v) => Math.round(v);
  const vmax = Math.max(1, ...V.filter((v) => Number.isFinite(v)));
  let svg = "";
  for (let i = 0; i < n; i++) {
    const o = O?.[i], c = C[i], up = o != null ? c > o : i > 0 ? c >= C[i - 1] : true, flat = o != null && c === o;
    const col = flat ? "var(--ink)" : up ? "var(--up)" : "var(--down)";
    const cx = r1(x(i));
    if (hasOHLC && o != null) {
      svg += `<rect x="${cx}" y="${r1(y(hi(i)))}" width="2" height="${Math.max(1, r1(y(lo(i))) - r1(y(hi(i))))}" fill="var(--ink)"/>`;
      const t = r1(y(Math.max(o, c))), b = r1(y(Math.min(o, c)));
      svg += `<rect x="${cx + 1 - Math.floor(body / 2)}" y="${t}" width="${body}" height="${Math.max(2, b - t)}" fill="${col}" stroke="var(--ink)" stroke-width="1"/>`;
    } else {
      svg += `<rect x="${cx + 1 - Math.floor(body / 2)}" y="${r1(y(c)) - 1}" width="${body}" height="3" fill="${col}"/>`;
    }
    if (Number.isFinite(V[i])) { const vh = Math.max(1, (V[i] / vmax) * VH); svg += `<rect x="${cx + 1 - Math.floor(body / 2)}" y="${r1(PH + GAP + VH - vh)}" width="${body}" height="${r1(vh)}" fill="${col}" opacity=".55"/>`; }
  }
  const line = (arr) => arr.map((v, i) => (v == null ? "" : `${arr.slice(0, i).some((z) => z != null) ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join("");
  svg += `<path d="${line(m20)}" fill="none" stroke="var(--sky)" stroke-width="2" vector-effect="non-scaling-stroke"/><path d="${line(m5)}" fill="none" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>`;
  const selFromRight = chartSel[st.code] ?? 0, si = Math.max(0, Math.min(n - 1, n - 1 - selFromRight));
  svg += `<rect x="${r1(x(si))}" y="0" width="2" height="${H_}" fill="var(--ink)" opacity=".35"/>`;
  const fmtP2 = (v) => (v == null ? "—" : fmt(v, v < 100 ? 2 : 1));
  const prevC = si > 0 ? C[si - 1] : off > 0 ? e.closes[off - 1] : null, chg = prevC ? C[si] - prevC : null;
  const isLive = e.liveBar && si === n - 1;
  const info = `<div class="kinfo"><span class="num">${esc(D?.[si] ? md(D[si]) : "")}${isLive ? ` 盤中 ${esc(liveTime() || "")}` : ""}</span>
    <span>開 <b class="num">${fmtP2(O?.[si])}</b></span><span>高 <b class="num">${fmtP2(H?.[si])}</b></span><span>低 <b class="num">${fmtP2(Lw?.[si])}</b></span><span>收 <b class="num ${cls(chg)}">${fmtP2(C[si])}</b></span>
    <span class="${cls(chg)}">${chg != null ? (chg > 0 ? "▲" : chg < 0 ? "▼" : "") + fmt(Math.abs(chg), 2) + " " + fmtP((chg / prevC) * 100) : ""}</span>${Number.isFinite(V[si]) ? `<span>量 <b class="num">${fmt(V[si])}</b> 張</span>` : ""}</div>`;
  const ranges = [[20, "1 月"], [60, "3 月"], [120, "6 月"]].map(([k, l]) => `<button type="button" data-krange="${k}" aria-pressed="${chartRange.n === k}">${l}</button>`).join("");
  return `<div class="kchart">
    <div class="khead"><div class="seg krange" role="group" aria-label="K 線期間">${ranges}</div><span class="sub"><span style="color:var(--ink)">┅</span> MA5　<span style="color:var(--sky)">━</span> MA20</span></div>
    ${info}
    <div class="chart"><svg class="candles" data-kcode="${esc(st.code)}" data-kn="${n}" viewBox="0 0 ${W} ${H_}" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="${esc(st.name)} 近 ${n} 日 K 線，點選可看單日開高低收">${svg}</svg></div>
    ${hasOHLC ? "" : `<p class="sub" style="margin:0">開高低價資料補齊前，先以收盤價畫成短橫線；下一次完整更新後會變成完整 K 棒。</p>`}
    ${tv}</div>`;
}

/* ---------- 渲染：同步面板 ---------- */
function renderSync() {
  const s = sync.state;
  const pill = $("#syncPill");
  const P = { off: ["未設定同步", "need"], signedOut: ["未登入同步", "need"], needTap: ["點此同步", "need"], syncing: ["同步中…", ""], ok: [`已同步 ${lastSync ? hm(lastSync) : ""}`, "ok"], error: ["同步失敗", "need"], needPass: ["需要同步密碼", "need"] }[s];
  pill.textContent = "☁ " + P[0];
  pill.className = "syncpill " + P[1];
  const origin = location.origin;
  const enc = !!getPass();
  const dot = s === "ok" ? "ok" : s === "error" ? "err" : s === "syncing" ? "" : "need";
  const head = {
    off: ["還沒設定雲端同步", "完成下方「首次設定」後，就能用 Google 帳號在手機和電腦之間同步。"],
    signedOut: ["尚未登入", "登入後，你的帳戶、買賣紀錄、觀察清單會存到你自己的 Google 雲端，手機和電腦自動同步。"],
    needTap: ["點一下開始同步", "Google 登入每次有效約 1 小時，打開 APP 時點一下「同步」即可（不用重新輸入帳號密碼）。"],
    syncing: ["同步中…", ""],
    ok: [`已同步・${lastSync ? hm(lastSync) : ""}`, "修改資料後會自動上傳；切回這個分頁時會自動下載另一台裝置的變更。"],
    error: ["同步失敗", sync.msg],
    needPass: ["需要同步密碼", sync.msg || "雲端資料已加密，請輸入在另一台裝置設定的同步密碼。"],
  }[s];
  const btns = {
    off: "",
    signedOut: `<button class="primary" type="button" data-sync="signin">用 Google 帳號登入</button>`,
    needTap: `<button class="primary" type="button" data-sync="signin">同步</button><button type="button" class="ghost" data-sync="signout">登出</button>`,
    syncing: "",
    ok: `<button type="button" data-sync="now">立即同步</button><button type="button" class="ghost" data-sync="signout">登出</button>`,
    error: `<button class="primary" type="button" data-sync="${Sync.hasToken() ? "now" : "signin"}">再試一次</button>${Sync.wasSignedIn() ? `<button type="button" class="ghost" data-sync="signout">登出</button>` : ""}`,
    needPass: `<form class="row" id="unlockForm" style="flex:1 1 280px"><input type="password" id="unlockPass" autocomplete="current-password" placeholder="同步密碼" style="flex:1 1 160px" required><button class="primary" type="submit">解鎖</button></form>`,
  }[s];
  $("#syncPanel").innerHTML = `
    <div class="state"><span class="dot ${dot}"></span><b>${esc(head[0])}</b><span class="sub">${enc ? "🔒 已加密" : ""}</span></div>
    ${head[1] ? `<p class="sub" style="margin:0">${esc(head[1])}</p>` : ""}
    ${btns ? `<div class="row">${btns}</div>` : ""}
    <details ${s === "off" ? "open" : ""}><summary>首次設定：Google 用戶端 ID</summary>
      <ol class="steps">
        <li>到 <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Google Cloud 憑證頁</a> 建立「OAuth 用戶端 ID」，類型選「網頁應用程式」。</li>
        <li>「已授權的 JavaScript 來源」填入：<code>${esc(origin)}</code></li>
        <li>到「API 和服務 → 程式庫」啟用 <b>Google Drive API</b>。</li>
        <li>把產生的用戶端 ID（結尾是 <code>.apps.googleusercontent.com</code>）貼在下面。</li>
      </ol>
      <form class="row" id="cidForm"><input id="cidInput" value="${esc(Sync.clientId())}" placeholder="xxxx.apps.googleusercontent.com" style="flex:1 1 260px" autocomplete="off"><button type="submit">儲存</button></form>
      <div class="err" id="cidErr"></div>
    </details>
    <details><summary>同步密碼加密（選用）</summary>
      <p class="sub" style="margin:0 0 8px">設定後，雲端上的資料會先用這組密碼加密，就算 Google 帳號外洩，別人也只看到亂碼。每台裝置都要輸入同一組密碼；<b>忘記密碼資料就救不回來</b>，請記在安全的地方。</p>
      <form class="form two" id="passForm">
        <label>${enc ? "更換" : "設定"}同步密碼<input type="password" id="passNew" minlength="8" autocomplete="new-password" placeholder="至少 8 個字"></label>
        <label>再輸入一次<input type="password" id="passNew2" autocomplete="new-password"></label>
        <label class="check full"><input type="checkbox" id="passRemember" checked> 在這台裝置記住密碼</label>
        <button class="primary" type="submit">${enc ? "更換密碼" : "開啟加密"}</button>
        ${enc ? `<button type="button" id="passOff">關閉加密</button>` : ""}
      </form>
      <div class="err" id="passErr"></div>
    </details>`;
}

/* ---------- 渲染：帳號 ---------- */
let curAcct = "main", side = "buy";
const acct = () => S.accounts.find((a) => a.id === curAcct) || S.accounts[0];
function renderAccount() {
  if (curAcct !== "__all" && !S.accounts.some((a) => a.id === curAcct)) curAcct = S.accounts[0].id;
  const all = curAcct === "__all";
  $("#acctBar").innerHTML = S.accounts.map((a) => `<button type="button" aria-pressed="${a.id === curAcct}" data-acct="${esc(a.id)}">${esc(a.name)}</button>`).join("") + (S.accounts.length > 1 ? `<button type="button" aria-pressed="${all}" data-acct="__all">全部帳戶</button>` : "");
  const L = ledgerOf(S, all ? null : curAcct, priceOf);
  const cost = L.holdings.reduce((s, h) => s + h.cost, 0), mv = L.holdings.reduce((s, h) => s + (h.mv ?? h.cost), 0), un = mv - cost;
  const COIN = `<svg width="44" height="44" viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true"><rect x="2" y="0" width="4" height="1" fill="#2A2019"/><rect x="1" y="1" width="6" height="6" fill="#A8473A"/><rect x="0" y="2" width="1" height="4" fill="#2A2019"/><rect x="7" y="2" width="1" height="4" fill="#2A2019"/><rect x="1" y="1" width="1" height="1" fill="#2A2019"/><rect x="6" y="1" width="1" height="1" fill="#2A2019"/><rect x="1" y="6" width="1" height="1" fill="#2A2019"/><rect x="6" y="6" width="1" height="1" fill="#2A2019"/><rect x="2" y="7" width="4" height="1" fill="#2A2019"/><rect x="3" y="2" width="2" height="4" fill="#2A2019"/><rect x="2" y="2" width="1" height="1" fill="#ECE7DC"/></svg>`;
  const arrow = (n) => (n > 0 ? "▲" : n < 0 ? "▼" : "");
  $("#acctStats").innerHTML = `
    <div class="stat lead">${COIN}<div><span>總資產（現金＋市值）</span><b>${fmt(L.cash + mv)}</b></div></div>
    <div class="stat"><span>可用現金</span><b>${fmt(L.cash)}</b></div>
    <div class="stat"><span>持股成本</span><b>${fmt(cost)}</b></div>
    <div class="stat"><span>持股市值</span><b>${fmt(mv)}</b></div>
    <div class="stat"><span>未實現損益</span><b class="${cls(un)}">${arrow(un)}${fmt(Math.abs(un))}</b></div>
    <div class="stat"><span>已實現損益</span><b class="${cls(L.realized)}">${arrow(L.realized)}${fmt(Math.abs(L.realized))}</b></div>`;
  const slots = Math.max(0, (L.holdings.length % 2 ? 1 : 0) + (L.holdings.length < 4 ? 2 : 0));
  $("#holdings").innerHTML = L.holdings.length ? `<div class="inv">${L.holdings.map((h) => {
      const pl = h.mv != null ? h.mv - h.cost : null, pp = pl != null ? (pl / h.cost) * 100 : null;
      const w = S.watch.find((x) => x.code === h.code), a = w ? analyze(w) : null;
      return `<div class="item"><div class="top">${esc(h.name || h.code)}<span>${esc(h.code)}</span></div>
        <span class="qty">× ${fmt(h.qty)} 股</span>
        <span class="sub">均價 <span class="num">${fmt(h.avg, 2)}</span>・現價 <span class="num">${h.px != null ? fmt(h.px, 2) : "—"}</span></span>
        <span class="pl ${cls(pl)}">${pl != null ? arrow(pl) + fmt(Math.abs(pl)) + "<br>" + fmtP(pp) : "—"}</span>
        ${a ? `<span><span class="chip ${sigClass(a)}">${esc(sigLabel(a))}</span></span>` : `<span class="sub">未在觀察清單</span>`}</div>`;
    }).join("")}${'<div class="item slot" aria-hidden="true"></div>'.repeat(slots)}</div>`
    : `<div class="empty"><span>道具欄是空的。先在「資金存入」放入資金，再用「下單紀錄」記下第一筆買入。</span></div>`;
  const rows = [...S.trades.filter((t) => all || t.acct === curAcct).map((t) => ({ ...t, k: "t" })), ...S.cash.filter((c) => all || c.acct === curAcct).map((c) => ({ ...c, k: "c" }))].sort((a, b) => b.time.localeCompare(a.time));
  $("#histCount").textContent = rows.length ? `QUEST LOG・${rows.length} 筆` : "QUEST LOG";
  const an = (id) => S.accounts.find((a) => a.id === id)?.name || "";
  const when = (t) => { const [d, h] = t.split("T"); return `${md(d)} ${h || ""}`; };
  $("#history").innerHTML = rows.length ? `<ol class="log">${rows.map((r) => {
      if (r.k === "c") return `<li><span class="kind">${r.type === "deposit" ? "存入" : "提出"}</span><span class="what">${r.type === "deposit" ? "資金存入" : "資金提出"}<small>${esc(when(r.time))}${all ? "・" + esc(an(r.acct)) : ""}</small></span>
        <span class="amt">${r.type === "deposit" ? "+" : "-"}${fmt(r.amt)}<small><span class="confirm" data-del="cash:${esc(r.id)}"><button type="button" class="ghost" data-delask>刪除</button></span></small></span></li>`;
      const amt = r.qty * r.price, net = r.side === "buy" ? -(amt + (+r.fee || 0)) : amt - (+r.fee || 0) - (+r.tax || 0);
      const pl = L.plById[r.id];
      return `<li><span class="kind ${r.side}">${r.side === "buy" ? "買入" : "賣出"}</span>
        <span class="what">${esc(r.name || r.code)} ${fmt(r.qty)} 股 × ${fmt(r.price, 2)}<small>${esc(when(r.time))}${all ? "・" + esc(an(r.acct)) : ""}・費 ${fmt(r.fee)}${r.side === "sell" ? "／稅 " + fmt(r.tax) : ""}</small>${r.note ? `<em>${esc(r.note)}</em>` : ""}</span>
        <span class="amt ${r.side === "sell" && pl != null ? cls(pl) : ""}">${r.side === "sell" && pl != null ? arrow(pl) + fmt(Math.abs(pl)) : (net > 0 ? "+" : "") + fmt(net)}<small>${r.side === "sell" && pl != null ? "已實現・" : ""}<span class="confirm" data-del="trades:${esc(r.id)}"><button type="button" class="ghost" data-delask>刪除</button></span></small></span></li>`;
    }).join("")}</ol>`
    : `<div class="empty"><span>還沒有任何紀錄。</span><br><button type="button" id="demoBtn" style="margin-top:10px">載入示範資料看看</button></div>`;
  const keepAcct = $("#tAcct").value;
  $("#tAcct").innerHTML = S.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("");
  $("#tAcct").value = all ? (S.accounts.some((a) => a.id === keepAcct) ? keepAcct : S.accounts[0].id) : curAcct;
  const A = all ? S.accounts[0] : acct();
  if (document.activeElement?.closest("#acctForm") == null) { $("#aName").value = A.name; $("#aDisc").value = A.disc; $("#aMin").value = A.minFee; }
  $("#aDelRow").innerHTML = S.accounts.length > 1 && !all ? `<span class="confirm" data-delacct><button type="button" class="ghost danger" data-delacctask>刪除此帳戶</button></span>` : "";
  if (!$("#tTime").value) $("#tTime").value = localInputNow();
  if (!$("#cTime").value) $("#cTime").value = localInputNow();
  tradePreview();
}
function tradePreview() {
  const a = S.accounts.find((x) => x.id === $("#tAcct").value) || S.accounts[0];
  const q = +$("#tQty").value || 0, p = +$("#tPrice").value || 0, amt = q * p, code = $("#tCode").value.trim().toUpperCase();
  if (!$("#tFee").dataset.touched) $("#tFee").value = amt ? feeOf(a, amt) : "";
  if (!$("#tTax").dataset.touched) $("#tTax").value = side === "sell" && amt ? taxOf(code, amt) : side === "buy" ? 0 : "";
  $("#tTax").disabled = side === "buy";
  const fee = +$("#tFee").value || 0, tax = side === "sell" ? +$("#tTax").value || 0 : 0;
  const L = ledgerOf(S, a.id, priceOf), h = L.holdings.find((x) => x.code === code);
  const total = side === "buy" ? amt + fee : amt - fee - tax;
  $("#tPreview").innerHTML = amt ? `<dt>成交金額</dt><dd>${fmt(amt)}</dd><dt>${side === "buy" ? "應付" : "應收"}</dt><dd><b>${fmt(total)}</b></dd><dt>帳戶現金</dt><dd>${fmt(L.cash)} → ${fmt(L.cash + (side === "buy" ? -total : total))}</dd>${h ? `<dt>目前持有</dt><dd>${fmt(h.qty)} 股（均價 ${fmt(h.avg, 2)}）</dd>` : ""}${side === "sell" && h ? `<dt>預估損益</dt><dd class="${cls(total - h.avg * q)}">${fmt(total - h.avg * q)}</dd>` : ""}` : "";
  $("#tSubmit").textContent = side === "buy" ? "記錄買入" : "記錄賣出";
}

/* ---------- 渲染：分析要點 ---------- */
function renderGuide() {
  const F = [["公司基本面", "長期最關鍵", ["營收、毛利率、營業利益率、EPS 的成長或衰退", "產品競爭力、市占率、客戶結構", "未來展望與接單狀況"]],
    ["總體經濟", "", ["利率：Fed 與台灣央行升降息，影響資金成本與估值", "通膨、景氣循環、GDP 成長", "新台幣升值通常吸引外資匯入，也影響出口企業匯兌"]],
    ["產業與國際市場", "", ["台股高度連動美股，特別是費半與那斯達克", "半導體、AI 伺服器等產業週期", "台積電權重高，漲跌常左右大盤"]],
    ["資金與籌碼", "", ["三大法人買賣方向", "融資融券變化（散戶槓桿）", "市場資金寬鬆或緊縮"]],
    ["政策與事件", "", ["地緣政治：兩岸、美中科技戰、出口管制、關稅", "政府產業政策、稅制", "天災、疫情、公司重大訊息"]],
    ["市場情緒", "短期", ["題材炒作、恐慌或過度樂觀，短期可能讓股價偏離基本面"]]];
  $("#factors").innerHTML = F.map(([t, s, l]) => `<div class="panel"><h3>${t}${s ? `<small>${s}</small>` : ""}</h3><ul>${l.map((x) => `<li>${x}</li>`).join("")}</ul></div>`).join("");
  const M = [["技術面", "什麼時候進出？", "K 線、均線、成交量、KD、MACD", "短線", "站上／跌破月線、均線交叉、KD 高低檔交叉、MACD 翻正負、價量配合（35%）"],
    ["籌碼面", "誰在買、誰在賣？", "三大法人、融資融券、集保股權分散", "中短期", "外資、投信 5 日買賣超；融資大增但股價不漲扣分（25%）"],
    ["基本面", "公司值多少錢？", "月營收、財報、EPS、本益比、淨值比、殖利率", "中長期", "營收 YoY ≥20% 加分、EPS 成長、本益比對照你設定的區間（25%）"],
    ["消息面", "有什麼會改變局勢？", "產業趨勢、法說會、國際事件", "全部", "近 3 天相關新聞與筆記的利多／利空，加上你自己的判斷（15%）"]];
  $("#methods").innerHTML = M.map((r) => `<tr>${r.map((c, i) => `<td class="${i === 4 || i === 2 ? "wrapcell" : ""}">${i === 0 ? `<b>${c}</b>` : c}</td>`).join("")}</tr>`).join("");
  const SCH = [["每天", [["開盤前（約 08:00）", "美股收盤、費半、台積電 ADR", "判斷今日開盤方向", "國際財經網站"], ["08:30–09:00", "盤前委託、試撮", "開盤價預估", "看盤軟體"], ["09:00–13:30", "台股盤中交易", "價量變化", "看盤軟體"], ["14:00–14:30", "盤後定價交易", "以收盤價成交", "看盤軟體"], ["約 15:00–16:00", "三大法人買賣超", "外資、投信動向", "證交所、櫃買中心"], ["約 15:00", "期貨三大法人未平倉", "外資期貨多空部位", "期交所"], ["約 21:00–22:30", "融資融券、借券賣出餘額", "散戶槓桿、空方力道", "證交所、櫃買中心"], ["22:30–05:00（冬令）／21:30–04:00（夏令）", "美股交易時段", "影響隔天台股", "國際財經網站"]]],
    ["每週", [["當週最後一個營業日為基準", "集保股權分散表", "大戶與散戶持股比例變化", "集保結算所"]]],
    ["每月", [["第一個工作日", "台灣製造業 PMI", "50 為分界", "中華經濟研究院"], ["第一個週五晚間", "美國非農就業", "影響 Fed 利率預期", "美國勞工部"], ["10 日前", "上市櫃公司月營收（遇假日順延）", "MoM、YoY", "公開資訊觀測站"], ["約 10–15 日", "美國 CPI", "通膨與降息預期", "美國勞工部"], ["第三個週三", "台指期、選擇權結算", "結算前後波動較大", "期交所"], ["約 20 日", "外銷訂單統計", "出口與接單動能", "經濟部統計處"], ["約 27 日", "景氣對策信號", "整體景氣位置", "國發會"]]],
    ["每季", [["5/15 前", "第一季財報", "4 月底到 5 月中陸續公布", ""], ["8/14 前", "第二季財報", "取代過去的半年報", ""], ["11/14 前", "第三季財報", "用前三季 EPS 推估全年", ""], ["次年 3/31 前", "年度財報", "全年 EPS，影響股利", ""], ["1、4、7、10 月中旬", "台積電法說會", "下季營收、毛利率指引", ""], ["2、5、8、11 月", "MSCI 季度調整", "外資被動買賣", ""], ["3、6、9、12 月", "台灣央行理監事會", "利率、信用管制", ""], ["每年 8 次", "Fed 利率會議 FOMC", "台灣凌晨 2:00（夏）／3:00（冬）公布", ""]]],
    ["每年", [["1–2 月", "全年自結、董事會決議股利", "股利政策、殖利率", ""], ["5–6 月", "股東常會旺季", "股利、董監改選", ""], ["6–8 月（7 月高峰）", "除權息旺季", "填息表現；股利約除息後 1 個月發放", ""], ["12 月", "年底作帳行情", "投信、法人績效調整", ""]]]];
  $("#schedules").innerHTML = SCH.map(([t, rows]) => `<div class="panel"><h3>${t}</h3><div class="tbl"><table><thead><tr><th>時間</th><th>事項</th><th>觀察重點</th><th>資料來源</th></tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td class="wrapcell" style="min-width:120px">${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>`).join("");
  const W = [["公開資訊觀測站", "https://mops.twse.com.tw", "月營收、財報、重大訊息、法說會"], ["臺灣證券交易所", "https://www.twse.com.tw", "三大法人、融資融券、上市個股"], ["證券櫃檯買賣中心", "https://www.tpex.org.tw", "上櫃股票資料"], ["臺灣期貨交易所", "https://www.taifex.com.tw", "期貨未平倉、結算日"], ["臺灣集中保管結算所", "https://www.tdcc.com.tw", "集保股權分散表"], ["國家發展委員會", "https://www.ndc.gov.tw", "景氣對策信號"]];
  $("#sites").innerHTML = W.map(([n, u, d]) => `<tr><td><a href="${u}" target="_blank" rel="noopener noreferrer">${n}</a></td><td class="wrapcell">${d}</td></tr>`).join("");
}

/* ---------- 路由 ---------- */
const VIEWS = ["news", "track", "account", "guide"];
function route() {
  const h = (location.hash || "").slice(1);
  const v = VIEWS.includes(h) ? h : "news";
  VIEWS.forEach((x) => ($("#v-" + x).hidden = x !== v));
  document.querySelectorAll("nav.tabs a").forEach((a) => a.setAttribute("aria-current", a.dataset.v === v ? "page" : "false"));
}
function renderClock() {
  const t = tpeParts();
  $("#clock").textContent = `${t.y}/${pad(t.m)}/${pad(t.d)} 週${"日一二三四五六"[t.wd]} ${pad(t.h)}:${pad(t.mi)}`;
  const p = phaseLabel(), el = $("#phase");
  el.classList.toggle("live", p.live);
  el.querySelector("span").textContent = p.t;
}
function renderAll() { renderClock(); renderTape(); renderTrend(); renderWatch(); renderAccount(); renderSync(); }

/* ---------- 事件 ---------- */
// 點 K 線圖：選取最接近的那一根，顯示開高低收
document.addEventListener("pointerdown", (e) => {
  const svg = e.target.closest?.("svg.candles");
  if (!svg) return;
  const r = svg.getBoundingClientRect(), n = +svg.dataset.kn, code = svg.dataset.kcode;
  const i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n)));
  chartSel[code] = n - 1 - i; renderWatch();
});
document.addEventListener("click", (e) => {
  const t = e.target.closest("button,[data-toggle]");
  if (!t) return;
  const ds = t.dataset;
  if (ds.toggle) { openCode = openCode === ds.toggle ? null : ds.toggle; renderWatch(); return; }
  if (ds.trend) { trendTab = ds.trend; lsSet("st.trend", trendTab); renderTrend(); return; }
  if ("major" in ds) { onlyMajor = !onlyMajor; lsSet("st.major", onlyMajor ? "1" : "0"); renderTrend(); return; }
  if (ds.addwatch) { if (!S.watch.some((w) => w.code === ds.addwatch)) { S.watch.push(newStock(ds.addwatch, ds.name || ds.addwatch)); commit(); renderWatch(); renderTrend(); } return; }
  if (ds.tick) { openTick(ds.tick); return; }
  if ("sheetclose" in ds) { closeSheet(); return; }
  if (ds.sheetgo) { closeSheet(); trendTab = ds.sheetgo; lsSet("st.trend", trendTab); location.hash = "news"; renderTrend(); setTimeout(() => $("#trendTabs").scrollIntoView({ behavior: "smooth", block: "start" }), 50); return; }
  if (ds.krange) { chartRange.n = +ds.krange; lsSet("st.krange", ds.krange); renderWatch(); return; }
  if (ds.acct) { curAcct = ds.acct; renderAccount(); return; }
  if (ds.trade) {
    const w = S.watch.find((x) => x.code === ds.code);
    side = ds.trade;
    $("#sideB").setAttribute("aria-pressed", side === "buy"); $("#sideS").setAttribute("aria-pressed", side === "sell");
    delete $("#tTax").dataset.touched; delete $("#tFee").dataset.touched;
    $("#tCode").value = ds.code; $("#tName").value = w?.name || "";
    const px = priceOf(ds.code); $("#tPrice").value = px ?? "";
    if (side === "sell") { const h = ledgerOf(S, $("#tAcct").value || null, priceOf).holdings.find((x) => x.code === ds.code); $("#tQty").value = h ? h.qty : ""; }
    location.hash = "account"; tradePreview();
    setTimeout(() => { $("#tradeForm").scrollIntoView({ behavior: "smooth", block: "center" }); $("#tQty").focus({ preventScroll: true }); }, 60);
    return;
  }
  if (ds.sync === "signin") { signIn(); return; }
  if (ds.sync === "now") { syncNow(); return; }
  if (ds.sync === "signout") { Sync.signOut(); setSync(initialSyncState()); return; }
  if (t.id === "syncPill") {
    if (sync.state === "needTap" || sync.state === "signedOut" && Sync.clientId()) { signIn(); return; }
    if (sync.state === "ok" || (sync.state === "error" && Sync.hasToken())) { syncNow(); return; }
    location.hash = "account"; return;
  }
  if ("delnote" in ds) { const n = S.notes.find((x) => x.id === ds.delnote); if (n) { bury("notes", n); S.notes = S.notes.filter((x) => x !== n); commit(); renderTrend(); renderWatch(); } return; }
  if ("rmask" in ds) { t.parentElement.innerHTML = `確定移除？<button type="button" class="danger" data-rmyes>移除</button><button type="button" class="ghost" data-rmno>取消</button>`; return; }
  if ("rmyes" in ds) { const code = t.closest("[data-rm]").dataset.rm; const w = S.watch.find((x) => x.code === code); if (w) { bury("watch", w); S.watch = S.watch.filter((x) => x !== w); } openCode = null; commit(); renderWatch(); return; }
  if ("rmno" in ds) { renderWatch(); return; }
  if ("delask" in ds) { t.parentElement.innerHTML = `<button type="button" class="danger" data-delyes>確定刪除</button><button type="button" class="ghost" data-delno>取消</button>`; return; }
  if ("delyes" in ds) {
    const [col, id] = t.closest("[data-del]").dataset.del.split(":");
    const it = S[col].find((x) => x.id === id);
    if (it) { bury(col, it); S[col] = S[col].filter((x) => x !== it); }
    commit(); renderAccount(); renderWatch(); return;
  }
  if ("delno" in ds) { renderAccount(); return; }
  if ("delacctask" in ds) { t.parentElement.innerHTML = `會一併刪除此帳戶的所有紀錄。<button type="button" class="danger" data-delacctyes>確定刪除帳戶</button><button type="button" class="ghost" data-delno>取消</button>`; return; }
  if ("delacctyes" in ds) {
    const id = curAcct, A = S.accounts.find((a) => a.id === id);
    if (A) bury("accounts", A);
    S.trades.filter((x) => x.acct === id).forEach((x) => bury("trades", x));
    S.cash.filter((x) => x.acct === id).forEach((x) => bury("cash", x));
    S.accounts = S.accounts.filter((a) => a.id !== id); S.trades = S.trades.filter((x) => x.acct !== id); S.cash = S.cash.filter((x) => x.acct !== id);
    curAcct = S.accounts[0].id; commit(); renderAccount(); renderWatch(); return;
  }
  if (t.id === "demoBtn") { loadDemo(); return; }
  if (t.id === "aNew") { const id = uid(); S.accounts.push(stamp({ id, name: `帳戶 ${S.accounts.length + 1}`, disc: 1, minFee: 20 })); curAcct = id; commit(); renderAccount(); $("#aName").focus(); $("#aName").select(); return; }
  if (t.id === "sideB" || t.id === "sideS") {
    side = t.id === "sideB" ? "buy" : "sell";
    $("#sideB").setAttribute("aria-pressed", side === "buy"); $("#sideS").setAttribute("aria-pressed", side === "sell");
    delete $("#tTax").dataset.touched; tradePreview(); return;
  }
  if (t.id === "passOff") { setPass("", false); forceUpload = true; renderSync(); scheduleSync(); return; }
  if (t.id === "exportBtn") { exportBackup(); return; }
});
function loadDemo() {
  const id = S.accounts[0].id, a = S.accounts[0];
  S.cash.push(stamp({ id: uid(), acct: id, type: "deposit", amt: 3000000, time: "2026-10-01T09:00" }));
  const add = (code, name, sd, qty, price, time, note) => { const amt = qty * price; S.trades.push(stamp({ id: uid(), acct: id, code, name, side: sd, qty, price, fee: feeOf(a, amt), tax: sd === "sell" ? taxOf(code, amt) : 0, time, note: "［示範］" + note })); };
  add("2330", "台積電", "buy", 500, 2180, "2026-10-06T10:12", "站上月線＋外資連買");
  add("2317", "鴻海", "buy", 2000, 232, "2026-10-14T09:35", "AI 伺服器出貨題材");
  add("2317", "鴻海", "sell", 1000, 251, "2026-10-29T13:05", "達短線目標，先賣一半");
  commit(); renderAccount(); renderWatch();
}
async function exportBackup() {
  try {
    const text = await Sync.seal(S, getPass());
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = `stock-tracker-backup-${todayStr().replace(/-/g, "")}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    $("#bkErr").textContent = "";
  } catch (e) { $("#bkErr").textContent = "無法產生備份檔：" + e.message; }
}
$("#importFile").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const data = await Sync.open(await f.text(), getPass());
    const incoming = normalizeState(data, starterState);
    S = mergeState(S, incoming);
    commit(); await loadHist(S.watch.map((w) => w.code)); renderAll();
    $("#bkErr").innerHTML = `<span class="okmsg">已合併備份檔：${incoming.trades.length} 筆交易、${incoming.cash.length} 筆資金紀錄</span>`;
  } catch (err) {
    $("#bkErr").textContent = err.code === "need_pass" ? "這份備份已加密，請先在上方「同步密碼加密」輸入密碼再匯入" : err.code === "bad_pass" ? "同步密碼不正確，無法解開這份備份" : "無法讀取這個檔案：" + err.message;
  }
  e.target.value = "";
});
document.addEventListener("submit", async (e) => {
  const f = e.target;
  if (f.id === "unlockForm") { e.preventDefault(); setPass($("#unlockPass").value, true); syncNow(); return; }
  if (f.id === "cidForm") {
    e.preventDefault();
    const v = $("#cidInput").value.trim();
    if (v && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(v)) { $("#cidErr").textContent = "格式不對：應該是以 .apps.googleusercontent.com 結尾的一串字"; return; }
    Sync.setClientId(v); setSync(initialSyncState()); return;
  }
  if (f.id === "passForm") {
    e.preventDefault();
    const a = $("#passNew").value, b = $("#passNew2").value;
    if (a.length < 8) { $("#passErr").textContent = "密碼至少 8 個字"; return; }
    if (a !== b) { $("#passErr").textContent = "兩次輸入的密碼不一樣"; return; }
    setPass(a, $("#passRemember").checked); forceUpload = true; renderSync(); scheduleSync(); return;
  }
  const ed = f.closest("form[data-edit]");
  if (!ed) return;
  e.preventDefault();
  const st = S.watch.find((w) => w.code === ed.dataset.edit);
  if (!st) return;
  const g = (n) => ed.elements[n].value;
  st.livePrice = g("livePrice");
  st.closes = g("closes").split(/[\s,，、]+/).map(Number).filter((x) => isFinite(x) && x > 0).slice(-250);
  st.c = { foreign: g("foreign"), trust: g("trust"), margin: g("margin") };
  st.f = { yoy: g("yoy"), mom: g("mom"), eps: g("eps"), pe: g("pe") };
  st.pe = { lo: g("pelo"), hi: g("pehi") };
  st.news = +g("news");
  st.stop = numOr(g("stop")) ?? 8; st.take = numOr(g("take")) ?? 20;
  const t = tpeParts(); st.upd = `${t.y}/${pad(t.m)}/${pad(t.d)} ${pad(t.h)}:${pad(t.mi)}`;
  stamp(st); commit(); renderWatch(); renderAccount();
});
$("#noteForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const codes = $("#noteCodes").value.split(/[,\s，、]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  S.notes.push(stamp({ id: uid(), title: $("#noteTitle").value.trim(), impact: +$("#noteImpact").value, codes, date: $("#noteDate").value || todayStr() }));
  e.target.reset(); $("#noteDate").value = todayStr(); commit(); renderTrend(); renderWatch();
});
// 代號欄位：英文自動轉大寫、去掉空白
for (const id of ["asCode", "tCode"]) $("#" + id).addEventListener("input", (e) => { const el = e.target, v = el.value.toUpperCase().replace(/\s/g, ""); if (v !== el.value) el.value = v; });
$("#asCode").addEventListener("input", () => {
  const q = AUTO.quotes?.q?.[$("#asCode").value.trim().toUpperCase()];
  if (q && q[0]) $("#asName").value = q[0];
});
$("#addStock").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("#asCode").value.trim().toUpperCase(), name = $("#asName").value.trim();
  if (!CODE_RE.test(code)) { $("#asErr").textContent = "代號格式不對，例如 2330、00878"; return; }
  if (S.watch.some((w) => w.code === code)) { $("#asErr").textContent = `${code} 已在觀察清單中`; return; }
  $("#asErr").textContent = "";
  S.watch.push(newStock(code, name));
  openCode = code; e.target.reset(); commit();
  await loadHist([code]); renderWatch();
});
["tQty", "tPrice", "tCode", "tAcct"].forEach((id) => $("#" + id).addEventListener("input", () => {
  if (id === "tCode") {
    const c = $("#tCode").value.trim().toUpperCase();
    const w = S.watch.find((x) => x.code === c), q = AUTO.quotes?.q?.[c];
    const nm = w?.name || q?.[0];
    if (nm) $("#tName").value = nm;
    const px = priceOf(c);
    if (!$("#tPrice").value && px) $("#tPrice").value = px;
  }
  tradePreview();
}));
["tFee", "tTax"].forEach((id) => $("#" + id).addEventListener("input", (e) => { e.target.dataset.touched = "1"; tradePreview(); }));
$("#tradeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const a = $("#tAcct").value, code = $("#tCode").value.trim().toUpperCase(), qty = Math.round(+$("#tQty").value), price = +$("#tPrice").value;
  const fee = +$("#tFee").value || 0, tax = side === "sell" ? +$("#tTax").value || 0 : 0, L = ledgerOf(S, a, priceOf);
  if (!CODE_RE.test(code)) { $("#tErr").textContent = "代號格式不對，例如 2330、00878"; return; }
  if (!(qty > 0) || !(price > 0)) { $("#tErr").textContent = "請輸入大於 0 的股數與成交價"; return; }
  if (side === "buy" && qty * price + fee > L.cash + 0.5) { $("#tErr").textContent = `現金不足：需要 ${fmt(qty * price + fee)}，帳戶只有 ${fmt(L.cash)}。請先在下方存入資金。`; return; }
  const h = L.holdings.find((x) => x.code === code);
  if (side === "sell" && (!h || h.qty < qty)) { $("#tErr").textContent = `持股不足：此帳戶持有 ${code} ${fmt(h ? h.qty : 0)} 股`; return; }
  $("#tErr").textContent = "";
  const name = $("#tName").value.trim() || S.watch.find((w) => w.code === code)?.name || AUTO.quotes?.q?.[code]?.[0] || "";
  S.trades.push(stamp({ id: uid(), acct: a, code, name, side, qty, price, fee, tax, time: $("#tTime").value, note: $("#tNote").value.trim() }));
  if (!S.watch.some((w) => w.code === code)) { S.watch.push(newStock(code, name, price)); await loadHist([code]); }
  ["tQty", "tPrice", "tNote", "tFee", "tTax"].forEach((id) => { $("#" + id).value = ""; delete $("#" + id).dataset.touched; });
  $("#tTime").value = localInputNow(); curAcct = a; commit(); renderAccount(); renderWatch();
});
$("#cashForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const amt = Math.round(+$("#cAmt").value), type = $("#cType").value, a = curAcct === "__all" ? S.accounts[0].id : curAcct;
  const cash = ledgerOf(S, a, priceOf).cash;
  if (!(amt > 0)) { $("#cErr").textContent = "請輸入金額"; return; }
  if (type === "withdraw" && amt > cash) { $("#cErr").textContent = `可用現金只有 ${fmt(cash)}`; return; }
  $("#cErr").textContent = "";
  S.cash.push(stamp({ id: uid(), acct: a, type, amt, time: $("#cTime").value }));
  $("#cAmt").value = ""; commit(); renderAccount();
});
$("#acctForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const A = curAcct === "__all" ? S.accounts[0] : acct();
  A.name = $("#aName").value.trim() || A.name;
  A.disc = Math.min(1, Math.max(0.1, +$("#aDisc").value || 1));
  A.minFee = Math.max(0, Math.round(+$("#aMin").value || 0));
  stamp(A); commit(); $("#aName").blur(); renderAccount();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (Sync.hasToken()) syncNow(); else if (Sync.wasSignedIn()) setSync("needTap");
  if (Date.now() - AUTO.loadedAt > 15 * 60000) loadAuto();
});


/* ---------- 啟動畫面 ---------- */
const splashEl = $("#splash");
let splashDone = 0, splashTotal = 7, splashTimer = null;
function splashProgress(done) {
  if (!splashEl || splashEl.hidden) return;
  splashDone = Math.min(splashTotal, done);
  const pct = Math.round((splashDone / splashTotal) * 100), on = Math.round(pct / 100 * 12);
  $("#splashBar").innerHTML = Array.from({ length: 12 }, (_, i) => `<i class="${i < on - 1 ? "on" : i === on - 1 ? "edge" : ""}"></i>`).join("");
  $("#splashBar").setAttribute("aria-valuenow", pct);
  $("#splashPct").textContent = pct + "%";
  if (pct >= 100) {
    const needTap = Sync.clientId() && Sync.wasSignedIn() && !Sync.hasToken();
    $("#splashMsg").textContent = needTap ? "資料已更新。按「開始」同時同步你的帳戶紀錄。" : "資料已更新";
    if (!needTap) splashTimer = setTimeout(closeSplash, 700);
  }
}
function closeSplash() {
  if (!splashEl || splashEl.hidden) return;
  clearTimeout(splashTimer);
  try { sessionStorage.setItem("st.splash", "1"); } catch {}
  splashEl.classList.add("leave");
  setTimeout(() => { splashEl.hidden = true; }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 360);
}
let splashSeen = false;
try { splashSeen = sessionStorage.getItem("st.splash") === "1"; } catch {}
if (splashEl) {
  if (splashSeen) splashEl.hidden = true;
  else {
    splashProgress(0);
    $("#splashStart").addEventListener("click", () => {
      // 這一下同時當作 Google 登入需要的點擊，不必再另外按「同步」
      if (Sync.clientId() && Sync.wasSignedIn() && !Sync.hasToken()) signIn();
      closeSplash();
    });
    setTimeout(() => splashProgress(splashTotal), 8000); // 網路很慢時也不要卡住
  }
}

/* ---------- 啟動 ---------- */
window.addEventListener("hashchange", route);
route(); renderGuide();
$("#noteDate").value = todayStr();
sync.state = initialSyncState();
saveLocal(); renderAll();
loadAuto();
setInterval(() => { renderClock(); if (!$("#v-news").hidden) renderTrend(); }, 60000);
// 開著 APP 時每 2 分鐘檢查新資料（GitHub 盤中每 5 分鐘、其他時間每 15 分鐘更新）
async function refreshLight() {
  if (document.visibilityState !== "visible") return;
  const names = ["news", "market", "status", "intraday"];
  const res = await Promise.allSettled(names.map((n) => getJson(`data/${n}.json`)));
  let changed = false;
  res.forEach((r, i) => { const key = (o) => JSON.stringify(o?.updatedAt ?? o?.at); if (r.status === "fulfilled" && key(r.value) !== key(AUTO[names[i]])) { AUTO[names[i]] = r.value; changed = true; } });
  if (changed) { renderTape(); renderTrend(); renderWatch(); renderAccount(); }
}
setInterval(refreshLight, 2 * 60000);

/* ---------- 即時轉送（Cloudflare Worker）：股價約 10 秒、新聞約 3 分鐘 ---------- */
const LIVE_API = String(window.STOCK_APP_CONFIG?.liveApi || "").replace(/\/+$/, "");
const isMarketHours = (n) => n.wd >= 1 && n.wd <= 5 && n.hour * 60 + n.minute >= 535 && n.hour * 60 + n.minute <= 825; // 08:55–13:45
const liveOk = /^https:\/\/[a-z0-9.-]+\.workers\.dev$/i.test(LIVE_API);
function liveSymbols() {
  const codes = new Set([...S.watch.map((w) => w.code), ...S.trades.map((t) => t.code)]);
  if (trendTab === "mem") MEM_STOCKS.forEach(([c]) => codes.add(c));
  if (trendTab === "ai") AI_STOCKS.forEach(([c]) => codes.add(c));
  return [...codes].filter((c) => CODE_RE.test(c)).slice(0, 79).map((c) => (AUTO.quotes?.q?.[c]?.[7] === "上櫃" ? "otc:" : "tse:") + c);
}
async function liveGet(path) {
  const r = await fetch(LIVE_API + path, { cache: "no-store" });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
const typing = () => { const a = document.activeElement; return !!(a && a.matches?.("input,textarea,select") && a.closest("#v-track,#v-account")); };
function renderLive() {
  renderTape();
  if (!$("#v-news").hidden) renderTrend();
  if (!typing()) { renderWatch(); renderAccount(); }
}
let liveBusy = false;
async function pollQuote() {
  if (!liveOk || liveBusy || document.visibilityState !== "visible") return;
  const t = tpeParts();
  if (!isMarketHours({ wd: t.wd, hour: t.h, minute: t.mi })) return;
  liveBusy = true;
  try {
    const j = await liveGet("/quote?s=" + encodeURIComponent(liveSymbols().join(",")));
    if (j && j.q && j.time !== AUTO.live?.time) { AUTO.live = j; renderLive(); }
    else if (j) AUTO.live = j;
  } catch {} finally { liveBusy = false; }
}
async function pollNews() {
  if (!liveOk || document.visibilityState !== "visible") return;
  try {
    const w = [...myCodes()].filter(([c, n]) => CODE_RE.test(c) && n).slice(0, 30).map(([c, n]) => `${c}:${n.replace(/[\s"'<>&]/g, "").slice(0, 12)}`);
    const j = await liveGet("/news?w=" + encodeURIComponent(w.join(",")));
    if (j && Array.isArray(j.items)) { AUTO.liveNews = j; if (!$("#v-news").hidden) renderTrend(); if (!typing()) renderWatch(); }
  } catch {}
}
if (liveOk) {
  pollQuote(); pollNews();
  setInterval(pollQuote, 10000);
  setInterval(pollNews, 3 * 60000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { pollQuote(); if (Date.now() - Date.parse(AUTO.liveNews?.at || 0) > 3 * 60000) pollNews(); } });
}
