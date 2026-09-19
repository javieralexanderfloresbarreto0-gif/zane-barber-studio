'use strict';

// ====================================================================
//  KIOSCO DE TURNOS  ·  se monta desde server/index.js con:
//    require('./kiosc/mount')({ app, database, publicDirectory, dataDirectory,
//      verifyToken, requireAuth, signToken, normalizePhone,
//      currentRate, bolivaresFromUsd, getSetting })
//
//  Rutas:
//    /api/kiosc/*   -> público, protegido con token de dispositivo (X-Kiosc-Token)
//    /api/orders/*  -> admin (JWT)
//    /api/stream    -> SSE para el tablero (token corto por query)
// ====================================================================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

module.exports = function mountKiosc(deps) {
  const {
    app, database, publicDirectory, dataDirectory,
    verifyToken, requireAuth, signToken, normalizePhone,
    currentRate, bolivaresFromUsd, getSetting, setSetting
  } = deps;

  const uploadsDir = path.join(dataDirectory, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  // La app de la tablet: /kiosc  y  /kiosc/  -> public/kiosc/index.html
  // (los assets kiosc.css / kiosc.js / sw.js los sirve express.static)
  app.get(['/kiosc', '/kiosc/'], (req, res) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.sendFile(path.join(publicDirectory, 'kiosc', 'index.html'));
  });

  // Tope del comprobante YA DECODIFICADO. En base64 crece ~1,33x, así que debe
  // quedar por debajo del límite de express.json (1 MB) con margen para el JSON.
  const MAX_PROOF_BYTES = 640 * 1024;
  const ORDER_TTL_MIN = 15;                // orden sin pagar caduca
  const PROOF_RETENTION_DAYS = 7;          // luego se borra la imagen (datos personales)

  // ---------------------------------------------------------------- SSE
  const sseClients = new Set();

  function sseAdd(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  }

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try { res.write(frame); } catch (e) { sseClients.delete(res); }
    }
  }

  setInterval(() => broadcast('ping', { t: Date.now() }), 25000).unref();

  // ----------------------------------------------------- token de dispositivo
  const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
  const findDevice = database.prepare('SELECT * FROM kiosc_devices WHERE token_hash = ? AND active = 1');
  const touchDevice = database.prepare('UPDATE kiosc_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?');

  function requireDevice(req, res, next) {
    // Solo por cabecera: un token en la query string acaba en logs y en Referer.
    const token = req.get('X-Kiosc-Token') || '';
    const device = token && findDevice.get(sha256(token));
    if (!device) return res.status(401).json({ error: 'Kiosco no autorizado. Registra el dispositivo.' });
    touchDevice.run(device.id);
    req.device = device;
    next();
  }

  // ----------------------------------------------------- statements
  const q = {
    servicesActive: database.prepare(
      'SELECT id, name, description, category, price_usd_cents, duration_min FROM services WHERE active = 1 ORDER BY sort_order, name'
    ),
    serviceById: database.prepare('SELECT * FROM services WHERE id = ? AND active = 1'),
    clientByPhone: database.prepare('SELECT id FROM clients WHERE phone = ?'),
    upsertClient: database.prepare(`
      INSERT INTO clients (name, phone, last_cut_date, last_service)
      VALUES (@name, @phone, date('now','localtime'), @service)
      ON CONFLICT(phone) DO UPDATE SET name = excluded.name, updated_at = CURRENT_TIMESTAMP`),
    insertOrder: database.prepare(`
      INSERT INTO orders
        (client_id, client_name, client_phone, service_id, service_name,
         amount_bs, amount_usd_cents, rate_used, device_id)
      VALUES
        (@client_id, @client_name, @client_phone, @service_id, @service_name,
         @amount_bs, @amount_usd_cents, @rate_used, @device_id)`),
    setCode: database.prepare('UPDATE orders SET code = ? WHERE id = ?'),
    orderById: database.prepare('SELECT * FROM orders WHERE id = ?'),
    orderByCode: database.prepare('SELECT * FROM orders WHERE code = ?'),
    event: database.prepare(
      'INSERT INTO payment_events (order_id, type, actor, note, meta_json) VALUES (?, ?, ?, ?, ?)'
    ),
    nextQueueNo: database.prepare(`
      SELECT COALESCE(MAX(queue_no), 0) + 1 AS n
      FROM orders WHERE date(created_at,'localtime') = date('now','localtime')`),
    boardToday: database.prepare(`
      SELECT id, code, client_name, client_phone, service_name, amount_bs, amount_usd_cents,
             payment_status, payment_reference,
             (payment_proof_path IS NOT NULL) AS has_proof,
             queue_status, queue_no, reject_reason,
             created_at, submitted_at, paid_at, called_at, done_at,
             (SELECT COUNT(*) FROM orders o2
                WHERE o2.payment_proof_sha = orders.payment_proof_sha
                  AND o2.payment_proof_sha IS NOT NULL AND o2.id <> orders.id) AS proof_reused
      FROM orders
      WHERE date(created_at,'localtime') = date('now','localtime')
        AND payment_status <> 'expired'
      ORDER BY
        CASE payment_status WHEN 'submitted' THEN 0 WHEN 'validated' THEN 1 ELSE 2 END,
        CASE queue_status WHEN 'in_service' THEN 0 WHEN 'waiting' THEN 1 ELSE 3 END,
        queue_no, created_at`),
    dailyHistory: database.prepare(`
      SELECT date(done_at,'localtime') AS date,
             COUNT(*) AS cuts,
             SUM(amount_bs) AS revenue_bs
      FROM orders
      WHERE queue_status = 'done'
      GROUP BY date(done_at,'localtime')
      ORDER BY date DESC
      LIMIT ?`),
    staleUnpaid: database.prepare(`
      SELECT id, code FROM orders
      WHERE payment_status = 'awaiting_payment'
        AND created_at <= datetime('now', ?)`),
    expire: database.prepare("UPDATE orders SET payment_status = 'expired' WHERE id = ?")
  };

  // Métodos de Pago Móvil: array JSON en app_settings 'pm_methods'.
  // Si no existe (BD vieja), se arma uno a partir de las claves sueltas pm_*.
  function pagoMovilMethods(includeEmpty) {
    const raw = getSetting('pm_methods');
    if (raw) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          return arr
            .filter((m) => m && (includeEmpty || m.phone || m.id))
            .map((m) => ({
              bank: String(m.bank || ''),
              code: String(m.code || ''),
              phone: String(m.phone || ''),
              id: String(m.id || ''),
              qr: m.qr ? String(m.qr) : null
            }));
        }
      } catch (e) { /* cae al legacy */ }
    }
    const legacy = {
      bank: getSetting('pm_bank') || '',
      code: '',
      phone: getSetting('pm_phone') || '',
      id: getSetting('pm_id') || '',
      qr: getSetting('pm_qr') || null
    };
    return legacy.phone || legacy.id ? [legacy] : [];
  }

  function publicView(o) {
    return {
      code: o.code,
      payment_status: o.payment_status,
      queue_status: o.queue_status,
      queue_no: o.queue_no,
      reject_reason: o.reject_reason
    };
  }

  function cardView(o) {
    return {
      id: o.id, code: o.code,
      client_name: o.client_name, client_phone: o.client_phone,
      service_name: o.service_name, amount_bs: o.amount_bs, amount_usd_cents: o.amount_usd_cents,
      payment_status: o.payment_status, payment_reference: o.payment_reference,
      has_proof: o.payment_proof_path != null, reject_reason: o.reject_reason,
      queue_status: o.queue_status, queue_no: o.queue_no,
      created_at: o.created_at, submitted_at: o.submitted_at,
      paid_at: o.paid_at, called_at: o.called_at, done_at: o.done_at
    };
  }

  // ----------------------------------------------------- crear orden (tx)
  const createOrderTx = database.transaction((input) => {
    const svc = q.serviceById.get(input.service_id);
    if (!svc) return { error: 'Servicio no disponible.', status: 404 };

    const rate = currentRate();
    const amountBs = bolivaresFromUsd(svc.price_usd_cents / 100, rate.rate);
    if (amountBs === null) return { error: 'No hay tasa configurada. Avisa a recepción.', status: 503 };

    q.upsertClient.run({ name: input.name, phone: input.phone, service: svc.name });
    const client = q.clientByPhone.get(input.phone);

    const info = q.insertOrder.run({
      client_id: client ? client.id : null,
      client_name: input.name,
      client_phone: input.phone,
      service_id: svc.id,
      service_name: svc.name,
      amount_bs: amountBs,
      amount_usd_cents: svc.price_usd_cents,
      rate_used: rate.rate,
      device_id: input.device_id
    });
    const id = Number(info.lastInsertRowid);
    const code = 'A-' + String(id).padStart(3, '0');
    q.setCode.run(code, id);
    q.event.run(id, 'created', 'kiosc:' + input.device_label, null,
      JSON.stringify({ amount_bs: amountBs, rate: rate.rate }));

    return { order: q.orderById.get(id) };
  });

  // ----------------------------------------------------- validar (tx)
  const validateTx = database.transaction((id, actor) => {
    const o = q.orderById.get(id);
    if (!o) return { error: 'Orden no encontrada.', status: 404 };
    if (o.payment_status === 'validated') return { order: o };            // idempotente
    if (o.payment_status !== 'submitted') {
      return { error: 'La orden no está esperando validación.', status: 409 };
    }
    const queueNo = q.nextQueueNo.get().n;
    database.prepare(`
      UPDATE orders SET
        payment_status = 'validated',
        queue_status   = 'waiting',
        queue_no       = @queueNo,
        validated_by   = @actor,
        paid_at        = CURRENT_TIMESTAMP
      WHERE id = @id`).run({ id, actor, queueNo });
    q.event.run(id, 'validated', actor, null,
      JSON.stringify({ queue_no: queueNo, reference: o.payment_reference }));
    return { order: q.orderById.get(id) };
  });

  // ====================================================================
  //  KIOSCO  (token de dispositivo)
  // ====================================================================

  app.get('/api/kiosc/menu', requireDevice, (req, res) => {
    const rate = currentRate();
    const services = q.servicesActive.all().map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      duration_min: s.duration_min,
      amount_usd_cents: s.price_usd_cents,
      amount_bs: bolivaresFromUsd(s.price_usd_cents / 100, rate.rate)
    }));
    res.json({
      services,
      rate: { value: rate.rate, source: rate.source },
      pago_movil: pagoMovilMethods()
    });
  });

  app.post('/api/kiosc/orders', requireDevice, (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 80);
    const phone = normalizePhone(body.phone).slice(0, 20);
    const serviceId = Number(body.service_id);
    if (!name || phone.length < 10 || !serviceId) {
      return res.status(400).json({ error: 'Faltan datos: nombre, teléfono o servicio.' });
    }
    // una sola orden activa por teléfono
    const active = database.prepare(`
      SELECT code FROM orders
      WHERE client_phone = ? AND (payment_status IN ('awaiting_payment','submitted')
        OR queue_status IN ('waiting','in_service'))
      ORDER BY id DESC LIMIT 1`).get(phone);
    if (active) {
      return res.status(409).json({ error: 'Ya tienes una orden en curso (' + active.code + ').' });
    }

    const out = createOrderTx({
      service_id: serviceId, name, phone,
      device_id: req.device.id, device_label: req.device.label
    });
    if (out.error) return res.status(out.status).json({ error: out.error });

    const o = out.order;
    res.status(201).json({
      code: o.code,
      amount_bs: o.amount_bs,
      amount_usd_cents: o.amount_usd_cents,
      service_name: o.service_name,
      pago_movil: pagoMovilMethods()
    });
  });

  app.post('/api/kiosc/orders/:code/payment', requireDevice, (req, res) => {
    const o = q.orderByCode.get(req.params.code);
    if (!o || o.device_id !== req.device.id) {
      return res.status(404).json({ error: 'Orden no encontrada.' });
    }
    if (!['awaiting_payment', 'rejected'].includes(o.payment_status)) {
      return res.status(409).json({ error: 'La orden ya no admite pago.' });
    }
    // La referencia y el comprobante son opcionales: el admin valida viendo
    // el ingreso en su banca. Si el kiosco los manda, se guardan igual.
    const refRaw = String((req.body || {}).reference || '').replace(/\s+/g, '').slice(0, 20);
    const reference = refRaw.length >= 4 ? refRaw : null;

    // comprobante opcional: data URL de imagen, ya reducida por la tablet
    let proofPath = null, proofSha = null;
    const raw = (req.body || {}).proof_base64;
    if (raw) {
      const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(raw));
      if (!m) return res.status(400).json({ error: 'El comprobante debe ser una imagen.' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_PROOF_BYTES) {
        return res.status(413).json({ error: 'La imagen es muy pesada; vuelve a tomarla.' });
      }
      const ext = m[1] === 'jpg' ? 'jpeg' : m[1];
      proofPath = 'uploads/' + o.code + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(dataDirectory, proofPath), buf, { mode: 0o600 });
      proofSha = crypto.createHash('sha256').update(buf).digest('hex');
    }

    try {
      const info = database.prepare(`
        UPDATE orders SET
          payment_status = 'submitted',
          payment_reference = @reference,
          payment_proof_path = @proofPath,
          payment_proof_sha = @proofSha,
          reject_reason = NULL,
          submitted_at = CURRENT_TIMESTAMP
        WHERE id = @id AND payment_status IN ('awaiting_payment','rejected')`)
        .run({ id: o.id, reference, proofPath, proofSha });
      if (!info.changes) {
        if (proofPath) try { fs.unlinkSync(path.join(dataDirectory, proofPath)); } catch (e) {}
        return res.status(409).json({ error: 'La orden ya no admite pago.' });
      }
    } catch (err) {
      if (proofPath) try { fs.unlinkSync(path.join(dataDirectory, proofPath)); } catch (e) {}
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ error: 'Esa referencia ya está registrada en otra orden.' });
      }
      throw err;
    }

    // reintento de pago: el comprobante anterior queda huérfano, se borra
    if (o.payment_proof_path && o.payment_proof_path !== proofPath) {
      try { fs.unlinkSync(path.join(dataDirectory, o.payment_proof_path)); } catch (e) {}
    }

    q.event.run(o.id, 'submitted', 'kiosc:' + req.device.label, null, JSON.stringify({ reference }));
    const fresh = q.orderById.get(o.id);
    res.json(publicView(fresh));
    broadcast('order.submitted', cardView(fresh));
  });

  app.get('/api/kiosc/orders/:code', requireDevice, (req, res) => {
    const o = q.orderByCode.get(req.params.code);
    if (!o) return res.status(404).json({ error: 'Orden no encontrada.' });
    res.json(publicView(o));
  });

  // ====================================================================
  //  ADMIN  (JWT)
  // ====================================================================

  app.get('/api/orders', requireAuth, (req, res) => {
    res.json(q.boardToday.all());
  });

  // Historial diario (para ver cómo fueron los días anteriores): fecha,
  // cantidad de cortes finalizados y total cobrado en Bs. Incluye hoy.
  app.get('/api/orders/history', requireAuth, (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    res.json(q.dailyHistory.all(days));
  });

  app.post('/api/orders/:id/validate', requireAuth, (req, res) => {
    const out = validateTx(Number(req.params.id), 'admin');
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json(cardView(out.order));
    broadcast('order.validated', cardView(out.order));
  });

  app.post('/api/orders/:id/reject', requireAuth, (req, res) => {
    const reason = String((req.body || {}).reason || '').trim().slice(0, 200) || 'Sin especificar';
    const info = database.prepare(`
      UPDATE orders SET payment_status = 'rejected', reject_reason = ?
      WHERE id = ? AND payment_status IN ('submitted','awaiting_payment')`).run(reason, req.params.id);
    if (!info.changes) return res.status(409).json({ error: 'No se puede rechazar en este estado.' });
    q.event.run(req.params.id, 'rejected', 'admin', reason, null);
    res.status(204).end();
    broadcast('order.rejected', { id: Number(req.params.id), reason });
  });

  // avanzar la cola: call | done | no-show
  const QUEUE_MOVES = {
    call: { from: ['waiting'], to: 'in_service', stamp: 'called_at', evt: 'order.called' },
    done: { from: ['in_service'], to: 'done', stamp: 'done_at', evt: 'order.done' },
    'no-show': { from: ['waiting', 'in_service'], to: 'no_show', stamp: 'done_at', evt: 'order.no_show' }
  };
  Object.keys(QUEUE_MOVES).forEach((action) => {
    const m = QUEUE_MOVES[action];
    app.post('/api/orders/:id/' + action, requireAuth, (req, res) => {
      const placeholders = m.from.map(() => '?').join(',');
      const info = database.prepare(
        `UPDATE orders SET queue_status = ?, ${m.stamp} = CURRENT_TIMESTAMP
         WHERE id = ? AND queue_status IN (${placeholders})`
      ).run(m.to, req.params.id, ...m.from);
      if (!info.changes) return res.status(409).json({ error: 'La orden no está en ese punto de la cola.' });
      q.event.run(req.params.id, m.to, 'admin', null, null);
      const o = q.orderById.get(req.params.id);
      // El corte solo cuenta como "hecho" cuando se termina: aquí se refresca la
      // ficha del cliente (base del recordatorio de los 15 días), no al crear.
      if (action === 'done' && o && o.client_id) {
        database.prepare(`UPDATE clients SET last_cut_date = date('now','localtime'),
          last_service = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(o.service_name, o.client_id);
      }
      res.json(cardView(o));
      broadcast(m.evt, cardView(o));
    });
  });

  app.get('/api/orders/:id/proof', requireAuth, (req, res) => {
    const o = q.orderById.get(req.params.id);
    if (!o || !o.payment_proof_path) return res.status(404).end();
    res.sendFile(path.join(dataDirectory, o.payment_proof_path));
  });

  // ---- datos de Pago Móvil (admin) ----
  app.get('/api/kiosc/pago-movil', requireAuth, (req, res) => {
    res.json(pagoMovilMethods(true));
  });

  app.put('/api/kiosc/pago-movil', requireAuth, (req, res) => {
    const list = (req.body && req.body.methods) || [];
    if (!Array.isArray(list)) return res.status(400).json({ error: 'Formato inválido.' });
    const clean = list
      .map((m) => ({
        bank: String((m && m.bank) || '').trim().slice(0, 60),
        code: String((m && m.code) || '').trim().slice(0, 8),
        phone: String((m && m.phone) || '').trim().slice(0, 20),
        id: String((m && m.id) || '').trim().slice(0, 20),
        qr: m && m.qr ? String(m.qr).trim().slice(0, 200) : ''
      }))
      .filter((m) => m.bank || m.phone || m.id);
    setSetting('pm_methods', JSON.stringify(clean));
    res.json(pagoMovilMethods());
  });

  // ---- gestión de dispositivos (admin) ----
  app.post('/api/kiosc/devices', requireAuth, (req, res) => {
    const label = String((req.body || {}).label || '').trim().slice(0, 60) || 'Tablet';
    const token = crypto.randomBytes(24).toString('base64url');
    database.prepare('INSERT INTO kiosc_devices (label, token_hash) VALUES (?, ?)')
      .run(label, sha256(token));
    res.status(201).json({ label, token }); // el token en claro se muestra UNA sola vez
  });

  // Solo las activas: una vez revocada, la tablet desaparece de la lista
  // (se conserva en la BD para no romper la referencia en orders.device_id).
  app.get('/api/kiosc/devices', requireAuth, (req, res) => {
    res.json(database.prepare(
      'SELECT id, label, active, last_seen_at, created_at FROM kiosc_devices WHERE active = 1 ORDER BY id'
    ).all());
  });

  app.delete('/api/kiosc/devices/:id', requireAuth, (req, res) => {
    const info = database.prepare('UPDATE kiosc_devices SET active = 0 WHERE id = ?').run(req.params.id);
    res.status(info.changes ? 204 : 404).end();
  });

  // ====================================================================
  //  STREAM SSE  (token corto por query: EventSource no manda cabeceras)
  // ====================================================================

  app.post('/api/stream-token', requireAuth, (req, res) => {
    // Vida corta: solo abre el SSE y el tablero lo renueva al reconectar.
    res.json({ token: signToken({ role: 'admin', scope: 'stream' }, 15 * 60 * 1000) });
  });

  app.get('/api/stream', (req, res) => {
    const payload = verifyToken((req.query && req.query.token) || '');
    if (!payload || payload.scope !== 'stream') return res.status(401).end();
    sseAdd(req, res);
  });

  // ---- caducar órdenes sin pagar ----
  setInterval(() => {
    const stale = q.staleUnpaid.all('-' + ORDER_TTL_MIN + ' minutes');
    for (const o of stale) {
      q.expire.run(o.id);
      q.event.run(o.id, 'expired', 'system', null, null);
      broadcast('order.expired', { id: o.id, code: o.code });
    }
  }, 60000).unref();

  // ---- borrar comprobantes viejos (datos personales, no se conservan) ----
  const oldProofs = database.prepare(
    `SELECT id, payment_proof_path FROM orders
     WHERE payment_proof_path IS NOT NULL AND created_at <= datetime('now', ?)`
  );
  const clearProofPath = database.prepare('UPDATE orders SET payment_proof_path = NULL WHERE id = ?');
  function sweepProofs() {
    for (const o of oldProofs.all('-' + PROOF_RETENTION_DAYS + ' days')) {
      try { fs.unlinkSync(path.join(dataDirectory, o.payment_proof_path)); } catch (e) {}
      clearProofPath.run(o.id);
    }
  }
  sweepProofs();
  setInterval(sweepProofs, 6 * 60 * 60 * 1000).unref();

  console.log('[ZANE] Kiosco de turnos montado · /api/kiosc  /api/orders  /api/stream');
};
