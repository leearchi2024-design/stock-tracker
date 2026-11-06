// 把 Google Cloud 建立的「OAuth 用戶端 ID」貼在下面引號裡（不是密碼，放在公開網頁上沒關係）。
// 也可以不改這個檔，直接在 APP「我的帳號 → 雲端同步 → 首次設定」貼上。
window.STOCK_APP_CONFIG = {
  // 即時報價與新聞的轉送網址（Cloudflare Worker，例如 https://stock-live.你的名字.workers.dev）。留空就只用 GitHub 每 5 分鐘的資料。
  liveApi: "",
  googleClientId: "164580792310-nb2icpauue7l2pdbjeelqp2rp7j7qjt2.apps.googleusercontent.com",
};
