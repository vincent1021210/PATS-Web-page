/* =====================================================================
   PATS — 對話列表與訊息畫面
   ===================================================================== */

var PatsChat = (function () {
  'use strict';

  var $ = PATS.$;
  var el = PATS.el;
  var icon = PATS.icon;
  var state = PATS.state;

  var POLL_INTERVAL_MS = 6000;
  var searchTimer = null;

  var VIEW_META = {
    dm: {
      title: '私人訊息',
      search: '搜尋訊息或聯絡人',
      emptyIcon: 'forum',
      emptyTitle: '你還沒有朋友',
      emptyText: '邀請朋友開始聊天，或是發起新的對話。',
      emptyAction: { label: '邀請朋友', handler: promptInviteContact },
      placeholderIcon: 'chat_bubble',
      placeholderTitle: '請選擇一個對話',
      placeholderText: '從左側列表選擇現有的聯絡人或群組，開始傳送訊息。'
    },
    group: {
      title: '多人討論',
      search: '搜尋群組或聯絡人',
      emptyIcon: 'groups',
      emptyTitle: '你還沒有群組，請建立',
      emptyText: '建立一個群組，把團隊成員拉進來一起討論。',
      emptyAction: { label: '建立新群組', handler: promptCreateGroup },
      placeholderIcon: 'forum',
      placeholderTitle: '開始多人討論',
      placeholderText: '選擇左側的群組，或建立一個新的群組來與團隊進行協作與溝通。'
    },
    archive: {
      title: '封存內容',
      search: '搜尋封存訊息…',
      emptyIcon: 'archive',
      emptyTitle: '目前沒有封存的對話',
      emptyText: '當您封存對話後，它們會顯示在這裡，且不會出現在您的主要訊息列表中，直到收到新訊息。',
      emptyAction: { label: '返回私人訊息', handler: function () { PatsMain.setView('dm'); } },
      placeholderIcon: 'archive',
      placeholderTitle: '封存內容',
      placeholderText: '選擇一則封存的對話來查看歷史紀錄，或將它移回主要訊息列表。'
    }
  };

  /* ------------------------------------------------------------- 列表區 */

  function renderListHeader() {
    var meta = VIEW_META[state.view] || VIEW_META.dm;
    $('#list-title').textContent = meta.title;
    $('#list-search').placeholder = meta.search;

    var hint = $('#list-hint');
    var isEmpty = state.conversations.length === 0 && !state.keyword;
    hint.textContent = (state.view === 'group' && isEmpty) ? '你還沒有群組，請建立' : '';

    $('#list-compose').classList.toggle('hidden', state.view === 'archive');
  }

  function renderList() {
    renderListHeader();
    var container = $('#conv-list');
    container.innerHTML = '';

    var meta = VIEW_META[state.view] || VIEW_META.dm;

    if (!state.conversations.length) {
      container.appendChild(emptyState(
        meta.emptyIcon,
        state.keyword ? '找不到符合的結果' : meta.emptyTitle,
        state.keyword ? '換個關鍵字再試一次。' : meta.emptyText,
        state.keyword ? null : meta.emptyAction
      ));
      return;
    }

    state.conversations.forEach(function (conv) {
      container.appendChild(conversationItem(conv));
    });
  }

  function conversationItem(conv) {
    var classes = ['conv-item'];
    if (conv.id === state.activeId) classes.push('is-active');
    if (conv.unread > 0) classes.push('is-unread');

    return el('button', {
      class: classes.join(' '),
      type: 'button',
      onclick: function () { openConversation(conv.id); },
      oncontextmenu: function (event) { event.preventDefault(); openConversationMenu(event.currentTarget, conv); }
    }, [
      PATS.avatarNode(conv.title, conv.avatarUrl),
      el('span', { class: 'body' }, [
        el('span', { class: 'row' }, [
          el('span', { class: 'title', text: conv.title }),
          el('span', { class: 'time', text: PATS.formatListTime(conv.lastMessageAt) })
        ]),
        el('span', { class: 'preview', text: conv.preview || '尚無訊息' })
      ]),
      conv.unread > 0 ? el('span', { class: 'badge', text: String(conv.unread) }) : null
    ]);
  }

  function emptyState(iconName, title, text, action) {
    return el('div', { class: 'empty-state' }, [
      el('div', { class: 'glyph' }, [icon(iconName)]),
      el('h3', { text: title }),
      el('p', { text: text }),
      action ? el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: action.label,
        onclick: action.handler
      }) : null
    ]);
  }

  /* ------------------------------------------------------------- 對話區 */

  function renderPlaceholder() {
    var meta = VIEW_META[state.view] || VIEW_META.dm;
    var pane = $('#chat-pane');
    pane.innerHTML = '';
    pane.appendChild(emptyState(meta.placeholderIcon, meta.placeholderTitle, meta.placeholderText, null));
  }

  function renderConversation(data) {
    var pane = $('#chat-pane');
    pane.innerHTML = '';
    var conv = data.conversation;

    var subtitle = conv.type === 'group'
      ? conv.memberCount + ' 位成員'
      : '私人對話';

    pane.appendChild(el('header', { class: 'chat-head' }, [
      el('button', {
        class: 'icon-btn chat-back', type: 'button', 'aria-label': '返回列表',
        onclick: function () { PatsMain.setMobilePane('list'); }
      }, [icon('arrow_back')]),
      PATS.avatarNode(conv.title, conv.avatarUrl, 'avatar-sm'),
      el('div', { class: 'meta' }, [
        el('div', { class: 'title', text: conv.title }),
        el('div', { class: 'sub', text: subtitle })
      ]),
      el('div', { class: 'actions' }, [
        el('button', {
          class: 'icon-btn', type: 'button', title: '更多',
          onclick: function (event) { openConversationMenu(event.currentTarget, conv); }
        }, [icon('more_vert')])
      ])
    ]));

    var body = el('div', { class: 'chat-body scroll-y', id: 'chat-body' });
    pane.appendChild(body);
    renderMessages(body, data.messages);

    pane.appendChild(composer());
    scrollToBottom();
  }

  function renderMessages(container, messages) {
    var lastDay = '';
    var previousSender = '';

    messages.forEach(function (message) {
      var day = PATS.formatDay(message.createdAt);
      if (day !== lastDay) {
        container.appendChild(el('div', { class: 'msg-day', text: day }));
        lastDay = day;
        previousSender = '';
      }

      if (message.kind === 'system') {
        container.appendChild(el('div', { class: 'msg-system', text: message.body }));
        previousSender = '';
        return;
      }

      var isTail = previousSender === message.senderId;
      previousSender = message.senderId;

      var showSender = !message.mine && !isTail && state.activeType === 'group';

      container.appendChild(el('div', {
        class: 'msg' + (message.mine ? ' is-mine' : '') + (isTail ? ' is-tail' : ''),
        'data-id': message.id
      }, [
        isTail ? el('div', { class: 'avatar', style: 'visibility:hidden' })
               : PATS.avatarNode(message.senderName, message.senderAvatar),
        el('div', { class: 'stack' }, [
          showSender ? el('div', { class: 'sender', text: message.senderName }) : null,
          el('div', { class: 'bubble', text: message.body }),
          el('div', { class: 'time', text: PATS.formatTime(message.createdAt) })
        ])
      ]));
    });
  }

  function composer() {
    var textarea = el('textarea', {
      id: 'composer-input',
      rows: '1',
      placeholder: '輸入訊息…',
      'aria-label': '訊息內容'
    });
    var sendButton = el('button', {
      class: 'send', type: 'submit', 'aria-label': '傳送', disabled: 'disabled'
    }, [icon('send')]);

    textarea.addEventListener('input', function () {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
      sendButton.disabled = !textarea.value.trim();
    });
    textarea.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    var form = el('form', { class: 'composer' }, [textarea, sendButton]);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var body = textarea.value.trim();
      if (!body) return;
      textarea.value = '';
      textarea.style.height = 'auto';
      sendButton.disabled = true;
      sendMessage(body);
    });

    return form;
  }

  function scrollToBottom() {
    var body = $('#chat-body');
    if (body) body.scrollTop = body.scrollHeight;
  }

  /* ------------------------------------------------------------ 資料流程 */

  function refreshList(options) {
    return PATS.rpc('listConversations', { scope: state.view, q: state.keyword })
      .then(function (list) {
        state.conversations = list;
        renderList();
        PatsMain.updateBadges(list);

        if (options && options.autoSelect && !state.activeId && list.length &&
            window.matchMedia('(min-width: 721px)').matches) {
          return openConversation(list[0].id);
        }
        if (!state.activeId) renderPlaceholder();
      })
      .catch(handleError);
  }

  function openConversation(conversationId) {
    state.activeId = conversationId;
    state.lastMessageAt = null;
    renderList();
    PatsMain.setMobilePane('chat');

    return PATS.rpc('listMessages', { conversationId: conversationId })
      .then(function (data) {
        if (state.activeId !== conversationId) return;
        state.activeType = data.conversation.type;
        state.messages = data.messages;
        state.lastMessageAt = data.messages.length
          ? data.messages[data.messages.length - 1].createdAt
          : null;
        renderConversation(data);
        return PATS.rpc('markRead', { conversationId: conversationId });
      })
      .then(function () { refreshBadgesOnly(); })
      .catch(handleError);
  }

  function refreshBadgesOnly() {
    var conv = state.conversations.filter(function (c) { return c.id === state.activeId; })[0];
    if (conv) { conv.unread = 0; renderList(); PatsMain.updateBadges(state.conversations); }
  }

  function sendMessage(body) {
    var conversationId = state.activeId;
    PATS.rpc('sendMessage', { conversationId: conversationId, body: body })
      .then(function (message) {
        if (state.activeId !== conversationId) return;
        appendMessages([message]);
        return refreshList();
      })
      .catch(handleError);
  }

  function appendMessages(messages) {
    var body = $('#chat-body');
    if (!body || !messages.length) return;
    renderMessages(body, messages);
    state.lastMessageAt = messages[messages.length - 1].createdAt;
    scrollToBottom();
  }

  /** 輪詢：抓新訊息與更新列表，讓多人對話能即時看到內容。 */
  function poll() {
    if (!state.user || state.view === 'settings' || state.view === 'profile') return;

    if (state.activeId && state.lastMessageAt) {
      var conversationId = state.activeId;
      PATS.rpc('listMessages', { conversationId: conversationId, since: state.lastMessageAt })
        .then(function (data) {
          if (state.activeId !== conversationId || !data.messages.length) return;
          appendMessages(data.messages);
          return PATS.rpc('markRead', { conversationId: conversationId });
        })
        .catch(function () { /* 輪詢錯誤不打擾使用者 */ });
    }
    refreshList().catch(function () {});
  }

  function startPolling() {
    stopPolling();
    state.poller = setInterval(poll, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (state.poller) clearInterval(state.poller);
    state.poller = null;
  }

  /* ------------------------------------------------------------ 互動操作 */

  function openConversationMenu(anchor, conv) {
    var archived = state.view === 'archive';
    PATS.openMenu(anchor, [
      {
        label: archived ? '移回主要訊息' : '封存這個對話',
        icon: archived ? 'unarchive' : 'archive',
        onSelect: function () { setArchived(conv.id, !archived); }
      },
      {
        label: '標記為已讀',
        icon: 'mark_email_read',
        onSelect: function () {
          PATS.rpc('markRead', { conversationId: conv.id })
            .then(function () { return refreshList(); })
            .catch(handleError);
        }
      }
    ]);
  }

  function setArchived(conversationId, archived) {
    PATS.rpc('setArchived', { conversationId: conversationId, archived: archived })
      .then(function () {
        if (state.activeId === conversationId) {
          state.activeId = null;
          renderPlaceholder();
        }
        PATS.toast(archived ? '已移至封存。' : '已移回主要訊息。', 'success');
        return refreshList();
      })
      .catch(handleError);
  }

  function promptInviteContact() {
    PATS.openModal({
      title: '邀請朋友',
      lead: '輸入對方在 PATS 的電子郵件或帳號，即可加入聯絡人並開始對話。',
      fields: [{ name: 'account', label: '電子郵件 / 帳號', placeholder: 'name@company.com' }],
      confirmText: '建立對話',
      onSubmit: function (values) {
        if (!values.account) throw new Error('請輸入電子郵件或帳號。');
        return PATS.rpc('startDirect', { account: values.account })
          .then(function (result) {
            PATS.toast('對話已建立。', 'success');
            return refreshList().then(function () { return openConversation(result.conversationId); });
          });
      }
    });
  }

  function promptCreateGroup() {
    PATS.openModal({
      title: '建立新群組',
      lead: '成員可用逗號分隔多個電子郵件或帳號，之後仍可再新增。',
      fields: [
        { name: 'name', label: '群組名稱', placeholder: '例如：產品開發組' },
        { name: 'members', label: '成員（選填）', placeholder: 'a@company.com, b@company.com' }
      ],
      confirmText: '建立群組',
      onSubmit: function (values) {
        var members = values.members
          ? values.members.split(/[,，\s]+/).filter(Boolean)
          : [];
        return PATS.rpc('createGroup', { name: values.name, members: members })
          .then(function (result) {
            if (result.missing.length) {
              PATS.toast('找不到這些成員：' + result.missing.join('、'), 'error');
            } else {
              PATS.toast('群組已建立。', 'success');
            }
            PatsMain.setView('group');
            return refreshList().then(function () { return openConversation(result.conversationId); });
          });
      }
    });
  }

  function compose() {
    if (state.view === 'group') promptCreateGroup();
    else promptInviteContact();
  }

  function handleError(err) {
    if (err.code === 'AUTH_REQUIRED') return PatsAuth.logout({ relogin: true });
    PATS.toast(err.message, 'error');
  }

  /* ---------------------------------------------------------------- 綁定 */

  function init() {
    $('#list-compose').addEventListener('click', compose);

    $('#list-more').addEventListener('click', function (event) {
      PATS.openMenu(event.currentTarget, [
        { label: '邀請朋友', icon: 'person_add', onSelect: promptInviteContact },
        { label: '建立新群組', icon: 'group_add', onSelect: promptCreateGroup },
        { label: '重新整理', icon: 'refresh', onSelect: function () { refreshList(); } }
      ]);
    });

    $('#list-search').addEventListener('input', function (event) {
      clearTimeout(searchTimer);
      var value = event.target.value;
      searchTimer = setTimeout(function () {
        state.keyword = value.trim();
        refreshList();
      }, 220);
    });
  }

  return {
    init: init,
    refreshList: refreshList,
    renderPlaceholder: renderPlaceholder,
    openConversation: openConversation,
    startPolling: startPolling,
    stopPolling: stopPolling,
    handleError: handleError
  };
})();
