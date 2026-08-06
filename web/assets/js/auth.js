/* =====================================================================
   PATS — 登入 / 登出
   ===================================================================== */

var PatsAuth = (function () {
  'use strict';

  var $ = PATS.$;
  var GIS_SRC = 'https://accounts.google.com/gsi/client';

  function showError(message) {
    var box = $('#login-error');
    box.querySelector('[data-role="text"]').textContent = message;
    box.classList.remove('hidden');
  }

  function clearError() { $('#login-error').classList.add('hidden'); }

  function setBusy(busy) {
    var button = $('#login-submit');
    button.disabled = busy;
    button.textContent = busy ? '登入中…' : '登入';
  }

  /* ------------------------------------------------------------ 帳密登入 */

  function handleSubmit(event) {
    event.preventDefault();
    clearError();

    var account = $('#login-account').value.trim();
    var password = $('#login-password').value;
    if (!account || !password) return showError('請輸入帳號與密碼。');

    setBusy(true);
    PATS.rpc('login', {
      account: account,
      password: password,
      remember: $('#login-remember').checked
    })
      .then(function (result) {
        PATS.writeToken(result.token);
        $('#login-password').value = '';
        PatsMain.enterApp(result.user);
      })
      .catch(function (err) { showError(err.message); })
      .finally(function () { setBusy(false); });
  }

  /* --------------------------------------------------------- Google 登入 */

  /**
   * 用 Google Identity Services 渲染官方登入按鈕。
   * 取得的 ID Token 交給後端驗簽，換成 PATS 自己的工作階段權杖。
   */
  function initGoogle() {
    var clientId = PATS.state.config.googleClientId;
    var slot = $('#google-slot');

    if (!clientId) {
      slot.appendChild(PATS.el('p', {
        class: 'auth-hint',
        text: '尚未設定 Google 用戶端 ID，目前僅開放帳密登入。'
      }));
      return;
    }

    loadScript(GIS_SRC)
      .then(function () {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: onCredential,
          auto_select: false,
          cancel_on_tap_outside: true
        });
        window.google.accounts.id.renderButton(slot, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          shape: 'rectangular',
          text: 'signin_with',
          locale: 'zh_TW',
          logo_alignment: 'center',
          width: Math.min(slot.offsetWidth || 320, 400)
        });
      })
      .catch(function () {
        slot.appendChild(PATS.el('p', {
          class: 'auth-hint',
          text: '無法載入 Google 登入元件，請檢查網路連線。'
        }));
      });
  }

  function onCredential(response) {
    clearError();
    if (!response || !response.credential) return showError('沒有取得 Google 憑證，請重新嘗試。');

    PATS.rpc('googleLogin', { credential: response.credential })
      .then(function (result) {
        PATS.writeToken(result.token);
        PatsMain.enterApp(result.user);
      })
      .catch(function (err) { showError(err.message); });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      var tag = document.createElement('script');
      tag.src = src;
      tag.async = true;
      tag.defer = true;
      tag.onload = resolve;
      tag.onerror = reject;
      document.head.appendChild(tag);
    });
  }

  /* ---------------------------------------------------------------- 登出 */

  function logout(options) {
    var relogin = options && options.relogin;

    if (window.google && window.google.accounts && window.google.accounts.id) {
      window.google.accounts.id.disableAutoSelect();
    }

    PATS.rpc('logout', {})
      .catch(function () { /* 權杖失效也視同登出 */ })
      .finally(function () {
        PATS.writeToken(null);
        PATS.state.user = null;
        PatsMain.showAuth();
        if (relogin) PATS.toast('已登出，請重新登入。');
      });
  }

  /* ---------------------------------------------------------------- 綁定 */

  function init() {
    $('#login-form').addEventListener('submit', handleSubmit);

    PATS.$$('[data-toggle-password]').forEach(function (button) {
      button.addEventListener('click', function () {
        var input = document.getElementById(button.getAttribute('data-toggle-password'));
        var toText = input.type === 'password';
        input.type = toText ? 'text' : 'password';
        button.querySelector('.material-symbols-outlined').textContent =
          toText ? 'visibility' : 'visibility_off';
        button.setAttribute('aria-label', toText ? '隱藏密碼' : '顯示密碼');
      });
    });

    $('#forgot-link').addEventListener('click', function (event) {
      event.preventDefault();
      PATS.toast('請聯絡系統管理員協助重設密碼。');
    });
    $('#request-account').addEventListener('click', function (event) {
      event.preventDefault();
      PATS.toast('請聯絡系統管理員為你開通帳號，或直接使用 Google 登入。');
    });

    initGoogle();
  }

  return { init: init, logout: logout, showError: showError, clearError: clearError };
})();
