// ====================================================================
//  ZANE BARBER STUDIO · versión Cloudflare (Workers + D1)
//
//  Mismas rutas y respuestas que server/index.js + server/kiosc/mount.js,
//  adaptadas a lo que cambia en un Worker:
//   - La base es D1 (SQLite remoto): API asíncrona y sin transacciones
//     interactivas; lo que debe ser atómico va en db.batch().
//   - No hay memoria compartida entre peticiones: los límites de intentos
//     (login, reservas) se guardan en la tabla `hits`.
//   - El Worker corre en UTC: la hora de Venezuela (UTC-4 fijo, sin horario
//     de verano) se aplica a mano en SQL ('-4 hours') y en JS.
//   - No hay conexiones abiertas (SSE): el tablero de Turnos consulta cada
//     pocos segundos (/api/stream-token responde { poll: true }).
//   - Tareas periódicas (tasa, órdenes vencidas, limpieza) van por cron.
// ====================================================================
import { Hono } from 'hono';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

const app = new Hono();

// Cabeceras de seguridad en todo lo que responde el Worker. Las respuestas de
// ASSETS tienen cabeceras inmutables, así que se copian antes de tocarlas.
app.use('*', async (c, next) => {
  await next();
  c.res = new Response(c.res.body, c.res);
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('X-XSS-Protection', '0');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
});

// ---------------------------------------------------------------- constantes
const CARACAS_OFFSET_MS = -4 * 60 * 60 * 1000;
const TZ = "'-4 hours'"; // modificador SQLite para pasar de UTC a hora de Caracas

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const RATE_MARGIN = 0.05;
const RATE_ROUND_TO = 250;
const RATE_TTL_MS = 30 * 60 * 1000;
const RATE_SOURCES = [
  {
    name: 'criptoya/binance-p2p',
    url: 'https://criptoya.com/api/usdt/ves/1',
    pick: (data) => {
      const asks = ['binancep2p', 'okexp2p', 'bybitp2p', 'bitgetp2p', 'bingxp2p']
        .map((key) => data && data[key] && Number(data[key].totalAsk))
        .filter((value) => Number.isFinite(value) && value > 0);
      return asks.length ? asks.reduce((sum, value) => sum + value, 0) / asks.length : null;
    }
  },
  {
    name: 'dolarapi/paralelo',
    url: 'https://ve.dolarapi.com/v1/dolares/paralelo',
    pick: (data) => (data && Number(data.promedio)) || null
  }
];

const WEEKDAY_SLOTS = ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
const SATURDAY_SLOTS = WEEKDAY_SLOTS.concat('19:00');
const BOOKING_WINDOW_DAYS = 60;
const BOOKING_LIMIT_PER_HOUR = 6;

const ORDER_TTL_MIN = 15;
const POLL_INTERVAL_MS = 5000;

// ---------------------------------------------------------------- D1
// D1 no acepta undefined en bind(): se convierte a null.
function stmt(env, sql, params) {
  const statement = env.DB.prepare(sql);
  return params && params.length ? statement.bind(...params.map((v) => (v === undefined ? null : v))) : statement;
}
const all = async (env, sql, ...params) => (await stmt(env, sql, params).all()).results;
const first = (env, sql, ...params) => stmt(env, sql, params).first();
const run = (env, sql, ...params) => stmt(env, sql, params).run();
const changes = (result) => (result && result.meta ? result.meta.changes : 0);
const lastId = (result) => (result && result.meta ? result.meta.last_row_id : null);
const isUnique = (error) => /UNIQUE/i.test(String(error && error.message));
const isForeignKey = (error) => /FOREIGN KEY/i.test(String(error && error.message));

// ---------------------------------------------------------------- utilidades
function json(c, data, status) {
  return c.json(data, status || 200);
}

function clientIp(c) {
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
}

async function body(c) {
  try { return (await c.req.json()) || {}; } catch (error) { return {}; }
}

function requireFields(source, fields) {
  return fields.filter((field) => source[field] !== 0 && !source[field]);
}

function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('58') && digits.length >= 12) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return '58' + digits.slice(1);
  if (digits.length === 10 && (digits.startsWith('4') || digits.startsWith('2'))) return '58' + digits;
  return digits;
}

function clientPayload(source) {
  return {
    name: String(source.name || '').trim().slice(0, 120),
    phone: normalizePhone(source.phone).slice(0, 20),
    birth_date: source.birth_date || null,
    last_cut_date: source.last_cut_date,
    last_service: String(source.last_service || '').trim().slice(0, 120)
  };
}

function validDate(dateString, allowNull) {
  if (!dateString) return allowNull;
  return /^\d{4}-\d{2}-\d{2}$/.test(dateString);
}

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

// Hora de Caracas como Date cuyos getters UTC dan la hora local.
function caracasNow() {
  return new Date(Date.now() + CARACAS_OFFSET_MS);
}

function isoDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// ---------------------------------------------------------------- tokens
function tokenSecret(env) {
  if (!env.TOKEN_SECRET) throw new Error('Falta el secreto TOKEN_SECRET (wrangler secret put TOKEN_SECRET).');
  return env.TOKEN_SECRET;
}

function signToken(env, payload, ttlMs) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const content = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + (ttlMs || 12 * 60 * 60 * 1000) })).toString('base64url');
  const signature = createHmac('sha256', tokenSecret(env)).update(header + '.' + content).digest('base64url');
  return header + '.' + content + '.' + signature;
}

function verifyToken(env, token) {
  const parts = String(token).split('.');
  if (parts.length !== 3 || !env.TOKEN_SECRET) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (error) {
    return null;
  }
  const expected = createHmac('sha256', env.TOKEN_SECRET).update(parts[0] + '.' + parts[1]).digest('base64url');
  if (!safeEqual(expected, parts[2])) return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

const requireAuth = async (c, next) => {
  const header = c.req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token ? verifyToken(c.env, token) : null;
  // Los tokens con "scope" son de propósito único y no valen como sesión de admin.
  if (!payload || payload.scope) {
    return json(c, { error: 'No autorizado. Inicia sesión nuevamente.' }, 401);
  }
  await next();
};

// ---------------------------------------------------------------- límites
async function countHits(env, key, sinceMs) {
  const row = await first(env, 'SELECT COUNT(*) AS n FROM hits WHERE key = ? AND at > ?', key, Date.now() - sinceMs);
  return row ? row.n : 0;
}

function recordHit(env, key) {
  return run(env, 'INSERT INTO hits (key, at) VALUES (?, ?)', key, Date.now());
}

// ---------------------------------------------------------------- ajustes y tasa
async function getSetting(env, key) {
  const row = await first(env, 'SELECT value FROM app_settings WHERE key = ?', key);
  return row ? row.value : null;
}

function setSettingStmt(env, key, value) {
  return stmt(env, `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`, [key, String(value)]);
}

function setSetting(env, key, value) {
  return setSettingStmt(env, key, value).run();
}

async function fetchAutoRate(env) {
  for (const source of RATE_SOURCES) {
    try {
      const response = await fetch(source.url, {
        headers: { 'User-Agent': 'ZaneBarber/1.0' },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) continue;
      const value = source.pick(await response.json());
      if (Number.isFinite(value) && value > 0) {
        await env.DB.batch([
          setSettingStmt(env, 'usdt_rate_auto', value),
          setSettingStmt(env, 'usdt_rate_auto_at', new Date().toISOString()),
          setSettingStmt(env, 'usdt_rate_source', source.name)
        ]);
        return value;
      }
    } catch (error) {
      // fuente caída: probamos la siguiente
    }
  }
  return null;
}

async function currentRate(env) {
  const rows = await all(env, `SELECT key, value, updated_at FROM app_settings
    WHERE key IN ('usdt_rate', 'usdt_rate_auto', 'usdt_rate_auto_at', 'usdt_rate_source')`);
  const map = Object.fromEntries(rows.map((row) => [row.key, row]));
  const manual = Number(map.usdt_rate && map.usdt_rate.value) || 0;
  const auto = Number(map.usdt_rate_auto && map.usdt_rate_auto.value) || 0;
  const usingManual = manual > 0;
  const rate = usingManual ? manual : auto;
  return {
    rate: Number.isFinite(rate) && rate > 0 ? rate : 0,
    margin: RATE_MARGIN,
    round_to: RATE_ROUND_TO,
    source: usingManual ? 'manual' : (auto > 0 ? ((map.usdt_rate_source && map.usdt_rate_source.value) || 'auto') : 'none'),
    updated_at: usingManual
      ? map.usdt_rate.updated_at
      : (map.usdt_rate_auto_at ? map.usdt_rate_auto_at.value : null)
  };
}

// Si la tasa automática está vieja: sin tasa se espera a obtenerla; con una
// tasa anterior se responde ya y se actualiza en segundo plano.
async function ensureAutoRate(c) {
  const env = c.env;
  if ((Number(await getSetting(env, 'usdt_rate')) || 0) > 0) return;
  const cached = Number(await getSetting(env, 'usdt_rate_auto')) || 0;
  const at = Date.parse((await getSetting(env, 'usdt_rate_auto_at')) || '') || 0;
  if (cached > 0 && Date.now() - at < RATE_TTL_MS) return;
  if (cached > 0) {
    c.executionCtx.waitUntil(fetchAutoRate(env));
    return;
  }
  await fetchAutoRate(env);
}

function bolivaresFromUsd(usd, rate) {
  const amount = Number(usd);
  const dayRate = Number(rate);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(dayRate) || dayRate <= 0) return null;
  return Math.ceil((amount * dayRate * (1 + RATE_MARGIN)) / RATE_ROUND_TO) * RATE_ROUND_TO;
}

// ---------------------------------------------------------------- páginas
function siteBase(c) {
  const configured = (c.env.BASE_URL || '').replace(/\/+$/, '');
  return configured || new URL(c.req.url).origin;
}

async function renderIndex(c) {
  const response = await c.env.ASSETS.fetch(new URL('/', c.req.url));
  const html = (await response.text()).split('{{BASE_URL}}').join(siteBase(c));
  return c.html(html);
}

app.get('/', renderIndex);
app.get('/index.html', renderIndex);
for (const path of ['/admin', '/admin/', '/admin/index.html']) {
  app.get(path, async (c) => {
    const response = await renderIndex(c);
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return response;
  });
}

app.get('/kiosc', (c) => c.redirect('/kiosc/', 301));
app.get('/kiosc/', async (c) => {
  const asset = await c.env.ASSETS.fetch(new URL('/kiosc/', c.req.url));
  const response = new Response(asset.body, asset);
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  response.headers.set('Cache-Control', 'no-cache');
  return response;
});

app.get('/robots.txt', (c) => c.text(
  `User-agent: *\nDisallow: /admin\nDisallow: /kiosc\n\nSitemap: ${siteBase(c)}/sitemap.xml\n`
));

app.get('/sitemap.xml', (c) => {
  c.header('Content-Type', 'application/xml');
  return c.body(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `  <url><loc>${siteBase(c)}/</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>\n` +
    `</urlset>\n`
  );
});

// ---------------------------------------------------------------- login
app.post('/api/login', async (c) => {
  const env = c.env;
  const key = 'login:' + clientIp(c);
  const recent = await all(env, 'SELECT at FROM hits WHERE key = ? AND at > ? ORDER BY at DESC LIMIT ?',
    key, Date.now() - LOCKOUT_MS, MAX_LOGIN_ATTEMPTS);
  if (recent.length >= MAX_LOGIN_ATTEMPTS) {
    const unlockAt = recent[recent.length - 1].at + LOCKOUT_MS;
    const remaining = Math.max(1, Math.ceil((unlockAt - Date.now()) / 60000));
    return json(c, { error: `Demasiados intentos. Intenta de nuevo en ${remaining} min.` }, 429);
  }
  const { password } = await body(c);
  if (!env.ADMIN_PASSWORD) {
    return json(c, { error: 'Falta configurar la contraseña del panel (ADMIN_PASSWORD).' }, 500);
  }
  if (!password || !safeEqual(password, env.ADMIN_PASSWORD)) {
    await recordHit(env, key);
    return json(c, { error: 'Contraseña incorrecta.' }, 401);
  }
  await run(env, 'DELETE FROM hits WHERE key = ?', key);
  return json(c, { token: signToken(env, { role: 'admin' }) });
});

// ---------------------------------------------------------------- agenda
function slotLabel(time) {
  const hour = Number(time.slice(0, 2));
  return `${hour % 12 || 12}:${time.slice(3)} ${hour < 12 ? 'AM' : 'PM'}`;
}

// Horas ofrecidas ese día, en hora de Caracas (null si la fecha es inválida,
// vacío si es domingo, pasada o fuera de la ventana de reservas).
function slotsForDate(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString || '')) return null;
  const day = new Date(dateString + 'T12:00:00Z');
  if (Number.isNaN(day.getTime()) || isoDate(day) !== dateString) return null;
  const now = caracasNow();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
  const diffDays = Math.round((day - today) / 86400000);
  if (diffDays < 0 || diffDays > BOOKING_WINDOW_DAYS) return [];
  const weekday = day.getUTCDay();
  if (weekday === 0) return [];
  const slots = weekday === 6 ? SATURDAY_SLOTS : WEEKDAY_SLOTS;
  if (diffDays > 0) return slots;
  const current = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  return slots.filter((time) => time > current);
}

app.get('/api/availability', async (c) => {
  const date = String(c.req.query('date') || '');
  const offered = slotsForDate(date);
  if (offered === null) return json(c, { error: 'La fecha no es válida.' }, 400);
  const taken = new Set((await all(c.env,
    `SELECT appt_time FROM appointments WHERE appt_date = ? AND status IN ('booked', 'done')`, date
  )).map((row) => row.appt_time));
  return json(c, {
    date,
    open: offered.length > 0,
    slots: offered.map((time) => ({ time, label: slotLabel(time), free: !taken.has(time) }))
  });
});

app.post('/api/appointments', async (c) => {
  const env = c.env;
  const input = await body(c);
  const name = String(input.name || '').trim().slice(0, 120);
  const phone = normalizePhone(input.phone).slice(0, 20);
  const service = String(input.service || '').trim().slice(0, 120);
  const date = String(input.date || '');
  const time = String(input.time || '');
  if (!name || !service) return json(c, { error: 'Faltan datos de la reserva.' }, 400);
  if (phone.length < 10) return json(c, { error: 'El teléfono no es válido.' }, 400);
  const limitKeys = ['book:phone:' + phone, 'book:ip:' + clientIp(c)];
  for (const key of limitKeys) {
    if (await countHits(env, key, 60 * 60 * 1000) >= BOOKING_LIMIT_PER_HOUR) {
      return json(c, { error: 'Demasiadas solicitudes. Escríbenos por WhatsApp.' }, 429);
    }
  }
  await env.DB.batch(limitKeys.map((key) => stmt(env, 'INSERT INTO hits (key, at) VALUES (?, ?)', [key, Date.now()])));
  const offered = slotsForDate(date);
  if (!offered || !offered.includes(time)) {
    return json(c, { error: 'Esa fecha u hora no está disponible.' }, 400);
  }
  try {
    const result = await run(env, `INSERT INTO appointments (client_name, client_phone, service, appt_date, appt_time)
      VALUES (?, ?, ?, ?, ?)`, name, phone, service, date, time);
    return json(c, { id: lastId(result), date, time, label: slotLabel(time) }, 201);
  } catch (error) {
    if (isUnique(error)) return json(c, { error: 'Esa hora acaba de ser reservada. Elige otra.' }, 409);
    throw error;
  }
});

app.get('/api/appointments', requireAuth, async (c) => {
  const rows = await all(c.env, `SELECT * FROM appointments
    WHERE appt_date >= date('now', ${TZ}, '-1 day') AND status != 'cancelled'
    ORDER BY appt_date, appt_time`);
  return json(c, rows.map((row) => ({ ...row, label: slotLabel(row.appt_time) })));
});

app.put('/api/appointments/:id/status', requireAuth, async (c) => {
  const { status } = await body(c);
  if (!['booked', 'done', 'cancelled', 'no_show'].includes(String(status))) {
    return json(c, { error: 'Estado no válido.' }, 400);
  }
  try {
    const result = await run(c.env, 'UPDATE appointments SET status = ? WHERE id = ?', status, c.req.param('id'));
    if (!changes(result)) return json(c, { error: 'Cita no encontrada.' }, 404);
    return json(c, { ok: true });
  } catch (error) {
    if (isUnique(error)) return json(c, { error: 'Esa hora ya está ocupada por otra cita.' }, 409);
    throw error;
  }
});

// En la nube no hay red local: el panel usa directamente la dirección pública.
app.get('/api/lan-urls', requireAuth, (c) => json(c, { exposed: true, urls: [new URL(c.req.url).origin] }));

app.get('/api/health', (c) => json(c, { ok: true, database: 'd1' }));

// ---------------------------------------------------------------- tasa
app.get('/api/rate', async (c) => {
  await ensureAutoRate(c);
  const info = await currentRate(c.env);
  const usd = c.req.query('usd');
  if (usd !== undefined) {
    info.usd = Number(usd);
    info.bolivares = bolivaresFromUsd(usd, info.rate);
  }
  return json(c, info);
});

app.put('/api/rate', requireAuth, async (c) => {
  const rate = Number((await body(c)).rate);
  if (!Number.isFinite(rate) || rate < 0) return json(c, { error: 'La tasa no es válida.' }, 400);
  await setSetting(c.env, 'usdt_rate', rate);
  if (rate === 0) await fetchAutoRate(c.env);
  return json(c, await currentRate(c.env));
});

app.post('/api/rate/refresh', requireAuth, async (c) => {
  await fetchAutoRate(c.env);
  return json(c, await currentRate(c.env));
});

// ---------------------------------------------------------------- clientes
const getClient = (env, id) => first(env, 'SELECT * FROM clients WHERE id = ?', id);

app.get('/api/reminders/pending', requireAuth, async (c) => json(c, await all(c.env,
  `SELECT *, date(last_cut_date, '+15 days') AS next_reminder_date
   FROM clients WHERE date(last_cut_date, '+15 days') <= date('now', ${TZ})
   ORDER BY next_reminder_date, name COLLATE NOCASE`)));

app.get('/api/clients', requireAuth, async (c) => json(c, await all(c.env, `
  SELECT clients.*,
    date(last_cut_date, '+15 days') AS next_reminder_date,
    CASE WHEN date(last_cut_date, '+15 days') <= date('now', ${TZ}) THEN 1 ELSE 0 END AS reminder_pending,
    (SELECT sides_machine FROM haircut_preferences WHERE client_id = clients.id ORDER BY created_at DESC LIMIT 1) AS sides_machine,
    (SELECT top_finish FROM haircut_preferences WHERE client_id = clients.id ORDER BY created_at DESC LIMIT 1) AS top_finish
  FROM clients
  ORDER BY reminder_pending DESC, name COLLATE NOCASE`)));

function invalidClient(c, payload) {
  const missingFields = requireFields(payload, ['name', 'phone', 'last_cut_date', 'last_service']);
  if (missingFields.length) return json(c, { error: `Faltan campos: ${missingFields.join(', ')}` }, 400);
  if (payload.phone.length < 10) return json(c, { error: 'El teléfono no es válido.' }, 400);
  if (!validDate(payload.last_cut_date, false) || !validDate(payload.birth_date, true)) {
    return json(c, { error: 'Una de las fechas no es válida.' }, 400);
  }
  return null;
}

app.post('/api/clients', requireAuth, async (c) => {
  const payload = clientPayload(await body(c));
  const invalid = invalidClient(c, payload);
  if (invalid) return invalid;
  try {
    const result = await run(c.env, `INSERT INTO clients (name, phone, birth_date, last_cut_date, last_service)
      VALUES (?, ?, ?, ?, ?)`, payload.name, payload.phone, payload.birth_date, payload.last_cut_date, payload.last_service);
    return json(c, await getClient(c.env, lastId(result)), 201);
  } catch (error) {
    return json(c, { error: 'Ese teléfono ya está registrado.' }, 409);
  }
});

app.put('/api/clients/:id', requireAuth, async (c) => {
  const payload = clientPayload(await body(c));
  const invalid = invalidClient(c, payload);
  if (invalid) return invalid;
  const id = c.req.param('id');
  try {
    const result = await run(c.env, `UPDATE clients SET name = ?, phone = ?, birth_date = ?,
      last_cut_date = ?, last_service = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    payload.name, payload.phone, payload.birth_date, payload.last_cut_date, payload.last_service, id);
    if (!changes(result)) return json(c, { error: 'Cliente no encontrado.' }, 404);
    return json(c, await getClient(c.env, id));
  } catch (error) {
    return json(c, { error: 'Ese teléfono ya está registrado.' }, 409);
  }
});

app.delete('/api/clients/:id', requireAuth, async (c) => {
  try {
    const result = await run(c.env, 'DELETE FROM clients WHERE id = ?', c.req.param('id'));
    if (!changes(result)) return json(c, { error: 'Cliente no encontrado.' }, 404);
    return c.body(null, 204);
  } catch (error) {
    if (isForeignKey(error)) return json(c, { error: 'No se pudo eliminar: tiene registros relacionados.' }, 409);
    throw error;
  }
});

app.post('/api/backup/import', requireAuth, async (c) => {
  const input = await body(c);
  if (!Array.isArray(input.clients)) return json(c, { error: 'El respaldo no tiene un formato válido.' }, 400);
  const validClients = input.clients.map(clientPayload).filter((client) => (
    client.name && client.phone.length >= 10 && client.last_cut_date && client.last_service
  ));
  if (!validClients.length) return json(c, { imported: 0 });
  try {
    await c.env.DB.batch(validClients.map((client) => stmt(c.env, `INSERT INTO clients
      (name, phone, birth_date, last_cut_date, last_service) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET name = excluded.name, birth_date = excluded.birth_date,
      last_cut_date = excluded.last_cut_date, last_service = excluded.last_service, updated_at = CURRENT_TIMESTAMP`,
    [client.name, client.phone, client.birth_date, client.last_cut_date, client.last_service])));
    return json(c, { imported: validClients.length });
  } catch (error) {
    return json(c, { error: 'No se pudo importar el respaldo.' }, 400);
  }
});

app.post('/api/clients/:id/preferences', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!(await getClient(c.env, id))) return json(c, { error: 'Cliente no encontrado.' }, 404);
  const input = await body(c);
  if (requireFields(input, ['sides_machine']).length) return json(c, { error: 'Indica las medidas utilizadas.' }, 400);
  const result = await run(c.env, 'INSERT INTO haircut_preferences (client_id, sides_machine, top_finish) VALUES (?, ?, ?)',
    id, String(input.sides_machine || '').trim(), input.top_finish ? String(input.top_finish).trim() : null);
  return json(c, await first(c.env, 'SELECT * FROM haircut_preferences WHERE id = ?', lastId(result)), 201);
});

// ---------------------------------------------------------------- estilos
app.get('/api/styles', async (c) => json(c, await all(c.env, 'SELECT * FROM styles WHERE active = 1 ORDER BY category, name')));

function invalidStyle(c, input) {
  const missingFields = requireFields(input, ['name', 'category']);
  if (missingFields.length) return json(c, { error: `Faltan campos: ${missingFields.join(', ')}` }, 400);
  if (!['cortes', 'barba', 'combos'].includes(input.category)) return json(c, { error: 'Categoría inválida.' }, 400);
  return null;
}

app.post('/api/styles', requireAuth, async (c) => {
  const input = await body(c);
  const invalid = invalidStyle(c, input);
  if (invalid) return invalid;
  const result = await run(c.env, 'INSERT INTO styles (name, category, image_url) VALUES (?, ?, ?)',
    String(input.name).trim(), input.category, input.image_url || null);
  return json(c, await first(c.env, 'SELECT * FROM styles WHERE id = ?', lastId(result)), 201);
});

app.put('/api/styles/:id', requireAuth, async (c) => {
  const input = await body(c);
  const invalid = invalidStyle(c, input);
  if (invalid) return invalid;
  const id = c.req.param('id');
  const result = await run(c.env, `UPDATE styles SET name = ?, category = ?, image_url = ?, active = ?,
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  String(input.name).trim(), input.category, input.image_url || null,
  input.active === 0 || input.active === false ? 0 : 1, id);
  if (!changes(result)) return json(c, { error: 'Estilo no encontrado.' }, 404);
  return json(c, await first(c.env, 'SELECT * FROM styles WHERE id = ?', id));
});

app.delete('/api/styles/:id', requireAuth, async (c) => {
  const result = await run(c.env, 'DELETE FROM styles WHERE id = ?', c.req.param('id'));
  if (!changes(result)) return json(c, { error: 'Estilo no encontrado.' }, 404);
  return c.body(null, 204);
});

app.put('/api/clients/:clientId/style', requireAuth, async (c) => {
  const client = await getClient(c.env, c.req.param('clientId'));
  const style = await first(c.env, 'SELECT id FROM styles WHERE id = ? AND active = 1', (await body(c)).style_id);
  if (!client || !style) return json(c, { error: 'Cliente o estilo no encontrado.' }, 404);
  await run(c.env, 'INSERT OR REPLACE INTO client_styles (client_id, style_id) VALUES (?, ?)', client.id, style.id);
  return c.body(null, 204);
});

app.get('/api/birthdays/current', requireAuth, async (c) => json(c, await all(c.env,
  `SELECT * FROM clients WHERE birth_date IS NOT NULL
   AND strftime('%m', birth_date) = strftime('%m', 'now', ${TZ}) ORDER BY strftime('%d', birth_date), name`)));

// ---------------------------------------------------------------- caja
app.get('/api/cash/:date', requireAuth, async (c) => {
  const date = c.req.param('date');
  if (!validDate(date, false)) return json(c, { error: 'Fecha inválida.' }, 400);
  const closure = await first(c.env, 'SELECT * FROM cash_closures WHERE closure_date = ?', date);
  return json(c, closure || { closure_date: date, gross_income_cents: 0, tips_cents: 0, notes: '' });
});

app.put('/api/cash/:date', requireAuth, async (c) => {
  const date = c.req.param('date');
  if (!validDate(date, false)) return json(c, { error: 'Fecha inválida.' }, 400);
  const input = await body(c);
  if (requireFields(input, ['gross_income_cents', 'tips_cents']).length) {
    return json(c, { error: 'Indica ingresos y propinas.' }, 400);
  }
  const grossIncome = Number(input.gross_income_cents);
  const tips = Number(input.tips_cents);
  if (!Number.isFinite(grossIncome) || !Number.isFinite(tips) || grossIncome < 0 || tips < 0) {
    return json(c, { error: 'Los montos de caja no son válidos.' }, 400);
  }
  if (tips > grossIncome) return json(c, { error: 'Las propinas no pueden superar los ingresos.' }, 400);
  await run(c.env, `INSERT INTO cash_closures (closure_date, gross_income_cents, tips_cents, notes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(closure_date) DO UPDATE SET gross_income_cents = excluded.gross_income_cents,
    tips_cents = excluded.tips_cents, notes = excluded.notes, updated_at = CURRENT_TIMESTAMP`,
  date, Math.round(grossIncome), Math.round(tips), input.notes ? String(input.notes).trim() : null);
  return json(c, await first(c.env, 'SELECT * FROM cash_closures WHERE closure_date = ?', date));
});

app.get('/api/dashboard', requireAuth, async (c) => json(c, await first(c.env, `SELECT
  COUNT(*) AS total_clients,
  SUM(CASE WHEN date(last_cut_date, '+15 days') <= date('now', ${TZ}) THEN 1 ELSE 0 END) AS pending_reminders
  FROM clients`)));

// ====================================================================
//  KIOSCO DE TURNOS
// ====================================================================
async function pagoMovilMethods(env, includeEmpty) {
  const raw = await getSetting(env, 'pm_methods');
  if (raw) {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        return list
          .filter((m) => m && (includeEmpty || m.phone || m.id))
          .map((m) => ({
            bank: String(m.bank || ''),
            code: String(m.code || ''),
            phone: String(m.phone || ''),
            id: String(m.id || ''),
            qr: m.qr ? String(m.qr) : null
          }));
      }
    } catch (error) { /* cae al formato antiguo */ }
  }
  const [bank, phone, id, qr] = await Promise.all(['pm_bank', 'pm_phone', 'pm_id', 'pm_qr'].map((k) => getSetting(env, k)));
  const legacy = { bank: bank || '', code: '', phone: phone || '', id: id || '', qr: qr || null };
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

const orderById = (env, id) => first(env, 'SELECT * FROM orders WHERE id = ?', id);
const orderByCode = (env, code) => first(env, 'SELECT * FROM orders WHERE code = ?', code);
const eventStmt = (env, orderId, type, actor, note, meta) => stmt(env,
  'INSERT INTO payment_events (order_id, type, actor, note, meta_json) VALUES (?, ?, ?, ?, ?)',
  [orderId, type, actor, note, meta]);

// Órdenes sin pagar caducan a los 15 min. Sin temporizadores en un Worker,
// se revisa al consultar órdenes y también desde el cron.
async function expireStaleOrders(env) {
  const stale = await all(env, `SELECT id FROM orders WHERE payment_status = 'awaiting_payment'
    AND created_at <= datetime('now', ?)`, `-${ORDER_TTL_MIN} minutes`);
  if (!stale.length) return;
  await env.DB.batch(stale.flatMap((o) => [
    stmt(env, "UPDATE orders SET payment_status = 'expired' WHERE id = ? AND payment_status = 'awaiting_payment'", [o.id]),
    eventStmt(env, o.id, 'expired', 'system', null, null)
  ]));
}

const requireDevice = async (c, next) => {
  // Solo por cabecera: un token en la query string acaba en logs y en Referer.
  const token = c.req.header('X-Kiosc-Token') || '';
  const device = token && await first(c.env, 'SELECT * FROM kiosc_devices WHERE token_hash = ? AND active = 1', sha256(token));
  if (!device) return json(c, { error: 'Kiosco no autorizado. Registra el dispositivo.' }, 401);
  c.executionCtx.waitUntil(run(c.env, 'UPDATE kiosc_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?', device.id));
  c.set('device', device);
  await next();
};

app.get('/api/kiosc/menu', requireDevice, async (c) => {
  await ensureAutoRate(c);
  const rate = await currentRate(c.env);
  const services = (await all(c.env,
    'SELECT id, name, description, category, price_usd_cents, duration_min FROM services WHERE active = 1 ORDER BY sort_order, name'
  )).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    category: s.category,
    duration_min: s.duration_min,
    amount_usd_cents: s.price_usd_cents,
    amount_bs: bolivaresFromUsd(s.price_usd_cents / 100, rate.rate)
  }));
  return json(c, {
    services,
    rate: { value: rate.rate, source: rate.source },
    pago_movil: await pagoMovilMethods(c.env)
  });
});

app.post('/api/kiosc/orders', requireDevice, async (c) => {
  const env = c.env;
  const device = c.get('device');
  const input = await body(c);
  const name = String(input.name || '').trim().slice(0, 80);
  const phone = normalizePhone(input.phone).slice(0, 20);
  const serviceId = Number(input.service_id);
  if (!name || phone.length < 10 || !serviceId) {
    return json(c, { error: 'Faltan datos: nombre, teléfono o servicio.' }, 400);
  }
  await expireStaleOrders(env);
  // una sola orden activa por teléfono
  const active = await first(env, `SELECT code FROM orders
    WHERE client_phone = ? AND (payment_status IN ('awaiting_payment','submitted')
      OR queue_status IN ('waiting','in_service'))
    ORDER BY id DESC LIMIT 1`, phone);
  if (active) return json(c, { error: 'Ya tienes una orden en curso (' + active.code + ').' }, 409);

  const svc = await first(env, 'SELECT * FROM services WHERE id = ? AND active = 1', serviceId);
  if (!svc) return json(c, { error: 'Servicio no disponible.' }, 404);
  await ensureAutoRate(c);
  const rate = await currentRate(env);
  const amountBs = bolivaresFromUsd(svc.price_usd_cents / 100, rate.rate);
  if (amountBs === null) return json(c, { error: 'No hay tasa configurada. Avisa a recepción.' }, 503);

  // Todo en un batch (atómico): cliente, orden, código y evento. last_insert_rowid()
  // es fiable dentro del batch porque corre en una sola conexión y en orden.
  const results = await env.DB.batch([
    stmt(env, `INSERT INTO clients (name, phone, last_cut_date, last_service)
      VALUES (?, ?, date('now', ${TZ}), ?)
      ON CONFLICT(phone) DO UPDATE SET name = excluded.name, updated_at = CURRENT_TIMESTAMP`, [name, phone, svc.name]),
    stmt(env, `INSERT INTO orders
      (client_id, client_name, client_phone, service_id, service_name, amount_bs, amount_usd_cents, rate_used, device_id)
      VALUES ((SELECT id FROM clients WHERE phone = ?), ?, ?, ?, ?, ?, ?, ?, ?)`,
    [phone, name, phone, svc.id, svc.name, amountBs, svc.price_usd_cents, rate.rate, device.id]),
    stmt(env, "UPDATE orders SET code = 'A-' || printf('%03d', id) WHERE id = last_insert_rowid()"),
    stmt(env, `INSERT INTO payment_events (order_id, type, actor, note, meta_json)
      VALUES (last_insert_rowid(), 'created', ?, NULL, ?)`,
    ['kiosc:' + device.label, JSON.stringify({ amount_bs: amountBs, rate: rate.rate })]),
    stmt(env, 'SELECT * FROM orders WHERE client_phone = ? ORDER BY id DESC LIMIT 1', [phone])
  ]);
  const order = results[4].results[0];
  return json(c, {
    code: order.code,
    amount_bs: order.amount_bs,
    amount_usd_cents: order.amount_usd_cents,
    service_name: order.service_name,
    pago_movil: await pagoMovilMethods(env)
  }, 201);
});

app.post('/api/kiosc/orders/:code/payment', requireDevice, async (c) => {
  const env = c.env;
  const device = c.get('device');
  const order = await orderByCode(env, c.req.param('code'));
  if (!order || order.device_id !== device.id) return json(c, { error: 'Orden no encontrada.' }, 404);
  if (!['awaiting_payment', 'rejected'].includes(order.payment_status)) {
    return json(c, { error: 'La orden ya no admite pago.' }, 409);
  }
  // Referencia opcional: el admin valida viendo el ingreso en su banca.
  // (Esta versión no guarda fotos de comprobante.)
  const refRaw = String((await body(c)).reference || '').replace(/\s+/g, '').slice(0, 20);
  const reference = refRaw.length >= 4 ? refRaw : null;
  try {
    const result = await run(env, `UPDATE orders SET
        payment_status = 'submitted', payment_reference = ?, payment_proof_path = NULL,
        payment_proof_sha = NULL, reject_reason = NULL, submitted_at = CURRENT_TIMESTAMP
      WHERE id = ? AND payment_status IN ('awaiting_payment','rejected')`, reference, order.id);
    if (!changes(result)) return json(c, { error: 'La orden ya no admite pago.' }, 409);
  } catch (error) {
    if (isUnique(error)) return json(c, { error: 'Esa referencia ya está registrada en otra orden.' }, 409);
    throw error;
  }
  await eventStmt(env, order.id, 'submitted', 'kiosc:' + device.label, null, JSON.stringify({ reference })).run();
  return json(c, publicView(await orderById(env, order.id)));
});

app.get('/api/kiosc/orders/:code', requireDevice, async (c) => {
  await expireStaleOrders(c.env);
  const order = await orderByCode(c.env, c.req.param('code'));
  if (!order) return json(c, { error: 'Orden no encontrada.' }, 404);
  return json(c, publicView(order));
});

// ---------------------------------------------------------------- tablero (admin)
app.get('/api/orders', requireAuth, async (c) => {
  await expireStaleOrders(c.env);
  return json(c, await all(c.env, `
    SELECT id, code, client_name, client_phone, service_name, amount_bs, amount_usd_cents,
           payment_status, payment_reference,
           (payment_proof_path IS NOT NULL) AS has_proof,
           queue_status, queue_no, reject_reason,
           created_at, submitted_at, paid_at, called_at, done_at,
           (SELECT COUNT(*) FROM orders o2
              WHERE o2.payment_proof_sha = orders.payment_proof_sha
                AND o2.payment_proof_sha IS NOT NULL AND o2.id <> orders.id) AS proof_reused
    FROM orders
    WHERE date(created_at, ${TZ}) = date('now', ${TZ})
      AND payment_status <> 'expired'
    ORDER BY
      CASE payment_status WHEN 'submitted' THEN 0 WHEN 'validated' THEN 1 ELSE 2 END,
      CASE queue_status WHEN 'in_service' THEN 0 WHEN 'waiting' THEN 1 ELSE 3 END,
      queue_no, created_at`));
});

app.get('/api/orders/history', requireAuth, async (c) => {
  const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 90);
  return json(c, await all(c.env, `
    SELECT date(done_at, ${TZ}) AS date, COUNT(*) AS cuts, SUM(amount_bs) AS revenue_bs
    FROM orders WHERE queue_status = 'done'
    GROUP BY date(done_at, ${TZ}) ORDER BY date DESC LIMIT ?`, days));
});

app.post('/api/orders/:id/validate', requireAuth, async (c) => {
  const env = c.env;
  const id = Number(c.req.param('id'));
  const order = await orderById(env, id);
  if (!order) return json(c, { error: 'Orden no encontrada.' }, 404);
  if (order.payment_status === 'validated') return json(c, cardView(order)); // idempotente
  if (order.payment_status !== 'submitted') return json(c, { error: 'La orden no está esperando validación.' }, 409);
  const results = await env.DB.batch([
    stmt(env, `UPDATE orders SET
        payment_status = 'validated', queue_status = 'waiting',
        queue_no = (SELECT COALESCE(MAX(queue_no), 0) + 1 FROM orders
                    WHERE date(created_at, ${TZ}) = date('now', ${TZ})),
        validated_by = 'admin', paid_at = CURRENT_TIMESTAMP
      WHERE id = ? AND payment_status = 'submitted'`, [id]),
    stmt(env, 'SELECT * FROM orders WHERE id = ?', [id])
  ]);
  if (!changes(results[0])) return json(c, { error: 'La orden no está esperando validación.' }, 409);
  const fresh = results[1].results[0];
  await eventStmt(env, id, 'validated', 'admin', null,
    JSON.stringify({ queue_no: fresh.queue_no, reference: fresh.payment_reference })).run();
  return json(c, cardView(fresh));
});

app.post('/api/orders/:id/reject', requireAuth, async (c) => {
  const id = c.req.param('id');
  const reason = String((await body(c)).reason || '').trim().slice(0, 200) || 'Sin especificar';
  const result = await run(c.env, `UPDATE orders SET payment_status = 'rejected', reject_reason = ?
    WHERE id = ? AND payment_status IN ('submitted','awaiting_payment')`, reason, id);
  if (!changes(result)) return json(c, { error: 'No se puede rechazar en este estado.' }, 409);
  await eventStmt(c.env, id, 'rejected', 'admin', reason, null).run();
  return c.body(null, 204);
});

// avanzar la cola: call | done | no-show
const QUEUE_MOVES = {
  call: { from: ['waiting'], to: 'in_service', stamp: 'called_at' },
  done: { from: ['in_service'], to: 'done', stamp: 'done_at' },
  'no-show': { from: ['waiting', 'in_service'], to: 'no_show', stamp: 'done_at' }
};
for (const [action, move] of Object.entries(QUEUE_MOVES)) {
  app.post('/api/orders/:id/' + action, requireAuth, async (c) => {
    const env = c.env;
    const id = c.req.param('id');
    const placeholders = move.from.map(() => '?').join(',');
    const result = await run(env, `UPDATE orders SET queue_status = ?, ${move.stamp} = CURRENT_TIMESTAMP
      WHERE id = ? AND queue_status IN (${placeholders})`, move.to, id, ...move.from);
    if (!changes(result)) return json(c, { error: 'La orden no está en ese punto de la cola.' }, 409);
    await eventStmt(env, id, move.to, 'admin', null, null).run();
    const order = await orderById(env, id);
    // El corte cuenta como hecho al terminar: se refresca la ficha del cliente.
    if (action === 'done' && order && order.client_id) {
      await run(env, `UPDATE clients SET last_cut_date = date('now', ${TZ}),
        last_service = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, order.service_name, order.client_id);
    }
    return json(c, cardView(order));
  });
}

app.get('/api/orders/:id/proof', requireAuth, (c) => c.body(null, 404));

// ---- datos de Pago Móvil (admin) ----
app.get('/api/kiosc/pago-movil', requireAuth, async (c) => json(c, await pagoMovilMethods(c.env, true)));

app.put('/api/kiosc/pago-movil', requireAuth, async (c) => {
  const list = (await body(c)).methods || [];
  if (!Array.isArray(list)) return json(c, { error: 'Formato inválido.' }, 400);
  const clean = list
    .map((m) => ({
      bank: String((m && m.bank) || '').trim().slice(0, 60),
      code: String((m && m.code) || '').trim().slice(0, 8),
      phone: String((m && m.phone) || '').trim().slice(0, 20),
      id: String((m && m.id) || '').trim().slice(0, 20),
      qr: m && m.qr ? String(m.qr).trim().slice(0, 200) : ''
    }))
    .filter((m) => m.bank || m.phone || m.id);
  await setSetting(c.env, 'pm_methods', JSON.stringify(clean));
  return json(c, await pagoMovilMethods(c.env));
});

// ---- dispositivos (admin) ----
app.post('/api/kiosc/devices', requireAuth, async (c) => {
  const label = String((await body(c)).label || '').trim().slice(0, 60) || 'Tablet';
  const token = randomBytes(24).toString('base64url');
  await run(c.env, 'INSERT INTO kiosc_devices (label, token_hash) VALUES (?, ?)', label, sha256(token));
  return json(c, { label, token }, 201); // el token en claro se muestra UNA sola vez
});

app.get('/api/kiosc/devices', requireAuth, async (c) => json(c, await all(c.env,
  'SELECT id, label, active, last_seen_at, created_at FROM kiosc_devices WHERE active = 1 ORDER BY id')));

app.delete('/api/kiosc/devices/:id', requireAuth, async (c) => {
  const result = await run(c.env, 'UPDATE kiosc_devices SET active = 0 WHERE id = ?', c.req.param('id'));
  return c.body(null, changes(result) ? 204 : 404);
});

// ---- tablero en vivo: sin SSE, el panel consulta cada pocos segundos ----
app.post('/api/stream-token', requireAuth, (c) => json(c, { poll: true, interval: POLL_INTERVAL_MS }));
app.get('/api/stream', (c) => json(c, { error: 'Esta versión usa consultas periódicas en lugar de SSE.' }, 410));

// ---------------------------------------------------------------- errores
app.notFound((c) => {
  if (new URL(c.req.url).pathname.startsWith('/api/')) return json(c, { error: 'Ruta no encontrada.' }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  console.error('Error no controlado:', error);
  return json(c, { error: 'Error interno del servidor.' }, 500);
});

// ---------------------------------------------------------------- cron
async function scheduled(event, env, ctx) {
  ctx.waitUntil((async () => {
    if (!((Number(await getSetting(env, 'usdt_rate')) || 0) > 0)) await fetchAutoRate(env);
    await expireStaleOrders(env);
    await run(env, 'DELETE FROM hits WHERE at < ?', Date.now() - 2 * 24 * 60 * 60 * 1000);
  })());
}

export default { fetch: app.fetch, scheduled };
