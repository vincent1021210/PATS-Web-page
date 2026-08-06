/**
 * PATS — 資料層
 *
 * 以 Google 試算表當作資料庫。第一次執行 setup() 會自動建立試算表、
 * 所有工作表與標題列，並把試算表 ID 記在指令碼屬性中。
 */

var DB_PROP_KEY = 'PATS_SPREADSHEET_ID';
var DB_LOCK_TIMEOUT_MS = 20000;

/**
 * 資料表結構。欄位順序即工作表的欄位順序，變更後請執行 setup() 補齊。
 */
var SCHEMA = {
  users: [
    'id', 'email', 'username', 'displayName', 'avatarUrl',
    'passwordHash', 'passwordSalt', 'provider', 'status',
    'settings', 'createdAt', 'lastSeenAt'
  ],
  sessions: ['token', 'userId', 'createdAt', 'expiresAt', 'userAgent'],
  contacts: ['id', 'userId', 'peerId', 'status', 'createdAt'],
  conversations: ['id', 'type', 'name', 'avatarUrl', 'createdBy', 'createdAt', 'lastMessageAt'],
  participants: ['id', 'conversationId', 'userId', 'role', 'joinedAt', 'lastReadAt', 'archived', 'archivedAt'],
  messages: ['id', 'conversationId', 'senderId', 'body', 'kind', 'createdAt', 'deleted']
};

/** 預設的使用者設定，寫在 users.settings（JSON 字串）。 */
var DEFAULT_USER_SETTINGS = {
  archiveDays: 90,
  notifications: true
};

/**
 * 建立（或修復）試算表結構。第一次部署時請在編輯器中手動執行一次。
 */
function setup() {
  SHEET_CACHE = {};
  ROW_CACHE = {};
  var ss = openSpreadsheet_();
  Object.keys(SCHEMA).forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    var headers = SCHEMA[name];
    var current = sheet.getLastColumn()
      ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      : [];
    if (current.join('|') !== headers.join('|')) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    }
    // 全部以純文字儲存，避免 ISO 時間字串被試算表自動轉成日期型別。
    sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setNumberFormat('@');
  });
  var blank = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);
  return ss.getUrl();
}

/** 單次執行內的快取，避免每個查詢都重新開啟試算表或重讀同一張表。 */
var SS_CACHE = null;
var SHEET_CACHE = {};
var ROW_CACHE = {};

function invalidate_(name) { delete ROW_CACHE[name]; }

function openSpreadsheet_() {
  if (SS_CACHE) return SS_CACHE;
  SS_CACHE = createOrOpenSpreadsheet_();
  return SS_CACHE;
}

function createOrOpenSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(DB_PROP_KEY);
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (err) {
      // ID 失效時往下重新建立
    }
  }
  var ss = SpreadsheetApp.create('PATS 資料庫');
  props.setProperty(DB_PROP_KEY, ss.getId());
  return ss;
}

function sheet_(name) {
  if (SHEET_CACHE[name]) return SHEET_CACHE[name];
  var ss = openSpreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    setup();
    sheet = openSpreadsheet_().getSheetByName(name);
  }
  SHEET_CACHE[name] = sheet;
  return sheet;
}

/**
 * 讀出整張表，回傳物件陣列。每筆多帶一個不可見的 _row（試算表列號）供更新使用。
 */
function dbAll(name) {
  if (ROW_CACHE[name]) return ROW_CACHE[name];
  var sheet = sheet_(name);
  var lastRow = sheet.getLastRow();
  var headers = SCHEMA[name];
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === '' || values[i][0] === null) continue;
    var obj = { _row: i + 2 };
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = values[i][c];
    rows.push(obj);
  }
  ROW_CACHE[name] = rows;
  return rows;
}

function dbFind(name, predicate) {
  var rows = dbAll(name);
  for (var i = 0; i < rows.length; i++) {
    if (predicate(rows[i])) return rows[i];
  }
  return null;
}

function dbFilter(name, predicate) {
  return dbAll(name).filter(predicate);
}

function dbGet(name, id) {
  var key = SCHEMA[name][0];
  return dbFind(name, function (r) { return String(r[key]) === String(id); });
}

function dbInsert(name, obj) {
  var headers = SCHEMA[name];
  var record = {};
  headers.forEach(function (h) { record[h] = obj[h] === undefined ? '' : obj[h]; });
  if (!record[headers[0]]) record[headers[0]] = newId_();
  var row = headers.map(function (h) { return record[h]; });
  withLock_(function () { sheet_(name).appendRow(row); });
  invalidate_(name);
  return record;
}

function dbUpdate(name, id, patch) {
  var headers = SCHEMA[name];
  var existing = dbGet(name, id);
  if (!existing) return null;
  var sheet = sheet_(name);
  withLock_(function () {
    Object.keys(patch).forEach(function (field) {
      var col = headers.indexOf(field);
      if (col >= 0) sheet.getRange(existing._row, col + 1).setValue(patch[field]);
    });
  });
  invalidate_(name);
  return Object.assign({}, existing, patch);
}

function dbDelete(name, id) {
  var existing = dbGet(name, id);
  if (!existing) return false;
  withLock_(function () { sheet_(name).deleteRow(existing._row); });
  invalidate_(name);
  return true;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(DB_LOCK_TIMEOUT_MS);
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function newId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 20);
}

function nowIso_() {
  return new Date().toISOString();
}

function parseJson_(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}
