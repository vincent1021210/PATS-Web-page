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

/* ------------------------------------------------------------------ 身分 */

/**
 * 三種身分與各自允許的信箱網域。註冊時只認這些網域，
 * 所以身分不是使用者自己說了算，而是由學校配發的信箱決定。
 */
var ROLES = {
  student: { label: '學生', domains: ['smail.hc.edu.tw'] },
  teacher: { label: '老師', domains: ['lsps.hc.edu.tw', 'tmail.hc.edu.tw'] },
  parent: { label: '家長', domains: ['gmail.com'] }
};

function emailDomain_(email) {
  return String(email || '').trim().toLowerCase().split('@')[1] || '';
}

/** 由信箱網域反推身分，認不出來時回傳空字串。 */
function roleOfEmail_(email) {
  var domain = emailDomain_(email);
  var found = '';
  Object.keys(ROLES).forEach(function (role) {
    if (!found && ROLES[role].domains.indexOf(domain) >= 0) found = role;
  });
  return found;
}

/** 舊資料沒有 role 欄位，用信箱推回去，再不行就當學生。 */
function roleOf_(user) {
  return String(user.role || '') || roleOfEmail_(user.email) || 'student';
}

/* -------------------------------------------------------------- 使用者 */

function publicUser_(user) {
  var role = roleOf_(user);
  var out = {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName || user.username || user.email,
    avatarUrl: user.avatarUrl || '',
    provider: user.provider || 'password',
    role: role,
    roleLabel: ROLES[role] ? ROLES[role].label : role,
    canChat: role !== 'parent',
    linkedStudent: null,
    settings: Object.assign({}, DEFAULT_USER_SETTINGS, parseJson_(user.settings, {}))
  };

  if (role === 'parent' && user.linkedStudentId) {
    var student = dbGet_('users', user.linkedStudentId);
    if (student) {
      out.linkedStudent = {
        id: student.id,
        name: student.displayName || student.username,
        email: student.email
      };
    }
  }
  return out;
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
    lastSeenAt: nowIso_(),
    role: fields.role || roleOfEmail_(email) || 'student',
    linkedStudentId: fields.linkedStudentId || ''
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

var SIGNUP_CODE_TTL_MS = 15 * 60 * 1000;
var SIGNUP_MAX_ATTEMPTS = 5;
var SIGNUP_RESEND_COOLDOWN_MS = 60 * 1000;

/** 註冊資料的共同檢查，寄驗證碼與真正建立帳號兩段都會用到。 */
function validateSignup_(payload) {
  var code = registrationCode_();
  if (code) {
    var provided = String(payload.inviteCode || '').trim();
    if (!provided) throw new Error('INVITE_CODE_REQUIRED');
    if (!safeEqual_(provided, code)) throw new Error('INVITE_CODE_INVALID');
  }

  var role = String(payload.role || '').trim();
  if (!ROLES[role]) throw new Error('ROLE_REQUIRED');

  var email = String(payload.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('EMAIL_INVALID');
  // 前端是把網域接在帳號後面組出信箱的，帳號那段混進 @ 或空白就會組出怪東西。
  if (!/^[a-z0-9._%+-]+$/.test(email.split('@')[0])) throw new Error('EMAIL_LOCAL_INVALID');
  if (ROLES[role].domains.indexOf(emailDomain_(email)) < 0) {
    throw new Error('EMAIL_DOMAIN_MISMATCH');
  }
  if (findUserByAccount_(email)) throw new Error('EMAIL_TAKEN');

  var displayName = String(payload.displayName || '').trim();
  if (displayName.length < 2) throw new Error('USERNAME_TOO_SHORT');
  if (displayName.length > 40) throw new Error('USERNAME_TOO_LONG');

  // 家長必須掛在一個已註冊的學生底下，否則不知道要看誰的紀錄。
  var studentId = '';
  if (role === 'parent') {
    var account = String(payload.studentAccount || '').trim().toLowerCase();
    if (!account) throw new Error('STUDENT_ACCOUNT_REQUIRED');
    // 只填帳號名稱時補上學生網域，家長不必自己打完整信箱。
    if (account.indexOf('@') < 0) account += '@' + ROLES.student.domains[0];
    if (ROLES.student.domains.indexOf(emailDomain_(account)) < 0) {
      throw new Error('STUDENT_ACCOUNT_DOMAIN');
    }
    var student = findUserByAccount_(account);
    if (!student) throw new Error('STUDENT_NOT_FOUND');
    if (roleOf_(student) !== 'student') throw new Error('NOT_A_STUDENT');
    studentId = student.id;
  }

  return { role: role, email: email, displayName: displayName, studentId: studentId };
}

function purgeExpiredSignups_() {
  var now = Date.now();
  dbFilter_('signups', function (s) {
    return new Date(s.expiresAt).getTime() < now;
  }).forEach(function (s) { dbDelete_('signups', s.id); });
}

/**
 * 註冊第一步：寄驗證碼到使用者填的信箱。
 *
 * 這一步不建立任何帳號，只確認「這個信箱真的是他本人的」。
 * 密碼刻意不在這裡收，避免尚未驗證的密碼被存進資料庫。
 */
function authRequestSignupCode_(payload) {
  var info = validateSignup_(payload);
  purgeExpiredSignups_();

  var pending = dbFilter_('signups', function (s) {
    return String(s.email).toLowerCase() === info.email;
  });

  var fresh = pending.filter(function (s) {
    return Date.now() - new Date(s.createdAt).getTime() < SIGNUP_RESEND_COOLDOWN_MS;
  });
  if (fresh.length) throw new Error('SIGNUP_TOO_SOON');

  // 同一個信箱同時只留一組有效驗證碼
  pending.forEach(function (s) { dbDelete_('signups', s.id); });

  var code = newResetCode_();
  var salt = newSalt_();
  dbInsert_('signups', {
    id: newId_(),
    email: info.email,
    role: info.role,
    studentId: info.studentId,
    codeHash: hashPassword_(code, salt),
    codeSalt: salt,
    createdAt: nowIso_(),
    expiresAt: new Date(Date.now() + SIGNUP_CODE_TTL_MS).toISOString(),
    attempts: 0
  });

  sendSignupCodeMail_(info, code);
  return { sent: true, email: info.email };
}

function sendSignupCodeMail_(info, code) {
  var minutes = Math.round(SIGNUP_CODE_TTL_MS / 60000);
  var roleLabel = ROLES[info.role].label;

  MailApp.sendEmail({
    to: info.email,
    subject: 'PATS 註冊驗證碼：' + code,
    body: [
      info.displayName + ' 你好，',
      '',
      '你正在以「' + roleLabel + '」身分註冊 PATS。',
      '你的驗證碼是：' + code,
      '',
      '請在 ' + minutes + ' 分鐘內回到 PATS 輸入這組驗證碼，帳號才會建立。',
      '如果這不是你本人的操作，請忽略這封信，不會有任何帳號被建立。',
      '',
      '— PATS'
    ].join('\n'),
    htmlBody: [
      '<div style="font-family:system-ui,-apple-system,\'Noto Sans TC\',sans-serif;',
      'max-width:440px;color:#1f2937;line-height:1.7">',
      '<p>' + escapeHtml_(info.displayName) + ' 你好，</p>',
      '<p>你正在以「<strong>' + roleLabel + '</strong>」身分註冊 PATS。你的驗證碼是：</p>',
      '<p style="font-size:30px;font-weight:700;letter-spacing:8px;color:#2563eb;',
      'background:#eff6ff;padding:14px 18px;border-radius:10px;text-align:center;',
      'margin:18px 0">' + code + '</p>',
      '<p>請在 <strong>' + minutes + ' 分鐘</strong>內回到 PATS 輸入這組驗證碼，帳號才會建立。</p>',
      '<p style="color:#6b7280;font-size:13px">',
      '如果這不是你本人的操作，請忽略這封信，不會有任何帳號被建立。</p>',
      '<p style="color:#6b7280;font-size:13px">— PATS</p>',
      '</div>'
    ].join('')
  });
}

/**
 * 註冊第二步：核對驗證碼並真正建立帳號。
 *
 * 身分與綁定的學生一律取自第一步存下來的紀錄，不採用這一步送來的值，
 * 避免有人用學生信箱收驗證碼、卻把自己註冊成老師。
 */
function authRegister_(payload) {
  var email = String(payload.email || '').trim().toLowerCase();
  var code = String(payload.code || '').trim();

  var pending = dbFind_('signups', function (s) {
    return String(s.email).toLowerCase() === email;
  });
  if (!pending) throw new Error('SIGNUP_NOT_REQUESTED');

  if (new Date(pending.expiresAt).getTime() < Date.now()) {
    dbDelete_('signups', pending.id);
    throw new Error('SIGNUP_CODE_EXPIRED');
  }

  if (!safeEqual_(hashPassword_(code, pending.codeSalt), pending.codeHash)) {
    var attempts = Number(pending.attempts) + 1;
    if (attempts >= SIGNUP_MAX_ATTEMPTS) {
      dbDelete_('signups', pending.id);
      throw new Error('SIGNUP_TOO_MANY_ATTEMPTS');
    }
    dbUpdate_('signups', pending.id, { attempts: attempts });
    throw new Error('SIGNUP_CODE_INVALID');
  }

  var displayName = String(payload.displayName || '').trim();
  if (displayName.length < 2) throw new Error('USERNAME_TOO_SHORT');
  if (displayName.length > 40) throw new Error('USERNAME_TOO_LONG');

  var password = String(payload.password || '');
  if (password.length < 8) throw new Error('WEAK_PASSWORD');

  // createUser_ 會在信箱重複時丟出 EMAIL_TAKEN（例如同時有兩個人在註冊）
  var user = createUser_({
    email: email,
    username: uniqueUsername_(email.split('@')[0]),
    displayName: displayName,
    password: password,
    provider: 'password',
    role: pending.role,
    linkedStudentId: pending.studentId
  });

  dbDelete_('signups', pending.id);

  return {
    token: createSession_(user.id, !!payload.remember),
    user: publicUser_(user)
  };
}

/* --------------------------------------------------------- 忘記密碼 */

var RESET_CODE_TTL_MS = 15 * 60 * 1000;  // 驗證碼有效 15 分鐘
var RESET_MAX_ATTEMPTS = 5;              // 同一組驗證碼最多可以試 5 次
var RESET_RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * 六位數字驗證碼。用 UUID 當亂數來源，不用 Math.random（後者可預測）。
 */
function newResetCode_() {
  var hex = Utilities.getUuid().replace(/-/g, '');
  var code = '';
  for (var i = 0; code.length < 6; i++) {
    var d = parseInt(hex.charAt(i), 16);
    if (d < 10) code += String(d);
    if (i >= hex.length - 1) { hex = Utilities.getUuid().replace(/-/g, ''); i = -1; }
  }
  return code;
}

function purgeExpiredResets_() {
  var now = Date.now();
  dbFilter_('resets', function (r) {
    return new Date(r.expiresAt).getTime() < now;
  }).forEach(function (r) { dbDelete_('resets', r.id); });
}

/**
 * 第一步：寄出驗證碼。
 *
 * 不論信箱是否存在都回報成功，否則這個匿名端點會變成
 * 「這個信箱有沒有註冊過」的查詢工具。
 */
function authRequestReset_(payload) {
  var email = String(payload.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('EMAIL_INVALID');

  purgeExpiredResets_();

  var user = findUserByAccount_(email);
  if (user) {
    var pending = dbFilter_('resets', function (r) { return r.userId === user.id; });

    // 太頻繁的重送直接擋掉，避免有人拿這個端點狂寄信騷擾別人。
    var fresh = pending.filter(function (r) {
      return Date.now() - new Date(r.createdAt).getTime() < RESET_RESEND_COOLDOWN_MS;
    });
    if (fresh.length) throw new Error('RESET_TOO_SOON');

    // 一個帳號同時只留一組有效驗證碼
    pending.forEach(function (r) { dbDelete_('resets', r.id); });

    var code = newResetCode_();
    var salt = newSalt_();
    dbInsert_('resets', {
      id: newId_(),
      userId: user.id,
      email: user.email,
      codeHash: hashPassword_(code, salt),
      codeSalt: salt,
      createdAt: nowIso_(),
      expiresAt: new Date(Date.now() + RESET_CODE_TTL_MS).toISOString(),
      attempts: 0,
      ticket: ''
    });

    sendResetCodeMail_(user, code);
  }

  return { sent: true };
}

function sendResetCodeMail_(user, code) {
  var name = user.displayName || user.username || user.email;
  var minutes = Math.round(RESET_CODE_TTL_MS / 60000);

  MailApp.sendEmail({
    to: user.email,
    subject: 'PATS 密碼重設驗證碼：' + code,
    body: [
      name + ' 你好，',
      '',
      '你的 PATS 密碼重設驗證碼是：' + code,
      '',
      '請在 ' + minutes + ' 分鐘內回到 PATS 輸入這組驗證碼。',
      '如果這不是你本人的操作，請忽略這封信，你的密碼不會有任何變動。',
      '',
      '— PATS'
    ].join('\n'),
    htmlBody: [
      '<div style="font-family:system-ui,-apple-system,\'Noto Sans TC\',sans-serif;',
      'max-width:440px;color:#1f2937;line-height:1.7">',
      '<p>' + escapeHtml_(name) + ' 你好，</p>',
      '<p>你的 PATS 密碼重設驗證碼是：</p>',
      '<p style="font-size:30px;font-weight:700;letter-spacing:8px;color:#2563eb;',
      'background:#eff6ff;padding:14px 18px;border-radius:10px;text-align:center;',
      'margin:18px 0">' + code + '</p>',
      '<p>請在 <strong>' + minutes + ' 分鐘</strong>內回到 PATS 輸入這組驗證碼。</p>',
      '<p style="color:#6b7280;font-size:13px">',
      '如果這不是你本人的操作，請忽略這封信，你的密碼不會有任何變動。</p>',
      '<p style="color:#6b7280;font-size:13px">— PATS</p>',
      '</div>'
    ].join('')
  });
}

function escapeHtml_(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 第二步：核對驗證碼，換一張只能用一次的通行證（ticket）。
 *
 * 這樣第三步就不必再把驗證碼傳一次，也能確保「改密碼」這個動作
 * 一定經過驗證碼這關。
 */
function authVerifyResetCode_(payload) {
  var email = String(payload.email || '').trim().toLowerCase();
  var code = String(payload.code || '').trim();

  var record = dbFind_('resets', function (r) {
    return String(r.email).toLowerCase() === email;
  });
  if (!record) throw new Error('RESET_CODE_INVALID');

  if (new Date(record.expiresAt).getTime() < Date.now()) {
    dbDelete_('resets', record.id);
    throw new Error('RESET_CODE_EXPIRED');
  }

  if (!safeEqual_(hashPassword_(code, record.codeSalt), record.codeHash)) {
    var attempts = Number(record.attempts) + 1;
    // 一到上限就當場銷毀，不留到下一次呼叫才處理。
    if (attempts >= RESET_MAX_ATTEMPTS) {
      dbDelete_('resets', record.id);
      throw new Error('RESET_TOO_MANY_ATTEMPTS');
    }
    dbUpdate_('resets', record.id, { attempts: attempts });
    throw new Error('RESET_CODE_INVALID');
  }

  var ticket = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  dbUpdate_('resets', record.id, { ticket: ticket });
  return { ticket: ticket };
}

/**
 * 第三步：設定新密碼。
 *
 * 成功後除了換掉密碼，也會把該帳號所有既有的工作階段清掉——
 * 會走到重設密碼流程，通常代表帳號可能已經不安全了。
 */
function authResetPassword_(payload) {
  var ticket = String(payload.ticket || '');
  if (!ticket) throw new Error('RESET_TICKET_INVALID');

  var record = dbFind_('resets', function (r) {
    return r.ticket && String(r.ticket) === ticket;
  });
  if (!record) throw new Error('RESET_TICKET_INVALID');

  if (new Date(record.expiresAt).getTime() < Date.now()) {
    dbDelete_('resets', record.id);
    throw new Error('RESET_CODE_EXPIRED');
  }

  var password = String(payload.newPassword || '');
  if (password.length < 8) throw new Error('WEAK_PASSWORD');

  var user = dbGet_('users', record.userId);
  if (!user) throw new Error('RESET_TICKET_INVALID');

  var salt = newSalt_();
  dbUpdate_('users', user.id, {
    passwordHash: hashPassword_(password, salt),
    passwordSalt: salt
  });

  dbFilter_('sessions', function (s) { return s.userId === user.id; })
    .forEach(function (s) { dbDelete_('sessions', s.token); });

  dbDelete_('resets', record.id);

  return {
    token: createSession_(user.id, false),
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
    // 家長帳號一定要綁學生，沒辦法只憑 Google 登入就建立。
    var role = roleOfEmail_(email);
    if (!role) throw new Error('EMAIL_DOMAIN_MISMATCH');
    if (role === 'parent') throw new Error('PARENT_MUST_REGISTER');

    user = createUser_({
      email: email,
      username: claims.name || email.split('@')[0],
      displayName: claims.name || email.split('@')[0],
      avatarUrl: claims.picture || '',
      provider: 'google',
      role: role
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
