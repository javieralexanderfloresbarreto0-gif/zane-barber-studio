#!/usr/bin/env bash
# Actualiza el sitio ya instalado: trae los últimos cambios, reinstala
# dependencias si cambiaron y reinicia el servicio.
#
#   ssh ubuntu@<IP-de-la-VM>
#   sudo /opt/zane-barber-studio/deploy/deploy.sh

set -euo pipefail

APP_USER="zane"
APP_DIR="/opt/zane-barber-studio"

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecuta este script con sudo." >&2
  exit 1
fi

cd "$APP_DIR"

echo "==> git pull"
sudo -u "$APP_USER" git pull --ff-only

echo "==> npm ci"
sudo -u "$APP_USER" npm ci --omit=dev

echo "==> comprobando sintaxis (npm run check)"
sudo -u "$APP_USER" npm run check

echo "==> reiniciando el servicio"
systemctl restart zane-barber
sleep 1
systemctl --no-pager status zane-barber
