#!/usr/bin/env bash
# Aprovisiona una VM Ubuntu 22.04 nueva (Oracle Cloud Always Free, Ampere A1)
# para correr Zane Barber Studio. Se ejecuta UNA vez, a mano, por SSH:
#
#   scp -r deploy ubuntu@<IP-de-la-VM>:~/
#   ssh ubuntu@<IP-de-la-VM>
#   chmod +x deploy/setup.sh
#   sudo ./deploy/setup.sh
#
# Idempotente en lo razonable: se puede volver a correr sin romper nada.
# No sustituye leer DEPLOY.md — ahí están los pasos de Oracle Cloud (Security
# List/NSG, dominio, certbot) que no se pueden automatizar desde aquí.

set -euo pipefail

APP_USER="zane"
APP_DIR="/opt/zane-barber-studio"
NODE_MAJOR="20"

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecuta este script con sudo." >&2
  exit 1
fi

echo "==> Actualizando el sistema"
apt-get update -y
apt-get upgrade -y

echo "==> Instalando dependencias base (git, nginx, build tools, ufw)"
apt-get install -y curl git nginx build-essential python3 ufw ca-certificates

if ! command -v node >/dev/null 2>&1; then
  echo "==> Instalando Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  echo "==> Node ya instalado: $(node -v)"
fi

echo "==> Creando usuario de sistema '${APP_USER}' (sin login, sin privilegios)"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

echo "==> Preparando ${APP_DIR}"
mkdir -p "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  echo "    ya existe un repo ahí; usa deploy/deploy.sh para actualizar en vez de este script."
else
  echo "    directorio vacío: clona tu repo ahí, por ejemplo:"
  echo "    sudo -u ${APP_USER} git clone <URL-de-tu-repo> ${APP_DIR}"
  echo "    (o copia el proyecto con: scp -r . ubuntu@<IP>:${APP_DIR})"
fi

if [ -f "$APP_DIR/package.json" ]; then
  echo "==> Instalando dependencias de producción"
  cd "$APP_DIR"
  sudo -u "$APP_USER" npm ci --omit=dev

  if [ ! -f "$APP_DIR/.env" ]; then
    echo "==> Creando .env a partir de .env.example (EDÍTALO antes de arrancar)"
    cp .env.example .env
    chown "$APP_USER:$APP_USER" .env
    chmod 600 .env
  fi

  mkdir -p "$APP_DIR/data"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
fi

echo "==> Instalando el servicio systemd"
cp "$(dirname "$0")/zane-barber.service" /etc/systemd/system/zane-barber.service
systemctl daemon-reload
systemctl enable zane-barber

echo "==> Configurando el firewall (ufw)"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

cat <<'EOF'

==> Listo el aprovisionamiento base. Pasos que faltan a mano:

  1. Edita /opt/zane-barber-studio/.env (ADMIN_PASSWORD, TOKEN_SECRET, BASE_URL, TZ...).
  2. Si aún no clonaste el repo, hazlo ahora en /opt/zane-barber-studio y vuelve
     a correr este script (o solo el bloque de "npm ci").
  3. sudo systemctl start zane-barber   &&   sudo systemctl status zane-barber
  4. Configura nginx: ver deploy/nginx.conf y DEPLOY.md.
  5. En la consola de Oracle Cloud, abre los puertos 80 y 443 en la Security
     List / Network Security Group de la VM (el firewall del sistema no basta).
  6. sudo certbot --nginx -d tu-dominio.com   (una vez el dominio apunte a la IP)

EOF
