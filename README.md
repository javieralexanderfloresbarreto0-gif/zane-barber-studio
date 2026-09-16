# Zane Barber Studio

Sitio web de una sola página (landing) para la barbería, con panel administrativo
integrado y backend en Node.js + SQLite.

## Estructura

```
.
├── public/              Todo lo que sirve el navegador
│   ├── index.html       Landing + panel admin (se abre con ?admin=1)
│   ├── css/custom.css   Estilos propios
│   ├── js/script.js     Landing + panel admin (reservas, galería, clientes…)
│   ├── js/board.js      Tablero de turnos en vivo (pestaña "Turnos" del panel)
│   ├── kiosc/           App de la tablet de autoservicio (/kiosc, PWA)
│   ├── img/             Imágenes propias (logo, hero, galeria/)
│   └── vendor/          Librerías de terceros (bootstrap, fontawesome, fonts)
├── server/
│   ├── index.js         Servidor Express + API REST (landing, clientes, tasa…)
│   └── kiosc/mount.js   Rutas del kiosco: catálogo, órdenes, Pago Móvil, SSE
├── db/
│   ├── schema.sql       Tablas base (se aplican al arrancar)
│   ├── seed.sql         Datos iniciales (estilos, tasa)
│   └── kiosc.sql        Tablas del kiosco (services, orders, kiosc_devices…)
├── data/                Runtime: SQLite, secretos y comprobantes (NO se versiona)
├── deploy/              systemd, nginx y scripts para producción (ver DEPLOY.md)
├── .env.example         Variables de entorno de ejemplo
└── package.json
```

## Puesta en marcha

```bash
npm install
npm start        # http://localhost:3000
npm run dev      # igual, con recarga al guardar
```

En el primer arranque, si no defines `ADMIN_PASSWORD` en el entorno, el servidor
genera una contraseña de administrador y la muestra **una sola vez** en consola.
Guárdala. Variables disponibles en `.env.example` (`ADMIN_PASSWORD`,
`TOKEN_SECRET`, `PORT`, `BASE_URL`, `TZ`, `TRUST_PROXY`).

`TZ` (por defecto `America/Caracas`) fija la zona horaria del proceso: de ella
dependen el agrupado "hoy" de la cola de turnos y los cierres de caja. En un
servidor en UTC sin `TZ`, el día rotaría a las 20:00 hora de Venezuela.

`TRUST_PROXY` solo se define si el sitio va detrás de un proxy inverso (nginx,
Cloudflare): pon el número de saltos (normalmente `1`) para que el bloqueo de
login por IP y las URLs `https://` funcionen bien.

`BASE_URL` es el dominio público del sitio; se usa para las URLs absolutas de las
etiquetas SEO (Open Graph, canónica, JSON-LD `HairSalon`). En local no hace falta
—se deriva del host—, pero en producción detrás de un proxy HTTPS conviene
fijarlo (`BASE_URL=https://tu-dominio.com`). El servidor renderiza `index.html`
sustituyendo `{{BASE_URL}}` por ese valor en cada petición.

Las respuestas se sirven con `compression` (gzip/brotli) y los estáticos con
`Cache-Control`: `vendor/` de forma agresiva (filename estable) e `img/` una
semana.

## Despliegue

Para ponerlo en producción gratis (Oracle Cloud Always Free), ver
[DEPLOY.md](DEPLOY.md) — incluye los ficheros de `deploy/` (systemd, nginx,
scripts de aprovisionamiento y actualización).

## Panel administrativo

Se abre desde la propia landing con `?admin=1` (o la ruta `/admin`). Gestiona
clientes y preferencias de corte, recordatorios por WhatsApp a los 15 días,
catálogo de estilos, cierre de caja diario, cumpleaños del mes y respaldo
JSON (exportar/importar).

## Kiosco de turnos (tablet)

`/kiosc` es la app de autoservicio para una tablet en recepción: el cliente elige
servicio, deja nombre y teléfono, paga por Pago Móvil y espera su turno. El
barbero valida los pagos y mueve la cola desde la pestaña **Turnos** del panel,
que se actualiza en vivo por SSE. Cada tablet se registra desde esa pestaña
(genera un enlace de enrolamiento de un solo uso).

## Notas

- `data/` contiene datos reales de clientes, secretos y comprobantes de pago:
  nunca se sube al repo (ya está en `.gitignore`). Los comprobantes se borran
  solos a los 7 días.
- El export JSON del panel solo respalda **clientes**; las órdenes y los pagos
  del kiosco viven únicamente en `data/zane.sqlite`.
- No hay migraciones: los tres `.sql` se re-ejecutan al arrancar con
  `CREATE TABLE IF NOT EXISTS`. Añadir una columna a una tabla ya creada exige
  hacerlo a mano en la BD existente.
