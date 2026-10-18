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
   * 語音通話信令（Node + Socket.io，不是 Apps Script）。
   *
   * 本機／同 Wi‑Fi：'http://192.168.x.x:3001'
   * GitHub Pages（HTTPS）必須用 https：
   *   - 臨時：後端跑 voip/一鍵啟動.bat（localtunnel）
   *   - 正式 $0：照 voip/oracle-free/部署說明.txt 架 Oracle + Caddy
   *     例如 'https://pats-call.duckdns.org'
   * 也可在 App「通話設定」覆寫，不必改此檔。
   */
  signalingUrl: 'http://192.168.1.68:3001',

  /**
   * STUN／TURN。同網段通常只要 Google STUN。
   * Oracle + Coturn 部署後加上（網域與密碼見 oracle-free/.env）：
   *   { urls: 'stun:pats-call.duckdns.org:3478' },
   *   { urls: 'turn:pats-call.duckdns.org:3478', username: 'pats', credential: '你的密碼' }
   */
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
    // { urls: 'turn:pats-call.duckdns.org:3478', username: 'pats', credential: 'please-change-this-password' }
  ]
};
