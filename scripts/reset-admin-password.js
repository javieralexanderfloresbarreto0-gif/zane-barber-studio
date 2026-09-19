#!/usr/bin/env node
'use strict';

// Restablece la contraseña del panel admin sin tener que editar el .env a mano.
//
//   node scripts/reset-admin-password.js              -> genera una segura
//   node scripts/reset-admin-password.js MiClaveNueva -> fija la que le pases
//
// Escribe data/admin_password.secret igual que hace el servidor en el primer
// arranque (server/index.js). Después hay que reiniciar el servicio para que
// el proceso recargue el valor.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rootDirectory = path.join(__dirname, '..');
const dataDirectory = path.join(rootDirectory, 'data');
const adminPasswordPath = path.join(dataDirectory, 'admin_password.secret');
const envPath = path.join(rootDirectory, '.env');

const requested = process.argv[2];
if (requested && requested.length < 8) {
  console.error('[ZANE] La contraseña debe tener al menos 8 caracteres.');
  process.exit(1);
}

const password = requested || crypto.randomBytes(12).toString('base64url');

fs.mkdirSync(dataDirectory, { recursive: true });
fs.writeFileSync(adminPasswordPath, password, { mode: 0o600 });
fs.chmodSync(adminPasswordPath, 0o600);

console.log('\n[ZANE] Nueva contraseña de administrador:');
console.log(`[ZANE]   ${password}`);
console.log(`[ZANE] Guardada en ${adminPasswordPath} (permisos 600).`);

// ADMIN_PASSWORD del entorno gana sobre el fichero, así que si está definida
// este script no cambiaría nada en la práctica. Mejor avisar que dejar al
// administrador probando una clave que el servidor ignora.
let envOverrides = false;
try {
  envOverrides = /^\s*ADMIN_PASSWORD\s*=\s*\S/m.test(fs.readFileSync(envPath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

if (envOverrides || process.env.ADMIN_PASSWORD) {
  console.log('\n[ZANE] AVISO: hay un ADMIN_PASSWORD definido en el entorno o en .env');
  console.log('[ZANE] y tiene prioridad sobre este fichero. Bórralo de .env (o');
  console.log('[ZANE] cámbialo allí) para que la contraseña de arriba tenga efecto.');
}

console.log('\n[ZANE] Reinicia el servicio para aplicarla:');
console.log('[ZANE]   sudo systemctl restart zane-barber\n');
