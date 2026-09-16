/* ====================================================================
   KIOSCO / TABLET  ·  asistente de 4 pasos + Pago Móvil simulado
   menú -> datos -> pago -> espera
   ==================================================================== */
(function () {
  'use strict';

  var TOKEN_KEY = 'kiosc-token';
  var ORDER_KEY = 'kiosc-order';
  var IDLE_MS = 150 * 1000;

  var app = document.getElementById('app');
  var toastEl = document.getElementById('toast');
  var toastTimer, idleTimer, watchTimer;

  var state = { step: 'boot', menu: [], pm: null, pick: null, order: null };

  // ---- transición entre pasos --------------------------------------
  // Igual dirección de entrada y salida (WWDC18 · Designing Fluid Interfaces,
  // "spatial consistency"): avanzar desliza desde la derecha, volver desde
  // la izquierda. Sólo transform + opacity (compositor-friendly). Un token
  // evita que dos transiciones encadenadas se pisen si el usuario va rápido.
  var STEP_ORDER = ['menu', 'datos', 'pago', 'waiting'];
  var transitionToken = 0;
  var motionQuery = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  var reduceMotion = !!(motionQuery && motionQuery.matches);
  if (motionQuery) {
    var onMotionChange = function (e) { reduceMotion = e.matches; };
    if (motionQuery.addEventListener) motionQuery.addEventListener('change', onMotionChange);
    else if (motionQuery.addListener) motionQuery.addListener(onMotionChange);
  }

  // ---- enrolamiento del dispositivo ---------------------------------
  var url = new URL(location.href);
  var enroll = url.searchParams.get('enroll');
  if (enroll) {
    localStorage.setItem(TOKEN_KEY, enroll.trim());
    url.searchParams.delete('enroll');
    history.replaceState(null, '', url.pathname + url.search);
  }
  function deviceToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

  // ---- API --------------------------------------------------------
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign(
      { 'Content-Type': 'application/json', 'X-Kiosc-Token': deviceToken() },
      opts.headers || {}
    );
    return fetch('/api/kiosc' + path, opts).then(function (r) {
      if (r.status === 401) { showEnroll('El dispositivo no está autorizado.'); throw r; }
      if (!r.ok) return r.json().then(function (x) { throw x; }, function () { throw r; });
      return r.status === 204 ? null : r.json();
    });
  }

  // ---- utilidades -----------------------------------------------
  function money(bs) {
    if (bs == null) return 'Consultar';
    return 'Bs. ' + Math.round(bs).toLocaleString('es-VE');
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 3500);
  }
  function saveOrder() {
    if (state.order) localStorage.setItem(ORDER_KEY, JSON.stringify(state.order));
    else localStorage.removeItem(ORDER_KEY);
  }
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      // No expulsar si está en la espera o si está escribiendo en un campo.
      var typing = document.activeElement &&
        /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
      if (state.step === 'waiting' || typing) { resetIdle(); return; }
      state.pick = null; go('menu');
    }, IDLE_MS);
  }
  document.addEventListener('pointerdown', resetIdle, { passive: true });
  document.addEventListener('keydown', resetIdle, { passive: true });

  function go(step) {
    var from = STEP_ORDER.indexOf(state.step);
    var to = STEP_ORDER.indexOf(step);
    var direction = (from === -1 || to === -1 || from === to)
      ? null
      : (to > from ? 'forward' : 'back');
    state.step = step;
    transitionTo(direction);
    resetIdle();
  }

  // Salida breve (120ms) -> se pinta el paso nuevo -> entrada (220ms) desde
  // el lado que corresponde a la dirección. Nunca bloquea el toque más de
  // lo que dura la propia salida, y una llamada más reciente siempre gana
  // sobre una en curso (comparando el token al final de cada fase).
  function transitionTo(direction) {
    var token = ++transitionToken;
    if (reduceMotion || !direction || !app.firstChild) {
      render();
      return;
    }
    var outShift = direction === 'forward' ? '-14px' : '14px';
    var inShift = direction === 'forward' ? '14px' : '-14px';
    app.style.pointerEvents = 'none';
    app.style.transition = 'opacity 120ms ease-in, transform 120ms ease-in';
    app.style.opacity = '0';
    app.style.transform = 'translateX(' + outShift + ')';
    setTimeout(function () {
      if (token !== transitionToken) return;
      render();
      app.style.transition = 'none';
      app.style.transform = 'translateX(' + inShift + ')';
      app.style.opacity = '0';
      void app.offsetHeight; // fuerza reflow: que arranque desde este estado, no desde el anterior
      requestAnimationFrame(function () {
        if (token !== transitionToken) return;
        app.style.transition = 'opacity 220ms cubic-bezier(.22,.61,.36,1), transform 220ms cubic-bezier(.22,.61,.36,1)';
        app.style.opacity = '1';
        app.style.transform = 'translateX(0)';
        setTimeout(function () {
          if (token === transitionToken) app.style.pointerEvents = '';
        }, 220);
      });
    }, 120);
  }

  // ---- render principal ---------------------------------------
  function render() {
    if (state.step === 'menu') return renderMenu();
    if (state.step === 'datos') return renderDatos();
    if (state.step === 'pago') return renderPago();
    if (state.step === 'waiting') return renderWaiting();
    if (state.step === 'enroll') return; // ya pintado por showEnroll
    app.innerHTML = '<div class="k-msg"><i class="fas fa-circle-notch fa-spin"></i><p>Cargando…</p></div>';
  }

  function showEnroll(reason) {
    state.step = 'enroll';
    app.innerHTML =
      '<div class="k-msg">' +
      '<i class="fas fa-lock"></i>' +
      '<h1>Kiosco sin registrar</h1>' +
      '<p>' + esc(reason || '') + ' Abre este equipo con el enlace de enrolamiento que genera el panel ' +
      '(Turnos → dispositivos), o pega el código:</p>' +
      '<div class="k-form" style="align-items:center">' +
      '<input id="enrollInput" type="text" placeholder="código del dispositivo" style="text-align:center">' +
      '<button class="k-primary" id="enrollBtn">Registrar</button></div></div>';
    document.getElementById('enrollBtn').onclick = function () {
      var v = document.getElementById('enrollInput').value.trim();
      if (!v) return;
      localStorage.setItem(TOKEN_KEY, v);
      boot();
    };
  }

  // ---- paso 1 · menú ------------------------------------------
  function renderMenu() {
    app.innerHTML =
      '<h1 class="k-title">Elige tu servicio</h1>' +
      '<div class="k-grid">' +
      state.menu.map(function (s) {
        return '<button class="k-card" data-id="' + s.id + '">' +
          '<span class="k-card-name">' + esc(s.name) + '</span>' +
          '<span class="k-card-desc">' + esc(s.description || '') + '</span>' +
          '<span class="k-card-price">' + money(s.amount_bs) +
          '<small>$' + (s.amount_usd_cents / 100).toFixed(0) + ' · ' + s.duration_min + ' min</small></span>' +
          '</button>';
      }).join('') +
      '</div>';
    app.querySelectorAll('.k-card').forEach(function (b) {
      b.onclick = function () {
        state.pick = state.menu.find(function (s) { return String(s.id) === b.dataset.id; });
        go('datos');
      };
    });
  }

  // ---- paso 2 · datos ----------------------------------------
  function renderDatos() {
    app.innerHTML =
      '<h1 class="k-title">Tus datos</h1>' +
      '<form id="f" class="k-form">' +
      '<label>Nombre y apellido<input name="name" type="text" autocomplete="off" maxlength="80" required></label>' +
      '<label>Teléfono (WhatsApp)<input name="phone" type="tel" inputmode="numeric" maxlength="20" ' +
      'placeholder="0412 000 0000" required></label>' +
      '<div class="k-summary">' + esc(state.pick.name) + ' · ' + money(state.pick.amount_bs) + '</div>' +
      '<div class="k-actions">' +
      '<button type="button" id="back">Atrás</button>' +
      '<button type="submit" class="k-primary">Continuar al pago</button>' +
      '</div></form>';
    document.getElementById('back').onclick = function () { state.pick = null; go('menu'); };
    document.getElementById('f').onsubmit = function (e) {
      e.preventDefault();
      var fd = new FormData(e.target);
      var btn = e.target.querySelector('.k-primary');
      btn.disabled = true;
      api('/orders', {
        method: 'POST',
        body: JSON.stringify({
          service_id: state.pick.id,
          name: String(fd.get('name')).trim(),
          phone: String(fd.get('phone')).trim()
        })
      }).then(function (order) {
        state.order = order; saveOrder(); go('pago');
      }).catch(function (x) {
        btn.disabled = false;
        toast((x && x.error) || 'No se pudo crear la orden.');
      });
    };
  }

  // ---- paso 3 · Pago Móvil ---------------------------------
  function renderPago() {
    var o = state.order;
    var methods = Array.isArray(o.pago_movil) ? o.pago_movil : (o.pago_movil ? [o.pago_movil] : []);
    var blocks = methods.map(function (pm) {
      var qr = pm.qr
        ? '<div class="k-qr"><img src="/' + esc(pm.qr).replace(/^\/+/, '') + '" alt="QR ' + esc(pm.bank) + '"></div>'
        : '';
      return '<div class="k-method">' +
        '<h2 class="k-method-name">' + esc(pm.bank || 'Pago Móvil') + (pm.code ? ' · ' + esc(pm.code) : '') + '</h2>' +
        qr +
        '<div class="k-pm">' +
        (pm.phone ? '<div><span>Teléfono</span><b>' + esc(pm.phone) + '</b></div>' : '') +
        (pm.id ? '<div><span>Cédula / RIF</span><b>' + esc(pm.id) + '</b></div>' : '') +
        '</div></div>';
    }).join('');
    app.innerHTML =
      '<h1 class="k-title">Pago Móvil</h1>' +
      '<p class="k-sub">Paga a cualquiera de estos por el <strong>monto exacto</strong> desde tu banca.</p>' +
      '<div class="k-amount-box"><span>Monto exacto</span><b>' + money(o.amount_bs) + '</b></div>' +
      '<div class="k-methods">' + blocks + '</div>' +
      '<form id="pf" class="k-form" style="margin-top:24px">' +
      '<p class="k-note">Cuando termines el pago pulsa el botón y espera a ser llamado.</p>' +
      '<div class="k-actions"><button type="submit" class="k-primary">Ya pagué</button></div>' +
      '</form>';

    app.querySelectorAll('.k-qr img').forEach(function (im) {
      im.onerror = function () {
        var wrap = im.closest('.k-qr');
        if (wrap) wrap.style.display = 'none';
      };
    });

    document.getElementById('pf').onsubmit = function (e) {
      e.preventDefault();
      var btn = e.target.querySelector('.k-primary');
      btn.disabled = true; btn.textContent = 'Enviando…';
      api('/orders/' + o.code + '/payment', { method: 'POST', body: JSON.stringify({}) }).then(function () {
        go('waiting'); watchStatus();
      }).catch(function (x) {
        btn.disabled = false; btn.textContent = 'Ya pagué';
        toast((x && x.error) || 'No se pudo registrar. Intenta de nuevo.');
      });
    };
  }

  // reduce la foto a <= 900px y jpeg 0.5 (quita EXIF, baja el peso)
  function shrink(file) {
    return new Promise(function (resolve) {
      if (!file || !/^image\//.test(file.type)) return resolve(null);
      var img = new Image();
      img.onload = function () {
        var max = 900;
        var scale = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        try { resolve(c.toDataURL('image/jpeg', 0.5)); }
        catch (e) { resolve(null); }
        URL.revokeObjectURL(img.src);
      };
      img.onerror = function () { resolve(null); };
      img.src = URL.createObjectURL(file);
    });
  }

  // ---- paso 4 · espera -------------------------------------
  function renderWaiting(extra) {
    var cls = extra && extra.cls ? ' ' + extra.cls : '';
    app.innerHTML =
      '<div class="k-wait' + cls + '">' +
      '<div class="k-check"><i class="fas ' + (extra && extra.icon || 'fa-check') + '"></i></div>' +
      '<div class="k-code">' + esc(state.order.code) + '</div>' +
      '<h1>' + esc(extra && extra.title || 'Pago recibido') + '</h1>' +
      '<p id="wmsg">' + esc(extra && extra.msg || 'Espera a ser llamado. Te avisamos por tu nombre.') + '</p>' +
      (extra && extra.retry
        ? '<button id="retry">Reintentar pago</button>'
        : '<button id="new">Nueva orden</button>') +
      '</div>';
    var nb = document.getElementById('new');
    if (nb) nb.onclick = function () {
      clearInterval(watchTimer);
      state.order = null; state.pick = null; saveOrder(); go('menu');
    };
    var rb = document.getElementById('retry');
    if (rb) rb.onclick = function () { clearInterval(watchTimer); go('pago'); };
  }

  function watchStatus() {
    clearInterval(watchTimer);
    watchTimer = setInterval(function () {
      if (!state.order || state.step !== 'waiting') return clearInterval(watchTimer);
      api('/orders/' + state.order.code).then(function (s) {
        if (s.payment_status === 'rejected') {
          renderWaiting({ cls: 'is-rejected', icon: 'fa-xmark', title: 'Pago no validado',
            msg: (s.reject_reason ? s.reject_reason + '. ' : '') + 'Acércate a caja, por favor.', retry: true });
          clearInterval(watchTimer);
        } else if (s.queue_status === 'in_service') {
          renderWaiting({ cls: 'is-turn', icon: 'fa-scissors', title: '¡Es tu turno!',
            msg: 'Pasa con el barbero.' });
        } else if (s.queue_status === 'waiting') {
          var m = document.getElementById('wmsg');
          if (m) m.textContent = 'Pago validado · turno ' + (s.queue_no || '') + '. Espera a ser llamado.';
        } else if (['done', 'no_show', 'expired'].indexOf(s.payment_status) > -1 ||
                   ['done', 'no_show', 'cancelled'].indexOf(s.queue_status) > -1) {
          clearInterval(watchTimer);
          setTimeout(function () { state.order = null; saveOrder(); go('menu'); }, 4000);
        }
      }).catch(function () { /* wifi intermitente: reintenta al próximo tick */ });
    }, 4000);
  }

  // ---- arranque -------------------------------------------
  function boot() {
    if (!deviceToken()) return showEnroll('');
    render(); // spinner
    // ¿hay una orden a medias guardada?
    var stored = null;
    try { stored = JSON.parse(localStorage.getItem(ORDER_KEY) || 'null'); } catch (e) {}

    var resume = stored && stored.code
      ? api('/orders/' + stored.code).then(function (s) {
          state.order = stored;
          if (['awaiting_payment', 'rejected'].indexOf(s.payment_status) > -1) { go('pago'); return true; }
          if (['submitted', 'validated'].indexOf(s.payment_status) > -1 ||
              ['waiting', 'in_service'].indexOf(s.queue_status) > -1) { go('waiting'); watchStatus(); return true; }
          state.order = null; saveOrder(); return false;
        }).catch(function () { state.order = null; saveOrder(); return false; })
      : Promise.resolve(false);

    resume.then(function (resumed) {
      return api('/menu').then(function (d) {
        state.menu = d.services; state.pm = d.pago_movil;
        if (!resumed) go('menu');
      });
    }).catch(function () {
      if (state.step === 'boot') {
        app.innerHTML = '<div class="k-msg"><i class="fas fa-wifi"></i>' +
          '<h1>Sin conexión</h1><p>Avisa a recepción.</p></div>';
      }
    });
  }

  // ---- guardas de kiosco --------------------------------
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  window.addEventListener('beforeunload', function (e) {
    if (state.step === 'datos' || state.step === 'pago') { e.preventDefault(); e.returnValue = ''; }
  });
  var wakeLock = null;
  function keepAwake() {
    if (!navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then(function (w) { wakeLock = w; }).catch(function () {});
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') keepAwake();
  });
  keepAwake();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/kiosc/sw.js').catch(function () {});
  }

  resetIdle();
  boot();
})();
