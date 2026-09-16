-- ====================================================================
--  KIOSCO DE TURNOS  ·  se ejecuta después de schema.sql y seed.sql
--  (todo IF NOT EXISTS / INSERT idempotente: seguro re-ejecutar)
-- ====================================================================

-- Catálogo que ve el cliente en la tablet -----------------------------
CREATE TABLE IF NOT EXISTS services (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  description     TEXT,
  category        TEXT NOT NULL DEFAULT 'corte',
  price_usd_cents INTEGER NOT NULL,
  duration_min    INTEGER NOT NULL DEFAULT 30,
  active          INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  image_url       TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Cada tablet registrada. token_hash = sha256(token en claro) --------
CREATE TABLE IF NOT EXISTS kiosc_devices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  label        TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  active       INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- La orden / turno. Dos ciclos de vida: payment_status y queue_status -
CREATE TABLE IF NOT EXISTS orders (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  code               TEXT UNIQUE,                 -- "A-047", se asigna tras el INSERT
  client_id          INTEGER REFERENCES clients(id),
  client_name        TEXT NOT NULL,               -- snapshot inmutable
  client_phone       TEXT NOT NULL,
  service_id         INTEGER NOT NULL REFERENCES services(id),
  service_name       TEXT NOT NULL,               -- snapshot
  amount_bs          INTEGER NOT NULL,            -- monto cobrado, bolívares enteros
  amount_usd_cents   INTEGER NOT NULL,
  rate_used          REAL NOT NULL,               -- tasa aplicada al crear
  currency           TEXT NOT NULL DEFAULT 'VES',
  payment_method     TEXT NOT NULL DEFAULT 'pago_movil',
  payment_status     TEXT NOT NULL DEFAULT 'awaiting_payment'
       CHECK (payment_status IN
       ('awaiting_payment','submitted','validated','rejected','expired')),
  payment_reference  TEXT,                        -- número que teclea el cliente
  payment_proof_path TEXT,                        -- archivo en data/uploads/
  payment_proof_sha  TEXT,                        -- evita reusar el mismo comprobante
  reject_reason      TEXT,
  queue_status       TEXT
       CHECK (queue_status IS NULL OR queue_status IN
       ('waiting','in_service','done','no_show','cancelled')),
  queue_no           INTEGER,                     -- turno del día, asignado al validar
  barber_id          INTEGER,
  device_id          INTEGER REFERENCES kiosc_devices(id),
  validated_by       TEXT,
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submitted_at       TEXT,
  paid_at            TEXT,
  called_at          TEXT,
  done_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_live
  ON orders (payment_status, queue_status, created_at);
-- una referencia de Pago Móvil no puede quedar en dos órdenes
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_ref_once
  ON orders (payment_reference) WHERE payment_reference IS NOT NULL;

-- Bitácora inmutable: auditoría + fuente de los eventos en tiempo real
CREATE TABLE IF NOT EXISTS payment_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,      -- created|submitted|validated|rejected|expired|called|done|no_show
  actor      TEXT NOT NULL,      -- 'kiosc:Tablet 1' | 'admin' | 'system'
  note       TEXT,
  meta_json  TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payment_events_order ON payment_events (order_id);

-- ---- Catálogo inicial: los 5 servicios reales, precio base en USD ---
INSERT INTO services (name, description, category, price_usd_cents, duration_min, sort_order)
SELECT 'Corte clásico y/o tijeras', 'Corte a máquina o tijera, terminado con navaja. Incluye perfilado de líneas.', 'corte', 600, 30, 1
WHERE NOT EXISTS (SELECT 1 FROM services WHERE name = 'Corte clásico y/o tijeras');

INSERT INTO services (name, description, category, price_usd_cents, duration_min, sort_order)
SELECT 'Corte con barba', 'Corte completo más diseño y perfilado de barba a navaja.', 'combo', 800, 45, 2
WHERE NOT EXISTS (SELECT 1 FROM services WHERE name = 'Corte con barba');

INSERT INTO services (name, description, category, price_usd_cents, duration_min, sort_order)
SELECT 'Corte VIP', 'Corte, lavado con hidratación, masaje y mascarilla facial.', 'corte', 1000, 50, 3
WHERE NOT EXISTS (SELECT 1 FROM services WHERE name = 'Corte VIP');

INSERT INTO services (name, description, category, price_usd_cents, duration_min, sort_order)
SELECT 'Corte VIP con barba', 'Corte y barba con lavado, hidratación, masaje y mascarilla facial.', 'combo', 1200, 60, 4
WHERE NOT EXISTS (SELECT 1 FROM services WHERE name = 'Corte VIP con barba');

INSERT INTO services (name, description, category, price_usd_cents, duration_min, sort_order)
SELECT 'Colorimetría', 'Desde $45. Requiere valoración previa o prueba de mechón.', 'color', 4500, 90, 5
WHERE NOT EXISTS (SELECT 1 FROM services WHERE name = 'Colorimetría');

-- ---- Datos de Pago Móvil (reusa app_settings de schema.sql) --------
-- pm_methods = array JSON de bancos. Se edita desde el panel (Turnos ->
-- Pago Móvil) o con:  UPDATE app_settings SET value='[...]' WHERE key='pm_methods';
INSERT INTO app_settings (key, value)
SELECT 'pm_methods',
  '[{"bank":"Banesco","code":"0134","phone":"0412-1453691","id":"V-27.594.568","qr":"kiosc/img/pago-movil-banesco.png"},'
  || '{"bank":"Banco de Venezuela","code":"0102","phone":"0412-1453691","id":"V-27.594.568","qr":"kiosc/img/pago-movil-venezuela.png"}]'
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'pm_methods');
