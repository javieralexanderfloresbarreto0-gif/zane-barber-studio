#!/usr/bin/env bash
# Trae los últimos cambios de GitHub y reinicia el servicio de esta PC.
#   bash deploy/actualizar.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> Trayendo cambios"
git pull --ff-only

echo "==> Dependencias"
npm install --omit=dev --no-audit --no-fund

echo "==> Comprobando el código"
npm run check

echo "==> Reiniciando el servicio (pide tu contraseña)"
sudo systemctl restart zane-barber
sleep 2
systemctl is-active --quiet zane-barber && echo "Listo: la web ya tiene los cambios." \
  || { echo "El servicio no arrancó. Mira:  journalctl -u zane-barber -n 50" >&2; exit 1; }
