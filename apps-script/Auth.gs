/**
 * PATS — 認證
 *
 * 支援兩種登入方式：
 *   1. 自建帳密（users 工作表，HMAC-SHA256 加鹽雜湊）
 *   2. Google 登入（前端用 Google Identity Services 取得 ID Token，
 *      後端驗證簽章與 aud 之後建立帳號）
 *
 * 兩種方式都會換成同一種 PATS 工作階段權杖（sessions 工作表）。
 */

var SESSION_TTL_MS = 12 * 60 * 60 * 1000;               // 12 小時
var SESSION_REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
var PASSWORD_ITERATIONS = 1200;

/* ------------------------------------------------------------------ 密碼 */

function hashPassword_(password, salt) {
  var digest = String(password) + '::' + salt;
  for (var i = 0; i < PASSWORD_ITERATIONS; i++) {
    digest = Utilities.base64Encode(
      Utilities.computeHmacSha256Signature(digest, salt)
    );
  }
  return digest;
}

function newSalt_() {
  return Utilities.base64Encode(Utilities.getUuid() + Utilities.getUuid());
}

/** 定值時間比較，避免以回應時間推測雜湊值。 */
function safeEqual_(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------------------------------------------------------------- 工作階段 */

function createSession_(userId, remember) {
  var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  var ttl = remember ? SESSION_REMEMBER_TTL_MS : SESSION_TTL_MS;
  dbInsert_('sessions', {
    token: token,
    userId: userId,
    createdAt: nowIso_(),
    expiresAt: new Date(Date.now() + ttl).toISOString(),
    userAgent: ''
  });
  dbUpdate_('users', userId, { lastSeenAt: nowIso_() });
  return token;
}

function resolveSession_(token) {
  if (!token) return null;
  var session = dbFind_('sessions', function (s) { return s.token === token; });
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    dbDelete_('sessions', session.token);
    return null;
  }
  var user = dbGet_('users', session.userId);
  if (!user || user.status === 'disabled') return null;
  return user;
}

function requireUser_(token) {
  var user = resolveSession_(token);
  if (!user) throw new Error('AUTH_REQUIRED');
  return user;
}

function destroySession_(token) {
  if (token) dbDelete_('sessions', token);
}

/** 清掉過期的工作階段，可掛在每日觸發程序上。 */
function purgeExpiredSessions() {
  var now = Date.now();
  dbAll_('sessions')
    .filter(function (s) { return new Date(s.expiresAt).getTime() < now; })
    .forEach(function (s) { dbDelete_('sessions', s.token); });
}

/* -------------------------------------------------------------- 使用者 */

function publicUser_(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName || user.username || user.email,
    avatarUrl: user.avatarUrl || '',
    provider: user.provider || 'password',
    settings: Object.assign({}, DEFAULT_USER_SETTINGS, parseJson_(user.settings, {}))
  };
}

function findUserByAccount_(account) {
  var key = String(account || '').trim().toLowerCase();
  if (!key) return null;
  return dbFind_('users', function (u) {
    return String(u.email).toLowerCase() === key ||
           String(u.username).toLowerCase() === key;
  });
}

function createUser_(fields) {
  var email = String(fields.email || '').trim().toLowerCase();
  if (!email) throw new Error('EMAIL_REQUIRED');
  if (findUserByAccount_(email)) throw new Error('EMAIL_TAKEN');

  var salt = newSalt_();
  return dbInsert_('users', {
    id: newId_(),
    email: email,
    username: fields.username || email.split('@')[0],
    displayName: fields.displayName || fields.username || email.split('@')[0],
    avatarUrl: fields.avatarUrl || '',
    passwordHash: fields.password ? hashPassword_(fields.password, salt) : '',
    passwordSalt: salt,
    provider: fields.provider || 'password',
    status: 'active',
    settings: JSON.stringify(DEFAULT_USER_SETTINGS),
    createdAt: nowIso_(),
    lastSeenAt: nowIso_()
  });
}

/**
 * 建立第一位管理員帳號。
 *
 * 帳號密碼讀自「專案設定 → 指令碼屬性」，不寫在程式碼裡——因為這份程式碼
 * 會推到公開的 git repo。需要的屬性：
 *   ADMIN_EMAIL     必填，登入用的電子郵件
 *   ADMIN_PASSWORD  必填，至少 8 個字元
 *   ADMIN_NAME      選填，顯示名稱，預設取電子郵件的帳號部分
 *
 * 建立成功後會自動刪掉 ADMIN_PASSWORD，避免明文密碼留在專案屬性中。
 */
function createAdminAccount() {
  var props = PropertiesService.getScriptProperties();
  var email = (props.getProperty('ADMIN_EMAIL') || '').trim();
  var password = props.getProperty('ADMIN_PASSWORD') || '';
  var name = (props.getProperty('ADMIN_NAME') || '').trim();

  if (!email || !password) {
    throw new Error(
      '請先到「專案設定 → 指令碼屬性」新增 ADMIN_EMAIL 與 ADMIN_PASSWORD 兩個屬性，再執行一次。'
    );
  }
  if (password.length < 8) {
    throw new Error('ADMIN_PASSWORD 至少需要 8 個字元，請改長一點再執行一次。');
  }

  setup();
  var user = createUser_({
    email: email,
    username: name || email.split('@')[0],
    displayName: name || email.split('@')[0],
    password: password,
    provider: 'password'
  });

  props.deleteProperty('ADMIN_PASSWORD');

  return '已建立管理員帳號：' + user.email +
         '。ADMIN_PASSWORD 屬性已自動刪除，請用這組帳密登入 PATS。';
}

/* ------------------------------------------------------------- 帳密登入 */

function authLogin_(payload) {
  var user = findUserByAccount_(payload.account);
  if (!user || !user.passwordHash) throw new Error('INVALID_CREDENTIALS');
  var hash = hashPassword_(payload.password, user.passwordSalt);
  if (!safeEqual_(hash, user.passwordHash)) throw new Error('INVALID_CREDENTIALS');
  return {
    token: createSession_(user.id, !!payload.remember),
    user: publicUser_(user)
  };
}

/* --------------------------------------------------------------- 註冊 */

/**
 * 邀請碼。設定「指令碼屬性」的 REGISTRATION_CODE 之後，註冊就需要輸入它；
 * 沒設定則開放任何人註冊。因為 /exec 是匿名可存取的端點，
 * 正式對外使用時建議設定。
 */
function registrationCode_() {
  return (PropertiesService.getScriptProperties()
    .getProperty('REGISTRATION_CODE') || '').trim();
}

/**
 * 產生不重複的帳號名稱。顯示名稱允許重複（同名同姓很正常），
 * 但 username 必須唯一，否則登入時無法區分是哪一個人。
 */
function uniqueUsername_(base) {
  var seed = String(base || 'user').replace(/[^a-zA-Z0-9._-]/g, '').toLowerCase() || 'user';
  var candidate = seed;
  var suffix = 1;
  while (dbFind_('users', function (u) {
    return String(u.username).toLowerCase() === candidate;
  })) {
    suffix++;
    candidate = seed + suffix;
  }
  return candidate;
}

function authRegister_(payload) {
  var code = registrationCode_();
  if (code) {
    var provided = String(payload.inviteCode || '').trim();
    if (!provided) throw new Error('INVITE_CODE_REQUIRED');
    if (!safeEqual_(provided, code)) throw new Error('INVITE_CODE_INVALID');
  }

  var email = String(payload.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('EMAIL_INVALID');

  var displayName = String(payload.displayName || '').trim();
  if (displayName.length < 2) throw new Error('USERNAME_TOO_SHORT');
  if (displayName.length > 40) throw new Error('USERNAME_TOO_LONG');

  var password = String(payload.password || '');
  if (password.length < 8) throw new Error('WEAK_PASSWORD');

  // createUser_ 會在信箱重複時丟出 EMAIL_TAKEN
  var user = createUser_({
    email: email,
    username: uniqueUsername_(email.split('@')[0]),
    displayName: displayName,
    password: password,
    provider: 'password'
  });

  return {
    token: createSession_(user.id, !!payload.remember),
    user: publicUser_(user)
  };
}

function authChangePassword_(user, payload) {
  if (user.passwordHash) {
    var current = hashPassword_(payload.currentPassword, user.passwordSalt);
    if (!safeEqual_(current, user.passwordHash)) throw new Error('WRONG_PASSWORD');
  }
  if (!payload.newPassword || String(payload.newPassword).length < 8) {
    throw new Error('WEAK_PASSWORD');
  }
  var salt = newSalt_();
  dbUpdate_('users', user.id, {
    passwordHash: hashPassword_(payload.newPassword, salt),
    passwordSalt: salt
  });
  return true;
}

/* ------------------------------------------------------- Google 登入 */

function googleClientId_() {
  return PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID') || '';
}

/**
 * 驗證前端送來的 Google ID Token 並建立工作階段。
 *
 * 交給 Google 的 tokeninfo 端點驗簽，再自行比對 aud / iss / exp。
 * 只信任 tokeninfo 的回應，不直接採用前端解出來的內容。
 */
function authGoogleLogin_(payload) {
  var clientId = googleClientId_();
  if (!clientId) throw new Error('GOOGLE_LOGIN_NOT_CONFIGURED');

  var credential = String(payload.credential || '');
  if (!credential) throw new Error('GOOGLE_TOKEN_MISSING');

  var res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential),
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) throw new Error('GOOGLE_TOKEN_INVALID');

  var claims = parseJson_(res.getContentText(), {});
  if (String(claims.aud) !== clientId) throw new Error('GOOGLE_AUDIENCE_MISMATCH');
  if (['accounts.google.com', 'https://accounts.google.com'].indexOf(String(claims.iss)) < 0) {
    throw new Error('GOOGLE_ISSUER_MISMATCH');
  }
  if (Number(claims.exp) * 1000 < Date.now()) throw new Error('GOOGLE_TOKEN_EXPIRED');
  if (!claims.email || String(claims.email_verified) !== 'true') {
    throw new Error('GOOGLE_EMAIL_UNVERIFIED');
  }

  var email = String(claims.email).toLowerCase();
  var user = findUserByAccount_(email);
  if (!user) {
    user = createUser_({
      email: email,
      username: claims.name || email.split('@')[0],
      displayName: claims.name || email.split('@')[0],
      avatarUrl: claims.picture || '',
      provider: 'google'
    });
  } else if (claims.picture && !user.avatarUrl) {
    dbUpdate_('users', user.id, { avatarUrl: claims.picture });
    user.avatarUrl = claims.picture;
  }

  return {
    token: createSession_(user.id, true),
    user: publicUser_(user)
  };
}
