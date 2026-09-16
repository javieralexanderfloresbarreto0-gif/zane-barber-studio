/*
 * ui-kit.js — piezas de interfaz con la identidad ZANE que sustituyen a los
 * controles genéricos del navegador:
 *   - window.zaneConfirm / zanePrompt / zaneAlert  → diálogos con marca
 *   - <select> nativos  → desplegable propio (panel oscuro, teclado, type-ahead)
 *
 * Se carga antes de script.js y board.js. Todo es progresivo: si algo falla,
 * el <select> nativo y los diálogos del navegador siguen disponibles.
 */
(function () {
  'use strict';

  /* ===================================================================== *
   *  Diálogos ZANE
   * ===================================================================== */
  var overlay = null;
  var current = null;

  function buildOverlay() {
    overlay = document.createElement('div');
    overlay.className = 'zdialog-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="zdialog" role="document">' +
        '<p class="zdialog-brand">ZANE <span>BARBER</span></p>' +
        '<h3 class="zdialog-title"></h3>' +
        '<p class="zdialog-message"></p>' +
        '<p class="zdialog-detail"></p>' +
        '<label class="zdialog-field" hidden>' +
          '<span class="zdialog-field-label"></span>' +
          '<input type="text" class="zdialog-input" autocomplete="off">' +
        '</label>' +
        '<div class="zdialog-actions">' +
          '<button type="button" class="zdialog-btn zdialog-cancel"></button>' +
          '<button type="button" class="zdialog-btn zdialog-confirm"></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) finish(dismissValue());
    });
    overlay.querySelector('.zdialog-cancel').addEventListener('click', function () {
      finish(dismissValue());
    });
    overlay.querySelector('.zdialog-confirm').addEventListener('click', function () {
      finish(current && current.type === 'prompt'
        ? overlay.querySelector('.zdialog-input').value.trim()
        : true);
    });
    document.addEventListener('keydown', function (e) {
      if (!current) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(dismissValue());
      } else if (e.key === 'Enter') {
        if (document.activeElement === overlay.querySelector('.zdialog-cancel')) return;
        e.preventDefault();
        finish(current.type === 'prompt'
          ? overlay.querySelector('.zdialog-input').value.trim()
          : true);
      }
    });
  }

  function dismissValue() {
    if (!current) return null;
    if (current.type === 'prompt') return null;
    if (current.type === 'alert') return undefined;
    return false;
  }

  function finish(value) {
    if (!current) return;
    var done = current.done;
    var restore = current.lastFocus;
    current = null;
    overlay.hidden = true;
    document.body.classList.remove('zdialog-open');
    if (restore && restore.focus) { try { restore.focus(); } catch (e) {} }
    done(value);
  }

  function openDialog(type, opts) {
    if (!overlay) buildOverlay();
    opts = opts || {};
    if (current) finish(dismissValue());

    var box = overlay.querySelector('.zdialog');
    var titleEl = overlay.querySelector('.zdialog-title');
    var messageEl = overlay.querySelector('.zdialog-message');
    var detailEl = overlay.querySelector('.zdialog-detail');
    var field = overlay.querySelector('.zdialog-field');
    var fieldLabel = overlay.querySelector('.zdialog-field-label');
    var input = overlay.querySelector('.zdialog-input');
    var cancelBtn = overlay.querySelector('.zdialog-cancel');
    var confirmBtn = overlay.querySelector('.zdialog-confirm');

    titleEl.textContent = opts.title || '';
    titleEl.hidden = !opts.title;
    messageEl.textContent = opts.message || '';
    messageEl.hidden = !opts.message;
    detailEl.textContent = opts.detail || '';
    detailEl.hidden = !opts.detail;

    if (type === 'prompt') {
      field.hidden = false;
      fieldLabel.textContent = opts.label || '';
      fieldLabel.hidden = !opts.label;
      input.value = opts.value != null ? opts.value : '';
      input.placeholder = opts.placeholder || '';
    } else {
      field.hidden = true;
    }

    cancelBtn.hidden = type === 'alert';
    cancelBtn.textContent = opts.cancelText || 'Cancelar';
    confirmBtn.textContent = opts.confirmText || (type === 'alert' ? 'Entendido' : 'Confirmar');
    confirmBtn.classList.toggle('is-danger', !!opts.danger);
    box.classList.toggle('zdialog--alert', type === 'alert');

    overlay.hidden = false;
    document.body.classList.add('zdialog-open');

    return new Promise(function (resolve) {
      current = { type: type, done: resolve, lastFocus: document.activeElement };
      window.requestAnimationFrame(function () {
        if (type === 'prompt') { input.focus(); input.select(); }
        else confirmBtn.focus();
      });
    });
  }

  window.zaneConfirm = function (opts) { return openDialog('confirm', opts); };
  window.zanePrompt = function (opts) { return openDialog('prompt', opts); };
  window.zaneAlert = function (opts) {
    return openDialog('alert', typeof opts === 'string' ? { message: opts } : opts);
  };

  /* ===================================================================== *
   *  Desplegable ZANE (reemplaza el <select> nativo)
   * ===================================================================== */
  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function enhanceSelect(select) {
    if (select.zselReady || select.multiple || select.dataset.noZaneSelect != null) return;
    select.zselReady = true;

    var wrap = document.createElement('div');
    wrap.className = 'zsel';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    select.classList.add('zsel-native');
    select.setAttribute('tabindex', '-1');
    select.setAttribute('aria-hidden', 'true');

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'zsel-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    var labelText = document.createElement('span');
    labelText.className = 'zsel-label';
    var caret = document.createElement('span');
    caret.className = 'zsel-caret';
    caret.setAttribute('aria-hidden', 'true');
    trigger.appendChild(labelText);
    trigger.appendChild(caret);
    wrap.appendChild(trigger);

    var panel = document.createElement('div');
    panel.className = 'zsel-panel';
    panel.setAttribute('role', 'listbox');
    panel.hidden = true;
    wrap.appendChild(panel);

    var formLabel = select.id ? document.querySelector('label[for="' + cssEscape(select.id) + '"]') : null;
    if (formLabel) {
      formLabel.addEventListener('click', function (e) { e.preventDefault(); trigger.focus(); });
    }

    var activeIndex = -1;
    var typeBuffer = '';
    var typeTimer = null;

    function currentOption() {
      return select.options[select.selectedIndex] || null;
    }

    function refreshLabel() {
      var opt = currentOption();
      var text = opt ? opt.textContent.trim() : '';
      var isPlaceholder = !opt || opt.value === '' || !text;
      labelText.textContent = text || select.dataset.placeholder || 'Selecciona una opción';
      trigger.classList.toggle('is-placeholder', isPlaceholder);
    }

    function buildPanel() {
      panel.innerHTML = '';
      Array.prototype.forEach.call(select.options, function (opt, i) {
        var item = document.createElement('div');
        item.className = 'zsel-option';
        item.setAttribute('role', 'option');
        item.dataset.index = i;
        item.textContent = opt.textContent.trim();
        if (opt.disabled) item.setAttribute('aria-disabled', 'true');
        if (opt.value === '') item.classList.add('is-empty-option');
        if (i === select.selectedIndex) {
          item.classList.add('is-selected');
          item.setAttribute('aria-selected', 'true');
        }
        panel.appendChild(item);
      });
    }

    function firstEnabled() {
      for (var i = 0; i < select.options.length; i++) {
        if (!select.options[i].disabled) return i;
      }
      return -1;
    }

    function lastEnabled() {
      for (var i = select.options.length - 1; i >= 0; i--) {
        if (!select.options[i].disabled) return i;
      }
      return -1;
    }

    function highlight(index, scroll) {
      var items = panel.children;
      for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle('is-active', i === index);
      }
      activeIndex = index;
      if (scroll && items[index]) items[index].scrollIntoView({ block: 'nearest' });
    }

    function move(delta) {
      var n = select.options.length;
      if (!n) return;
      var i = activeIndex < 0 ? (delta > 0 ? -1 : n) : activeIndex;
      for (var step = 0; step < n; step++) {
        i = (i + delta + n) % n;
        if (!select.options[i].disabled) { highlight(i, true); return; }
      }
    }

    function typeAhead(ch) {
      typeBuffer += ch.toLowerCase();
      window.clearTimeout(typeTimer);
      typeTimer = window.setTimeout(function () { typeBuffer = ''; }, 600);
      for (var i = 0; i < select.options.length; i++) {
        if (select.options[i].disabled) continue;
        if (select.options[i].textContent.trim().toLowerCase().indexOf(typeBuffer) === 0) {
          highlight(i, true);
          return;
        }
      }
    }

    function openPanel() {
      if (!panel.hidden) return;
      buildPanel();
      panel.hidden = false;
      wrap.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      highlight(select.selectedIndex >= 0 ? select.selectedIndex : firstEnabled(), true);
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onOpenKey, true);
    }

    function closePanel(focusTrigger) {
      if (panel.hidden) return;
      panel.hidden = true;
      wrap.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onOpenKey, true);
      if (focusTrigger) trigger.focus();
    }

    function onOutside(e) {
      if (!wrap.contains(e.target)) closePanel(false);
    }

    function commit(index) {
      if (index < 0 || index >= select.options.length || select.options[index].disabled) return;
      if (select.selectedIndex !== index) {
        select.selectedIndex = index;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      refreshLabel();
      closePanel(true);
    }

    function onOpenKey(e) {
      if (panel.hidden) return;
      switch (e.key) {
        case 'Escape': e.preventDefault(); closePanel(true); break;
        case 'ArrowDown': e.preventDefault(); move(1); break;
        case 'ArrowUp': e.preventDefault(); move(-1); break;
        case 'Home': e.preventDefault(); highlight(firstEnabled(), true); break;
        case 'End': e.preventDefault(); highlight(lastEnabled(), true); break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          commit(activeIndex);
          break;
        case 'Tab':
          closePanel(false);
          break;
        default:
          if (e.key.length === 1) { e.preventDefault(); typeAhead(e.key); }
      }
    }

    trigger.addEventListener('click', function () {
      if (panel.hidden) openPanel(); else closePanel(true);
    });
    trigger.addEventListener('keydown', function (e) {
      // Si onOpenKey ya atendió la tecla (panel abierto), no reabrir al burbujear.
      if (e.defaultPrevented) return;
      if (panel.hidden && ['ArrowDown', 'ArrowUp', 'Enter', ' '].indexOf(e.key) !== -1) {
        e.preventDefault();
        openPanel();
      }
    });
    panel.addEventListener('mousemove', function (e) {
      var item = e.target.closest('.zsel-option');
      if (item && item.getAttribute('aria-disabled') !== 'true') {
        highlight(Number(item.dataset.index), false);
      }
    });
    panel.addEventListener('click', function (e) {
      var item = e.target.closest('.zsel-option');
      if (item) commit(Number(item.dataset.index));
    });

    // Mantener la etiqueta al día cuando otro script cambia el <select>.
    select.addEventListener('change', refreshLabel);
    var nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (nativeValue && nativeValue.configurable) {
      Object.defineProperty(select, 'value', {
        configurable: true,
        get: function () { return nativeValue.get.call(this); },
        set: function (v) { nativeValue.set.call(this, v); refreshLabel(); }
      });
    }
    if (window.MutationObserver) {
      new MutationObserver(function () {
        refreshLabel();
        if (!panel.hidden) buildPanel();
      }).observe(select, { childList: true, subtree: true, characterData: true });
    }

    refreshLabel();
  }

  /* ===================================================================== *
   *  Calendario ZANE (reemplaza <input type="date">)
   * ===================================================================== */
  var DAY_MS = 86400000;
  var WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
  var MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  function iso(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function parseIso(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  function sameDay(a, b) {
    return a && b && a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function enhanceDate(input) {
    if (input.zdateReady || input.dataset.noZaneDate != null) return;
    input.zdateReady = true;

    var wrap = document.createElement('div');
    wrap.className = 'zdate';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.classList.add('zdate-native');
    input.setAttribute('tabindex', '-1');
    input.setAttribute('aria-hidden', 'true');

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'zdate-trigger';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    var labelText = document.createElement('span');
    labelText.className = 'zdate-label';
    var icon = document.createElement('span');
    icon.className = 'zdate-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M8 2v3"/><path d="M16 2v3"/><rect x="3" y="3" width="18" height="18" rx="2"/>' +
      '<path d="M3 9h18"/></svg>';
    trigger.appendChild(labelText);
    trigger.appendChild(icon);
    wrap.appendChild(trigger);

    var panel = document.createElement('div');
    panel.className = 'zdate-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Elegir fecha');
    panel.hidden = true;
    wrap.appendChild(panel);

    var formLabel = input.id ? document.querySelector('label[for="' + cssEscape(input.id) + '"]') : null;
    if (formLabel) {
      formLabel.addEventListener('click', function (e) { e.preventDefault(); trigger.focus(); });
    }

    var view = null;   // primer día del mes visible
    var focus = null;  // día enfocado dentro de la rejilla

    function limits() {
      return { min: parseIso(input.min), max: parseIso(input.max) };
    }

    function disabled(d) {
      var l = limits();
      if (l.min && startOfDay(d) < startOfDay(l.min)) return true;
      if (l.max && startOfDay(d) > startOfDay(l.max)) return true;
      return false;
    }

    function clampToLimits(d) {
      var l = limits();
      if (l.min && d < startOfDay(l.min)) return startOfDay(l.min);
      if (l.max && d > startOfDay(l.max)) return startOfDay(l.max);
      return d;
    }

    function refreshLabel() {
      var d = parseIso(input.value);
      if (d) {
        labelText.textContent = d.toLocaleDateString('es-VE', { day: 'numeric', month: 'short', year: 'numeric' });
        trigger.classList.remove('is-placeholder');
      } else {
        labelText.textContent = input.dataset.placeholder || 'Elige una fecha';
        trigger.classList.add('is-placeholder');
      }
    }

    function buildPanel() {
      panel.innerHTML = '';

      var head = document.createElement('div');
      head.className = 'zdate-head';
      head.innerHTML =
        '<button type="button" class="zdate-nav" data-step="-12" aria-label="Año anterior">&laquo;</button>' +
        '<button type="button" class="zdate-nav" data-step="-1" aria-label="Mes anterior">&lsaquo;</button>' +
        '<span class="zdate-title">' + MONTHS[view.getMonth()] + ' ' + view.getFullYear() + '</span>' +
        '<button type="button" class="zdate-nav" data-step="1" aria-label="Mes siguiente">&rsaquo;</button>' +
        '<button type="button" class="zdate-nav" data-step="12" aria-label="Año siguiente">&raquo;</button>';
      panel.appendChild(head);

      var week = document.createElement('div');
      week.className = 'zdate-week';
      WEEKDAYS.forEach(function (w) {
        var s = document.createElement('span');
        s.textContent = w;
        week.appendChild(s);
      });
      panel.appendChild(week);

      var grid = document.createElement('div');
      grid.className = 'zdate-grid';
      grid.setAttribute('role', 'grid');

      // Lunes como primer día de la semana.
      var first = new Date(view.getFullYear(), view.getMonth(), 1);
      var offset = (first.getDay() + 6) % 7;
      var cursor = new Date(first);
      cursor.setDate(first.getDate() - offset);

      var selected = parseIso(input.value);
      var today = startOfDay(new Date());

      for (var i = 0; i < 42; i++) {
        var day = new Date(cursor);
        var cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'zdate-day';
        cell.textContent = String(day.getDate());
        cell.dataset.iso = iso(day);
        if (day.getMonth() !== view.getMonth()) cell.classList.add('is-outside');
        if (sameDay(day, today)) cell.classList.add('is-today');
        if (sameDay(day, selected)) {
          cell.classList.add('is-selected');
          cell.setAttribute('aria-selected', 'true');
        }
        if (sameDay(day, focus)) cell.classList.add('is-focus');
        if (disabled(day)) { cell.disabled = true; cell.classList.add('is-disabled'); }
        grid.appendChild(cell);
        cursor.setDate(cursor.getDate() + 1);
      }
      panel.appendChild(grid);

      var foot = document.createElement('div');
      foot.className = 'zdate-foot';
      foot.innerHTML =
        '<button type="button" class="zdate-link" data-action="clear">Borrar</button>' +
        '<button type="button" class="zdate-link" data-action="today">Hoy</button>';
      panel.appendChild(foot);
    }

    function openPanel() {
      if (!panel.hidden) return;
      var base = clampToLimits(startOfDay(parseIso(input.value) || new Date()));
      focus = startOfDay(base);
      view = new Date(focus.getFullYear(), focus.getMonth(), 1);
      buildPanel();
      panel.hidden = false;
      wrap.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onOpenKey, true);
    }

    function closePanel(focusTrigger) {
      if (panel.hidden) return;
      panel.hidden = true;
      wrap.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onOpenKey, true);
      if (focusTrigger) trigger.focus();
    }

    function onOutside(e) {
      if (!wrap.contains(e.target)) closePanel(false);
    }

    function setView(y, m) {
      view = new Date(y, m, 1);
      buildPanel();
    }

    function moveFocus(days) {
      var next = new Date(focus);
      next.setDate(next.getDate() + days);
      focus = startOfDay(next);
      if (focus.getMonth() !== view.getMonth() || focus.getFullYear() !== view.getFullYear()) {
        view = new Date(focus.getFullYear(), focus.getMonth(), 1);
      }
      buildPanel();
    }

    function commit(d) {
      if (!d || disabled(d)) return;
      input.value = iso(d);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      refreshLabel();
      closePanel(true);
    }

    function onOpenKey(e) {
      if (panel.hidden) return;
      switch (e.key) {
        case 'Escape': e.preventDefault(); closePanel(true); break;
        case 'ArrowLeft': e.preventDefault(); moveFocus(-1); break;
        case 'ArrowRight': e.preventDefault(); moveFocus(1); break;
        case 'ArrowUp': e.preventDefault(); moveFocus(-7); break;
        case 'ArrowDown': e.preventDefault(); moveFocus(7); break;
        case 'PageUp': e.preventDefault(); setView(view.getFullYear(), view.getMonth() - (e.shiftKey ? 12 : 1)); break;
        case 'PageDown': e.preventDefault(); setView(view.getFullYear(), view.getMonth() + (e.shiftKey ? 12 : 1)); break;
        case 'Home': e.preventDefault(); moveFocus(-((focus.getDay() + 6) % 7)); break;
        case 'End': e.preventDefault(); moveFocus(6 - ((focus.getDay() + 6) % 7)); break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          commit(focus);
          break;
        case 'Tab':
          closePanel(false);
          break;
      }
    }

    trigger.addEventListener('click', function () {
      if (panel.hidden) openPanel(); else closePanel(true);
    });
    trigger.addEventListener('keydown', function (e) {
      // Si onOpenKey ya atendió la tecla (panel abierto), no reabrir al burbujear.
      if (e.defaultPrevented) return;
      if (panel.hidden && ['ArrowDown', 'ArrowUp', 'Enter', ' '].indexOf(e.key) !== -1) {
        e.preventDefault();
        openPanel();
      }
    });

    panel.addEventListener('click', function (e) {
      var nav = e.target.closest('.zdate-nav');
      if (nav) {
        var step = Number(nav.dataset.step);
        setView(view.getFullYear(), view.getMonth() + step);
        return;
      }
      var link = e.target.closest('.zdate-link');
      if (link) {
        if (link.dataset.action === 'clear') {
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          refreshLabel();
          closePanel(true);
        } else {
          commit(clampToLimits(startOfDay(new Date())));
        }
        return;
      }
      var cell = e.target.closest('.zdate-day');
      if (cell && !cell.disabled) commit(parseIso(cell.dataset.iso));
    });

    input.addEventListener('change', refreshLabel);
    var nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (nativeValue && nativeValue.configurable) {
      Object.defineProperty(input, 'value', {
        configurable: true,
        get: function () { return nativeValue.get.call(this); },
        set: function (v) { nativeValue.set.call(this, v); refreshLabel(); }
      });
    }
    if (window.MutationObserver) {
      new MutationObserver(function () {
        refreshLabel();
        if (!panel.hidden) buildPanel();
      }).observe(input, { attributes: true, attributeFilter: ['min', 'max', 'value'] });
    }

    refreshLabel();
  }

  function enhanceAll(root) {
    var scope = root || document;
    Array.prototype.forEach.call(scope.querySelectorAll('select'), enhanceSelect);
    Array.prototype.forEach.call(scope.querySelectorAll('input[type="date"]'), enhanceDate);
  }

  window.zaneEnhanceSelects = enhanceAll;
  window.zaneEnhanceFields = enhanceAll;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { enhanceAll(); });
  } else {
    enhanceAll();
  }
})();
