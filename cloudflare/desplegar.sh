#!/usr/bin/env bash
# Publica Zane Barber Studio en Cloudflare (Workers + D1).
#
# Uso, desde la carpeta del proyecto:
#   bash cloudflare/desplegar.sh
#
# La primera vez: abre el navegador para que autorices tu cuenta de Cloudflare,
# crea la base de datos, copia tus datos de esta PC y guarda la contraseña del
# panel. Las siguientes veces solo publica los cambios (es seguro repetirlo).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
export WRANGLER_SEND_METRICS=false
# Config generada (con el id de la base) para no modificar wrangler.toml, que
# está en Git: así "git pull" nunca choca con cambios locales.
CONFIG="wrangler.generated.toml"
WR="npx --no-install wrangler"

echo "==> Instalando herramientas de Cloudflare"
npm install --no-audit --no-fund --loglevel=error

echo "==> Comprobando tu sesión de Cloudflare"
if $WR whoami 2>&1 | grep -qiE "not authenticated|not logged in"; then
  echo "    Se abrirá el navegador: pulsa 'Allow' para autorizar."
  $WR login
fi

echo "==> Base de datos (D1)"
node scripts/build-schema.js >/dev/null
db_id() {
  $WR d1 list --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
      try { const db = JSON.parse(s).find((d) => d.name === "zane-db"); process.stdout.write(db ? db.uuid : ""); }
      catch (e) { process.stdout.write(""); }
    });'
}
DB_ID="$(db_id)"
if [ -z "$DB_ID" ]; then
  echo "    Creando la base zane-db…"
  $WR d1 create zane-db >/dev/null
  DB_ID="$(db_id)"
fi
if [ -z "$DB_ID" ]; then
  echo "No pude obtener el identificador de la base de datos. Revisa 'npx wrangler d1 list'." >&2
  exit 1
fi
sed "s/^database_id = .*/database_id = \"$DB_ID\"/" wrangler.toml > "$CONFIG"
$WR d1 execute zane-db --config "$CONFIG" --remote --yes --file=schema.sql >/dev/null
echo "    Lista ($DB_ID)"

# ---- copiar los datos de esta PC (solo la primera vez, o si lo pides) ----
SOURCE_DB="../data/zane.sqlite"
if [ -f "$SOURCE_DB" ] && { [ ! -f .datos-importados ] || [ "${1:-}" = "--importar" ]; }; then
  echo
  echo "Encontré los datos de esta PC (clientes, citas, caja, tablets)."
  echo "Copiarlos REEMPLAZA lo que haya en Cloudflare por lo de esta PC."
  read -r -p "¿Copiarlos ahora? (s/n) " answer
  if [ "$answer" = "s" ] || [ "$answer" = "S" ]; then
    node scripts/export-data.js "$SOURCE_DB" > importar.sql
    $WR d1 execute zane-db --config "$CONFIG" --remote --yes --file=importar.sql >/dev/null
    rm -f importar.sql
    date > .datos-importados
    echo "    Datos copiados."
  fi
fi

echo "==> Publicando la web"
DEPLOY_LOG="$(mktemp)"
$WR deploy --config "$CONFIG" 2>&1 | tee "$DEPLOY_LOG"
URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' "$DEPLOY_LOG" | head -n1 || true)"
rm -f "$DEPLOY_LOG"

echo "==> Contraseñas"
SECRETS="$($WR secret list --config "$CONFIG" --format json 2>/dev/null || echo '[]')"
if ! echo "$SECRETS" | grep -q '"TOKEN_SECRET"'; then
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' | $WR secret put TOKEN_SECRET --config "$CONFIG" >/dev/null
  echo "    Clave interna de sesiones creada."
fi
if ! echo "$SECRETS" | grep -q '"ADMIN_PASSWORD"'; then
  PASS=""
  if [ -f ../.env ]; then PASS="$(grep -E '^ADMIN_PASSWORD=' ../.env | tail -n1 | cut -d= -f2- || true)"; fi
  if [ -z "$PASS" ] && [ -f ../data/admin_password.secret ]; then PASS="$(tr -d '\r\n' < ../data/admin_password.secret)"; fi
  if [ -n "$PASS" ]; then
    echo "    Uso la misma contraseña del panel que tienes en esta PC."
  else
    read -r -s -p "    Escribe la contraseña que quieres para el panel: " PASS; echo
  fi
  printf '%s' "$PASS" | $WR secret put ADMIN_PASSWORD --config "$CONFIG" >/dev/null
  echo "    Contraseña del panel guardada."
fi

echo
echo "Listo. Tu web está publicada en Cloudflare:"
echo "  ${URL:-(mira la dirección https://….workers.dev que aparece arriba)}"
echo "  Panel:   ${URL:-…}/?admin=1"
echo "  Kiosco:  regístralo desde el panel (Turnos → Tablets → Registrar tablet)"
