# 股票追蹤器

依 Notion「股票追蹤器／分析要點」的四個面向（技術面、籌碼面、基本面、消息面）整理台股資料、給出買賣參考，並記錄自己的買入賣出。

- 網址：https://leearchi2024-design.github.io/stock-tracker/
- 訊號依規則自動整理，僅供參考，不構成投資建議。

## 資料放在哪裡

| 資料 | 位置 | 誰看得到 |
| --- | --- | --- |
| 程式碼 | 這個 GitHub repo | 公開 |
| 股價、法人、月營收、新聞 | GitHub Pages 的 `data/`（由 Actions 產生，不進 git 紀錄） | 公開（本來就是公開資訊） |
| 帳戶、買賣紀錄、觀察清單、筆記 | 你的瀏覽器＋你自己 Google 雲端的「應用程式專用資料夾」 | 只有你 |

雲端資料可另外設「同步密碼」用 AES-GCM 加密，忘記密碼就無法還原。

## 自動更新時間（台灣時間，平日）

| 時間 | 內容 |
| --- | --- |
| 08:17（週一到週六） | 美股收盤、費半、台積電 ADR、新聞 |
| 14:43 | 上市櫃收盤價、成交量 |
| 16:38 | 三大法人買賣超、本益比 |
| 22:47 | 融資餘額、晚間新聞 |

GitHub 排程尖峰時段可能延遲數分鐘到一小時。第一次執行會自動補抓約 70 個交易日的上市歷史資料（上櫃若抓不到，會從第一天開始每天累積）。

資料來源：臺灣證券交易所 OpenAPI／網站、證券櫃檯買賣中心 OpenAPI、Yahoo Finance、Google 新聞 RSS、Yahoo 股市 RSS。各來源每次的成功與否，可在 APP「重大新聞 → 自動資料更新狀態」查看。

## 第一次設定

1. **開啟 GitHub Pages**：repo 的 Settings → Pages → Build and deployment → Source 選 **GitHub Actions**。
2. **跑第一次**：Actions → 「更新股市資料並發布」→ Run workflow。約 10 分鐘（補抓歷史資料）。
3. **建立 Google 用戶端 ID**（雲端同步用）：
   1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案（名稱例如 `stock-tracker`）。
   2. 「API 和服務 → 程式庫」搜尋並啟用 **Google Drive API**。
   3. 「API 和服務 → OAuth 同意畫面」：使用者類型選「外部」，填 APP 名稱與你的 Email；範圍（Scopes）加入 `.../auth/drive.appdata`；測試使用者加入你自己的 Gmail。
   4. 「API 和服務 → 憑證 → 建立憑證 → OAuth 用戶端 ID」：類型選「網頁應用程式」，「已授權的 JavaScript 來源」填 `https://leearchi2024-design.github.io`。
   5. 複製用戶端 ID，貼到 APP「我的帳號 → 首次設定」，或寫進 `config.js`。
4. 手機、電腦都打開網址，按「用 Google 帳號登入」就會同步。

## 本機測試

```
node scripts/test.mjs          # 離線測試解析、帳務、同步合併
node scripts/fetch-data.mjs _site/data   # 實際抓一次資料（需要網路）
```

## 檔案

- `index.html`、`style.css`、`app.js`：APP 畫面與邏輯
- `core.js`：技術指標、手續費、帳務、兩台裝置資料合併
- `sync.js`：Google 登入、雲端讀寫、加密
- `scripts/fetch-data.mjs`、`scripts/lib.mjs`：抓公開資料
- `.github/workflows/update.yml`：排程與部署
