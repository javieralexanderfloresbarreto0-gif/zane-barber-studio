// Arma cloudflare/schema.sql a partir de db/*.sql (las mismas tablas que usa el
// servidor Node) más las tablas propias de la versión Cloudflare.
//   node scripts/build-schema.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const parts = ['schema.sql', 'seed.sql', 'kiosc.sql']
  .map((file) => fs.readFileSync(path.join(root, 'db', file), 'utf8'))
  .join('\n\n')
  // D1 aplica las claves foráneas siempre y no admite cambiar el PRAGMA.
  .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;\s*$/gim, '');

const extra = `
-- ---- Solo Cloudflare ---------------------------------------------------
-- Contador de intentos para límites (login, reservas): un Worker no tiene
-- memoria compartida entre peticiones, así que se guarda en la base.
CREATE TABLE IF NOT EXISTS hits (
  key TEXT NOT NULL,
  at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hits_key_at ON hits (key, at);
`;

const out = `-- GENERADO por cloudflare/scripts/build-schema.js — no editar a mano.\n${parts}\n${extra}`;
fs.writeFileSync(path.join(__dirname, '..', 'schema.sql'), out);
console.log('schema.sql generado');
