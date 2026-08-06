/* =====================================================================
   PATS — 應用外框：啟動流程、畫面切換、導覽列
   ===================================================================== */

var PatsMain = (function () {
  'use strict';

  var $ = PATS.$;
  var state = PATS.state;

  /* Rail 上的按鈕 → 設定區實際要顯示的子畫面 */
  var SETTINGS_SECTION = { settings: 'archive', profile: 'account', switch: 'switch' };

  /* --------------------------------------------------------------- 啟動 */

  function boot() {
    PatsAuth.init();
    PatsChat.init();
    bindRail();
    bindResize();

    if (!state.config.apiUrl) {
      PATS.hide($('#loading'));
      PATS.show($('#auth'));
      PatsAuth.showError(PATS.describeError('NO_API_URL'));
      return;
    }

    var token = PATS.readToken();
    if (!token) return showAuth();

    state.token = token;
    PATS.rpc('session', { token: token })
      .then(function (result) {
        if (!result) return showAuth();
        enterApp(result.user);
      })
      .catch(function (err) {
        showAuth();
        if (err.code === 'NETWORK' || err.code === 'BAD_RESPONSE') PatsAuth.showError(err.message);
      });
  }

  function showAuth() {
    PatsChat.stopPolling();
    PATS.hide($('#loading'));
    PATS.hide($('#app'));
    PATS.show($('#auth'));
    PatsAuth.clearError();
  }

  function enterApp(user) {
    state.user = user;
    state.activeId = null;
    state.keyword = '';
    $('#list-search').value = '';

    PATS.hide($('#loading'));
    PATS.hide($('#auth'));
    PATS.show($('#app'));

    renderIdentity();
    setView('dm', { autoSelect: true });
    PatsChat.startPolling();
  }

  function renderIdentity() {
    var user = state.user || {};
    $('#me-name').textContent = user.displayName || user.username || 'PATS';
    var avatar = $('#me-avatar');
    avatar.innerHTML = '';
    if (user.avatarUrl) {
      avatar.appendChild(PATS.el('img', { src: user.avatarUrl, alt: '' }));
    } else {
      avatar.textContent = PATS.initials(user.displayName || user.username);
    }
  }

  /* ----------------------------------------------------------- 畫面切換 */

  function setView(view, options) {
    state.view = view;
    PATS.closeMenu();

    PATS.$$('.rail-link[data-view]').forEach(function (link) {
      link.classList.toggle('is-active', link.getAttribute('data-view') === view);
    });

    var app = $('#app');
    var isSettings = !!SETTINGS_SECTION[view];

    app.setAttribute('data-list-hidden', isSettings ? 'true' : 'false');
    $('#chat-pane').classList.toggle('hidden', isSettings);
    $('#settings-pane').classList.toggle('hidden', !isSettings);

    if (isSettings) {
      PatsSettings.render(SETTINGS_SECTION[view]);
      return;
    }

    state.activeId = null;
    state.keyword = '';
    $('#list-search').value = '';
    PatsChat.renderPlaceholder();
    setMobilePane('list');
    PatsChat.refreshList({ autoSelect: options && options.autoSelect });
  }

  /** 手機版單欄時，決定要顯示列表還是對話。 */
  function setMobilePane(pane) {
    $('#app').setAttribute('data-mobile', pane);
  }

  function updateBadges(list) {
    if (state.view === 'archive') return;
    var total = list.reduce(function (sum, conv) { return sum + (conv.unread || 0); }, 0);
    var badge = document.querySelector('[data-count="' + state.view + '"]');
    if (!badge) return;
    badge.textContent = String(total);
    badge.classList.toggle('hidden', total === 0);
  }

  /* --------------------------------------------------------------- 綁定 */

  function bindRail() {
    PATS.$$('.rail-link[data-view]').forEach(function (link) {
      link.addEventListener('click', function () { setView(link.getAttribute('data-view')); });
    });
    PATS.$$('.rail-link[data-action="logout"]').forEach(function (link) {
      link.addEventListener('click', function () { setView('switch'); });
    });
  }

  function bindResize() {
    var desktop = window.matchMedia('(min-width: 721px)');
    var handler = function () { if (desktop.matches) setMobilePane('list'); };
    if (desktop.addEventListener) desktop.addEventListener('change', handler);
    else desktop.addListener(handler);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  return {
    enterApp: enterApp,
    showAuth: showAuth,
    setView: setView,
    setMobilePane: setMobilePane,
    updateBadges: updateBadges,
    renderIdentity: renderIdentity
  };
})();
