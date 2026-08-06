/* =====================================================================
   PATS — 登入 / 登出
   ===================================================================== */

var PatsAuth = (function () {
  'use strict';

  var $ = PATS.$;
  var GIS_SRC = 'https://accounts.google.com/gsi/client';

  function showError(message) {
    showErrorIn('#login-error', message);
  }

  function showErrorIn(selector, message) {
    var box = $(selector);
    box.querySelector('[data-role="text"]').textContent = message;
    box.classList.remove('hidden');
  }

  function clearError() {
    $('#login-error').classList.add('hidden');
    $('#register-error').classList.add('hidden');
    $('#reset-error').classList.add('hidden');
  }

  /** 送出期間鎖住按鈕，避免重複點擊送出兩次請求。 */
  function busy(selector, label) {
    var button = $(selector);
    var original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    return function () {
      button.disabled = false;
      button.textContent = original;
    };
  }

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

  /* ---------------------------------------------------------------- 註冊 */

  var PANELS = {
    login: { el: '#login-panel', focus: '#login-account' },
    register: { el: '#register-panel', focus: '#register-name' },
    reset: { el: '#reset-panel', focus: '#reset-email' }
  };

  function switchPanel(target) {
    clearError();
    Object.keys(PANELS).forEach(function (name) {
      $(PANELS[name].el).classList.toggle('hidden', name !== target);
    });
    if (target === 'reset') resetFlow();
    var focus = $(PANELS[target].focus);
    if (focus) focus.focus();
  }

  function handleRegister(event) {
    event.preventDefault();
    clearError();

    var name = $('#register-name').value.trim();
    var email = $('#register-email').value.trim();
    var password = $('#register-password').value;
    var confirm = $('#register-confirm').value;
    var invite = $('#register-invite').value.trim();

    if (password !== confirm) {
      return showErrorIn('#register-error', PATS.describeError('PASSWORD_MISMATCH'));
    }

    var button = $('#register-submit');
    button.disabled = true;
    button.textContent = '建立中…';

    PATS.rpc('register', {
      displayName: name,
      email: email,
      password: password,
      inviteCode: invite,
      remember: true
    })
      .then(function (result) {
        PATS.writeToken(result.token);
        $('#register-password').value = '';
        $('#register-confirm').value = '';
        PATS.toast('帳號建立完成，歡迎加入 PATS。', 'success');
        PatsMain.enterApp(result.user);
      })
      .catch(function (err) {
        // 後端啟用邀請碼時才把欄位顯示出來，一般情況不打擾使用者。
        if (err.code === 'INVITE_CODE_REQUIRED' || err.code === 'INVITE_CODE_INVALID') {
          $('#invite-field').classList.remove('hidden');
          $('#register-invite').focus();
        }
        showErrorIn('#register-error', err.message);
      })
      .finally(function () {
        button.disabled = false;
        button.textContent = '建立帳號';
      });
  }

  /* ------------------------------------------------------------ 忘記密碼 */

  var reset = { email: '', ticket: '' };

  var RESET_STEPS = {
    1: { form: '#reset-email-form', sub: '輸入你的電子郵件，我們會寄一組驗證碼給你' },
    2: { form: '#reset-code-form', sub: '' },
    3: { form: '#reset-password-form', sub: '驗證成功，請設定你的新密碼' }
  };

  function resetFlow() {
    reset = { email: '', ticket: '' };
    ['#reset-email', '#reset-code', '#reset-new', '#reset-confirm'].forEach(function (s) {
      $(s).value = '';
    });
    resetStep(1);
  }

  function resetStep(step) {
    Object.keys(RESET_STEPS).forEach(function (n) {
      $(RESET_STEPS[n].form).classList.toggle('hidden', Number(n) !== step);
    });
    PATS.$$('#reset-steps .step').forEach(function (li) {
      var n = Number(li.getAttribute('data-step'));
      li.classList.toggle('is-active', n === step);
      li.classList.toggle('is-done', n < step);
    });
    $('#reset-sub').textContent = RESET_STEPS[step].sub ||
      ('驗證碼已寄到 ' + reset.email + '，請查看收件匣');
    var focus = { 1: '#reset-email', 2: '#reset-code', 3: '#reset-new' }[step];
    if ($(focus)) $(focus).focus();
  }

  function sendResetCode(isResend) {
    clearError();
    var email = $('#reset-email').value.trim();
    var done = busy(isResend ? '#reset-resend' : '#reset-email-submit', '寄送中…');

    return PATS.rpc('requestReset', { email: email })
      .then(function () {
        reset.email = email;
        // 後端刻意不透露信箱是否存在，所以這裡一律往下一步走。
        if (!isResend) resetStep(2);
        else PATS.toast('驗證碼已重新寄出。', 'success');
      })
      .catch(function (err) { showErrorIn('#reset-error', err.message); })
      .finally(done);
  }

  function handleResetEmail(event) {
    event.preventDefault();
    sendResetCode(false);
  }

  function handleResetCode(event) {
    event.preventDefault();
    clearError();
    var done = busy('#reset-code-submit', '驗證中…');

    PATS.rpc('verifyResetCode', { email: reset.email, code: $('#reset-code').value.trim() })
      .then(function (result) {
        reset.ticket = result.ticket;
        resetStep(3);
      })
      .catch(function (err) {
        showErrorIn('#reset-error', err.message);
        // 驗證碼過期或試太多次，這組碼已被後端作廢，得重新申請。
        if (err.code === 'RESET_CODE_EXPIRED' || err.code === 'RESET_TOO_MANY_ATTEMPTS') {
          resetStep(1);
        }
      })
      .finally(done);
  }

  function handleResetPassword(event) {
    event.preventDefault();
    clearError();

    var password = $('#reset-new').value;
    if (password !== $('#reset-confirm').value) {
      return showErrorIn('#reset-error', PATS.describeError('PASSWORD_MISMATCH'));
    }

    var done = busy('#reset-password-submit', '更新中…');
    PATS.rpc('resetPassword', { ticket: reset.ticket, newPassword: password })
      .then(function (result) {
        PATS.writeToken(result.token);
        resetFlow();
        PATS.toast('密碼已更新，已為你登入。', 'success');
        PatsMain.enterApp(result.user);
      })
      .catch(function (err) {
        showErrorIn('#reset-error', err.message);
        if (err.code === 'RESET_TICKET_INVALID' || err.code === 'RESET_CODE_EXPIRED') {
          resetStep(1);
        }
      })
      .finally(done);
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
    $('#register-form').addEventListener('submit', handleRegister);

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

    $('#reset-email-form').addEventListener('submit', handleResetEmail);
    $('#reset-code-form').addEventListener('submit', handleResetCode);
    $('#reset-password-form').addEventListener('submit', handleResetPassword);
    $('#reset-resend').addEventListener('click', function () { sendResetCode(true); });

    $('#forgot-link').addEventListener('click', function (event) {
      event.preventDefault();
      // 已經打過的帳號如果是信箱，就順手帶進重設流程，少打一次。
      var account = $('#login-account').value.trim();
      switchPanel('reset');
      if (account.indexOf('@') > 0) $('#reset-email').value = account;
    });
    $('#reset-back').addEventListener('click', function (event) {
      event.preventDefault();
      switchPanel('login');
    });
    $('#go-register').addEventListener('click', function (event) {
      event.preventDefault();
      switchPanel('register');
    });
    $('#go-login').addEventListener('click', function (event) {
      event.preventDefault();
      switchPanel('login');
    });

    initGoogle();
  }

  return {
    init: init,
    logout: logout,
    showError: showError,
    clearError: clearError,
    showLoginPanel: function () { switchPanel('login'); }
  };
})();
