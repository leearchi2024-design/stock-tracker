// 純計算：技術指標、手續費、帳務、兩台裝置的資料合併。瀏覽器與 Node 測試共用。

// ---------- 技術指標 ----------
export const sma = (a, n) => (a.length >= n ? a.slice(-n).reduce((s, x) => s + x, 0) / n : null);

export function emaSeries(a, n) {
  const k = 2 / (n + 1);
  const out = [];
  a.forEach((x, i) => out.push(i ? out[i - 1] + k * (x - out[i - 1]) : x));
  return out;
}

/** KD(9,3,3)，以收盤價近似最高最低價。 */
export function kdSeries(a) {
  let K = 50, D = 50;
  const ks = [], ds = [];
  for (let i = 0; i < a.length; i++) {
    if (i < 8) { ks.push(null); ds.push(null); continue; }
    const w = a.slice(i - 8, i + 1), hi = Math.max(...w), lo = Math.min(...w);
    const rsv = hi === lo ? 50 : ((a[i] - lo) / (hi - lo)) * 100;
    K = (K * 2) / 3 + rsv / 3;
    D = (D * 2) / 3 + K / 3;
    ks.push(K); ds.push(D);
  }
  return { ks, ds };
}

export function indicators(closes, vols = []) {
  const c = closes, n = c.length, r = { n };
  r.ma5 = sma(c, 5); r.ma20 = sma(c, 20); r.ma60 = sma(c, 60);
  if (n >= 9) {
    const { ks, ds } = kdSeries(c);
    r.k = ks[n - 1]; r.d = ds[n - 1];
    r.kp = n >= 10 ? ks[n - 2] : null; r.dp = n >= 10 ? ds[n - 2] : null;
  }
  if (n >= 35) {
    const e12 = emaSeries(c, 12), e26 = emaSeries(c, 26);
    const dif = e12.map((x, i) => x - e26[i]);
    const dea = emaSeries(dif, 9);
    r.dif = dif[n - 1]; r.dea = dea[n - 1];
    r.hist = dif[n - 1] - dea[n - 1]; r.histp = dif[n - 2] - dea[n - 2];
  }
  if (n >= 23) {
    for (let j = 0; j < 3; j++) {
      const a = c.slice(0, n - j), b = c.slice(0, n - j - 1);
      const s1 = sma(a, 5) - sma(a, 20), s0 = sma(b, 5) - sma(b, 20);
      if (s0 <= 0 && s1 > 0) { r.cross = "golden"; break; }
      if (s0 >= 0 && s1 < 0) { r.cross = "death"; break; }
    }
  }
  const v = vols.filter((x) => Number.isFinite(x));
  if (v.length >= 21 && v.length === n) {
    r.vol = v[n - 1];
    r.vol20 = v.slice(-21, -1).reduce((s, x) => s + x, 0) / 20;
    r.volRatio = r.vol20 ? r.vol / r.vol20 : null;
    r.dayChg = c[n - 1] - c[n - 2];
  }
  return r;
}

// ---------- 交易成本 ----------
/** 手續費 0.1425% × 折數，不足最低手續費以最低計。 */
export function feeOf(acct, amt) {
  const a = acct || { disc: 1, minFee: 20 };
  const f = Math.floor(amt * 0.001425 * (+a.disc || 1));
  return Math.max(f, +a.minFee || 0);
}
/** 證交稅：股票 0.3%，ETF（00 開頭）0.1%。 */
export function taxOf(code, amt) {
  return Math.floor(amt * (String(code).startsWith("00") ? 0.001 : 0.003));
}

/** 依時間重算現金、平均成本與已實現損益。priceOf(code) 回傳目前價格或 null。 */
export function ledgerOf(state, acctId, priceOf = () => null) {
  const tr = state.trades.filter((t) => !acctId || t.acct === acctId).slice().sort((a, b) => a.time.localeCompare(b.time) || String(a.id).localeCompare(String(b.id)));
  const pos = {};
  const plById = {};
  let cash = 0, realized = 0;
  for (const c of state.cash) if (!acctId || c.acct === acctId) cash += c.type === "deposit" ? +c.amt : -c.amt;
  for (const t of tr) {
    const amt = t.qty * t.price;
    const p = pos[t.code] || (pos[t.code] = { code: t.code, name: t.name, qty: 0, cost: 0, realized: 0 });
    if (t.name) p.name = t.name;
    if (t.side === "buy") {
      const total = amt + (+t.fee || 0);
      cash -= total; p.cost += total; p.qty += t.qty;
    } else {
      const net = amt - (+t.fee || 0) - (+t.tax || 0);
      cash += net;
      const avg = p.qty ? p.cost / p.qty : 0;
      const basis = avg * Math.min(t.qty, p.qty);
      const pl = net - basis;
      p.realized += pl; realized += pl;
      p.cost -= basis; p.qty -= t.qty;
      if (p.qty <= 0) { p.qty = 0; p.cost = 0; }
      plById[t.id] = pl;
    }
  }
  const list = Object.values(pos).map((p) => {
    const px = priceOf(p.code);
    return { ...p, avg: p.qty ? p.cost / p.qty : 0, px, mv: px != null ? px * p.qty : null };
  });
  return { cash, realized, holdings: list.filter((p) => p.qty > 0), all: list, plById };
}

// ---------- 裝置同步：合併 ----------
// 每筆資料帶 ts（最後修改時間），刪除會留下 tomb（墓碑）紀錄，兩邊合併時取較新的一方。
const COLS = { watch: (x) => "w:" + x.code, accounts: (x) => "a:" + x.id, trades: (x) => "t:" + x.id, cash: (x) => "c:" + x.id, notes: (x) => "n:" + x.id };
const TOMB_DAYS = 365;

export function normalizeState(x, starter) {
  const b = starter();
  if (!x || typeof x !== "object") return b;
  const arr = (k) => (Array.isArray(x[k]) ? x[k].filter((i) => i && typeof i === "object") : b[k]);
  const s = {
    v: 2,
    watch: arr("watch").filter((w) => typeof w.code === "string" && w.code),
    accounts: arr("accounts").filter((a) => a.id),
    trades: arr("trades").filter((t) => t.id && t.code && t.time && (t.side === "buy" || t.side === "sell")),
    cash: arr("cash").filter((c) => c.id && c.time),
    notes: arr("notes").filter((n) => n.id),
    tomb: x.tomb && typeof x.tomb === "object" ? { ...x.tomb } : {},
  };
  if (!s.accounts.length) s.accounts = b.accounts;
  return s;
}

export function mergeState(a, b) {
  const tomb = { ...(a.tomb || {}) };
  for (const [k, t] of Object.entries(b.tomb || {})) tomb[k] = Math.max(tomb[k] || 0, t);
  const out = { v: 2, tomb };
  for (const [col, keyOf] of Object.entries(COLS)) {
    const map = new Map();
    const order = [];
    for (const src of [a[col] || [], b[col] || []]) {
      for (const it of src) {
        const k = keyOf(it);
        const cur = map.get(k);
        if (!cur) { map.set(k, it); order.push(k); }
        else if ((it.ts || 0) > (cur.ts || 0)) map.set(k, it);
      }
    }
    out[col] = order.map((k) => map.get(k)).filter((it) => !(tomb[keyOf(it)] >= (it.ts || 0)));
  }
  if (!out.accounts.length) out.accounts = a.accounts?.length ? a.accounts : b.accounts;
  const cutoff = Date.now() - TOMB_DAYS * 864e5;
  for (const [k, t] of Object.entries(out.tomb)) if (t < cutoff) delete out.tomb[k];
  return out;
}

const stable = (v) => Array.isArray(v) ? "[" + v.map(stable).join(",") + "]"
  : v && typeof v === "object" ? "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}"
  : JSON.stringify(v ?? null);

/** 與順序無關的比較用字串。 */
export function canon(s) {
  const o = { tomb: s.tomb || {} };
  for (const [col, keyOf] of Object.entries(COLS)) o[col] = (s[col] || []).map((x) => [keyOf(x), x]).sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));
  return stable(o);
}

export const tombKey = (col, item) => COLS[col](item);
