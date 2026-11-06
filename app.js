import { indicators, feeOf, taxOf, ledgerOf, normalizeState, mergeState, canon, tombKey } from "./core.js";
import * as Sync from "./sync.js";

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
const AUTO = { market: null, news: null, quotes: null, revenue: null, status: null, hist: {}, loadedAt: 0 };
const bust = () => Math.floor(Date.now() / 300000);
async function getJson(p) {
  const r = await fetch(`${p}?t=${bust()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
async function loadAuto() {
  const names = ["market", "news", "quotes", "revenue", "status"];
  const res = await Promise.allSettled(names.map((n) => getJson(`data/${n}.json`)));
  res.forEach((r, i) => { if (r.status === "fulfilled") AUTO[names[i]] = r.value; });
  AUTO.loadedAt = Date.now();
  AUTO.hist = {};
  await loadHist(S.watch.map((w) => w.code));
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

/* ---------- 每檔股票的有效數據（自動優先，缺的才用手動） ---------- */
function eff(st) {
  const q = AUTO.quotes?.q?.[st.code];
  const h = AUTO.hist[st.code];
  const rv = AUTO.revenue?.r?.[st.code];
  const e = { src: {}, q, rv };
  const live = numOr(st.livePrice);
  if (live != null) { e.price = live; e.src.price = "manual"; }
  else if (q && q[1] != null) { e.price = q[1]; e.src.price = "auto"; }
  else { e.price = numOr(st.price); e.src.price = e.price != null ? "manual" : null; }
  e.chg = q && q[1] != null && q[2] != null ? q[2] : null;
  e.prev = e.chg != null ? +(q[1] - q[2]).toFixed(2) : numOr(st.prev);
  if (e.chg == null && e.price != null && e.prev != null) e.chg = e.price - e.prev;
  // 收盤價與成交量
  const hc = [], hv = [];
  if (h && Array.isArray(h.c)) h.c.forEach((c, i) => { if (Number.isFinite(c)) { hc.push(c); hv.push(h.v?.[i] ?? null); } });
  const mc = st.closes || [];
  if (hc.length && hc.length >= mc.length) { e.closes = hc; e.vols = hv.every((x) => Number.isFinite(x)) ? hv : []; e.src.closes = "auto"; e.histFrom = h.d?.[h.c.findIndex((x) => Number.isFinite(x))]; }
  else { e.closes = mc; e.vols = []; e.src.closes = mc.length ? "manual" : null; }
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
  const auto = (AUTO.news?.items || []).filter((n) => (n.t.includes(st.name) || n.t.includes(st.code)) && (!n.time || now - Date.parse(n.time) < 3 * 864e5));
  const mine = S.notes.filter((n) => (n.codes || []).includes(st.code));
  return [...mine.map((n) => ({ impact: +n.impact, t: n.title })), ...auto.map((n) => ({ impact: n.impact, t: n.t }))];
}
function analyze(st) {
  const e = eff(st);
  const out = { e, tech: { s: 0, r: [], ok: false }, chip: { s: 0, r: [], ok: false }, fund: { s: 0, r: [], ok: false }, news: { s: 0, r: [], ok: false } };
  const px = e.price, ind = indicators(e.closes, e.vols);
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
function tick(label, o, digits = 2, extra = "") {
  if (!o || o.close == null) return `<div class="tick"><span>${label}</span><b>—</b><small class="flat">尚無資料</small></div>`;
  return `<div class="tick"><span>${label}・${md(o.date)}</span><b class="${cls(o.chg)}">${fmt(o.close, digits)}</b><small class="${cls(o.chg)}">${o.chg != null ? (o.chg > 0 ? "▲" : o.chg < 0 ? "▼" : "") + fmt(Math.abs(o.chg), digits) + "　" + fmtP(o.pct) : ""}</small>${extra}</div>`;
}
function renderTape() {
  const m = AUTO.market;
  if (!m) { $("#tape").innerHTML = `<div class="notice full">還沒有自動資料。GitHub Actions 第一次跑完（約 10 分鐘）後，這裡會顯示加權指數、費半與台積電 ADR。</div>`; return; }
  const us = m.us || {};
  let adr = "";
  if (us.TSM?.close && us.TWD?.close) {
    const conv = (us.TSM.close * us.TWD.close) / 5;
    const tw = AUTO.quotes?.q?.["2330"]?.[1];
    adr = `<small class="sub">折台股 ${fmt(conv, 0)} 元${tw ? `，溢價 ${fmtP(((conv - tw) / tw) * 100)}` : ""}</small>`;
  }
  $("#tape").innerHTML = tick("加權指數", m.taiex) + tick("費城半導體", us.SOX) + tick("那斯達克", us.IXIC) + tick("標普 500", us.GSPC) + tick("台積電 ADR（美元）", us.TSM, 2, adr);
}
let newsFilter = "all";
function newsItem(n, mine) {
  const k = n.impact > 0 ? "bull" : n.impact < 0 ? "bear" : "", lab = n.impact > 0 ? "利多" : n.impact < 0 ? "利空" : "中性";
  const tags = (n.tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join("");
  const codes = mine ? (n.codes || []).map((c) => `<span class="chip info">${esc(c)} ${esc(S.watch.find((w) => w.code === c)?.name || "")}</span>`).join("")
    : S.watch.filter((w) => n.t.includes(w.name) || n.t.includes(w.code)).map((w) => `<span class="chip info">${esc(w.code)} ${esc(w.name)}</span>`).join("");
  const title = mine ? esc(n.t) : `<a href="${esc(safeUrl(n.u))}" target="_blank" rel="noopener noreferrer">${esc(n.t)}</a>`;
  return `<article><span class="stripe ${k}"></span>
    <div class="meta"><span class="chip ${k}">${lab}</span><span class="num">${esc(n.when)}</span>${tags}${codes}</div>
    <h3>${title}</h3>
    <div class="meta">${mine ? `<button class="ghost danger" data-delnote="${esc(n.id)}">刪除筆記</button>` : esc(n.src || "")}</div>
  </article>`;
}
function renderNews() {
  const items = AUTO.news?.items || [];
  $("#newsStamp").textContent = AUTO.news?.updatedAt ? `更新於 ${mdhm(AUTO.news.updatedAt)}` : "";
  const tags = ["大盤", "半導體", "AI", "總經", "政策", "財報"].filter((t) => items.some((n) => (n.tags || []).includes(t)));
  const F = [["all", "全部"], ["watch", "我的觀察"], ["bull", "利多"], ["bear", "利空"], ...tags.map((t) => ["tag:" + t, t])];
  $("#newsFilter").innerHTML = F.map(([k, l]) => `<button type="button" data-nf="${esc(k)}" aria-pressed="${newsFilter === k}">${esc(l)}</button>`).join("");
  const keep = (n) => newsFilter === "all" || (newsFilter === "bull" && n.impact > 0) || (newsFilter === "bear" && n.impact < 0)
    || (newsFilter === "watch" && S.watch.some((w) => n.t.includes(w.name) || n.t.includes(w.code)))
    || (newsFilter.startsWith("tag:") && (n.tags || []).includes(newsFilter.slice(4)));
  const list = items.filter(keep).slice(0, 30);
  $("#newsList").innerHTML = !items.length ? `<div class="empty">還沒有自動新聞。GitHub Actions 每天 08:17、14:43、16:38、22:47 會更新。</div>`
    : list.length ? list.map((n) => newsItem({ ...n, when: mdhm(n.time) }, false)).join("") : `<div class="empty">這個分類目前沒有新聞</div>`;
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
const SRC_NAMES = { twse_quotes: "上市收盤價", tpex_quotes: "上櫃收盤價", twse_pe: "上市本益比", tpex_pe: "上櫃本益比", twse_insti: "上市三大法人", tpex_insti: "上櫃三大法人", twse_margin: "融資餘額", taiex: "加權指數", us_market: "美股與 ADR", revenue: "月營收", news: "新聞", backfill: "歷史補抓" };
function renderStatus() {
  const st = AUTO.status;
  if (!st) { $("#srcStatus").innerHTML = `<p class="sub" style="margin:0">讀不到自動資料。若剛建立 GitHub 專案，請等 Actions 第一次跑完。</p>`; return; }
  $("#srcStatus").innerHTML = `<p class="sub" style="margin:0 0 6px">最後執行 ${mdhm(st.updatedAt)}・歷史 ${st.days} 個交易日（${md(st.firstDay)}～${md(st.lastDay)}）</p>
    <ul class="srcs">${Object.entries(st.sources || {}).map(([k, v]) => `<li><span class="${v.ok ? "k" : "x"}">${v.ok ? "✓" : "✗"}</span><span>${esc(SRC_NAMES[k] || k)}<br><small class="sub">${esc(v.msg || "")}</small></span><span class="sub num">${mdhm(v.at)}</span></li>`).join("")}</ul>`;
}

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
    <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="var(--line)" stroke-dasharray="3 4" />
    <path d="${line} L${x(c.length - 1)},${H} L${x(0)},${H} Z" fill="${col}" opacity=".1"/>
    ${maP ? `<path d="${maP}" fill="none" stroke="var(--warn)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>` : ""}
    <path d="${line}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <circle cx="${x(c.length - 1)}" cy="${y(last)}" r="3.5" fill="${col}"/></svg>
    <div class="row sub" style="justify-content:space-between"><span>近 ${c.length} 日　最低 <span class="num">${fmt(mn, 2)}</span>　最高 <span class="num">${fmt(mx, 2)}</span></span><span><span style="color:var(--warn)">━</span> 月線 MA20</span></div>`;
}
const reasonsHtml = (g) => `<ul class="reasons">${g.r.map((r) => `<li class="${r.v > 0 ? "p" : r.v < 0 ? "n" : ""}">${esc(r.txt)}</li>`).join("")}</ul>`;
const grpScore = (g) => (!g.ok ? `<span class="chip">無資料</span>` : `<span class="chip ${g.s > 0.2 ? "bull" : g.s < -0.2 ? "bear" : ""}">${g.s > 0 ? "+" : ""}${g.s.toFixed(1)}</span>`);
const sigLabel = (a) => (a.risk ? (a.risk.k === "bear" ? "觸及停損" : "達停利") : a.verdict.t.split("・")[0]);
const sigClass = (a) => (a.risk ? "warn" : a.verdict.k);

function renderWatch() {
  const d = AUTO.quotes?.date;
  $("#refNote").textContent = d ? `股價為 ${md(d)} 收盤（每個交易日 14:43 自動更新）。盤中想看即時價，可在個股裡填「盤中價」暫時覆蓋。` : "還沒有自動資料，目前顯示的是 11/4 收盤參考價。";
  const el = $("#watch");
  if (!S.watch.length) { el.innerHTML = `<div class="empty">觀察清單是空的，從下方加入第一檔股票。</div>`; return; }
  el.innerHTML = S.watch.map((st) => {
    const a = analyze(st), e = a.e;
    const pv = e.price != null && e.chg != null ? e.price - e.chg : null;
    const pct = pv ? (e.chg / pv) * 100 : null;
    const pos = Math.round(((a.score + 2) / 4) * 100);
    const open = openCode === st.code;
    return `<div class="stock">
      <button class="head" type="button" data-toggle="${esc(st.code)}" aria-expanded="${open}">
        <div class="nm"><span>${esc(st.code)}</span><b>${esc(st.name)}</b>${a.pos ? ` <span class="chip info">持有 ${fmt(a.pos.qty)} 股</span>` : ""}</div>
        <div class="px"><b class="${cls(e.chg)}">${e.price != null ? fmt(e.price, e.price < 100 ? 2 : 1) : "—"}</b><small class="${cls(e.chg)}">${e.chg != null ? (e.chg > 0 ? "▲" : e.chg < 0 ? "▼" : "") + fmt(Math.abs(e.chg), 2) + "　" + fmtP(pct) : e.src.price === "manual" ? "參考價" : ""}</small></div>
        <div class="sig"><span class="chip ${sigClass(a)}">${esc(sigLabel(a))}</span><div class="meter" title="綜合分數 ${a.score.toFixed(2)}"><i style="left:${pos}%"></i></div></div>
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
    <div class="verdict ${a.verdict.k}"><strong>${esc(a.verdict.t)}</strong><span class="sub" style="color:inherit">${esc(a.verdict.d)}</span>
      <span class="sub">綜合分數 <b class="num">${a.score > 0 ? "+" : ""}${a.score.toFixed(2)}</b>（-2 偏空 ～ +2 偏多）</span></div>
    ${a.risk ? `<div class="notice">${esc(a.risk.t)}</div>` : ""}
    ${a.pos ? `<div class="notice info">持有 ${fmt(a.pos.qty)} 股，平均成本 <span class="num">${fmt(a.pos.avg, 2)}</span>，損益 <b class="num ${cls(a.posPct)}">${fmtP(a.posPct)}</b>。停損 -${esc(st.stop)}%／停利 +${esc(st.take)}%</div>` : ""}
    <div>${spark(e.closes)}</div>
    <div class="cols">
      <div class="box"><div class="row" style="justify-content:space-between"><h3>技術面 <small class="sub">35%</small></h3>${grpScore(a.tech)}</div>${reasonsHtml(a.tech)}
        <dl class="kv"><dt>MA5／20／60</dt><dd>${fmt(i.ma5, 1)}／${fmt(i.ma20, 1)}／${fmt(i.ma60, 1)}</dd><dt>K／D</dt><dd>${fmt(i.k, 1)}／${fmt(i.d, 1)}</dd><dt>MACD 柱</dt><dd>${fmt(i.hist, 2)}</dd>${i.vol != null ? `<dt>成交量／20日均</dt><dd>${fmt(i.vol)}／${fmt(i.vol20)} 張</dd>` : ""}</dl>
        <p class="sub" style="margin:0">${esc(histNote)}</p></div>
      <div class="box"><div class="row" style="justify-content:space-between"><h3>籌碼面 <small class="sub">25%</small></h3>${grpScore(a.chip)}</div>${reasonsHtml(a.chip)}</div>
      <div class="box"><div class="row" style="justify-content:space-between"><h3>基本面 <small class="sub">25%</small></h3>${grpScore(a.fund)}</div>${reasonsHtml(a.fund)}${e.revYm ? `<p class="sub" style="margin:0">月營收資料：${esc(e.revYm)}</p>` : ""}</div>
      <div class="box"><div class="row" style="justify-content:space-between"><h3>消息面 <small class="sub">15%</small></h3>${grpScore(a.news)}</div>${reasonsHtml(a.news)}</div>
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
    <p class="sub" style="margin:0">KD 以收盤價近似計算（未用最高最低價），會比看盤軟體略鈍。${st.upd ? `最後修改：${esc(st.upd)}` : ""}</p>
  </div>`;
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
  $("#acctStats").innerHTML = `
    <div class="stat lead"><span>總資產（現金＋市值）</span><b>${fmt(L.cash + mv)}</b></div>
    <div class="stat"><span>可用現金</span><b>${fmt(L.cash)}</b></div>
    <div class="stat"><span>持股成本</span><b>${fmt(cost)}</b></div>
    <div class="stat"><span>持股市值</span><b>${fmt(mv)}</b></div>
    <div class="stat"><span>未實現損益</span><b class="${cls(un)}">${un > 0 ? "+" : ""}${fmt(un)}</b></div>
    <div class="stat"><span>已實現損益</span><b class="${cls(L.realized)}">${L.realized > 0 ? "+" : ""}${fmt(L.realized)}</b></div>`;
  $("#holdings").innerHTML = L.holdings.length ? `<div class="tbl"><table><thead><tr><th>股票</th><th class="r">股數</th><th class="r">均價</th><th class="r">現價</th><th class="r">市值</th><th class="r">損益</th><th>訊號</th></tr></thead><tbody>${
    L.holdings.map((h) => {
      const pl = h.mv != null ? h.mv - h.cost : null, pp = pl != null ? (pl / h.cost) * 100 : null;
      const w = S.watch.find((x) => x.code === h.code), a = w ? analyze(w) : null;
      return `<tr><td><span class="num sub">${esc(h.code)}</span> ${esc(h.name || "")}</td><td class="r num">${fmt(h.qty)}</td><td class="r num">${fmt(h.avg, 2)}</td><td class="r num">${h.px != null ? fmt(h.px, 2) : "—"}</td><td class="r num">${h.mv != null ? fmt(h.mv) : "—"}</td>
      <td class="r num ${cls(pl)}">${pl != null ? (pl > 0 ? "+" : "") + fmt(pl) + "<br><small>" + fmtP(pp) + "</small>" : "—"}</td><td>${a ? `<span class="chip ${sigClass(a)}">${esc(sigLabel(a))}</span>` : `<span class="sub">未在觀察清單</span>`}</td></tr>`;
    }).join("")}</tbody></table></div>`
    : `<div class="empty">目前沒有持股。先在右側「資金存入」，再用「下單紀錄」記下買入。</div>`;
  const rows = [...S.trades.filter((t) => all || t.acct === curAcct).map((t) => ({ ...t, k: "t" })), ...S.cash.filter((c) => all || c.acct === curAcct).map((c) => ({ ...c, k: "c" }))].sort((a, b) => b.time.localeCompare(a.time));
  $("#histCount").textContent = rows.length ? `共 ${rows.length} 筆` : "";
  const an = (id) => S.accounts.find((a) => a.id === id)?.name || "";
  $("#history").innerHTML = rows.length ? `<div class="tbl"><table><thead><tr><th>時間</th><th>類型</th><th>內容</th><th class="r">金額</th><th class="r">已實現</th><th></th></tr></thead><tbody>${rows.map((r) => {
      const tm = esc(r.time.replace("T", " "));
      if (r.k === "c") return `<tr><td class="num">${tm}</td><td><span class="chip info">${r.type === "deposit" ? "存入" : "提出"}</span></td><td class="sub">${all ? esc(an(r.acct)) : ""}</td><td class="r num">${r.type === "deposit" ? "+" : "-"}${fmt(r.amt)}</td><td></td><td><span class="confirm" data-del="cash:${esc(r.id)}"><button type="button" class="ghost" data-delask>刪除</button></span></td></tr>`;
      const amt = r.qty * r.price, net = r.side === "buy" ? -(amt + (+r.fee || 0)) : amt - (+r.fee || 0) - (+r.tax || 0);
      const pl = L.plById[r.id];
      return `<tr><td class="num">${tm}</td><td><span class="chip ${r.side === "buy" ? "bull" : "bear"}">${r.side === "buy" ? "買入" : "賣出"}</span></td>
        <td class="wrapcell">${esc(r.code)} ${esc(r.name || "")}　<span class="num">${fmt(r.qty)} 股 × ${fmt(r.price, 2)}</span>${all ? ` <span class="sub">・${esc(an(r.acct))}</span>` : ""}${r.note ? `<br><small class="sub">${esc(r.note)}</small>` : ""}</td>
        <td class="r num">${net > 0 ? "+" : ""}${fmt(net)}<br><small class="sub">費 ${fmt(r.fee)}${r.side === "sell" ? "／稅 " + fmt(r.tax) : ""}</small></td>
        <td class="r num ${cls(pl)}">${r.side === "sell" && pl != null ? (pl > 0 ? "+" : "") + fmt(pl) : ""}</td>
        <td><span class="confirm" data-del="trades:${esc(r.id)}"><button type="button" class="ghost" data-delask>刪除</button></span></td></tr>`;
    }).join("")}</tbody></table></div>`
    : `<div class="empty">還沒有任何紀錄。<br><button type="button" id="demoBtn" style="margin-top:8px">載入示範資料看看</button></div>`;
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
function renderAll() { renderClock(); renderTape(); renderNews(); renderWatch(); renderAccount(); renderSync(); }

/* ---------- 事件 ---------- */
document.addEventListener("click", (e) => {
  const t = e.target.closest("button,[data-toggle]");
  if (!t) return;
  const ds = t.dataset;
  if (ds.toggle) { openCode = openCode === ds.toggle ? null : ds.toggle; renderWatch(); return; }
  if (ds.nf) { newsFilter = ds.nf; renderNews(); return; }
  if (ds.acct) { curAcct = ds.acct; renderAccount(); return; }
  if (ds.sync === "signin") { signIn(); return; }
  if (ds.sync === "now") { syncNow(); return; }
  if (ds.sync === "signout") { Sync.signOut(); setSync(initialSyncState()); return; }
  if (t.id === "syncPill") {
    if (sync.state === "needTap" || sync.state === "signedOut" && Sync.clientId()) { signIn(); return; }
    if (sync.state === "ok" || (sync.state === "error" && Sync.hasToken())) { syncNow(); return; }
    location.hash = "account"; return;
  }
  if ("delnote" in ds) { const n = S.notes.find((x) => x.id === ds.delnote); if (n) { bury("notes", n); S.notes = S.notes.filter((x) => x !== n); commit(); renderNews(); renderWatch(); } return; }
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
  e.target.reset(); $("#noteDate").value = todayStr(); commit(); renderNews(); renderWatch();
});
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

/* ---------- 啟動 ---------- */
window.addEventListener("hashchange", route);
route(); renderGuide();
$("#noteDate").value = todayStr();
sync.state = initialSyncState();
saveLocal(); renderAll();
loadAuto();
setInterval(() => { renderClock(); if (!$("#v-news").hidden) renderNews(); }, 60000);
