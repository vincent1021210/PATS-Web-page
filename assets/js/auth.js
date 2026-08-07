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

  /* 三種身分各自的信箱網域與說明，必須和後端 Auth.gs 的 ROLES 一致。 */
  var ROLES = {
    student: {
      label: '學生',
      domains: ['smail.hc.edu.tw'],
      hint: '請使用學校配發的 @smail.hc.edu.tw 信箱'
    },
    teacher: {
      label: '老師',
      domains: ['lsps.hc.edu.tw', 'tmail.hc.edu.tw'],
      hint: '請使用 @lsps.hc.edu.tw 或 @tmail.hc.edu.tw 信箱'
    },
    parent: {
      label: '家長',
      domains: ['gmail.com'],
      hint: '請使用 Gmail 信箱，並填寫孩子已註冊的學生帳號。' +
            '家長帳號只會收到孩子的違規與舉報通知，不能使用聊天功能。'
    }
  };

  /* 反查表：網域 → 身分，用來判斷使用者貼進來的信箱屬於哪一種身分。 */
  var DOMAIN_ROLE = {};
  Object.keys(ROLES).forEach(function (role) {
    ROLES[role].domains.forEach(function (domain) { DOMAIN_ROLE[domain] = role; });
  });

  var LOCAL_PART = /^[A-Za-z0-9._%+-]+$/;

  var registerRole = 'student';

  function selectRole(role) {
    registerRole = role;
    clearError();

    PATS.$$('#role-group .role-btn').forEach(function (button) {
      var active = button.getAttribute('data-role') === role;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    });

    $('#role-hint').textContent = ROLES[role].hint;
    $('#student-field').classList.toggle('hidden', role !== 'parent');
    $('#register-student').required = role === 'parent';

    // 老師有兩個網域可選，其餘身分只有一個，直接顯示成固定文字。
    var multi = ROLES[role].domains.length > 1;
    $('#register-domain').classList.toggle('hidden', multi);
    $('#register-domain-select').classList.toggle('hidden', !multi);
    $('#register-domain').textContent = '@' + ROLES[role].domains[0];
  }

  /**
   * 把註冊表單清成初始狀態。
   *
   * 只在回到「乾淨的登入畫面」時呼叫（首次載入、登出），不在使用者
   * 於登入／註冊之間來回切換時清除，免得打到一半的資料被吃掉。
   */
  function resetRegisterForm() {
    ['#register-name', '#register-local', '#register-student',
      '#register-password', '#register-confirm', '#register-invite',
      '#register-code'].forEach(function (s) {
      $(s).value = '';
    });
    $('#invite-field').classList.add('hidden');
    signup = null;
    selectRole('student');
    registerStep(1);
  }

  function registerEmail() {
    var local = $('#register-local').value.trim().replace(/^@+/, '');
    var domain = ROLES[registerRole].domains.length > 1
      ? $('#register-domain-select').value
      : ROLES[registerRole].domains[0];
    return local ? local + '@' + domain : '';
  }

  /**
   * 帳號欄只該填 @ 前面那一段，但使用者常常整串信箱貼進來。
   * 這裡把網域拆掉，並依網域判斷這是哪一種身分，需要的話自動切換。
   */
  function absorbTypedDomain() {
    var input = $('#register-local');
    var raw = input.value.trim();
    if (raw.indexOf('@') < 0) return true;

    var at = raw.indexOf('@');
    var local = raw.slice(0, at);
    var domain = raw.slice(at + 1).toLowerCase().replace(/\s+/g, '').replace(/@+$/, '');
    input.value = local;

    if (!domain) return true;

    var role = DOMAIN_ROLE[domain];
    if (!role) {
      showErrorIn('#register-error',
        '不支援的信箱網域「@' + domain + '」。PATS 只開放 ' +
        '@smail.hc.edu.tw（學生）、@lsps.hc.edu.tw 或 @tmail.hc.edu.tw（老師）、' +
        '@gmail.com（家長）。');
      return false;
    }

    if (role !== registerRole) {
      selectRole(role);
      PATS.toast('已依信箱網域自動把身分改成「' + ROLES[role].label + '」。', 'info');
    }
    if (ROLES[role].domains.length > 1) $('#register-domain-select').value = domain;
    return true;
  }

  /** 家長常只填孩子的帳號名稱，這裡補上學生網域並檢查對不對。 */
  function normalizeStudentAccount() {
    var input = $('#register-student');
    var value = input.value.trim().toLowerCase();
    if (!value) return '';
    if (value.indexOf('@') < 0) value += '@' + ROLES.student.domains[0];
    input.value = value;
    return value;
  }

  /** 送出前把三種身分的信箱規則逐一判斷過，錯了就別浪費一次寄信。 */
  function validateRegisterFields() {
    if (!absorbTypedDomain()) return false;

    var local = $('#register-local').value.trim();
    if (!local) {
      showErrorIn('#register-error', '請填寫電子郵件帳號（@ 前面那一段）。');
      return false;
    }
    if (!LOCAL_PART.test(local)) {
      showErrorIn('#register-error',
        '電子郵件帳號只能使用英文、數字與 . _ % + - 這些符號。');
      return false;
    }

    if (registerRole === 'parent') {
      var student = normalizeStudentAccount();
      if (!student) {
        showErrorIn('#register-error', PATS.describeError('STUDENT_ACCOUNT_REQUIRED'));
        return false;
      }
      if (ROLES.student.domains.indexOf(student.split('@').pop()) < 0) {
        showErrorIn('#register-error',
          '孩子的帳號必須是 @' + ROLES.student.domains[0] + ' 的學生信箱。');
        return false;
      }
    }

    return true;
  }

  /* 第一步填好的資料，等信箱驗證通過後才送去建立帳號。密碼只放在記憶體。 */
  var signup = null;

  function registerStep(step) {
    $('#register-form').classList.toggle('hidden', step !== 1);
    $('#register-verify-form').classList.toggle('hidden', step !== 2);

    PATS.$$('#register-steps .step').forEach(function (li) {
      var n = Number(li.getAttribute('data-step'));
      li.classList.toggle('is-active', n === step);
      li.classList.toggle('is-done', n < step);
    });

    $('#register-sub').textContent = step === 2 && signup
      ? '驗證碼已寄到 ' + signup.email + '，請查看收件匣'
      : '填寫以下資料，我們會寄驗證碼確認你的信箱';

    var focus = step === 2 ? '#register-code' : '#register-name';
    if ($(focus)) $(focus).focus();
  }

  /** 第一步：驗證資料並請後端寄出驗證碼。 */
  function sendSignupCode(isResend) {
    clearError();

    if (!validateRegisterFields()) return Promise.resolve();

    var password = $('#register-password').value;
    if (!isResend && password !== $('#register-confirm').value) {
      showErrorIn('#register-error', PATS.describeError('PASSWORD_MISMATCH'));
      return Promise.resolve();
    }

    var draft = {
      role: registerRole,
      displayName: $('#register-name').value.trim(),
      email: registerEmail(),
      studentAccount: $('#register-student').value.trim(),
      inviteCode: $('#register-invite').value.trim(),
      password: password
    };

    var done = busy(isResend ? '#register-resend' : '#register-submit', '寄送中…');

    return PATS.rpc('requestSignupCode', {
      role: draft.role,
      displayName: draft.displayName,
      email: draft.email,
      studentAccount: draft.studentAccount,
      inviteCode: draft.inviteCode
    })
      .then(function () {
        signup = draft;
        if (isResend) PATS.toast('驗證碼已重新寄出。', 'success');
        else registerStep(2);
      })
      .catch(function (err) {
        // 後端啟用邀請碼時才把欄位顯示出來，一般情況不打擾使用者。
        if (err.code === 'INVITE_CODE_REQUIRED' || err.code === 'INVITE_CODE_INVALID') {
          $('#invite-field').classList.remove('hidden');
          $('#register-invite').focus();
        }
        showErrorIn('#register-error', err.message);
      })
      .finally(done);
  }

  function handleRegister(event) {
    event.preventDefault();
    sendSignupCode(false);
  }

  /** 第二步：送出驗證碼，通過就建立帳號並直接登入。 */
  function handleRegisterVerify(event) {
    event.preventDefault();
    clearError();
    if (!signup) return registerStep(1);

    var done = busy('#register-verify-submit', '建立中…');

    PATS.rpc('register', {
      email: signup.email,
      code: $('#register-code').value.trim(),
      displayName: signup.displayName,
      password: signup.password,
      remember: true
    })
      .then(function (result) {
        PATS.writeToken(result.token);
        signup = null;
        resetRegisterForm();
        PATS.toast('帳號建立完成，歡迎加入 PATS。', 'success');
        PatsMain.enterApp(result.user);
      })
      .catch(function (err) {
        showErrorIn('#register-error', err.message);
        // 這幾種情況該組驗證碼已經作廢，得重新填一次資料再寄一次。
        if (err.code === 'SIGNUP_CODE_EXPIRED' ||
            err.code === 'SIGNUP_TOO_MANY_ATTEMPTS' ||
            err.code === 'SIGNUP_NOT_REQUESTED') {
          registerStep(1);
        }
      })
      .finally(done);
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
    $('#register-verify-form').addEventListener('submit', handleRegisterVerify);
    $('#register-resend').addEventListener('click', function () { sendSignupCode(true); });
    $('#register-back').addEventListener('click', function () {
      clearError();
      registerStep(1);
    });
    // 離開欄位就先判斷一次，不用等到按下按鈕才知道填錯。
    $('#register-local').addEventListener('blur', absorbTypedDomain);
    $('#register-student').addEventListener('blur', normalizeStudentAccount);
    PATS.$$('#role-group .role-btn').forEach(function (button) {
      button.addEventListener('click', function () {
        selectRole(button.getAttribute('data-role'));
      });
    });

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

    resetRegisterForm();
    initGoogle();
  }

  return {
    init: init,
    logout: logout,
    showError: showError,
    clearError: clearError,
    showLoginPanel: function () {
      resetRegisterForm();
      switchPanel('login');
    }
  };
})();
