/**
 * PATS — 應用邏輯
 *
 * 這裡的每個函式都對應前端 rpc() 的一個 action，統一由 Code.gs 的
 * apiCall() 分派並負責錯誤包裝。
 */

/* ------------------------------------------------------------ 共用查詢工具 */

function userMap_() {
  var map = {};
  dbAll('users').forEach(function (u) { map[u.id] = u; });
  return map;
}

function myParticipations_(userId) {
  return dbFilter('participants', function (p) { return p.userId === userId; });
}

function participantsOf_(conversationId) {
  return dbFilter('participants', function (p) { return p.conversationId === conversationId; });
}

function assertMember_(userId, conversationId) {
  var row = dbFind('participants', function (p) {
    return p.userId === userId && p.conversationId === conversationId;
  });
  if (!row) throw new Error('NOT_A_MEMBER');
  return row;
}

function conversationTitle_(conv, participants, users, meId) {
  if (conv.type === 'group') return conv.name || '未命名群組';
  var peer = participants.filter(function (p) { return p.userId !== meId; })[0];
  var peerUser = peer && users[peer.userId];
  return peerUser ? (peerUser.displayName || peerUser.username || peerUser.email) : '未知的聯絡人';
}

function conversationAvatar_(conv, participants, users, meId) {
  if (conv.type === 'group') return conv.avatarUrl || '';
  var peer = participants.filter(function (p) { return p.userId !== meId; })[0];
  var peerUser = peer && users[peer.userId];
  return peerUser ? peerUser.avatarUrl : '';
}

/* -------------------------------------------------------------- 啟動載入 */

function apiBootstrap(user) {
  return {
    user: publicUser_(user),
    serverTime: nowIso_(),
    googleClientId: googleClientId_()
  };
}

/* -------------------------------------------------------------- 對話列表 */

/**
 * scope: 'dm' 私人訊息 / 'group' 多人討論 / 'archive' 封存
 */
function apiListConversations(user, payload) {
  payload = payload || {};
  applyAutoArchive_(user);

  var users = userMap_();
  var mine = myParticipations_(user.id);
  var byConv = {};
  mine.forEach(function (p) { byConv[p.conversationId] = p; });

  var allParticipants = dbAll('participants');
  var participantsByConv = {};
  allParticipants.forEach(function (p) {
    (participantsByConv[p.conversationId] = participantsByConv[p.conversationId] || []).push(p);
  });

  var allMessages = liveMessages_();
  var lastMessages = lastMessageByConversation_(allMessages);
  var scope = payload.scope || 'dm';
  var keyword = String(payload.q || '').trim().toLowerCase();

  var list = dbAll('conversations')
    .filter(function (conv) { return !!byConv[conv.id]; })
    .filter(function (conv) {
      var me = byConv[conv.id];
      var archived = String(me.archived) === 'true' || me.archived === true;
      if (scope === 'archive') return archived;
      if (archived) return false;
      return scope === 'group' ? conv.type === 'group' : conv.type === 'dm';
    })
    .map(function (conv) {
      var members = participantsByConv[conv.id] || [];
      var me = byConv[conv.id];
      var last = lastMessages[conv.id];
      var lastReadAt = me.lastReadAt ? new Date(me.lastReadAt).getTime() : 0;
      return {
        id: conv.id,
        type: conv.type,
        title: conversationTitle_(conv, members, users, user.id),
        avatarUrl: conversationAvatar_(conv, members, users, user.id),
        memberCount: members.length,
        archived: scope === 'archive',
        lastMessageAt: conv.lastMessageAt || conv.createdAt,
        preview: last ? previewText_(last, users) : '',
        unread: countUnread_(allMessages, conv.id, user.id, lastReadAt)
      };
    })
    .filter(function (row) {
      if (!keyword) return true;
      return row.title.toLowerCase().indexOf(keyword) >= 0 ||
             String(row.preview).toLowerCase().indexOf(keyword) >= 0;
    })
    .sort(function (a, b) {
      return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
    });

  return list;
}

function previewText_(message, users) {
  var sender = users[message.senderId];
  var name = sender ? (sender.displayName || sender.username) : '';
  var body = String(message.body || '');
  if (message.kind === 'system') return body;
  return name ? name + '：' + body : body;
}

function liveMessages_() {
  return dbAll('messages').filter(function (m) {
    return String(m.deleted) !== 'true' && m.deleted !== true;
  });
}

function lastMessageByConversation_(messages) {
  var latest = {};
  messages.forEach(function (m) {
    var current = latest[m.conversationId];
    if (!current || new Date(m.createdAt).getTime() >= new Date(current.createdAt).getTime()) {
      latest[m.conversationId] = m;
    }
  });
  return latest;
}

function countUnread_(messages, conversationId, userId, lastReadAt) {
  var count = 0;
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m.conversationId === conversationId &&
        m.senderId !== userId &&
        new Date(m.createdAt).getTime() > lastReadAt) count++;
  }
  return count;
}

/* ------------------------------------------------------------------ 訊息 */

function apiListMessages(user, payload) {
  var conversationId = payload.conversationId;
  assertMember_(user.id, conversationId);
  var users = userMap_();
  var since = payload.since ? new Date(payload.since).getTime() : 0;

  var rows = dbFilter('messages', function (m) {
    return m.conversationId === conversationId &&
           String(m.deleted) !== 'true' &&
           new Date(m.createdAt).getTime() > since;
  }).sort(function (a, b) {
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  }).map(function (m) {
    var sender = users[m.senderId] || {};
    return {
      id: m.id,
      body: m.body,
      kind: m.kind || 'text',
      createdAt: m.createdAt,
      mine: m.senderId === user.id,
      senderId: m.senderId,
      senderName: sender.displayName || sender.username || '系統',
      senderAvatar: sender.avatarUrl || ''
    };
  });

  var conv = dbGet('conversations', conversationId);
  var members = participantsOf_(conversationId);
  return {
    conversation: {
      id: conversationId,
      type: conv.type,
      title: conversationTitle_(conv, members, users, user.id),
      avatarUrl: conversationAvatar_(conv, members, users, user.id),
      memberCount: members.length,
      members: members.map(function (p) {
        var u = users[p.userId] || {};
        return { id: p.userId, name: u.displayName || u.username, avatarUrl: u.avatarUrl || '', role: p.role };
      })
    },
    messages: rows
  };
}

function apiSendMessage(user, payload) {
  var conversationId = payload.conversationId;
  assertMember_(user.id, conversationId);
  var body = String(payload.body || '').trim();
  if (!body) throw new Error('EMPTY_MESSAGE');
  if (body.length > 4000) throw new Error('MESSAGE_TOO_LONG');

  var message = dbInsert('messages', {
    id: newId_(),
    conversationId: conversationId,
    senderId: user.id,
    body: body,
    kind: 'text',
    createdAt: nowIso_(),
    deleted: 'false'
  });
  dbUpdate('conversations', conversationId, { lastMessageAt: message.createdAt });
  unarchiveForAll_(conversationId);
  apiMarkRead(user, { conversationId: conversationId });

  return {
    id: message.id,
    body: message.body,
    kind: 'text',
    createdAt: message.createdAt,
    mine: true,
    senderId: user.id,
    senderName: user.displayName || user.username,
    senderAvatar: user.avatarUrl || ''
  };
}

function apiMarkRead(user, payload) {
  var row = assertMember_(user.id, payload.conversationId);
  dbUpdate('participants', row.id, { lastReadAt: nowIso_() });
  return true;
}

/* ---------------------------------------------------------------- 建立對話 */

function apiStartDirect(user, payload) {
  var peer = findUserByAccount_(payload.account);
  if (!peer) throw new Error('USER_NOT_FOUND');
  if (peer.id === user.id) throw new Error('CANNOT_CHAT_SELF');

  var existing = findDirectConversation_(user.id, peer.id);
  if (existing) return { conversationId: existing };

  var conv = dbInsert('conversations', {
    id: newId_(),
    type: 'dm',
    name: '',
    avatarUrl: '',
    createdBy: user.id,
    createdAt: nowIso_(),
    lastMessageAt: nowIso_()
  });
  addParticipant_(conv.id, user.id, 'member');
  addParticipant_(conv.id, peer.id, 'member');
  ensureContact_(user.id, peer.id);
  ensureContact_(peer.id, user.id);
  return { conversationId: conv.id };
}

function findDirectConversation_(a, b) {
  var byConv = {};
  dbAll('participants').forEach(function (p) {
    (byConv[p.conversationId] = byConv[p.conversationId] || []).push(p.userId);
  });
  var found = null;
  dbAll('conversations').forEach(function (conv) {
    if (found || conv.type !== 'dm') return;
    var ids = byConv[conv.id] || [];
    if (ids.length === 2 && ids.indexOf(a) >= 0 && ids.indexOf(b) >= 0) found = conv.id;
  });
  return found;
}

function apiCreateGroup(user, payload) {
  var name = String(payload.name || '').trim();
  if (!name) throw new Error('GROUP_NAME_REQUIRED');

  var conv = dbInsert('conversations', {
    id: newId_(),
    type: 'group',
    name: name,
    avatarUrl: '',
    createdBy: user.id,
    createdAt: nowIso_(),
    lastMessageAt: nowIso_()
  });
  addParticipant_(conv.id, user.id, 'owner');

  var missing = [];
  (payload.members || []).forEach(function (account) {
    var member = findUserByAccount_(account);
    if (!member) { missing.push(account); return; }
    if (member.id === user.id) return;
    addParticipant_(conv.id, member.id, 'member');
  });

  dbInsert('messages', {
    id: newId_(),
    conversationId: conv.id,
    senderId: user.id,
    body: (user.displayName || user.username) + ' 建立了群組「' + name + '」',
    kind: 'system',
    createdAt: nowIso_(),
    deleted: 'false'
  });

  return { conversationId: conv.id, missing: missing };
}

function addParticipant_(conversationId, userId, role) {
  var exists = dbFind('participants', function (p) {
    return p.conversationId === conversationId && p.userId === userId;
  });
  if (exists) return exists;
  return dbInsert('participants', {
    id: newId_(),
    conversationId: conversationId,
    userId: userId,
    role: role || 'member',
    joinedAt: nowIso_(),
    lastReadAt: '',
    archived: 'false',
    archivedAt: ''
  });
}

/* ---------------------------------------------------------------- 聯絡人 */

function ensureContact_(userId, peerId) {
  var exists = dbFind('contacts', function (c) {
    return c.userId === userId && c.peerId === peerId;
  });
  if (exists) return exists;
  return dbInsert('contacts', {
    id: newId_(),
    userId: userId,
    peerId: peerId,
    status: 'active',
    createdAt: nowIso_()
  });
}

function apiListContacts(user) {
  var users = userMap_();
  return dbFilter('contacts', function (c) { return c.userId === user.id; })
    .map(function (c) {
      var peer = users[c.peerId] || {};
      return {
        id: peer.id,
        name: peer.displayName || peer.username || '',
        email: peer.email || '',
        avatarUrl: peer.avatarUrl || ''
      };
    })
    .filter(function (c) { return !!c.id; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
}

function apiInviteContact(user, payload) {
  var peer = findUserByAccount_(payload.account);
  if (!peer) throw new Error('USER_NOT_FOUND');
  if (peer.id === user.id) throw new Error('CANNOT_ADD_SELF');
  ensureContact_(user.id, peer.id);
  ensureContact_(peer.id, user.id);
  return { id: peer.id, name: peer.displayName || peer.username, email: peer.email };
}

/* ------------------------------------------------------------------ 封存 */

function apiSetArchived(user, payload) {
  var row = assertMember_(user.id, payload.conversationId);
  var archived = !!payload.archived;
  dbUpdate('participants', row.id, {
    archived: archived ? 'true' : 'false',
    archivedAt: archived ? nowIso_() : ''
  });
  return true;
}

function unarchiveForAll_(conversationId) {
  participantsOf_(conversationId).forEach(function (p) {
    if (String(p.archived) === 'true') {
      dbUpdate('participants', p.id, { archived: 'false', archivedAt: '' });
    }
  });
}

/** 依使用者設定的天數，把久未互動的對話自動搬進封存。 */
function applyAutoArchive_(user) {
  var settings = Object.assign({}, DEFAULT_USER_SETTINGS, parseJson_(user.settings, {}));
  var days = Number(settings.archiveDays);
  if (!days || days <= 0) return;

  var threshold = Date.now() - days * 24 * 60 * 60 * 1000;
  var conversations = {};
  dbAll('conversations').forEach(function (c) { conversations[c.id] = c; });

  myParticipations_(user.id).forEach(function (p) {
    if (String(p.archived) === 'true') return;
    var conv = conversations[p.conversationId];
    if (!conv) return;
    var last = new Date(conv.lastMessageAt || conv.createdAt).getTime();
    if (last < threshold) {
      dbUpdate('participants', p.id, { archived: 'true', archivedAt: nowIso_() });
    }
  });
}

/* ------------------------------------------------------------------ 設定 */

function apiUpdateProfile(user, payload) {
  var patch = {};
  if (payload.username !== undefined) {
    var username = String(payload.username).trim();
    if (username.length < 2) throw new Error('USERNAME_TOO_SHORT');
    var taken = dbFind('users', function (u) {
      return u.id !== user.id && String(u.username).toLowerCase() === username.toLowerCase();
    });
    if (taken) throw new Error('USERNAME_TAKEN');
    patch.username = username;
    patch.displayName = username;
  }
  if (payload.avatarUrl !== undefined) patch.avatarUrl = String(payload.avatarUrl).trim();
  if (!Object.keys(patch).length) return publicUser_(user);
  dbUpdate('users', user.id, patch);
  return publicUser_(Object.assign({}, user, patch));
}

function apiChangePassword(user, payload) {
  authChangePassword_(user, payload);
  return true;
}

function apiUpdateSettings(user, payload) {
  var settings = Object.assign(
    {},
    DEFAULT_USER_SETTINGS,
    parseJson_(user.settings, {}),
    payload.settings || {}
  );
  settings.archiveDays = Number(settings.archiveDays) || 0;
  dbUpdate('users', user.id, { settings: JSON.stringify(settings) });
  return settings;
}

/** 「清除快取資料」：只丟掉伺服器端快取，不動訊息本體。 */
function apiClearCache(user) {
  CacheService.getScriptCache().removeAll(['conversations:' + user.id, 'messages:' + user.id]);
  return true;
}

function apiStorageUsage(user) {
  var mine = {};
  myParticipations_(user.id).forEach(function (p) { mine[p.conversationId] = true; });
  var bytes = 0;
  liveMessages_().forEach(function (m) {
    if (mine[m.conversationId]) bytes += String(m.body || '').length * 2;
  });
  return { bytes: bytes };
}
