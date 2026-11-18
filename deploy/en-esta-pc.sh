#!/usr/bin/env bash
# Deja Zane Barber Studio funcionando como servicio en ESTA computadora (Linux):
#  - arranca solo al encender la PC y se reinicia si falla
#  - escucha en la red local (kiosco desde tablet/teléfono por Wi-Fi)
#  - copia de seguridad diaria de la base de datos (data/backups/)
#
# Uso, desde la carpeta del proyecto:
#   sudo bash deploy/en-esta-pc.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecútalo con sudo:  sudo bash deploy/en-esta-pc.sh" >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="${SUDO_USER:-}"
if [ -z "$APP_USER" ] || [ "$APP_USER" = "root" ]; then
  echo "Ejecútalo con sudo desde tu usuario normal (no como root directamente)." >&2
  exit 1
fi

# Node del usuario (sirve también si se instaló con nvm)
NODE_BIN="$(sudo -u "$APP_USER" bash -ic 'command -v node' 2>/dev/null | tail -n1 || true)"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
if [ ! -x "$NODE_BIN" ]; then
  echo "No encuentro Node.js. Instálalo (versión 18 o superior) y vuelve a intentarlo." >&2
  exit 1
fi

echo "==> Proyecto: $APP_DIR"
echo "==> Usuario:  $APP_USER"
echo "==> Node:     $NODE_BIN ($("$NODE_BIN" --version))"

echo "==> Instalando dependencias"
sudo -u "$APP_USER" bash -c "cd \"$APP_DIR\" && \"$(dirname "$NODE_BIN")/npm\" install --omit=dev --no-audit --no-fund"

echo "==> Apagando el servidor si estaba encendido a mano"
pkill -u "$APP_USER" -f "node server/index.js" 2>/dev/null || true

# Acceso directo sin espacios: systemd no se lleva bien con rutas como
# "Proyecto zane 4-SEP", así que el servicio usa /opt/zane-barber.
LINK_DIR="/opt/zane-barber"
ln -sfn "$APP_DIR" "$LINK_DIR"

echo "==> Creando el servicio zane-barber"
cat > /etc/systemd/system/zane-barber.service <<UNIT
[Unit]
Description=Zane Barber Studio (web + panel + kiosco)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$LINK_DIR
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=3000
Environment=TZ=America/Caracas
Environment=TRUST_PROXY=loopback
EnvironmentFile=-$LINK_DIR/.env
ExecStart=$NODE_BIN server/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

echo "==> Creando la copia de seguridad diaria (3:30 AM)"
cat > /etc/systemd/system/zane-barber-backup.service <<UNIT
[Unit]
Description=Copia de seguridad de Zane Barber Studio

[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$LINK_DIR
ExecStart=$NODE_BIN server/backup.js
UNIT

cat > /etc/systemd/system/zane-barber-backup.timer <<UNIT
[Unit]
Description=Copia diaria de Zane Barber Studio

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now zane-barber.service
systemctl enable --now zane-barber-backup.timer

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  echo "==> Abriendo el puerto 3000 en el firewall (red local)"
  ufw allow 3000/tcp >/dev/null
fi

sleep 2
if systemctl is-active --quiet zane-barber; then
  echo
  echo "Listo. El servicio está funcionando y arrancará solo al encender la PC."
  echo "  En esta PC:          http://localhost:3000"
  for ip in $(hostname -I); do
    case "$ip" in *:*) ;; *) echo "  Desde el Wi-Fi:      http://$ip:3000   (kiosco: http://$ip:3000/kiosc/)";; esac
  done
  echo
  echo "Comandos útiles:"
  echo "  Ver si está activo:  systemctl status zane-barber"
  echo "  Ver los mensajes:    journalctl -u zane-barber -f"
  echo "  Reiniciar:           sudo systemctl restart zane-barber"
  echo "  Copia ahora mismo:   sudo systemctl start zane-barber-backup"
else
  echo "El servicio no arrancó. Mira el error con:  journalctl -u zane-barber -n 50" >&2
  exit 1
fi
