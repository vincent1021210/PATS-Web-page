# PATS · 企業級商務通訊

前端是**託管在 GitHub Pages 的純靜態網站**，後端與資料庫是 **Google Apps Script + Google 試算表**。
登入支援自建帳密與 Google 登入，介面為手刻 CSS 並完整支援 RWD。

```
瀏覽器 ── HTTPS ──▶ GitHub Pages（HTML / CSS / JS）
   │
   └── fetch POST ──▶ Apps Script /exec ──▶ Google 試算表
```

---

## 專案結構

```
web/                      ← 部署到 GitHub Pages 的靜態網站
├── index.html
├── .nojekyll             （避免 GitHub Pages 用 Jekyll 處理檔案）
└── assets/
    ├── css/styles.css    設計系統與 RWD
    └── js/
        ├── config.js     ★ 唯一需要你手動修改的檔案
        ├── core.js       狀態、rpc()、共用 UI（toast / modal / menu）
        ├── auth.js       帳密登入、Google 登入、登出
        ├── chat.js       對話列表與訊息畫面
        ├── settings.js   設定區三個子畫面
        └── main.js       啟動流程與畫面切換

apps-script/              ← 部署成 Apps Script 網頁應用程式（API）
├── appsscript.json       資訊清單：執行身分、權限範圍
├── Code.gs               doPost 進入點與 apiCall 路由
├── Auth.gs               密碼雜湊、工作階段、Google ID Token 驗證
├── Db.gs                 試算表資料層（schema、CRUD、鎖、快取）
└── Api.gs                對話 / 訊息 / 聯絡人 / 封存 / 設定的商業邏輯

.github/workflows/deploy-pages.yml   推上 main 就自動發佈前端
```

### 資料表（自動建立於「PATS 資料庫」試算表）

`users`、`sessions`、`contacts`、`conversations`、`participants`、`messages`

---

## 部署步驟

順序很重要：**先部署後端拿到網址，再設定前端**。

### 第一步 — 部署 Apps Script 後端

用 [clasp](https://github.com/google/clasp)：

```bash
npm install -g @google/clasp
clasp login
clasp create --title "PATS API" --type webapp
# 把產生的 scriptId 填進 .clasp.json（可複製 .clasp.json.example），
# 並確認 rootDir 是 "apps-script"
clasp push
```

或手動：在 [script.google.com](https://script.google.com) 建立專案，把 `apps-script/`
內的四個 `.gs` 檔依相同檔名貼上，並在「專案設定」勾選顯示 `appsscript.json` 後一併貼上。

接著在編輯器中依序執行兩個函式：

1. `setup()` — 建立試算表與所有工作表，回傳試算表網址。
2. `createAdminAccount()` — 建立第一個帳號。
   **請先修改函式內的 email 與密碼**，預設是 `pats.admin@messenger.com` / `ChangeMe!2026`。

然後「部署」→「新增部署作業」→ 類型選「網頁應用程式」：

| 設定 | 值 | 為什麼 |
| --- | --- | --- |
| 執行身分 | **我** | 所有使用者共用同一份試算表資料庫 |
| 具有存取權的使用者 | **任何人** | 前端在別的網域，必須允許匿名呼叫 |

複製產生的 `.../exec` 網址備用。用瀏覽器直接打開它應該會看到
`{"ok":true,"data":{"app":"PATS","status":"ready",...}}`，代表後端正常。

> **每次改完後端程式碼，都要「管理部署作業」→ 編輯 → 版本選「新版本」再儲存**，
> 否則線上跑的還是舊版。

### 第二步 — 設定 Google 登入（選填）

不做這一步時，登入頁會顯示「僅開放帳密登入」，其餘功能不受影響。

1. 到 [Google Cloud Console → 憑證](https://console.cloud.google.com/apis/credentials)
   建立 **OAuth 用戶端 ID**，類型選「網頁應用程式」。
2. 在「**已授權的 JavaScript 來源**」加入你的前端網域，例如
   `https://your-name.github.io`（本機測試再加 `http://localhost:8080`）。
   這裡**不需要**填重新導向 URI。
3. 回到 Apps Script →「專案設定」→「指令碼屬性」，新增
   `GOOGLE_CLIENT_ID` = 剛剛的用戶端 ID。
4. 重新部署一次後端。

用 Google 登入的人若尚未有 PATS 帳號，系統會自動建立。

### 第三步 — 設定並發佈前端

編輯 `web/assets/js/config.js`：

```js
var PATS_CONFIG = {
  apiUrl: 'https://script.google.com/macros/s/AKfycb...../exec',
  googleClientId: '1234567890-abcdefg.apps.googleusercontent.com'  // 沒設定就留空字串
};
```

推上 GitHub：

```bash
git init
git add .
git commit -m "PATS 初版"
git branch -M main
git remote add origin https://github.com/<你的帳號>/<repo>.git
git push -u origin main
```

到 GitHub repo →「Settings」→「Pages」→ Source 選 **GitHub Actions**。
`.github/workflows/deploy-pages.yml` 會自動把 `web/` 發佈出去，
網址是 `https://<你的帳號>.github.io/<repo>/`。

> 若你偏好不用 Actions，也可以在 Pages 設定選「Deploy from a branch」，
> 但 GitHub 只允許根目錄或 `/docs`，那就要把 `web/` 改名成 `docs/`。

### 本機預覽

```bash
cd web
python -m http.server 8080
# 開 http://localhost:8080
```

請用 http server 而不是直接雙擊 `index.html`，`file://` 協定會讓
跨網域請求與 Google 登入都失敗。

---

## 為什麼前端是這樣呼叫後端的

`core.js` 裡的 `rpc()` 用 `Content-Type: text/plain` 送 JSON 字串，看起來有點怪，
但這是必要的：**Apps Script 的網頁應用程式不會回應 CORS 預檢（OPTIONS）請求**。
只要帶了 `application/json`，瀏覽器就會先發預檢，然後整個請求失敗。
`text/plain` 屬於「簡單請求」不觸發預檢，後端 `doPost` 再自己解析 body。

如果你之後要改這裡，請保留這個 header，否則跨網域呼叫會全部壞掉。

---

## 使用方式

1. 以管理員帳號登入，或用 Google 登入（首次登入會自動建立帳號）。
2. 在「私訊」按右上角的新增圖示 →「邀請朋友」，輸入對方的電子郵件即可建立對話。
   對方必須已經在 PATS 註冊過（用 Google 登入過一次即可）。
3. 在「群組討論」建立群組，成員欄位可用逗號分隔多筆帳號。
4. 對話項目按右鍵（或右上角「更多」）可封存 / 取消封存。
5. 設定區有三個子頁：封存時間設定、帳號安全設定、帳號切換與登入。

---

## 響應式行為

| 視窗寬度 | 版面 |
| --- | --- |
| > 1100px | 三欄：導覽列（含文字）＋ 對話列表 ＋ 對話內容 |
| 721–1100px | 三欄，導覽列收合為圖示 |
| ≤ 720px | 單欄堆疊，導覽列移到底部；列表與對話用返回鍵切換 |

登入頁在 720px 以下由左右分割改為上下堆疊。

---

## 安全性說明

- 密碼以 **HMAC-SHA256 加鹽並迭代 1200 次**儲存，比對時使用定值時間比較。
- Google ID Token 一律交給 Google 的 tokeninfo 端點驗簽，並在後端比對
  `aud`、`iss`、`exp`，不採信前端自行解出的內容。
- 工作階段權杖存在 `sessions` 工作表，預設 12 小時；勾選「保持登入狀態」為 30 天。
- 所有需要身分的 API 都在後端重新驗證權杖與對話成員資格，前端無法繞過。
- `config.js` 裡的用戶端 ID 本來就是公開資訊，可以安全地放進 repo；
  **但用戶端密鑰（client secret）絕對不要放進來**，這個架構也不需要它。
- 試算表本身請勿設為公開共用，資料只透過 API 存取。

---

## 已知限制

- Apps Script 沒有 WebSocket，訊息以 6 秒輪詢更新。
- 試算表適合中小型團隊；訊息量很大時建議改接 Firestore 或 Cloud SQL。
- Apps Script 網頁應用程式有每日執行時間配額，輪詢頻率請視使用人數調整
  （在 `chat.js` 的 `POLL_INTERVAL_MS`）。
- 未實作檔案／圖片上傳，`messages.kind` 已預留欄位可擴充。
