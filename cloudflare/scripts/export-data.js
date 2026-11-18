// Convierte la base de datos del servidor Node (data/zane.sqlite) en un archivo
// SQL para cargarla en D1. Reemplaza TODO lo que haya en D1 por estos datos.
//   node scripts/export-data.js ../data/zane.sqlite > importar.sql
//
// Usa better-sqlite3 del proyecto principal (no hace falta instalar nada más).
const path = require('path');
const fs = require('fs');

const source = process.argv[2];
if (!source || !fs.existsSync(source)) {
  console.error('Uso: node scripts/export-data.js <ruta a zane.sqlite>');
  process.exit(1);
}

const Database = require(path.join(__dirname, '..', '..', 'node_modules', 'better-sqlite3'));
const db = new Database(source, { readonly: true });

// Padres antes que hijos (por las claves foráneas).
const TABLES = [
  'clients', 'styles', 'services', 'kiosc_devices', 'app_settings',
  'haircut_preferences', 'client_styles', 'cash_closures',
  'orders', 'payment_events', 'appointments'
];

const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));

function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

const out = [];
out.push('-- Datos exportados de ' + path.basename(source) + ' el ' + new Date().toISOString());
out.push('PRAGMA defer_foreign_keys = true;');
// Vacía primero (hijos antes que padres) para que la carga sea repetible.
for (const table of [...TABLES].reverse().concat('hits')) out.push(`DELETE FROM ${table};`);

const counts = {};
for (const table of TABLES) {
  if (!existing.has(table)) continue;
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  counts[table] = rows.length;
  for (const row of rows) {
    // Las fotos de comprobante viven en el disco de la PC y no se migran.
    if (table === 'orders') row.payment_proof_path = null;
    const columns = Object.keys(row);
    out.push(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => literal(row[c])).join(', ')});`);
  }
}

process.stdout.write(out.join('\n') + '\n');
console.error('Filas exportadas: ' + Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(', '));
