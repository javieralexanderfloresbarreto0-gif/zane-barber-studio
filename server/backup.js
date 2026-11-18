// Copia de seguridad de la base de datos (segura aunque el servidor esté en marcha).
// Guarda data/backups/zane-AAAA-MM-DD.sqlite y conserva las últimas 14.
//   node server/backup.js
process.env.TZ = process.env.TZ || 'America/Caracas';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDirectory = path.join(__dirname, '..', 'data');
const source = path.join(dataDirectory, 'zane.sqlite');
const backupDirectory = path.join(dataDirectory, 'backups');
const KEEP = 14;

if (!fs.existsSync(source)) {
  console.error('[ZANE] No existe data/zane.sqlite; nada que respaldar.');
  process.exit(1);
}

fs.mkdirSync(backupDirectory, { recursive: true });
const now = new Date();
const pad = (value) => String(value).padStart(2, '0');
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const target = path.join(backupDirectory, `zane-${stamp}.sqlite`);

const database = new Database(source, { readonly: true });
database.backup(target)
  .then(() => {
    database.close();
    const old = fs.readdirSync(backupDirectory)
      .filter((name) => /^zane-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name))
      .sort()
      .slice(0, -KEEP);
    old.forEach((name) => fs.unlinkSync(path.join(backupDirectory, name)));
    console.log(`[ZANE] Copia guardada en ${target}`);
  })
  .catch((error) => {
    database.close();
    console.error('[ZANE] La copia falló:', error.message);
    process.exit(1);
  });
