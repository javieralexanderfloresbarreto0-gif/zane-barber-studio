const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const port = Number(process.env.PORT) || 3000;
const dataDirectory = path.join(__dirname, 'data');
const databasePath = path.join(dataDirectory, 'zane.sqlite');
const tokenSecretPath = path.join(dataDirectory, 'token.secret');
const adminPasswordPath = path.join(dataDirectory, 'admin_password.secret');

fs.mkdirSync(dataDirectory, { recursive: true });

// Ya no existe un password por defecto adivinable. Si no se define
// ADMIN_PASSWORD por entorno, se genera uno fuerte una sola vez y se
// guarda localmente (igual que TOKEN_SECRET), mostrándolo por consola
// para que el administrador lo copie y lo guarde en un gestor de claves.
function loadAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (fs.existsSync(adminPasswordPath)) return fs.readFileSync(adminPasswordPath, 'utf8').trim();
  const generated = crypto.randomBytes(12).toString('base64url');
  fs.writeFileSync(adminPasswordPath, generated, { mode: 0o600 });
  console.warn('\n[ZANE] No se definió ADMIN_PASSWORD. Se generó uno nuevo:');
  console.warn(`[ZANE] Password de administrador: ${generated}`);
  console.warn('[ZANE] Guárdalo ahora; no se volverá a mostrar en texto plano.\n');
  return generated;
}

const ADMIN_PASSWORD = loadAdminPassword();

const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function loadTokenSecret() {
  if (process.env.TOKEN_SECRET) return process.env.TOKEN_SECRET;
  if (fs.existsSync(tokenSecretPath)) return fs.readFileSync(tokenSecretPath, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenSecretPath, secret, { mode: 0o600 });
  return secret;
}

const TOKEN_SECRET = loadTokenSecret();
const database = new Database(databasePath);
database.pragma('foreign_keys = ON');
database.exec(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));
database.exec(fs.readFileSync(path.join(__dirname, 'db', 'seed.sql'), 'utf8'));

app.use(express.json({ limit: '1mb' }));
app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('X-XSS-Protection', '1; mode=block');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/js', express.static(path.join(__dirname, 'js')));
app.use('/images', express.static(path.join(__dirname, 'images')));

app.use((request, response, next) => {
  const blocked = ['/data', '/db', '/node_modules'];
  if (blocked.some((prefix) => request.path.startsWith(prefix))) {
    return response.status(403).json({ error: 'Acceso denegado.' });
  }
  next();
});

app.get(['/', '/index.html'], (request, response) => {
  response.sendFile(path.join(__dirname, 'index.html'));
});

app.get(['/admin', '/admin/', '/admin/index.html'], (request, response) => {
  response.sendFile(path.join(__dirname, 'index.html'));
});

function requireFields(body, fields) {
  return fields.filter((field) => body[field] !== 0 && !body[field]);
}

function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('58') && digits.length >= 12) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return '58' + digits.slice(1);
  if (digits.length === 10 && (digits.startsWith('4') || digits.startsWith('2'))) return '58' + digits;
  return digits;
}

function clientPayload(body) {
  return {
    name: String(body.name || '').trim().slice(0, 120),
    phone: normalizePhone(body.phone).slice(0, 20),
    birth_date: body.birth_date || null,
    last_cut_date: body.last_cut_date,
    last_service: String(body.last_service || '').trim().slice(0, 120)
  };
}

function validDate(dateString, allowNull) {
  if (!dateString) return allowNull;
  return /^\d{4}-\d{2}-\d{2}$/.test(dateString);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    crypto.timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 12 * 60 * 60 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + signature;
}

function verifyToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (error) {
    return null;
  }
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(parts[0] + '.' + parts[1]).digest('base64url');
  if (!safeEqual(expected, parts[2]) || payload.exp < Date.now()) return null;
  return payload;
}

function requireAuth(request, response, next) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || !verifyToken(token)) return response.status(401).json({ error: 'No autorizado. Inicia sesión nuevamente.' });
  next();
}

function getClient(clientId) {
  return database.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
}

app.post('/api/login', (request, response) => {
  const ip = request.ip || request.connection.remoteAddress;
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (record && record.lockedUntil > now) {
    const remaining = Math.ceil((record.lockedUntil - now) / 60000);
    return response.status(429).json({ error: `Demasiados intentos. Intenta de nuevo en ${remaining} min.` });
  }
  const password = request.body && request.body.password;
  if (!password || !safeEqual(password, ADMIN_PASSWORD)) {
    const attempts = (record ? record.count : 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      loginAttempts.set(ip, { count: 0, lockedUntil: now + LOCKOUT_MS });
    } else {
      loginAttempts.set(ip, { count: attempts, lockedUntil: 0 });
    }
    return response.status(401).json({ error: 'Contraseña incorrecta.' });
  }
  loginAttempts.delete(ip);
  response.json({ token: signToken({ role: 'admin' }) });
});

app.get('/api/health', (request, response) => {
  response.json({ ok: true, database: 'sqlite' });
});

app.get('/api/reminders/pending', requireAuth, (request, response) => {
  const pendingClients = database.prepare(`SELECT *, date(last_cut_date, '+15 days') AS next_reminder_date
    FROM clients WHERE date(last_cut_date, '+15 days') <= date('now', 'localtime')
    ORDER BY next_reminder_date, name COLLATE NOCASE`).all();
  response.json(pendingClients);
});

app.get('/api/clients', requireAuth, (request, response) => {
  const clients = database.prepare(`
    SELECT clients.*,
      date(last_cut_date, '+15 days') AS next_reminder_date,
      CASE WHEN date(last_cut_date, '+15 days') <= date('now', 'localtime') THEN 1 ELSE 0 END AS reminder_pending,
      (SELECT sides_machine FROM haircut_preferences WHERE client_id = clients.id ORDER BY created_at DESC LIMIT 1) AS sides_machine,
      (SELECT top_finish FROM haircut_preferences WHERE client_id = clients.id ORDER BY created_at DESC LIMIT 1) AS top_finish
    FROM clients
    ORDER BY reminder_pending DESC, name COLLATE NOCASE
  `).all();
  response.json(clients);
});

app.post('/api/clients', requireAuth, (request, response) => {
  const payload = clientPayload(request.body);
  const missingFields = requireFields(payload, ['name', 'phone', 'last_cut_date', 'last_service']);
  if (missingFields.length) return response.status(400).json({ error: `Faltan campos: ${missingFields.join(', ')}` });
  if (payload.phone.length < 10) return response.status(400).json({ error: 'El teléfono no es válido.' });
  if (!validDate(payload.last_cut_date, false) || !validDate(payload.birth_date, true)) {
    return response.status(400).json({ error: 'Una de las fechas no es válida.' });
  }
  try {
    const result = database.prepare(`INSERT INTO clients (name, phone, birth_date, last_cut_date, last_service)
      VALUES (@name, @phone, @birth_date, @last_cut_date, @last_service)`).run(payload);
    response.status(201).json(getClient(result.lastInsertRowid));
  } catch (error) {
    response.status(409).json({ error: 'Ese teléfono ya está registrado.' });
  }
});

app.put('/api/clients/:id', requireAuth, (request, response) => {
  const payload = { ...clientPayload(request.body), id: request.params.id };
  const missingFields = requireFields(payload, ['name', 'phone', 'last_cut_date', 'last_service']);
  if (missingFields.length) return response.status(400).json({ error: `Faltan campos: ${missingFields.join(', ')}` });
  if (payload.phone.length < 10) return response.status(400).json({ error: 'El teléfono no es válido.' });
  if (!validDate(payload.last_cut_date, false) || !validDate(payload.birth_date, true)) {
    return response.status(400).json({ error: 'Una de las fechas no es válida.' });
  }
  try {
    const result = database.prepare(`UPDATE clients SET name=@name, phone=@phone, birth_date=@birth_date,
      last_cut_date=@last_cut_date, last_service=@last_service, updated_at=CURRENT_TIMESTAMP WHERE id=@id`).run(payload);
    if (!result.changes) return response.status(404).json({ error: 'Cliente no encontrado.' });
    response.json(getClient(request.params.id));
  } catch (error) {
    response.status(409).json({ error: 'Ese teléfono ya está registrado.' });
  }
});

app.delete('/api/clients/:id', requireAuth, (request, response) => {
  const result = database.prepare('DELETE FROM clients WHERE id = ?').run(request.params.id);
  if (!result.changes) return response.status(404).json({ error: 'Cliente no encontrado.' });
  response.status(204).end();
});

app.post('/api/backup/import', requireAuth, (request, response) => {
  if (!Array.isArray(request.body.clients)) return response.status(400).json({ error: 'El respaldo no tiene un formato válido.' });
  const insertClient = database.prepare(`INSERT INTO clients (name, phone, birth_date, last_cut_date, last_service)
    VALUES (@name, @phone, @birth_date, @last_cut_date, @last_service)
    ON CONFLICT(phone) DO UPDATE SET name=excluded.name, birth_date=excluded.birth_date,
    last_cut_date=excluded.last_cut_date, last_service=excluded.last_service, updated_at=CURRENT_TIMESTAMP`);
  const validClients = request.body.clients.map(clientPayload).filter((client) => (
    client.name && client.phone.length >= 10 && client.last_cut_date && client.last_service
  ));
  const importClients = database.transaction((clients) => clients.forEach((client) => insertClient.run(client)));
  try {
    importClients(validClients);
    response.json({ imported: validClients.length });
  } catch (error) {
    response.status(400).json({ error: 'No se pudo importar el respaldo.' });
  }
});

app.post('/api/clients/:id/preferences', requireAuth, (request, response) => {
  if (!getClient(request.params.id)) return response.status(404).json({ error: 'Cliente no encontrado.' });
  const missingFields = requireFields(request.body, ['sides_machine']);
  if (missingFields.length) return response.status(400).json({ error: 'Indica las medidas utilizadas.' });
  const result = database.prepare(`INSERT INTO haircut_preferences (client_id, sides_machine, top_finish)
    VALUES (@client_id, @sides_machine, @top_finish)`).run({
    client_id: request.params.id,
    sides_machine: String(request.body.sides_machine || '').trim(),
    top_finish: request.body.top_finish ? String(request.body.top_finish).trim() : null
  });
  response.status(201).json(database.prepare('SELECT * FROM haircut_preferences WHERE id = ?').get(result.lastInsertRowid));
});

app.get('/api/styles', (request, response) => {
  response.json(database.prepare('SELECT * FROM styles WHERE active = 1 ORDER BY category, name').all());
});

app.post('/api/styles', requireAuth, (request, response) => {
  const missingFields = requireFields(request.body, ['name', 'category']);
  if (missingFields.length) return response.status(400).json({ error: `Faltan campos: ${missingFields.join(', ')}` });
  if (!['cortes', 'barba', 'combos'].includes(request.body.category)) return response.status(400).json({ error: 'Categoría inválida.' });
  const result = database.prepare('INSERT INTO styles (name, category, image_url) VALUES (@name, @category, @image_url)').run({
    name: String(request.body.name).trim(),
    category: request.body.category,
    image_url: request.body.image_url || null
  });
  response.status(201).json(database.prepare('SELECT * FROM styles WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/styles/:id', requireAuth, (request, response) => {
  const missingFields = requireFields(request.body, ['name', 'category']);
  if (missingFields.length) return response.status(400).json({ error: `Faltan campos: ${missingFields.join(', ')}` });
  if (!['cortes', 'barba', 'combos'].includes(request.body.category)) return response.status(400).json({ error: 'Categoría inválida.' });
  const result = database.prepare(`UPDATE styles SET name=@name, category=@category, image_url=@image_url, active=@active, updated_at=CURRENT_TIMESTAMP WHERE id=@id`)
    .run({
      name: String(request.body.name).trim(),
      category: request.body.category,
      image_url: request.body.image_url || null,
      active: request.body.active === 0 || request.body.active === false ? 0 : 1,
      id: request.params.id
    });
  if (!result.changes) return response.status(404).json({ error: 'Estilo no encontrado.' });
  response.json(database.prepare('SELECT * FROM styles WHERE id = ?').get(request.params.id));
});

app.delete('/api/styles/:id', requireAuth, (request, response) => {
  const result = database.prepare('DELETE FROM styles WHERE id = ?').run(request.params.id);
  if (!result.changes) return response.status(404).json({ error: 'Estilo no encontrado.' });
  response.status(204).end();
});

app.put('/api/clients/:clientId/style', requireAuth, (request, response) => {
  const client = getClient(request.params.clientId);
  const style = database.prepare('SELECT id FROM styles WHERE id = ? AND active = 1').get(request.body.style_id);
  if (!client || !style) return response.status(404).json({ error: 'Cliente o estilo no encontrado.' });
  database.prepare('INSERT OR REPLACE INTO client_styles (client_id, style_id) VALUES (?, ?)').run(client.id, style.id);
  response.status(204).end();
});

app.get('/api/birthdays/current', requireAuth, (request, response) => {
  response.json(database.prepare(`SELECT * FROM clients WHERE birth_date IS NOT NULL
    AND strftime('%m', birth_date) = strftime('%m', 'now', 'localtime') ORDER BY strftime('%d', birth_date), name`).all());
});

app.get('/api/cash/:date', requireAuth, (request, response) => {
  if (!validDate(request.params.date, false)) return response.status(400).json({ error: 'Fecha inválida.' });
  const closure = database.prepare('SELECT * FROM cash_closures WHERE closure_date = ?').get(request.params.date);
  response.json(closure || { closure_date: request.params.date, gross_income_cents: 0, tips_cents: 0, notes: '' });
});

app.put('/api/cash/:date', requireAuth, (request, response) => {
  if (!validDate(request.params.date, false)) return response.status(400).json({ error: 'Fecha inválida.' });
  const missingFields = requireFields(request.body, ['gross_income_cents', 'tips_cents']);
  if (missingFields.length) return response.status(400).json({ error: 'Indica ingresos y propinas.' });
  const grossIncome = Number(request.body.gross_income_cents);
  const tips = Number(request.body.tips_cents);
  if (!Number.isFinite(grossIncome) || !Number.isFinite(tips) || grossIncome < 0 || tips < 0) {
    return response.status(400).json({ error: 'Los montos de caja no son válidos.' });
  }
  if (tips > grossIncome) return response.status(400).json({ error: 'Las propinas no pueden superar los ingresos.' });
  database.prepare(`INSERT INTO cash_closures (closure_date, gross_income_cents, tips_cents, notes)
    VALUES (@closure_date, @gross_income_cents, @tips_cents, @notes)
    ON CONFLICT(closure_date) DO UPDATE SET gross_income_cents=excluded.gross_income_cents,
    tips_cents=excluded.tips_cents, notes=excluded.notes, updated_at=CURRENT_TIMESTAMP`).run({
    closure_date: request.params.date,
    gross_income_cents: Math.round(grossIncome),
    tips_cents: Math.round(tips),
    notes: request.body.notes ? String(request.body.notes).trim() : null
  });
  response.json(database.prepare('SELECT * FROM cash_closures WHERE closure_date = ?').get(request.params.date));
});

app.get('/api/dashboard', requireAuth, (request, response) => {
  const totals = database.prepare(`SELECT
    COUNT(*) AS total_clients,
    SUM(CASE WHEN date(last_cut_date, '+15 days') <= date('now', 'localtime') THEN 1 ELSE 0 END) AS pending_reminders
    FROM clients`).get();
  response.json(totals);
});

app.use((request, response) => {
  if (request.path.startsWith('/api/')) {
    return response.status(404).json({ error: 'Ruta no encontrada.' });
  }
  response.status(404).send('Página no encontrada.');
});

app.use((error, request, response, next) => {
  console.error('Error no controlado:', error);
  response.status(500).json({ error: 'Error interno del servidor.' });
});

app.listen(port, () => console.log(`Zane Barber Studio: http://localhost:${port}`));