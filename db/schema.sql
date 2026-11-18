PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  birth_date TEXT,
  last_cut_date TEXT NOT NULL,
  last_service TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS haircut_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  sides_machine TEXT NOT NULL,
  top_finish TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS styles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('cortes', 'barba', 'combos')),
  image_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS client_styles (
  client_id INTEGER NOT NULL,
  style_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, style_id),
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (style_id) REFERENCES styles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cash_closures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  closure_date TEXT NOT NULL UNIQUE,
  gross_income_cents INTEGER NOT NULL DEFAULT 0,
  tips_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (gross_income_cents >= 0),
  CHECK (tips_cents >= 0),
  CHECK (tips_cents <= gross_income_cents)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_clients_birth_month ON clients (birth_date);
CREATE INDEX IF NOT EXISTS idx_clients_last_cut ON clients (last_cut_date);
CREATE INDEX IF NOT EXISTS idx_preferences_client ON haircut_preferences (client_id);

-- Citas reservadas desde la web. Una hora solo puede tener una cita activa.
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_name TEXT NOT NULL,
  client_phone TEXT NOT NULL,
  service TEXT NOT NULL,
  appt_date TEXT NOT NULL,
  appt_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'done', 'cancelled', 'no_show')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_slot_active
  ON appointments (appt_date, appt_time) WHERE status IN ('booked', 'done');
CREATE INDEX IF NOT EXISTS idx_appt_date ON appointments (appt_date, appt_time);
