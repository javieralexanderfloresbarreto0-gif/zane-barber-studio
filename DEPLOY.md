# Despliegue en Oracle Cloud Always Free

Guía paso a paso para poner Zane Barber Studio en una VM gratis de por vida
(Ampere A1, ARM) de Oracle Cloud. Los ficheros de `deploy/` hacen la parte
mecánica; aquí van los pasos que solo se pueden hacer desde la consola web de
Oracle o tocando el DNS, que nadie puede automatizar por ti.

## 0. Antes de empezar

- Cuenta de Oracle Cloud (**Always Free**, sin tarjeta que cobre después:
  https://signup.oraclecloud.com). Pide un documento de identidad y una
  tarjeta solo para verificar que eres humano; el tier Always Free no cobra.
- Un dominio (o subdominio) que puedas apuntar a la IP de la VM. Si todavía no
  tienes uno, sirve un gratuito tipo `tuapp.duckdns.org` mientras compras uno
  real.

## 1. Crear la VM (consola de Oracle Cloud)

1. **Compute → Instances → Create Instance.**
2. Imagen: **Canonical Ubuntu 22.04** (arm64).
3. Shape: **VM.Standard.A1.Flex** — dentro del límite gratis puedes darle
   hasta 4 OCPU / 24 GB RAM (con 1 OCPU / 6 GB sobra de sobra para este sitio).
4. En "Add SSH keys" sube tu clave pública (o genera un par nuevo y guarda la
   privada).
5. Crea la instancia. Anota la **IP pública**.

## 2. Abrir los puertos (el paso que todos olvidan)

Oracle filtra el tráfico en dos capas; el firewall del propio Ubuntu (que
configura `deploy/setup.sh` con `ufw`) **no basta** si esta capa de arriba
sigue cerrada:

1. Ve a la VM → pestaña **Subnet** → la **Security List** (o el **Network
   Security Group** si usaste uno) asociado.
2. **Add Ingress Rules**: permite `0.0.0.0/0` a los puertos **80** (HTTP) y
   **443** (HTTPS), protocolo TCP. El puerto 22 (SSH) ya suele estar abierto
   por defecto.

## 3. Subir el proyecto y aprovisionar la VM

Desde tu máquina, con el código de este repo:

```bash
# copia el proyecto (o mejor, sube el repo a GitHub/GitLab y clónalo en la VM)
scp -r deploy ubuntu@<IP-DE-LA-VM>:~/

ssh ubuntu@<IP-DE-LA-VM>
chmod +x deploy/setup.sh
sudo ./deploy/setup.sh
```

El script instala Node 20, nginx, `ufw`, crea el usuario de sistema `zane` y
deja `/opt/zane-barber-studio` listo. Si todavía no clonaste el repo ahí,
hazlo y vuelve a correr el script (o solo el bloque de `npm ci`):

```bash
sudo -u zane git clone <URL-de-tu-repo> /opt/zane-barber-studio
sudo ./deploy/setup.sh
```

## 4. Variables de entorno

```bash
sudo nano /opt/zane-barber-studio/.env
```

Como mínimo define (ver `.env.example` para la lista completa):

```
ADMIN_PASSWORD=<algo fuerte, o déjalo vacío y el server genera uno la 1ª vez>
TOKEN_SECRET=<déjalo vacío; se genera solo>
PORT=3000
BASE_URL=https://tu-dominio.com
TZ=America/Caracas
TRUST_PROXY=1
```

`TRUST_PROXY=1` es importante aquí: nginx queda delante del servidor Node, y
sin esto el bloqueo de intentos de login por IP y las URLs `https://` de las
etiquetas SEO no funcionan bien (ver comentarios en `server/index.js`).

## 5. Arrancar el servicio

```bash
sudo systemctl start zane-barber
sudo systemctl status zane-barber      # debe decir "active (running)"
sudo journalctl -u zane-barber -f      # logs en vivo, Ctrl+C para salir
```

La primera vez, si no pusiste `ADMIN_PASSWORD`, la contraseña generada sale
**una sola vez** en estos logs — guárdala ya.

### Si perdiste la contraseña del panel

No se puede recuperar (no está en el repo ni en ningún otro sitio). Se
restablece desde la propia VM:

```bash
cd /opt/zane-barber-studio
sudo -u zane npm run reset-password -- MiClaveNueva   # o sin argumento, la genera
sudo systemctl restart zane-barber
```

Si tienes `ADMIN_PASSWORD` puesto en `/opt/zane-barber-studio/.env`, ese valor
manda sobre el fichero: cámbialo allí y reinicia, o bórralo de `.env` para que
valga el que generó el script.

## 6. nginx + dominio + HTTPS

1. Apunta tu dominio (registro **A**) a la IP pública de la VM. Espera a que
   propague (`dig tu-dominio.com` debe devolver esa IP).
2. Instala el sitio de nginx:

   ```bash
   sudo cp /opt/zane-barber-studio/deploy/nginx.conf /etc/nginx/sites-available/zane-barber
   sudo sed -i 's/TU_DOMINIO/tu-dominio.com/' /etc/nginx/sites-available/zane-barber
   sudo ln -s /etc/nginx/sites-available/zane-barber /etc/nginx/sites-enabled/
   sudo rm -f /etc/nginx/sites-enabled/default
   sudo nginx -t && sudo systemctl reload nginx
   ```

3. HTTPS gratis con certbot:

   ```bash
   sudo apt-get install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d tu-dominio.com
   ```

   Certbot reescribe el `server{}` para servir HTTPS y renueva el
   certificado solo (systemd timer `certbot.timer`, ya viene activado).

4. Visita `https://tu-dominio.com` — debería cargar la landing.

## 7. El kiosco (tablet)

Una vez el dominio funciona, en la tablet abre el enlace de enrolamiento que
genera el panel (**Turnos → Tablets → Registrar tablet**) apuntando a tu
dominio, no a `localhost`. El Service Worker del kiosco (`public/kiosc/sw.js`)
necesita HTTPS para funcionar fuera de `localhost`, así que hasta que el
certificado esté activo, el modo offline del kiosco no funcionará.

## 8. Actualizar el sitio más adelante

```bash
ssh ubuntu@<IP-DE-LA-VM>
sudo /opt/zane-barber-studio/deploy/deploy.sh
```

Hace `git pull`, `npm ci`, corre `npm run check` y reinicia el servicio.

## 9. Copias de seguridad

`data/zane.sqlite` es la única fuente de verdad (clientes, órdenes, pagos).
Recomendado: un cron que la copie fuera de la VM.

```bash
# /etc/cron.d/zane-backup — copia diaria a las 3am, se queda con 14 días
0 3 * * * zane sqlite3 /opt/zane-barber-studio/data/zane.sqlite ".backup /opt/zane-barber-studio/data/backups/$(date +\%F).sqlite" && find /opt/zane-barber-studio/data/backups -mtime +14 -delete
```

Para sacarla de la propia VM (si se pierde la instancia, no sirve de nada un
backup que vive en el mismo disco), sincroniza esa carpeta a otro sitio
(otro servidor, un bucket S3-compatible, etc.) — eso ya depende de qué tengas
a mano; pregúntame cuando llegues a ese punto y lo dejamos armado.

## Resumen de lo que vive en cada sitio

| Archivo | Para qué |
|---|---|
| `deploy/setup.sh` | Aprovisiona una VM nueva (Node, nginx, usuario, systemd) |
| `deploy/deploy.sh` | Actualiza una instalación ya hecha (`git pull` + reinicio) |
| `deploy/zane-barber.service` | Unidad systemd: mantiene el proceso vivo y lo reinicia si se cae |
| `deploy/nginx.conf` | Reverse proxy, con el ajuste especial que necesita el SSE del tablero |
| `.env.example` | Plantilla de variables de entorno (copiar a `.env` en el servidor) |
