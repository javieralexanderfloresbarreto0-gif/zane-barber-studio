(function () {
  var navbar = document.getElementById('mainNav');

  function onScroll() {
    if (!navbar) return;
    var atHero = window.scrollY <= 100 && (!window.location.hash || window.location.hash === '#inicio');
    navbar.classList.toggle('at-hero', atHero);
    navbar.classList.toggle('scrolled', !atHero);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('hashchange', onScroll);
  window.addEventListener('pageshow', onScroll);
  onScroll();
  window.requestAnimationFrame(onScroll);

  var sections = document.querySelectorAll('section[id], header[id]');
  var navLinks = document.querySelectorAll('.navbar-nav .nav-link');

  function onScrollSpy() {
    var pos = window.scrollY + 120;
    var current = '';
    sections.forEach(function (section) {
      if (section.offsetTop <= pos) current = section.getAttribute('id');
    });
    navLinks.forEach(function (link) {
      link.classList.toggle('active', link.getAttribute('href') === '#' + current);
    });
  }

  window.addEventListener('scroll', onScrollSpy, { passive: true });
  onScrollSpy();

  function localISODate(date) {
    var value = date || new Date();
    var month = String(value.getMonth() + 1).padStart(2, '0');
    var day = String(value.getDate()).padStart(2, '0');
    return value.getFullYear() + '-' + month + '-' + day;
  }

  var bookingModalElement = document.getElementById('bookingModal');
  var bookingForm = document.getElementById('bookingForm');
  var bookingService = document.getElementById('bookingService');
  var bookingDate = document.getElementById('bookingDate');
  var bookingTime = document.getElementById('bookingTime');
  var bookingSummary = document.getElementById('bookingSummary');
  var bookingError = document.getElementById('bookingError');
  var bookingModal = bookingModalElement && window.bootstrap
    ? bootstrap.Modal.getOrCreateInstance(bookingModalElement)
    : null;

  function updateBookingSummary() {
    if (!bookingService || !bookingDate || !bookingTime || !bookingSummary) return;
    var serviceOption = bookingService.options[bookingService.selectedIndex];
    if (!bookingService.value || !bookingDate.value || !bookingTime.value) {
      bookingSummary.textContent = 'Completa los datos para continuar';
      return;
    }
    var readableDate = new Date(bookingDate.value + 'T12:00:00').toLocaleDateString('es-VE', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
    bookingSummary.textContent = serviceOption.value + ' · $' + serviceOption.dataset.price + ' · ' + readableDate + ' · ' + bookingTime.value;
  }

  if (bookingForm && bookingModal) {
    document.querySelectorAll('[data-booking-open]').forEach(function (trigger) {
      trigger.addEventListener('click', function (event) {
        event.preventDefault();
        bookingForm.reset();
        bookingForm.classList.remove('was-validated');
        if (bookingError) bookingError.textContent = '';
        if (trigger.dataset.bookingService) bookingService.value = trigger.dataset.bookingService;
        updateBookingSummary();
        bookingModal.show();
      });
    });

    bookingModalElement.addEventListener('hidden.bs.modal', function () {
      bookingForm.reset();
      bookingForm.classList.remove('was-validated');
      if (bookingError) bookingError.textContent = '';
      updateBookingSummary();
    });

    bookingDate.min = localISODate();
    [bookingService, bookingDate, bookingTime].forEach(function (field) {
      field.addEventListener('change', updateBookingSummary);
    });

    bookingForm.addEventListener('submit', function (event) {
      event.preventDefault();
      if (bookingError) bookingError.textContent = '';
      if (!bookingForm.checkValidity()) {
        if (bookingError) bookingError.textContent = 'Elige un servicio, una fecha y una hora para continuar.';
        bookingForm.classList.add('was-validated');
        return;
      }
      var serviceOption = bookingService.options[bookingService.selectedIndex];
      var message = 'Hola, quiero reservar en Zane Barber Studio.%0A%0AServicio: ' + encodeURIComponent(serviceOption.value) + '%0APrecio: $' + serviceOption.dataset.price + '%0AFecha: ' + encodeURIComponent(bookingDate.value) + '%0AHora: ' + encodeURIComponent(bookingTime.value);
      window.open('https://wa.me/584121453691?text=' + message, '_blank', 'noopener');
      bookingModal.hide();
    });
  }

  var galleryItems = Array.from(document.querySelectorAll('.gallery-item'));
  var galleryFilters = document.querySelectorAll('.gallery-filter');
  var lightboxItems = galleryItems;
  var lightboxIndex = 0;
  var lightbox = document.getElementById('galleryLightbox');
  var lightboxImage = document.getElementById('lightboxImage');
  var lightboxTitle = document.getElementById('lightboxTitle');
  var lightboxCounter = document.getElementById('lightboxCounter');

  function showLightboxItem() {
    var item = lightboxItems[lightboxIndex];
    if (!item || !lightboxImage) return;
    lightboxImage.src = item.querySelector('img').src;
    lightboxImage.alt = item.querySelector('img').alt;
    if (lightboxTitle) lightboxTitle.textContent = item.querySelector('figcaption').textContent;
    if (lightboxCounter) lightboxCounter.textContent = (lightboxIndex + 1) + ' / ' + lightboxItems.length;
  }

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.classList.remove('is-open');
    lightbox.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  function openLightbox(item) {
    if (!lightbox) return;
    lightboxItems = galleryItems.filter(function (galleryItem) { return !galleryItem.classList.contains('is-hidden'); });
    lightboxIndex = lightboxItems.indexOf(item);
    if (lightboxIndex < 0) lightboxIndex = 0;
    showLightboxItem();
    lightbox.classList.add('is-open');
    lightbox.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    var closeButton = lightbox.querySelector('.lightbox-close');
    if (closeButton) closeButton.focus();
  }

  galleryFilters.forEach(function (filterButton) {
    filterButton.addEventListener('click', function () {
      var filter = filterButton.dataset.filter;
      galleryFilters.forEach(function (button) { button.classList.toggle('is-active', button === filterButton); });
      galleryItems.forEach(function (item) {
        var categories = (item.dataset.category || '').split(' ');
        item.classList.toggle('is-hidden', filter !== 'all' && categories.indexOf(filter) === -1);
      });
    });
  });

  galleryItems.forEach(function (item) {
    item.addEventListener('click', function () { openLightbox(item); });
    item.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openLightbox(item); }
    });
  });

  if (lightbox) {
    var lbClose = lightbox.querySelector('.lightbox-close');
    var lbPrev = lightbox.querySelector('.lightbox-prev');
    var lbNext = lightbox.querySelector('.lightbox-next');
    if (lbClose) lbClose.addEventListener('click', closeLightbox);
    if (lbPrev) lbPrev.addEventListener('click', function () {
      if (!lightboxItems.length) return;
      lightboxIndex = (lightboxIndex - 1 + lightboxItems.length) % lightboxItems.length;
      showLightboxItem();
    });
    if (lbNext) lbNext.addEventListener('click', function () {
      if (!lightboxItems.length) return;
      lightboxIndex = (lightboxIndex + 1) % lightboxItems.length;
      showLightboxItem();
    });
    lightbox.addEventListener('click', function (event) { if (event.target === lightbox) closeLightbox(); });
    document.addEventListener('keydown', function (event) {
      if (!lightbox.classList.contains('is-open')) return;
      if (event.key === 'Escape') closeLightbox();
      if (event.key === 'ArrowLeft' && lbPrev) lbPrev.click();
      if (event.key === 'ArrowRight' && lbNext) lbNext.click();
    });
  }

  var carouselElement = document.getElementById('testimonialsCarousel');
  if (carouselElement && window.bootstrap) {
    var carousel = bootstrap.Carousel.getOrCreateInstance(carouselElement);
    carouselElement.addEventListener('mouseenter', function () { carousel.pause(); });
    carouselElement.addEventListener('mouseleave', function () { carousel.cycle(); });
  }

  var statsSection = document.querySelector('.stats-section');
  var counters = document.querySelectorAll('[data-counter]');
  var countersStarted = false;
  function animateCounters() {
    if (countersStarted) return;
    countersStarted = true;
    counters.forEach(function (counter) {
      var target = Number(counter.dataset.counter);
      var suffix = counter.dataset.suffix || '';
      var start = performance.now();
      function tick(now) {
        var progress = Math.min((now - start) / 900, 1);
        var value = Math.floor(progress * target);
        counter.textContent = value.toLocaleString('es-VE') + suffix;
        if (progress < 1) window.requestAnimationFrame(tick);
      }
      window.requestAnimationFrame(tick);
    });
  }

  if (statsSection && 'IntersectionObserver' in window) {
    var statsObserver = new IntersectionObserver(function (entries, observer) {
      if (entries[0].isIntersecting) { animateCounters(); observer.disconnect(); }
    }, { threshold: 0.35 });
    statsObserver.observe(statsSection);
  } else if (counters.length) {
    animateCounters();
  }

  var API_BASE = '';
  var authToken = sessionStorage.getItem('zane-auth-token') || '';
  var templateKey = 'zane-barber-plantilla-recordatorio';
  var reminderQueue = [];

  function apiFetch(url, options) {
    options = options || {};
    var headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    if (authToken) headers.Authorization = 'Bearer ' + authToken;
    return fetch(API_BASE + url, Object.assign({}, options, { headers: headers })).then(function (res) {
      if (res.status === 401 && authToken) {
        authToken = '';
        sessionStorage.removeItem('zane-auth-token');
        if (adminDashboard) adminDashboard.hidden = true;
        if (adminLogin) adminLogin.hidden = false;
        showFeedback(clientFeedback, 'La sesión expiró. Inicia sesión nuevamente.');
      }
      return res;
    });
  }

  var adminSection = document.getElementById('adminPanel');
  var adminAccess = document.getElementById('adminAccess');
  var adminAccessTop = document.getElementById('adminAccessTop');
  var adminLogin = document.getElementById('adminLogin');
  var adminDashboard = document.getElementById('adminDashboard');
  var adminLoginForm = document.getElementById('adminLoginForm');
  var adminLoginError = document.getElementById('adminLoginError');
  var clientForm = document.getElementById('clientForm');
  var clientList = document.getElementById('clientList');
  var clientFeedback = document.getElementById('clientFeedback');
  var clientFormTitle = document.getElementById('clientFormTitle');
  var clientCancel = document.getElementById('clientCancel');
  var reminderTemplate = document.getElementById('reminderTemplate');
  var clientCountEl = document.getElementById('clientCount');
  var tabCountClients = document.getElementById('tabCountClients');
  var tabCountStyles = document.getElementById('tabCountStyles');
  var tabCountBirthdays = document.getElementById('tabCountBirthdays');
  var stylesList = document.getElementById('stylesList');
  var styleForm = document.getElementById('styleForm');
  var cashDateInput = document.getElementById('cashDate');
  var cashIncome = document.getElementById('cashIncome');
  var cashTips = document.getElementById('cashTips');
  var cashNotes = document.getElementById('cashNotes');
  var cashFeedback = document.getElementById('cashFeedback');
  var cashSave = document.getElementById('cashSave');
  var birthdayList = document.getElementById('birthdayList');
  var dashboardInfo = document.getElementById('dashboardInfo');
  var clientSearch = document.getElementById('clientSearch');
  var clientFilter = document.getElementById('clientFilter');
  var backupFile = document.getElementById('backupFile');
  var allClients = [];

  var isAdminRoute = window.location.pathname === '/admin' || window.location.pathname.endsWith('/admin') || new URLSearchParams(window.location.search).has('admin');
  var isAdminServer = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port === '3000';
  if (adminAccessTop && isAdminServer && !isAdminRoute) adminAccessTop.hidden = false;
  if (isAdminRoute && adminSection) {
    document.body.classList.add('admin-route');
    adminSection.hidden = false;
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>'"]/g, function (character) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character];
    });
  }

  function formatDate(dateString) {
    if (!dateString) return '—';
    return new Date(dateString + 'T12:00:00').toLocaleDateString('es-VE', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function daysSince(dateString) {
    return Math.max(0, Math.floor((new Date() - new Date(dateString + 'T12:00:00')) / 86400000));
  }

  function showFeedback(el, msg, duration) {
    if (!el) return;
    el.textContent = msg;
    if (duration) window.setTimeout(function () { if (el.textContent === msg) el.textContent = ''; }, duration);
  }

  function setLoading(button, loading) {
    if (!button) return;
    if (loading) {
      button.dataset.originalText = button.textContent;
      button.disabled = true;
      button.textContent = 'Guardando...';
    } else {
      button.disabled = false;
      button.textContent = button.dataset.originalText || button.textContent;
    }
  }

  function getLastCut(client) {
    return client.last_cut_date || client.lastCut || '';
  }

  function isPending(client) {
    var lastCut = getLastCut(client);
    if (!lastCut) return false;
    var d = new Date(lastCut + 'T12:00:00');
    d.setDate(d.getDate() + 15);
    return d <= new Date();
  }

  function addDays(dateString, days) {
    var date = new Date(dateString + 'T12:00:00');
    date.setDate(date.getDate() + days);
    return localISODate(date);
  }

  function whatsappNumber(phone) {
    var digits = String(phone || '').replace(/\D/g, '');
    if (digits.indexOf('00') === 0) digits = digits.slice(2);
    if (digits.indexOf('58') === 0 && digits.length >= 12) return digits;
    if (digits.length === 11 && digits.charAt(0) === '0') return '58' + digits.slice(1);
    if (digits.length === 10 && (digits.charAt(0) === '4' || digits.charAt(0) === '2')) return '58' + digits;
    return digits;
  }

  function openWhatsApp(phone, message) {
    var number = whatsappNumber(phone);
    if (!number) return false;
    window.open('https://wa.me/' + number + '?text=' + encodeURIComponent(message), '_blank', 'noopener');
    return true;
  }

  function findClient(clientId) {
    return allClients.find(function (client) { return String(client.id) === String(clientId); });
  }

  function renderDashboard(clients) {
    var pending = clients.filter(isPending).length;
    if (dashboardInfo) {
      dashboardInfo.innerHTML =
        '<div class="dash-stat"><strong>' + clients.length + '</strong><span>Clientes</span></div>' +
        '<div class="dash-stat"><strong>' + pending + '</strong><span>Pendientes</span></div>';
    }
    if (clientCountEl) clientCountEl.textContent = clients.length;
    if (tabCountClients) {
      tabCountClients.textContent = pending > 0 ? pending : clients.length;
      tabCountClients.classList.toggle('has-urgent', pending > 0);
      tabCountClients.title = pending > 0 ? pending + ' cliente(s) con recordatorio pendiente' : clients.length + ' cliente(s) registrados';
    }
  }

  function clientCardHTML(client) {
    var pendingClass = isPending(client) ? ' is-pending' : '';
    var status = isPending(client) ? '<span class="pending-badge">Recordatorio pendiente</span>' : '';
    var lastCut = getLastCut(client);
    var service = client.last_service || '';
    var phone = client.phone || '';
    var notes = [];
    if (client.sides_machine) notes.push(client.sides_machine);
    if (client.top_finish) notes.push(client.top_finish);
    var extra = notes.length ? '<p>' + escapeHTML(notes.join(' · ')) + '</p>' : '';
    return '<article class="client-item' + pendingClass + '">' +
      '<div><h4>' + escapeHTML(client.name) + '</h4><p>' + escapeHTML(phone) + ' · ' + escapeHTML(service) + '</p>' + extra + '</div>' +
      '<div class="client-reminder">Próximo aviso: <strong>' + formatDate(client.next_reminder_date || addDays(lastCut, 15)) + '</strong>' + status + '</div>' +
      '<div class="client-actions">' +
        '<button type="button" data-client-action="send" data-client-id="' + client.id + '" aria-label="Enviar recordatorio a ' + escapeHTML(client.name) + '"><i class="fab fa-whatsapp"></i></button>' +
        '<button type="button" data-client-action="edit" data-client-id="' + client.id + '" aria-label="Editar a ' + escapeHTML(client.name) + '"><i class="fas fa-pen"></i></button>' +
        '<button type="button" data-client-action="delete" data-client-id="' + client.id + '" aria-label="Eliminar a ' + escapeHTML(client.name) + '"><i class="fas fa-trash"></i></button>' +
      '</div>' +
      '</article>';
  }

  function renderFilteredClients() {
    if (!clientList) return;
    var query = clientSearch ? clientSearch.value.trim().toLowerCase() : '';
    var filter = clientFilter ? clientFilter.value : 'all';
    var filtered = allClients.filter(function (client) {
      var matchesQuery = !query || (client.name + ' ' + client.phone).toLowerCase().includes(query);
      var matchesFilter = filter === 'all' || (filter === 'pending' && isPending(client)) || (filter === 'current' && !isPending(client));
      return matchesQuery && matchesFilter;
    });
    if (!allClients.length) {
      clientList.innerHTML = '<p class="admin-empty">Todavía no hay clientes registrados.</p>';
      return;
    }
    clientList.innerHTML = filtered.length
      ? filtered.map(clientCardHTML).join('')
      : '<p class="admin-empty">No hay clientes que coincidan con la búsqueda.</p>';
  }

  function openReminder(client) {
    var template = reminderTemplate ? reminderTemplate.value : 'Hola {nombre}';
    var lastCut = getLastCut(client);
    var service = client.last_service || client.service || '';
    var message = template
      .replace(/{nombre}/g, client.name)
      .replace(/{dias}/g, lastCut ? daysSince(lastCut) : '?')
      .replace(/{servicio}/g, service)
      .replace(/{fecha_corte}/g, lastCut ? formatDate(lastCut) : '?');
    return openWhatsApp(client.phone, message);
  }

  function openNextReminder() {
    if (!reminderQueue.length) {
      showFeedback(clientFeedback, 'No hay recordatorios pendientes hoy.');
      return;
    }
    var client = reminderQueue.shift();
    if (!openReminder(client)) {
      showFeedback(clientFeedback, 'No se pudo abrir WhatsApp para ' + client.name + '. Revisa el teléfono.');
      return;
    }
    if (reminderQueue.length) {
      showFeedback(clientFeedback, 'Abierto 1. Quedan ' + reminderQueue.length + '. Pulsa de nuevo para el siguiente.');
    } else {
      showFeedback(clientFeedback, 'Último recordatorio abierto.', 3000);
    }
  }

  function resetClientForm() {
    if (!clientForm) return;
    clientForm.reset();
    document.getElementById('clientId').value = '';
    if (clientFormTitle) clientFormTitle.textContent = 'Agregar cliente';
    var submit = document.getElementById('clientSubmit');
    if (submit) submit.textContent = 'Guardar cliente';
    if (clientCancel) clientCancel.hidden = true;
  }

  function resetStyleForm() {
    if (!styleForm) return;
    styleForm.reset();
    var styleId = document.getElementById('styleId');
    if (styleId) styleId.value = '';
    var title = document.getElementById('styleFormTitle');
    var submit = document.getElementById('styleSubmit');
    if (title) title.textContent = 'Agregar estilo';
    if (submit) submit.textContent = 'Agregar estilo';
  }

  function enterDashboard() {
    if (adminLogin) adminLogin.hidden = true;
    if (adminDashboard) adminDashboard.hidden = false;
    if (reminderTemplate) reminderTemplate.value = localStorage.getItem(templateKey) || reminderTemplate.value;
    loadClients();
    loadStyles();
    loadCash();
    loadBirthdays();
  }

  function loadClients() {
    apiFetch('/api/clients').then(function (res) {
      if (!res.ok) throw res;
      return res.json();
    }).then(function (clients) {
      allClients = clients;
      renderDashboard(clients);
      renderFilteredClients();
    }).catch(function () {
      allClients = [];
      renderDashboard([]);
      if (clientList) clientList.innerHTML = '<p class="admin-empty">No se pudo cargar la lista de clientes.</p>';
      showFeedback(clientFeedback, 'Error al cargar clientes.');
    });
  }

  function loadStyles() {
    if (!stylesList) return;
    apiFetch('/api/styles').then(function (res) {
      if (!res.ok) throw res;
      return res.json();
    }).then(function (styles) {
      if (tabCountStyles) tabCountStyles.textContent = styles.length;
      if (!styles.length) {
        stylesList.innerHTML = '<p class="admin-empty">No hay estilos registrados.</p>';
        return;
      }
      stylesList.innerHTML = styles.map(function (style) {
        var catLabel = { cortes: 'Corte', barba: 'Barba', combos: 'Combo' }[style.category] || style.category;
        return '<article class="client-item">' +
          '<div><h4>' + escapeHTML(style.name) + '</h4><p>' + catLabel + (style.image_url ? ' · ' + escapeHTML(style.image_url) : '') + '</p></div>' +
          '<div class="client-actions">' +
            '<button type="button" data-style-action="edit" data-style-id="' + style.id + '" data-style-name="' + escapeHTML(style.name) + '" data-style-cat="' + escapeHTML(style.category) + '" data-style-img="' + escapeHTML(style.image_url || '') + '" aria-label="Editar estilo"><i class="fas fa-pen"></i></button>' +
            '<button type="button" data-style-action="delete" data-style-id="' + style.id + '" aria-label="Eliminar estilo"><i class="fas fa-trash"></i></button>' +
          '</div>' +
          '</article>';
      }).join('');
    }).catch(function () {
      stylesList.innerHTML = '<p class="admin-empty">Error al cargar estilos.</p>';
    });
  }

  function loadCash() {
    if (!cashDateInput) return;
    var date = cashDateInput.value;
    if (!date) return;
    apiFetch('/api/cash/' + date).then(function (res) {
      if (!res.ok) throw res;
      return res.json();
    }).then(function (data) {
      if (cashIncome) cashIncome.value = ((data.gross_income_cents || 0) / 100).toFixed(2);
      if (cashTips) cashTips.value = ((data.tips_cents || 0) / 100).toFixed(2);
      if (cashNotes) cashNotes.value = data.notes || '';
    }).catch(function () {
      showFeedback(cashFeedback, 'Error al cargar caja.');
    });
  }

  function loadBirthdays() {
    if (!birthdayList) return;
    apiFetch('/api/birthdays/current').then(function (res) {
      if (!res.ok) throw res;
      return res.json();
    }).then(function (clients) {
      if (tabCountBirthdays) {
        tabCountBirthdays.textContent = clients.length;
        tabCountBirthdays.classList.toggle('has-urgent', clients.length > 0);
      }
      if (!clients.length) {
        birthdayList.innerHTML = '<p class="admin-empty">No hay cumpleaños este mes.</p>';
        return;
      }
      birthdayList.innerHTML = clients.map(function (client) {
        var day = new Date(client.birth_date + 'T12:00:00').toLocaleDateString('es-VE', { day: 'numeric', month: 'long' });
        return '<article class="client-item">' +
          '<div><h4>' + escapeHTML(client.name) + '</h4><p>Cumple el ' + day + ' · ' + escapeHTML(client.phone) + '</p></div>' +
          '<div class="client-actions">' +
            '<button type="button" data-client-action="send-birthday" data-client-phone="' + escapeHTML(client.phone) + '" data-client-name="' + escapeHTML(client.name) + '" aria-label="Felicitación WhatsApp"><i class="fab fa-whatsapp"></i></button>' +
          '</div>' +
          '</article>';
      }).join('');
    }).catch(function () {
      birthdayList.innerHTML = '<p class="admin-empty">Error al cargar cumpleaños.</p>';
    });
  }

  if (adminAccess) {
    adminAccess.addEventListener('click', function () {
      if (!adminSection) return;
      adminSection.hidden = false;
      adminSection.scrollIntoView({ behavior: 'smooth' });
      if (authToken) enterDashboard();
    });
  }

  if (adminLoginForm) {
    adminLoginForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var password = document.getElementById('adminPassword').value;
      if (adminLoginError) adminLoginError.textContent = '';
      fetch(API_BASE + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password })
      }).then(function (res) {
        if (!res.ok) throw res;
        return res.json();
      }).then(function (data) {
        authToken = data.token;
        sessionStorage.setItem('zane-auth-token', authToken);
        enterDashboard();
      }).catch(function () {
        if (adminLoginError) adminLoginError.textContent = 'Contraseña incorrecta.';
      });
    });
  }

  if (reminderTemplate) {
    reminderTemplate.addEventListener('input', function () {
      localStorage.setItem(templateKey, reminderTemplate.value);
    });
  }

  if (clientForm) {
    clientForm.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!clientForm.checkValidity()) return;
      var id = document.getElementById('clientId').value;
      var submitBtn = document.getElementById('clientSubmit');
      setLoading(submitBtn, true);
      var data = {
        name: document.getElementById('clientName').value.trim(),
        phone: document.getElementById('clientPhone').value.trim(),
        birth_date: document.getElementById('clientBirthDate').value || null,
        last_cut_date: document.getElementById('clientLastCut').value,
        last_service: document.getElementById('clientService').value.trim()
      };
      var promise = id
        ? apiFetch('/api/clients/' + id, { method: 'PUT', body: JSON.stringify(data) })
        : apiFetch('/api/clients', { method: 'POST', body: JSON.stringify(data) });
      promise.then(function (res) {
        if (!res.ok) return res.json().then(function (err) { throw err; });
        return res.json();
      }).then(function (savedClient) {
        var sidesMachine = document.getElementById('clientSidesMachine').value;
        var topFinish = document.getElementById('clientTopFinish').value;
        if (!sidesMachine) return savedClient;
        return apiFetch('/api/clients/' + savedClient.id + '/preferences', {
          method: 'POST',
          body: JSON.stringify({ sides_machine: sidesMachine, top_finish: topFinish || null })
        }).then(function () { return savedClient; });
      }).then(function () {
        loadClients();
        resetClientForm();
        setLoading(submitBtn, false);
        showFeedback(clientFeedback, id ? 'Cliente actualizado.' : 'Cliente guardado.', 2500);
      }).catch(function (err) {
        setLoading(submitBtn, false);
        showFeedback(clientFeedback, err.error || 'Error al guardar cliente.');
      });
    });
  }

  if (clientCancel) clientCancel.addEventListener('click', resetClientForm);
  if (clientSearch) clientSearch.addEventListener('input', renderFilteredClients);
  if (clientFilter) clientFilter.addEventListener('change', renderFilteredClients);

  var exportBackup = document.getElementById('exportBackup');
  if (exportBackup) {
    exportBackup.addEventListener('click', function () {
      var backup = { exported_at: new Date().toISOString(), clients: allClients };
      var blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      var link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'zane-respaldo-' + localISODate() + '.json';
      link.click();
      URL.revokeObjectURL(link.href);
    });
  }

  var importBackup = document.getElementById('importBackup');
  if (importBackup && backupFile) {
    importBackup.addEventListener('click', function () { backupFile.click(); });
    backupFile.addEventListener('change', function () {
      var file = backupFile.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var backup = JSON.parse(reader.result);
          apiFetch('/api/backup/import', { method: 'POST', body: JSON.stringify(backup) }).then(function (res) {
            if (!res.ok) return res.json().then(function (error) { throw error; });
            return res.json();
          }).then(function (result) {
            loadClients();
            showFeedback(clientFeedback, result.imported + ' cliente(s) importado(s).', 3000);
          }).catch(function (error) {
            showFeedback(clientFeedback, error.error || 'No se pudo importar el respaldo.');
          });
        } catch (error) {
          showFeedback(clientFeedback, 'El archivo no es un JSON válido.');
        }
        backupFile.value = '';
      };
      reader.readAsText(file);
    });
  }

  var adminLogout = document.getElementById('adminLogout');
  if (adminLogout) {
    adminLogout.addEventListener('click', function () {
      authToken = '';
      reminderQueue = [];
      sessionStorage.removeItem('zane-auth-token');
      if (adminDashboard) adminDashboard.hidden = true;
      if (adminLogin) adminLogin.hidden = false;
      resetClientForm();
    });
  }

  if (clientList) {
    clientList.addEventListener('click', function (event) {
      var button = event.target.closest('[data-client-action]');
      if (!button) return;
      var clientId = button.dataset.clientId;
      var action = button.dataset.clientAction;
      var client = findClient(clientId);
      if (action === 'send') {
        if (client) openReminder(client);
        return;
      }
      if (action === 'delete') {
        if (!window.confirm('¿Eliminar este cliente?')) return;
        apiFetch('/api/clients/' + clientId, { method: 'DELETE' }).then(function (res) {
          if (!res.ok && res.status !== 204) throw res;
          loadClients();
          showFeedback(clientFeedback, 'Cliente eliminado.', 2500);
        }).catch(function () {
          showFeedback(clientFeedback, 'No se pudo eliminar el cliente.');
        });
        return;
      }
      if (action === 'edit' && client) {
        document.getElementById('clientId').value = client.id;
        document.getElementById('clientName').value = client.name;
        document.getElementById('clientPhone').value = client.phone;
        document.getElementById('clientBirthDate').value = client.birth_date || '';
        document.getElementById('clientLastCut').value = client.last_cut_date || '';
        document.getElementById('clientService').value = client.last_service || '';
        document.getElementById('clientSidesMachine').value = client.sides_machine || '';
        document.getElementById('clientTopFinish').value = client.top_finish || '';
        if (clientFormTitle) clientFormTitle.textContent = 'Editar cliente';
        var submit = document.getElementById('clientSubmit');
        if (submit) submit.textContent = 'Actualizar cliente';
        if (clientCancel) clientCancel.hidden = false;
        clientForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  if (birthdayList) {
    birthdayList.addEventListener('click', function (event) {
      var button = event.target.closest('[data-client-action="send-birthday"]');
      if (!button) return;
      var name = button.dataset.clientName || '';
      var phone = button.dataset.clientPhone || '';
      var message = 'Hola ' + name + ', ¡feliz cumpleaños! Te deseamos un gran día desde Zane Barber Studio.';
      if (!openWhatsApp(phone, message)) {
        showFeedback(clientFeedback, 'No se pudo abrir WhatsApp. Revisa el teléfono.');
      }
    });
  }

  var sendAllReminders = document.getElementById('sendAllReminders');
  if (sendAllReminders) {
    sendAllReminders.addEventListener('click', function () {
      if (reminderQueue.length) {
        openNextReminder();
        return;
      }
      apiFetch('/api/reminders/pending').then(function (r) {
        if (!r.ok) throw r;
        return r.json();
      }).then(function (pending) {
        reminderQueue = pending.slice();
        openNextReminder();
      }).catch(function () {
        showFeedback(clientFeedback, 'No se pudieron cargar los recordatorios.');
      });
    });
  }

  if (styleForm) {
    styleForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var name = document.getElementById('styleName').value.trim();
      var category = document.getElementById('styleCategory').value;
      var imageUrl = document.getElementById('styleImage').value.trim();
      var id = document.getElementById('styleId').value;
      var submitBtn = document.getElementById('styleSubmit');
      setLoading(submitBtn, true);
      var data = { name: name, category: category, image_url: imageUrl || null, active: 1 };
      var promise = id
        ? apiFetch('/api/styles/' + id, { method: 'PUT', body: JSON.stringify(data) })
        : apiFetch('/api/styles', { method: 'POST', body: JSON.stringify(data) });
      promise.then(function (res) {
        if (!res.ok) return res.json().then(function (err) { throw err; });
        loadStyles();
        resetStyleForm();
        setLoading(submitBtn, false);
        showFeedback(document.getElementById('styleFeedback'), id ? 'Estilo actualizado.' : 'Estilo agregado.', 2500);
      }).catch(function (err) {
        setLoading(submitBtn, false);
        showFeedback(document.getElementById('styleFeedback'), err.error || 'Error al guardar estilo.');
      });
    });
  }

  if (stylesList) {
    stylesList.addEventListener('click', function (event) {
      var button = event.target.closest('[data-style-action]');
      if (!button) return;
      var action = button.dataset.styleAction;
      var styleId = button.dataset.styleId;
      if (action === 'edit') {
        document.getElementById('styleId').value = styleId;
        document.getElementById('styleName').value = button.dataset.styleName;
        document.getElementById('styleCategory').value = button.dataset.styleCat;
        document.getElementById('styleImage').value = button.dataset.styleImg || '';
        document.getElementById('styleFormTitle').textContent = 'Editar estilo';
        document.getElementById('styleSubmit').textContent = 'Actualizar estilo';
      }
      if (action === 'delete' && window.confirm('¿Eliminar este estilo?')) {
        apiFetch('/api/styles/' + styleId, { method: 'DELETE' }).then(function (res) {
          if (!res.ok && res.status !== 204) throw res;
          loadStyles();
          resetStyleForm();
          showFeedback(document.getElementById('styleFeedback'), 'Estilo eliminado.', 2500);
        }).catch(function () {
          showFeedback(document.getElementById('styleFeedback'), 'No se pudo eliminar el estilo.');
        });
      }
    });
  }

  if (cashSave) {
    cashSave.addEventListener('click', function () {
      var date = cashDateInput && cashDateInput.value;
      if (!date) { showFeedback(cashFeedback, 'Selecciona una fecha.'); return; }
      setLoading(cashSave, true);
      var data = {
        gross_income_cents: Math.round(Number(cashIncome.value) * 100),
        tips_cents: Math.round(Number(cashTips.value) * 100),
        notes: cashNotes.value.trim()
      };
      apiFetch('/api/cash/' + date, { method: 'PUT', body: JSON.stringify(data) }).then(function (res) {
        if (!res.ok) return res.json().then(function (err) { throw err; });
        setLoading(cashSave, false);
        showFeedback(cashFeedback, 'Caja guardada.', 2500);
      }).catch(function (err) {
        setLoading(cashSave, false);
        showFeedback(cashFeedback, err.error || 'Error al guardar caja.');
      });
    });
  }

  if (cashDateInput) {
    cashDateInput.value = localISODate();
    cashDateInput.addEventListener('change', loadCash);
  }

  document.querySelectorAll('[data-panel-tab]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var target = tab.dataset.panelTab;
      document.querySelectorAll('[data-panel-tab]').forEach(function (item) { item.classList.remove('is-active'); });
      tab.classList.add('is-active');
      document.querySelectorAll('[data-panel-view]').forEach(function (view) {
        view.hidden = view.dataset.panelView !== target;
      });
      if (target === 'clients') loadClients();
      if (target === 'styles') loadStyles();
      if (target === 'cash') loadCash();
      if (target === 'birthdays') loadBirthdays();
    });
  });

  if (isAdminRoute && authToken) enterDashboard();
})();