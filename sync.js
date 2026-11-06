// Google 帳號登入與雲端同步。
// 資料存在你 Google 雲端的「應用程式專用資料夾」(appDataFolder)：
// 在雲端硬碟裡看不到、其他 APP 讀不到，這個 APP 也只能存取它自己建立的檔案。
const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const FILE = "stock-tracker-data.json";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

const err = (code, message = code) => Object.assign(new Error(message), { code });
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

let token = null, tokenExp = 0, fileId = null;

export function clientId() {
  return (lsGet("st.clientId") || window.STOCK_APP_CONFIG?.googleClientId || "").trim();
}
export function setClientId(v) { lsSet("st.clientId", v ? v.trim() : null); }
export const wasSignedIn = () => lsGet("st.signedIn") === "1";
export const hasToken = () => !!token && Date.now() < tokenExp;
export const gisLoaded = () => !!window.google?.accounts?.oauth2;

/** 必須在按鈕的 click 事件裡直接呼叫，否則瀏覽器會擋掉登入視窗。 */
export function signIn() {
  return new Promise((resolve, reject) => {
    const id = clientId();
    if (!id) return reject(err("no_client", "還沒設定 Google 用戶端 ID"));
    if (!gisLoaded()) return reject(err("gis_not_loaded", "Google 登入元件沒有載入，請檢查網路後重新整理"));
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) return reject(err(r.error));
        if (!window.google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) return reject(err("scope_denied", "需要勾選「查看及管理這個應用程式的設定資料」才能同步"));
        token = r.access_token;
        tokenExp = Date.now() + (Number(r.expires_in || 3600) - 120) * 1000;
        lsSet("st.signedIn", "1");
        resolve();
      },
      error_callback: (e) => reject(err(e?.type || "popup_failed", e?.type === "popup_closed" ? "登入視窗被關閉" : "登入視窗無法開啟，請允許此網站的彈出式視窗")),
    });
    client.requestAccessToken({ prompt: wasSignedIn() ? "" : "consent" });
  });
}

export function signOut() {
  if (token && gisLoaded()) { try { window.google.accounts.oauth2.revoke(token, () => {}); } catch {} }
  token = null; tokenExp = 0; fileId = null;
  lsSet("st.signedIn", null);
}

async function api(url, opts = {}) {
  if (!hasToken()) throw err("auth_expired", "登入已過期");
  let r;
  try {
    r = await fetch(url, { ...opts, headers: { Authorization: "Bearer " + token, ...(opts.headers || {}) } });
  } catch { throw err("offline", "連不上 Google，請檢查網路"); }
  if (r.status === 401) { token = null; throw err("auth_expired", "登入已過期"); }
  if (r.status === 403) throw err("forbidden", "Google 拒絕存取（可能是權限沒勾選或用量超過）");
  if (!r.ok) throw err("http_" + r.status, `Google 雲端回應錯誤 ${r.status}`);
  return r;
}

/** 讀取雲端檔案；沒有檔案回傳 null。 */
export async function download() {
  const q = encodeURIComponent(`name='${FILE}'`);
  const list = await (await api(`${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc&pageSize=5`)).json();
  const f = list.files?.[0];
  if (!f) { fileId = null; return null; }
  fileId = f.id;
  return (await api(`${DRIVE}/files/${f.id}?alt=media`)).text();
}

export async function upload(text) {
  if (fileId) {
    await api(`${UPLOAD}/files/${fileId}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: text });
    return;
  }
  const b = "st" + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name: FILE, parents: ["appDataFolder"], mimeType: "application/json" });
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${b}--`;
  const r = await (await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${b}` }, body })).json();
  fileId = r.id;
}

// ---------- 選用：同步密碼加密（AES-GCM，金鑰由 PBKDF2-SHA256 31 萬次推導） ----------
const te = new TextEncoder(), td = new TextDecoder();
const ITER = 310000;
const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
let keyCache = { pass: null, salt: null, key: null };

async function keyFor(pass, salt, iter = ITER) {
  const sk = toB64(salt);
  if (keyCache.pass === pass && keyCache.salt === sk && keyCache.iter === iter) return keyCache.key;
  const base = await crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  keyCache = { pass, salt: sk, iter, key };
  return key;
}

/** 物件 → 要存到雲端或備份檔的文字。有密碼就加密。 */
export async function seal(obj, pass) {
  if (!pass) return JSON.stringify({ format: "stock-tracker", v: 2, savedAt: new Date().toISOString(), data: obj });
  const salt = keyCache.pass === pass && keyCache.salt ? fromB64(keyCache.salt) : crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(pass, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(obj))));
  return JSON.stringify({ format: "stock-tracker", v: 2, savedAt: new Date().toISOString(), enc: "AES-GCM/PBKDF2-SHA256", iter: ITER, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) });
}

/** 文字 → 物件。加密過但沒密碼丟 need_pass，密碼錯丟 bad_pass。 */
export async function open(text, pass) {
  let j;
  try { j = JSON.parse(text); } catch { throw err("bad_file", "檔案格式不正確"); }
  if (!j || typeof j !== "object") throw err("bad_file", "檔案格式不正確");
  if (!j.enc) return j.format === "stock-tracker" ? j.data : j;
  if (!pass) throw err("need_pass", "雲端資料已加密，請輸入同步密碼");
  try {
    const salt = fromB64(j.salt);
    const key = await keyFor(pass, salt, Number(j.iter) || ITER);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(j.iv) }, key, fromB64(j.ct));
    return JSON.parse(td.decode(pt));
  } catch { throw err("bad_pass", "同步密碼不正確"); }
}

export const isEncrypted = (text) => { try { return !!JSON.parse(text).enc; } catch { return false; } };
