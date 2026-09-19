/* ====================================================================
   TABLERO DE TURNOS EN VIVO  ·  pestaña "Turnos" del panel admin
   Autónomo: lee el token de sessionStorage (igual que script.js),
   se engancha a la pestaña por el DOM y escucha /api/stream por SSE.
   ==================================================================== */
(function () {
  var TOKEN_KEY = 'zane-auth-token';
  var SOUND_KEY = 'zane-board-sound';

  // Solo tiene sentido en el panel admin; en la landing pública no hace nada.
  var adminCtx = /(?:^|\/)admin(?:\/|$)/.test(location.pathname) ||
    new URLSearchParams(location.search).has('admin');
  if (!adminCtx) return;

  var pendingEl = document.getElementById('turnosPending');
  var queueEl = document.getElementById('turnosQueue');
  if (!pendingEl || !queueEl) return;

  var statusEl = document.getElementById('boardStatus');
  var soundBtn = document.getElementById('boardSound');
  var pendCountEl = document.getElementById('turnosPendingCount');
  var queueCountEl = document.getElementById('turnosQueueCount');
  var tabBadge = document.getElementById('tabCountTurnos');
  var tabBtn = document.querySelector('[data-panel-tab="turnos"]');
  var kpisEl = document.getElementById('turnosKpis');
  var historyEl = document.getElementById('turnosHistory');
  var historyCountEl = document.getElementById('turnosHistoryCount');
  var daysEl = document.getElementById('turnosDays');
  var callNextBtn = document.getElementById('callNext');

  var byId = {};
  var es = null;
  var started = false;
  var soundOn = localStorage.getItem(SOUND_KEY) !== '0';
  var audioCtx = null;

  // Iconos en línea (Lucide, heredan el color del botón con currentColor)
  var SVG_OPEN = '<svg class="ico" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var SPEAKER = '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/>';
  var ICON_VOLUME_ON = SVG_OPEN + SPEAKER + '<path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/></svg>';
  var ICON_VOLUME_OFF = SVG_OPEN + SPEAKER + '<line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/></svg>';

  injectCss();
  reflectSound();

  // ---- helpers ---------------------------------------------------------
  function token() { return sessionStorage.getItem(TOKEN_KEY) || ''; }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign(
      { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
      opts.headers || {}
    );
    return fetch(path, opts);
  }

  function money(bs) { return 'Bs. ' + Math.round(Number(bs) || 0).toLocaleString('es-VE'); }
  function usd(c) { return '$' + (Number(c) / 100).toFixed(0); }

  function ago(ts) {
    if (!ts) return '';
    var d = new Date(String(ts).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return '';
    var m = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
    if (m < 1) return 'ahora';
    if (m < 60) return 'hace ' + m + ' min';
    return 'hace ' + Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }
  function isTerminal(o) {
    return o.payment_status === 'rejected' || o.payment_status === 'expired' ||
      o.queue_status === 'done' || o.queue_status === 'no_show' || o.queue_status === 'cancelled';
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  function setStatus(state, text) {
    if (!statusEl) return;
    statusEl.dataset.state = state;
    statusEl.textContent = text;
  }

  function beep() {
    if (!soundOn) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      [880, 1245].forEach(function (freq, i) {
        var o = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        var t0 = audioCtx.currentTime + i * 0.16;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t0); o.stop(t0 + 0.24);
      });
    } catch (e) { /* sin audio, sin drama */ }
  }

  function reflectSound() {
    if (!soundBtn) return;
    soundBtn.setAttribute('aria-pressed', String(soundOn));
    soundBtn.innerHTML = soundOn
      ? ICON_VOLUME_ON + ' Sonido'
      : ICON_VOLUME_OFF + ' Silencio';
  }
  if (soundBtn) soundBtn.addEventListener('click', function () {
    soundOn = !soundOn;
    localStorage.setItem(SOUND_KEY, soundOn ? '1' : '0');
    reflectSound();
    if (soundOn) beep();
  });

  // ---- dispositivos (tablets) --------------------------------------
  var devPanel = document.getElementById('devicePanel');
  var devList = document.getElementById('deviceList');
  var devEnroll = document.getElementById('deviceEnroll');
  var devBtn = document.getElementById('boardDevices');
  var devAdd = document.getElementById('deviceAdd');

  function loadDevices() {
    if (!devList) return;
    api('/api/kiosc/devices').then(function (r) { return r.ok ? r.json() : []; }).then(function (list) {
      devList.innerHTML = list.length
        ? list.map(function (d) {
            return '<div class="device-row">' +
              '<div><strong>' + esc(d.label) + '</strong>' +
              '<span>visto ' + (d.last_seen_at ? esc(d.last_seen_at) : 'nunca') + '</span></div>' +
              '<button type="button" class="btn-no" data-revoke="' + d.id + '">Revocar</button>' +
              '</div>';
          }).join('')
        : '<p class="admin-empty">Ninguna tablet registrada.</p>';
    });
  }

  if (devBtn) devBtn.addEventListener('click', function () {
    devPanel.hidden = !devPanel.hidden;
    if (!devPanel.hidden) loadDevices();
  });

  if (devAdd) devAdd.addEventListener('click', function () {
    window.zanePrompt({
      title: 'Registrar tablet',
      message: 'Ponle un nombre para reconocerla en la lista de dispositivos.',
      label: 'Nombre de la tablet',
      value: 'Tablet recepción',
      placeholder: 'Ej. Tablet recepción',
      confirmText: 'Registrar'
    }).then(function (label) {
      if (!label) return;
      api('/api/kiosc/devices', { method: 'POST', body: JSON.stringify({ label: label }) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var link = location.origin + '/kiosc/?enroll=' + d.token;
          devEnroll.hidden = false;
          devEnroll.innerHTML =
            '<p><strong>' + esc(d.label) + '</strong> — abre este enlace <em>una sola vez</em> en la tablet:</p>' +
            '<code>' + esc(link) + '</code>' +
            '<div class="device-enroll-actions">' +
            '<button type="button" id="devCopy">Copiar enlace</button>' +
            '<button type="button" id="devHide">Cerrar</button></div>';
          document.getElementById('devCopy').onclick = function () {
            if (navigator.clipboard) navigator.clipboard.writeText(link);
            this.textContent = 'Copiado ✓';
          };
          document.getElementById('devHide').onclick = function () { devEnroll.hidden = true; };
          loadDevices();
        })
        .catch(function () {
          window.zaneAlert({
            title: 'No se pudo registrar',
            message: 'La tablet no quedó registrada. Revisa la conexión e inténtalo de nuevo.'
          });
        });
    });
  });

  if (devList) devList.addEventListener('click', function (e) {
    var b = e.target.closest('[data-revoke]');
    if (!b) return;
    var row = b.closest('.device-row');
    var name = row && row.querySelector('strong') ? row.querySelector('strong').textContent : 'esta tablet';
    window.zaneConfirm({
      title: 'Revocar tablet',
      message: '¿Revocar el acceso de "' + name + '"?',
      detail: 'Dejará de recibir turnos y tendrás que volver a vincularla con un enlace nuevo.',
      confirmText: 'Revocar',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      api('/api/kiosc/devices/' + b.dataset.revoke, { method: 'DELETE' }).then(loadDevices);
    });
  });

  // ---- editor de Pago Móvil --------------------------------------
  var pmPanel = document.getElementById('pmPanel');
  var pmForms = document.getElementById('pmForms');
  var pmBtn = document.getElementById('boardPm');
  var pmAdd = document.getElementById('pmAdd');
  var pmSave = document.getElementById('pmSave');
  var pmMsg = document.getElementById('pmMsg');

  function pmField(label, name, val, ph) {
    return '<label>' + esc(label) + '<input data-pm="' + name + '" value="' + esc(val || '') + '"' +
      (ph ? ' placeholder="' + esc(ph) + '"' : '') + '></label>';
  }
  function pmFieldset(m, i) {
    m = m || {};
    return '<fieldset class="pm-fs">' +
      '<div class="pm-grid">' +
      pmField('Banco', 'bank', m.bank, 'Banesco') +
      pmField('Código', 'code', m.code, '0134') +
      pmField('Teléfono', 'phone', m.phone, '0412...') +
      pmField('Cédula / RIF', 'id', m.id, 'V-12.345.678') +
      pmField('Ruta del QR', 'qr', m.qr, 'kiosc/img/archivo.png') +
      '</div><button type="button" class="btn-no" data-pm-del="' + i + '">Quitar</button></fieldset>';
  }
  function pmRender(list) {
    pmForms.innerHTML = list.length
      ? list.map(pmFieldset).join('')
      : '<p class="admin-empty">Sin bancos. Pulsa “Añadir banco”.</p>';
  }
  function pmCollect() {
    return [].map.call(pmForms.querySelectorAll('.pm-fs'), function (fs) {
      var o = {};
      [].forEach.call(fs.querySelectorAll('[data-pm]'), function (inp) { o[inp.dataset.pm] = inp.value.trim(); });
      return o;
    });
  }
  function pmLoad() {
    api('/api/kiosc/pago-movil').then(function (r) { return r.ok ? r.json() : []; }).then(pmRender);
  }
  if (pmBtn) pmBtn.addEventListener('click', function () {
    pmPanel.hidden = !pmPanel.hidden;
    if (!pmPanel.hidden) pmLoad();
  });
  if (pmAdd) pmAdd.addEventListener('click', function () {
    var cur = pmCollect(); cur.push({}); pmRender(cur);
  });
  if (pmForms) pmForms.addEventListener('click', function (e) {
    var d = e.target.closest('[data-pm-del]');
    if (!d) return;
    var cur = pmCollect(); cur.splice(Number(d.dataset.pmDel), 1); pmRender(cur);
  });
  if (pmSave) pmSave.addEventListener('click', function () {
    pmSave.disabled = true; if (pmMsg) pmMsg.textContent = '';
    api('/api/kiosc/pago-movil', { method: 'PUT', body: JSON.stringify({ methods: pmCollect() }) })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (list) { pmRender(list); if (pmMsg) pmMsg.textContent = 'Guardado ✓'; })
      .catch(function () { if (pmMsg) pmMsg.textContent = 'No se pudo guardar.'; })
      .then(function () { pmSave.disabled = false; });
  });

  // ---- render --------------------------------------------------------
  function render() {
    var orders = Object.keys(byId).map(function (k) { return byId[k]; });
    var pending = orders
      .filter(function (o) { return o.payment_status === 'submitted'; })
      .sort(function (a, b) {
        return String(a.submitted_at || a.created_at).localeCompare(String(b.submitted_at || b.created_at));
      });
    var queue = orders
      .filter(function (o) { return o.queue_status === 'waiting' || o.queue_status === 'in_service'; })
      .sort(function (a, b) { return (a.queue_no || 0) - (b.queue_no || 0); });
    var history = orders.filter(isTerminal).sort(function (a, b) {
      return String(b.done_at || b.paid_at || b.created_at).localeCompare(String(a.done_at || a.paid_at || a.created_at));
    });

    renderKpis(orders, queue);

    pendingEl.innerHTML = pending.length
      ? pending.map(pendingCard).join('')
      : '<p class="admin-empty">Nada por validar.</p>';
    queueEl.innerHTML = queue.length
      ? queue.map(queueCard).join('')
      : '<p class="admin-empty">Cola vacía.</p>';
    if (historyEl) historyEl.innerHTML = history.length
      ? history.map(historyRow).join('')
      : '<p class="admin-empty">Aún nada.</p>';

    if (pendCountEl) pendCountEl.textContent = pending.length;
    if (queueCountEl) queueCountEl.textContent = queue.length;
    if (historyCountEl) historyCountEl.textContent = history.length;
    if (callNextBtn) {
      var anyWaiting = queue.some(function (o) { return o.queue_status === 'waiting'; });
      var anyServing = queue.some(function (o) { return o.queue_status === 'in_service'; });
      callNextBtn.hidden = !anyWaiting || anyServing;
    }
    if (tabBadge) {
      tabBadge.textContent = pending.length || queue.length;
      tabBadge.classList.toggle('has-urgent', pending.length > 0);
    }
    pending.forEach(function (o) { if (o.has_proof) loadProof(o.id); });
  }

  function renderKpis(all, queue) {
    if (!kpisEl) return;
    var waiting = 0, serv = 0, done = 0, rejected = 0, cobrado = 0;
    all.forEach(function (o) {
      if (o.queue_status === 'waiting') waiting++;
      if (o.queue_status === 'in_service') serv++;
      if (o.queue_status === 'done') done++;
      if (o.payment_status === 'rejected') rejected++;
      if (o.payment_status === 'validated') cobrado += Number(o.amount_bs) || 0;
    });
    kpisEl.innerHTML =
      kpi('En espera', waiting) +
      kpi('En la silla', serv) +
      kpi('Atendidos', done) +
      kpi('Rechazados', rejected, rejected ? 'crit' : '') +
      kpi('Cobrado hoy', money(cobrado), 'wide');
  }
  function kpi(label, value, mod) {
    return '<div class="kpi' + (mod ? ' kpi--' + mod : '') + '">' +
      '<strong>' + esc(value) + '</strong><span>' + esc(label) + '</span></div>';
  }

  function pendingCard(o) {
    var proof = o.has_proof
      ? '<button type="button" class="turno-proof" data-proof="' + o.id + '">' +
          '<img alt="comprobante" data-thumb="' + o.id + '"><span>Ver</span></button>'
      : '';
    var refLine = o.payment_reference ? 'Ref: <strong>' + esc(o.payment_reference) + '</strong> · ' : '';
    return '<article class="client-item turno-card is-pending" data-id="' + o.id + '">' +
      '<div><h4>' + esc(o.client_name) + ' <span class="turno-code">' + esc(o.code) + '</span></h4>' +
      '<p>' + esc(o.client_phone) + ' · ' + esc(o.service_name) + '</p>' +
      '<p class="turno-amount">' + money(o.amount_bs) + ' <small>(' + usd(o.amount_usd_cents) + ')</small></p>' +
      '<p class="turno-ref">' + refLine + '<span class="turno-age">' + ago(o.submitted_at || o.created_at) + '</span></p>' +
      '</div>' +
      '<div class="turno-side">' + proof +
        '<div class="turno-actions">' +
          '<button type="button" class="btn-ok" data-act="validate" data-id="' + o.id + '">Validar pago</button>' +
          '<button type="button" class="btn-no" data-act="reject" data-id="' + o.id + '">Rechazar</button>' +
        '</div></div>' +
      '</article>';
  }

  function queueCard(o) {
    var inService = o.queue_status === 'in_service';
    var pill = inService
      ? '<span class="turno-pill p-serv">En la silla · ' + ago(o.called_at) + '</span>'
      : '<span class="turno-pill p-wait">Esperando · ' + ago(o.paid_at || o.created_at) + '</span>';
    var primary = inService
      ? '<button type="button" class="btn-ok" data-act="done" data-id="' + o.id + '">Finalizar</button>'
      : '<button type="button" class="btn-ok" data-act="call" data-id="' + o.id + '">Llamar</button>';
    return '<article class="client-item turno-card' + (inService ? ' is-serv' : '') + '" data-id="' + o.id + '">' +
      '<div class="turno-num">' + (o.queue_no || '–') + '</div>' +
      '<div><h4>' + esc(o.client_name) + ' <span class="turno-code">' + esc(o.code) + '</span></h4>' +
      '<p>' + esc(o.service_name) + ' · ' + money(o.amount_bs) + '</p>' + pill + '</div>' +
      '<div class="turno-actions">' + primary +
        '<button type="button" class="btn-no" data-act="no-show" data-id="' + o.id + '">No vino</button>' +
      '</div></article>';
  }

  function historyRow(o) {
    var label, cls;
    if (o.payment_status === 'rejected') { label = 'Rechazado' + (o.reject_reason ? ' · ' + o.reject_reason : ''); cls = 'h-rej'; }
    else if (o.payment_status === 'expired') { label = 'Sin pago'; cls = 'h-mut'; }
    else if (o.queue_status === 'no_show') { label = 'No vino'; cls = 'h-mut'; }
    else if (o.queue_status === 'cancelled') { label = 'Cancelado'; cls = 'h-mut'; }
    else { label = 'Atendido'; cls = 'h-ok'; }
    return '<div class="history-row ' + cls + '">' +
      '<span class="turno-code">' + esc(o.code) + '</span>' +
      '<span class="h-name">' + esc(o.client_name) + '</span>' +
      '<span class="h-svc">' + esc(o.service_name) + '</span>' +
      '<span class="h-amt">' + money(o.amount_bs) + '</span>' +
      '<span class="h-tag">' + esc(label) + '</span>' +
      '<span class="h-time">' + ago(o.done_at || o.paid_at || o.created_at) + '</span>' +
      '</div>';
  }

  // ---- comprobante (imagen protegida por JWT -> blob) ----------------
  var proofUrls = {};
  function loadProof(id) {
    if (proofUrls[id]) { paintThumb(id); return; }
    proofUrls[id] = 'pending';
    api('/api/orders/' + id + '/proof').then(function (r) {
      if (!r.ok) throw r;
      return r.blob();
    }).then(function (blob) {
      proofUrls[id] = URL.createObjectURL(blob);
      paintThumb(id);
    }).catch(function () { proofUrls[id] = null; });
  }
  function paintThumb(id) {
    var u = proofUrls[id];
    if (!u || u === 'pending') return;
    var img = pendingEl.querySelector('img[data-thumb="' + id + '"]');
    if (img && img.src !== u) img.src = u;
  }

  // ---- acciones -----------------------------------------------------
  function handleClick(e) {
    var proofBtn = e.target.closest('[data-proof]');
    if (proofBtn) {
      var u = proofUrls[proofBtn.dataset.proof];
      if (u && u !== 'pending') window.open(u, '_blank', 'noopener');
      return;
    }
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var id = btn.dataset.id;
    var act = btn.dataset.act;
    var who = (byId[id] && byId[id].client_name) ? byId[id].client_name : 'este cliente';

    var ask;
    if (act === 'reject') {
      ask = window.zanePrompt({
        title: 'Rechazar pago',
        message: 'Se le avisará a ' + who + ' que la referencia no fue válida.',
        label: 'Motivo del rechazo',
        value: 'La referencia no coincide',
        placeholder: 'Explica brevemente el motivo',
        confirmText: 'Rechazar pago'
      }).then(function (reason) {
        return reason === null ? { cancel: true } : { reason: reason };
      });
    } else if (act === 'no-show') {
      ask = window.zaneConfirm({
        title: 'Marcar que no vino',
        message: '¿' + who + ' no se presentó a su turno?',
        detail: 'Saldrá de la cola de espera.',
        confirmText: 'No vino',
        danger: true
      }).then(function (ok) { return ok ? {} : { cancel: true }; });
    } else if (act === 'done') {
      ask = window.zaneConfirm({
        title: 'Cerrar turno',
        message: '¿Terminaste el servicio de ' + who + '?',
        detail: 'El turno pasará al historial del día.',
        confirmText: 'Marcar terminado'
      }).then(function (ok) { return ok ? {} : { cancel: true }; });
    } else {
      ask = Promise.resolve({});
    }

    ask.then(function (res) {
      if (!res || res.cancel) return;
      var reason = res.reason != null ? res.reason : null;
      setBusy(btn, true);
      api('/api/orders/' + id + '/' + act, {
        method: 'POST',
        body: reason != null ? JSON.stringify({ reason: reason }) : undefined
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (x) { throw x; });
        if (act === 'reject') {
          if (byId[id]) { byId[id].payment_status = 'rejected'; byId[id].reject_reason = reason; }
          render();
        } else {
          return r.json().then(function (order) { byId[order.id] = order; render(); });
        }
      }).catch(function (x) {
        setBusy(btn, false);
        window.zaneAlert({
          title: 'No se pudo completar',
          message: (x && x.error) || 'La acción no se aplicó. Revisa la conexión e inténtalo otra vez.'
        });
      });
    });
  }
  function setBusy(btn, on) {
    btn.disabled = on;
    var card = btn.closest('.turno-card');
    if (card) card.classList.toggle('is-busy', on);
  }
  pendingEl.addEventListener('click', handleClick);
  queueEl.addEventListener('click', handleClick);

  if (callNextBtn) callNextBtn.addEventListener('click', function () {
    var next = Object.keys(byId).map(function (k) { return byId[k]; })
      .filter(function (o) { return o.queue_status === 'waiting'; })
      .sort(function (a, b) { return (a.queue_no || 0) - (b.queue_no || 0); })[0];
    if (!next) return;
    callNextBtn.disabled = true;
    api('/api/orders/' + next.id + '/call', { method: 'POST' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (o) { byId[o.id] = o; render(); })
      .catch(function () {})
      .then(function () { callNextBtn.disabled = false; });
  });

  // refresca los "hace N min" sin recargar del servidor
  setInterval(function () { if (started && !document.hidden) render(); }, 30000);

  // ---- carga inicial + SSE ----------------------------------------
  function loadBoard() {
    setStatus('connecting', 'Cargando…');
    return api('/api/orders').then(function (r) {
      if (!r.ok) throw r;
      return r.json();
    }).then(function (list) {
      byId = {};
      list.forEach(function (o) { byId[o.id] = o; });
      render();
    }).catch(function () {
      setStatus('error', 'No se pudo cargar');
    });
  }

  // ---- historial de días anteriores --------------------------------
  var todayISO = new Date().toLocaleDateString('sv-SE'); // yyyy-mm-dd, hora local
  function loadHistory() {
    if (!daysEl) return;
    api('/api/orders/history?days=30').then(function (r) {
      if (!r.ok) throw r;
      return r.json();
    }).then(renderDays).catch(function () {
      daysEl.innerHTML = '<p class="admin-empty">No se pudo cargar el historial.</p>';
    });
  }

  function renderDays(rows) {
    var past = rows.filter(function (d) { return d.date !== todayISO; });
    if (!past.length) {
      daysEl.innerHTML = '<p class="admin-empty">Todavía no hay días anteriores registrados.</p>';
      return;
    }
    daysEl.innerHTML =
      '<table class="board-days"><thead><tr><th>Día</th><th>Cortes</th><th>Cobrado</th></tr></thead><tbody>' +
      past.map(function (d) {
        var label = new Date(d.date + 'T12:00:00').toLocaleDateString('es-VE', { weekday: 'short', day: 'numeric', month: 'short' });
        return '<tr><td>' + label + '</td><td>' + d.cuts + '</td><td>' + money(d.revenue_bs) + '</td></tr>';
      }).join('') +
      '</tbody></table>';
  }

  function connectStream() {
    if (es || !token()) return;
    api('/api/stream-token', { method: 'POST' }).then(function (r) {
      if (!r.ok) throw r;
      return r.json();
    }).then(function (d) {
      es = new EventSource('/api/stream?token=' + encodeURIComponent(d.token));

      // al (re)conectar, resincroniza por si se perdieron eventos; loadBoard()
      // pone el estado en "Cargando…" así que "En vivo" se marca después,
      // si no queda pisado y el badge se ve pegado en "Cargando…" para siempre.
      es.onopen = function () { loadBoard().then(function () { setStatus('live', 'En vivo'); }); };

      es.addEventListener('order.submitted', function (ev) {
        var o = JSON.parse(ev.data);
        var isNew = !byId[o.id] || byId[o.id].payment_status !== 'submitted';
        byId[o.id] = o; render();
        if (isNew) {
          beep();
          if (window.Notification && Notification.permission === 'granted') {
            new Notification('Pago por validar', { body: o.client_name + ' · ' + o.service_name + ' · ' + money(o.amount_bs) });
          }
        }
      });
      ['order.validated', 'order.called', 'order.done', 'order.no_show'].forEach(function (name) {
        es.addEventListener(name, function (ev) {
          var o = JSON.parse(ev.data); byId[o.id] = o; render();
        });
      });
      es.addEventListener('order.rejected', function (ev) {
        var o = JSON.parse(ev.data);
        if (byId[o.id]) { byId[o.id].payment_status = 'rejected'; byId[o.id].reject_reason = o.reason; }
        render();
      });
      es.addEventListener('order.expired', function (ev) {
        var o = JSON.parse(ev.data);
        if (byId[o.id]) { byId[o.id].payment_status = 'expired'; render(); }
      });

      es.onerror = function () {
        if (es && es.readyState === EventSource.CLOSED) {
          es = null;
          setStatus('error', 'Reconectando…');
          setTimeout(connectStream, 3000);
        }
      };
    }).catch(function () {
      setStatus('error', 'Sin conexión');
      setTimeout(connectStream, 5000);
    });
  }

  function start() {
    if (started) { loadBoard(); return; }
    started = true;
    if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
    loadBoard().then(connectStream);
    loadHistory();
  }

  // arrancar al abrir la pestaña Turnos (y re-cargar en cada visita)
  if (tabBtn) tabBtn.addEventListener('click', start);
  // si el admin ya tenía sesión y la pestaña está visible al cargar
  if (tabBtn && tabBtn.classList.contains('is-active')) start();

  // ---- CSS del tablero (inyectado, no toca custom.css) --------------
  function injectCss() {
    if (document.getElementById('board-css')) return;
    var s = document.createElement('style');
    s.id = 'board-css';
    s.textContent = [
      '.board-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:4px}',
      '.board-bar .btn{display:inline-flex;align-items:center;gap:7px}',
      'svg.ico{width:1.05em;height:1.05em;flex:0 0 auto;vertical-align:-.16em}',
      '.board-status{font:600 12px/1 "IBM Plex Mono",monospace;letter-spacing:.06em;text-transform:uppercase;',
      'padding:5px 10px;border-radius:999px;border:1px solid currentColor}',
      '.board-status[data-state="off"],.board-status[data-state="error"]{color:#F0736A}',
      '.board-status[data-state="connecting"]{color:var(--zane-gold,#C8C7C9)}',
      '.board-status[data-state="live"]{color:#43C588}',
      '.board-days{width:100%;border-collapse:collapse;font-size:.9rem}',
      '.board-days th,.board-days td{padding:7px 10px;text-align:left;',
      'border-bottom:1px solid var(--zane-border,rgba(255,255,255,.1))}',
      '.board-days th{font:600 10.5px/1.3 "IBM Plex Mono",monospace;text-transform:uppercase;',
      'letter-spacing:.04em;color:var(--zane-text-muted,#8E8E90)}',
      '.board-days td:first-child{text-transform:capitalize}',
      '.turno-card{align-items:flex-start;gap:14px}',
      '.turno-card.is-pending{border-left:3px solid var(--accent-urgent,#D97757)}',
      '.turno-card.is-serv{border-left:3px solid #43C588}',
      '.turno-card.is-busy{opacity:.5;pointer-events:none}',
      '.turno-code{font:500 11px/1 "IBM Plex Mono",monospace;color:var(--zane-text-muted,#8E8E90);',
      'border:1px solid var(--zane-border,rgba(255,255,255,.15));border-radius:5px;padding:2px 6px;margin-left:6px}',
      '.turno-amount{font-size:1.05rem;font-weight:700;margin:4px 0 2px}',
      '.turno-amount small{font-weight:500;color:var(--zane-text-muted,#8E8E90)}',
      '.turno-ref{font-size:.85rem;color:var(--zane-text-secondary,#C8C7C9);margin:0}',
      '.turno-warn{color:#F0736A;font-size:.82rem;margin:6px 0 0;display:flex;gap:6px;align-items:center}',
      '.turno-side{display:flex;flex-direction:column;gap:8px;align-items:flex-end;min-width:130px}',
      '.turno-num{font:800 1.6rem/1 "Archivo","Barlow Condensed",sans-serif;color:var(--zane-gold,#C8C7C9);',
      'min-width:44px;text-align:center}',
      '.turno-actions{display:flex;flex-direction:column;gap:6px}',
      '.turno-actions button,.turno-proof{font:600 13px/1 inherit;padding:9px 14px;border-radius:8px;',
      'border:1px solid var(--zane-border,rgba(255,255,255,.18));cursor:pointer;white-space:nowrap;',
      'background:var(--zane-bg-elevated,#213A63);color:var(--zane-text-main,#fff);',
      'transition:transform 100ms ease-out}',
      '.turno-actions button:active,.turno-proof:active{transform:scale(.94)}',
      '.turno-actions .btn-ok{background:var(--azul-brand,#1C1C1E);border-color:transparent}',
      '.turno-actions .btn-no{background:transparent}',
      '.turno-proof.has-thumb{border-color:var(--zane-gold,#C8C7C9)}',
      '.turno-noproof{font-size:.78rem;color:var(--zane-text-muted,#8E8E90)}',
      '.turno-pill{display:inline-block;font:600 11px/1 "IBM Plex Mono",monospace;padding:3px 8px;',
      'border-radius:999px;border:1px solid currentColor;margin-top:4px}',
      '.turno-pill.p-wait{color:var(--accent-urgent,#D97757)}',
      '.turno-pill.p-serv{color:#43C588}',
      '@media (max-width:640px){.turno-card{flex-wrap:wrap}.turno-side{align-items:stretch;width:100%}',
      '.turno-actions{flex-direction:row}}',
      '.device-panel{border:1px solid var(--zane-border,rgba(255,255,255,.14));border-radius:14px;padding:16px 18px;margin-top:14px;',
      'background:var(--zane-bg-card,#12305F)}',
      '.device-row{display:flex;justify-content:space-between;align-items:center;gap:12px;',
      'padding:10px 0;border-bottom:1px solid var(--zane-border,rgba(255,255,255,.14))}',
      '.device-row:last-child{border-bottom:0}',
      '.device-row span{display:block;font:500 12px/1.4 "IBM Plex Mono",monospace;color:var(--zane-text-muted,#8E8E90)}',
      '.device-row .btn-no{font:600 12px/1 inherit;padding:7px 12px;border-radius:8px;',
      'border:1px solid var(--zane-border,rgba(255,255,255,.14));background:transparent;color:var(--zane-text-main,#fff);cursor:pointer}',
      '.device-enroll{margin:12px 0;padding:14px 16px;border-radius:12px;',
      'background:var(--zane-bg-elevated,#1B2136);border:1px solid var(--zane-gold,#C8C7C9)}',
      '.device-enroll code{display:block;word-break:break-all;font-size:12.5px;margin:8px 0 12px;',
      'padding:8px 10px;background:rgba(0,0,0,.25);border-radius:8px}',
      '.device-enroll-actions{display:flex;gap:8px}',
      '.device-enroll-actions button{font:600 13px/1 inherit;padding:9px 14px;border-radius:8px;',
      'border:1px solid var(--zane-border,rgba(255,255,255,.14));background:var(--azul-brand,#1C1C1E);color:#fff;cursor:pointer}',
      // --- resumen del día (KPIs) ---
      '.board-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(94px,1fr));gap:10px;margin:14px 0 4px}',
      '.kpi{background:var(--zane-bg-card,#12305F);border:1px solid var(--zane-border,rgba(255,255,255,.14));border-radius:12px;padding:12px 14px}',
      '.kpi strong{display:block;font:800 1.4rem/1.05 "Archivo","Barlow Condensed",sans-serif;color:var(--zane-text-main,#fff)}',
      '.kpi span{font:600 10.5px/1.3 "IBM Plex Mono",monospace;text-transform:uppercase;letter-spacing:.04em;color:var(--zane-text-muted,#8E8E90)}',
      '.kpi--crit strong{color:#F0736A}',
      '.kpi--wide{grid-column:span 2}',
      '@media (max-width:520px){.kpi--wide{grid-column:auto}}',
      // --- edad y miniatura ---
      '.turno-age{color:var(--zane-text-muted,#8E8E90)}',
      '.turno-proof{display:flex !important;flex-direction:column;align-items:center;gap:4px;padding:6px !important;overflow:hidden}',
      '.turno-proof img{width:104px;height:78px;object-fit:cover;border-radius:6px;display:block;background:rgba(0,0,0,.25)}',
      '.turno-proof span{font:600 11px/1 inherit}',
      '#callNext[hidden]{display:none}',
      '.device-row .btn-no,.device-enroll-actions button,.pm-fs .btn-no,#callNext,#boardSound,#boardDevices,#boardPm,#deviceAdd,#pmAdd,#pmSave{',
      'transition:transform 100ms ease-out}',
      '.device-row .btn-no:active,.device-enroll-actions button:active,.pm-fs .btn-no:active,',
      '#callNext:active,#boardSound:active,#boardDevices:active,#boardPm:active,#deviceAdd:active,#pmAdd:active,#pmSave:active{transform:scale(.95)}',
      // --- historial del día ---
      '.board-history{margin-top:22px;border-top:1px solid var(--zane-border,rgba(255,255,255,.14));padding-top:8px}',
      '.board-history summary{cursor:pointer;font:700 13px/1 "Archivo",sans-serif;text-transform:uppercase;',
      'letter-spacing:.04em;color:var(--zane-text-secondary,#C8C7C9);padding:6px 0;list-style-position:inside}',
      '.board-history summary span{color:var(--zane-gold,#C8C7C9);margin-left:6px}',
      '.history-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;padding:9px 2px;',
      'border-bottom:1px solid var(--zane-border,rgba(255,255,255,.14));font-size:.85rem}',
      '.history-row:last-child{border-bottom:0}',
      '.history-row .h-name{font-weight:600;color:var(--zane-text-main,#fff)}',
      '.history-row .h-svc,.history-row .h-time{color:var(--zane-text-muted,#8E8E90)}',
      '.history-row .h-amt{font-variant-numeric:tabular-nums}',
      '.history-row .h-tag{font:600 11px/1 "IBM Plex Mono",monospace;padding:2px 7px;border-radius:999px;',
      'border:1px solid currentColor;margin-left:auto}',
      '.history-row.h-ok .h-tag{color:#43C588}',
      '.history-row.h-rej .h-tag{color:#F0736A}',
      '.history-row.h-mut .h-tag{color:var(--zane-text-muted,#8E8E90)}',
      // --- editor de Pago Móvil ---
      '.pm-fs{border:1px solid var(--zane-border,rgba(255,255,255,.14));border-radius:12px;padding:14px;margin:10px 0}',
      '.pm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}',
      '.pm-fs label{display:flex;flex-direction:column;gap:4px;font:600 11px/1.3 "IBM Plex Mono",monospace;',
      'text-transform:uppercase;letter-spacing:.03em;color:var(--zane-text-muted,#8E8E90)}',
      '.pm-fs input{font:400 14px/1.3 inherit;padding:8px 10px;border-radius:8px;',
      'border:1px solid var(--zane-border,rgba(255,255,255,.14));background:var(--zane-bg-elevated,#213A63);color:#fff}',
      '.pm-fs .btn-no{margin-top:10px;font:600 12px/1 inherit;padding:6px 12px;border-radius:8px;',
      'border:1px solid var(--zane-border,rgba(255,255,255,.14));background:transparent;color:#fff;cursor:pointer}',
      '.pm-save{display:flex;align-items:center;gap:12px;margin-top:10px}',
      '.pm-save .admin-feedback{margin:0;color:var(--zane-gold,#C8C7C9)}'
    ].join('');
    document.head.appendChild(s);
  }
})();
