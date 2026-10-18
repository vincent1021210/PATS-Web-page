/* =====================================================================
   PATS — 部署設定
   =====================================================================
   這是整個前端唯一需要你手動修改的檔案。
   兩個值都填好之後，前端就能連上你自己的 Apps Script 後端。
   ===================================================================== */

var PATS_CONFIG = {

  /**
   * Apps Script 網頁應用程式的 /exec 網址。
   * 取得方式：Apps Script 編輯器 →「部署」→「新增部署作業」→「網頁應用程式」，
   * 執行身分選「我」、存取權限選「任何人」，複製產生的網址貼在這裡。
   *
   * 範例：'https://script.google.com/macros/s/AKfycb.../exec'
   */
  apiUrl: 'https://script.google.com/macros/s/AKfycbzNkhCXzywXo6dxazgRCmB2JnEkLqV2XMVAlP0umwQpLZ6WrD6RcIYCqAjrj9sxFCW33Q/exec',

  /**
   * Google 用戶端 ID（選填）。
   * 留空時「使用 Google 登入」會停用，帳密登入仍可正常使用。
   *
   * 取得方式：Google Cloud Console →「憑證」→ 建立 OAuth 用戶端 ID →
   * 類型選「網頁應用程式」，並在「已授權的 JavaScript 來源」加入你的
   * GitHub Pages 網域（例如 https://your-name.github.io）。
   *
   * 範例：'1234567890-abcdefg.apps.googleusercontent.com'
   */
  googleClientId: '354935544437-1vrje0je178afce6nturpghuu5r16qp6.apps.googleusercontent.com',

  /**
   * 語音通話的信令伺服器（跑在「另一台電腦」上的 Node，不是 Apps Script）。
   * 另一台電腦：複製整個 voip/ 資料夾 → npm install → npm start
   * 然後把下面改成那台的位址，例如：
   *   同網段測試：'http://192.168.1.50:3001'
   *   正式／GitHub Pages（HTTPS 頁面）必須用 wss，例如 Cloudflare Tunnel：
   *   'https://pats-signal.example.com'
   * 留空字串會停用語音按鈕的連線。
   */
  signalingUrl: 'http://192.168.1.68:3001',

  /**
   * STUN 用來找得到對方；跨網段或公司防火牆後還需要自己的 TURN。
   * 架好 Coturn 後，把下面註解打開並改成你的主機。帳密會出現在網頁裡，
   * 只拿來當中繼認證，不要用在別的系統。
   */
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
    // { urls: 'turn:YOUR_PUBLIC_IP:3478', username: 'pats', credential: 'change-this-password' }
  ]
};
