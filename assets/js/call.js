/* =====================================================================
   PATS — 通話狀態：撥號中 → 響鈴中 → 通話中 → 已掛斷
   ===================================================================== */

var PatsCall = (function () {
  'use strict';

  var socket = null;
  var session = null;
  var generation = 0;
  var timerId = null;
  var muted = false;

  function $(id) { return document.getElementById(id); }

  function iceServers() {
    var configured = PATS.state.config.iceServers;
    if (configured && configured.length) return configured;
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }

  function signalingUrl() {
    return PATS.state.config.signalingUrl || '';
  }

  /* --------------------------------------------------------------- 畫面 */

  function showLayer() { $('call-layer').classList.remove('hidden'); }
  function hideLayer() { $('call-layer').classList.add('hidden'); }

  function setStatus(text) { $('call-status').textContent = text; }

  function setActions(mode) {
    $('call-accept').classList.toggle('hidden', mode !== 'ringing');
    $('call-reject').classList.toggle('hidden', mode !== 'ringing');
    $('call-hangup').classList.toggle('hidden', mode === 'ringing' || mode === 'idle');
    $('call-mute').classList.toggle('hidden', mode !== 'active' && mode !== 'dialing' && mode !== 'connecting');
  }

  function paintPeer(name) {
    $('call-name').textContent = name || '對方';
    var avatar = $('call-avatar');
    avatar.textContent = PATS.initials(name);
  }

  function setMuteIcon() {
    var icon = $('call-mute').querySelector('.material-symbols-outlined');
    icon.textContent = muted ? 'mic_off' : 'mic';
    $('call-mute').setAttribute('aria-label', muted ? '取消靜音' : '靜音麥克風');
  }

  function startTimer() {
    stopTimer();
    var started = Date.now();
    timerId = setInterval(function () {
      var seconds = Math.floor((Date.now() - started) / 1000);
      var min = Math.floor(seconds / 60);
      var sec = seconds % 60;
      setStatus((min < 10 ? '0' : '') + min + ':' + (sec < 10 ? '0' : '') + sec);
    }, 1000);
  }

  function stopTimer() {
    if (timerId) clearInterval(timerId);
    timerId = null;
  }

  /* ------------------------------------------------------------- 連線 */

  function connect(user) {
    var url = signalingUrl();
    if (!url || typeof io !== 'function') return;
    if (socket) socket.disconnect();

    socket = io(url, { autoConnect: true, transports: ['websocket', 'polling'] });
    socket.on('connect', function () {
      socket.emit('register', {
        userId: user.id,
        name: user.displayName || user.username || user.email
      });
    });
    socket.on('incoming-call', onIncoming);
    socket.on('call-accepted', onAccepted);
    socket.on('call-rejected', function () { finish('對方已拒絕'); });
    socket.on('hung-up', function () { finish('通話已結束'); });
    socket.on('call-failed', function (payload) {
      if (payload && payload.reason === 'offline') finish('對方不在線上');
    });
    socket.on('ice-candidate', function (payload) {
      if (!sameCall(payload) || !session || !payload.candidate) return;
      if (!session.pc) {
        session.earlyIce.push(payload.candidate);
        return;
      }
      session.pc.addIceCandidate(payload.candidate);
    });
    socket.on('renegotiate', onRenegotiate);
    socket.on('renegotiate-answer', function (payload) {
      if (!sameCall(payload) || !session || !session.pc) return;
      session.pc.acceptAnswer(payload.answer).catch(function () { finish('重新連線失敗'); });
    });
    socket.on('request-restart', function (payload) {
      if (!sameCall(payload) || !session || !session.isCaller) return;
      restart();
    });
    socket.on('replaced', function () {
      finish('已在其他分頁登入');
    });
  }

  function disconnect() {
    finish(null);
    if (socket) {
      socket.disconnect();
      socket = null;
    }
  }

  function sameCall(payload) {
    return session && payload && payload.callId === session.callId;
  }

  function emit(event, extra) {
    if (!socket || !socket.connected || !session) return;
    socket.emit(event, Object.assign({ to: session.peerId, callId: session.callId }, extra || {}));
  }

  /* ------------------------------------------------------------- 通話 */

  function dial(peer) {
    if (!peer || !peer.id) {
      PATS.toast('找不到這位聯絡人。', 'error');
      return;
    }
    if (peer.id === (PATS.state.user && PATS.state.user.id)) return;
    if (!signalingUrl()) {
      PATS.toast('尚未設定通話伺服器。請在 config.js 填入 signalingUrl。', 'error');
      return;
    }
    if (!socket || !socket.connected) {
      PATS.toast('通話伺服器未連線。請先在 voip 資料夾執行 npm start。', 'error');
      return;
    }
    if (session) {
      PATS.toast('已經有一通通話進行中。', 'error');
      return;
    }

    var token = begin(peer, true);
    paintPeer(peer.name);
    setStatus('撥號中');
    setActions('dialing');
    showLayer();

    openMedia(token).then(function () {
      if (!alive(token)) return null;
      return session.pc.createOffer();
    }).then(function (offer) {
      if (!offer || !alive(token)) return;
      emit('call-user', { offer: offer });
    }).catch(function (err) {
      if (!alive(token)) return;
      finish(err && err.message ? err.message : '無法開始通話');
    });
  }

  function onIncoming(payload) {
    if (!payload || !payload.offer) return;
    if (session) {
      socket.emit('reject-call', { to: payload.from, callId: payload.callId, reason: 'busy' });
      return;
    }
    begin({ id: payload.from, name: payload.fromName }, false);
    session.callId = payload.callId;
    session.offer = payload.offer;
    paintPeer(payload.fromName);
    setStatus('響鈴中');
    setActions('ringing');
    showLayer();
  }

  function accept() {
    if (!session || session.phase !== 'ringing') return;
    var token = generation;
    var offer = session.offer;
    setStatus('接通中');
    setActions('connecting');

    openMedia(token).then(function () {
      if (!alive(token)) return null;
      return session.pc.acceptOffer(offer);
    }).then(function (answer) {
      if (!answer || !alive(token)) return;
      session.phase = 'connecting';
      emit('accept-call', { answer: answer });
    }).catch(function (err) {
      if (!alive(token)) return;
      emit('reject-call', {});
      finish(err && err.message ? err.message : '無法接聽');
    });
  }

  function reject() {
    if (!session) return;
    emit('reject-call', {});
    finish('已拒絕');
  }

  function hangup() {
    if (!session) return;
    emit('hang-up', {});
    finish('通話已結束');
  }

  function toggleMute() {
    if (!session || !session.stream) return;
    muted = !muted;
    AudioStreamManager.setMuted(session.stream, muted);
    setMuteIcon();
  }

  function onAccepted(payload) {
    if (!sameCall(payload) || !session || !session.pc) return;
    session.phase = 'connecting';
    setStatus('接通中');
    setActions('connecting');
    session.pc.acceptAnswer(payload.answer).catch(function () { finish('無法建立通話'); });
  }

  function onRenegotiate(payload) {
    if (!sameCall(payload) || !session || !session.pc || session.isCaller) return;
    session.pc.acceptOffer(payload.offer).then(function (answer) {
      emit('renegotiate-answer', { answer: answer });
    }).catch(function () { finish('重新連線失敗'); });
  }

  function markActive() {
    if (!session || session.phase === 'active') return;
    session.phase = 'active';
    setActions('active');
    startTimer();
  }

  function onConnectionState(state) {
    if (!session) return;
    if (state === 'connected' || state === 'completed') {
      markActive();
      return;
    }
    if (state === 'disconnected') {
      setStatus('連線不穩，正在重新連線…');
      scheduleRestart();
      return;
    }
    if (state === 'failed') restart();
  }

  function scheduleRestart() {
    if (!session || session.restartTimer) return;
    session.restartTimer = setTimeout(function () {
      if (session) session.restartTimer = null;
      restart();
    }, 3000);
  }

  function restart() {
    if (!session || !session.pc) return;
    if (session.retried) {
      finish('無法穿越網路。請確認 TURN 伺服器已啟動，且防火牆有放行 UDP。');
      return;
    }
    session.retried = true;
    setStatus('正在重新連線…');
    if (session.isCaller) {
      session.pc.restartIce().then(function (offer) {
        emit('renegotiate', { offer: offer });
      }).catch(function () { finish('重新連線失敗'); });
    } else {
      emit('request-restart', {});
    }
  }

  function openMedia(token) {
    return AudioStreamManager.getStream().then(function (stream) {
      if (!alive(token)) {
        AudioStreamManager.stop(stream);
        return;
      }
      session.stream = stream;
      session.pc = WebRTCManager.create({
        iceServers: iceServers(),
        onIceCandidate: function (candidate) {
          emit('ice-candidate', { candidate: candidate });
        },
        onTrack: function (remote) {
          var audio = $('call-remote');
          audio.srcObject = remote;
          audio.play().catch(function () {});
        },
        onConnectionState: onConnectionState
      });
      session.pc.addStream(stream);
      var queued = session.earlyIce.splice(0);
      queued.forEach(function (candidate) {
        session.pc.addIceCandidate(candidate);
      });
      muted = false;
      setMuteIcon();
    });
  }

  function begin(peer, isCaller) {
    generation += 1;
    session = {
      token: generation,
      callId: isCaller ? newId() : '',
      peerId: peer.id,
      isCaller: isCaller,
      phase: isCaller ? 'dialing' : 'ringing',
      pc: null,
      stream: null,
      offer: null,
      retried: false,
      restartTimer: null,
      earlyIce: []
    };
    return generation;
  }

  function alive(token) {
    return session && session.token === token;
  }

  function finish(message) {
    generation += 1;
    stopTimer();
    if (session) {
      if (session.restartTimer) clearTimeout(session.restartTimer);
      if (session.pc) session.pc.close();
      AudioStreamManager.stop(session.stream);
    }
    session = null;
    muted = false;
    var audio = $('call-remote');
    if (audio) {
      audio.pause();
      audio.srcObject = null;
    }
    hideLayer();
    if (message) PATS.toast(message);
  }

  function newId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function bind() {
    $('call-accept').addEventListener('click', accept);
    $('call-reject').addEventListener('click', reject);
    $('call-hangup').addEventListener('click', hangup);
    $('call-mute').addEventListener('click', toggleMute);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  return {
    connect: connect,
    disconnect: disconnect,
    dial: dial
  };
})();
