# Zane Barber Studio

Sitio web de una sola página (landing) para la barbería, con panel administrativo
integrado y backend en Node.js + SQLite.

## Estructura

```
.
├── public/              Todo lo que sirve el navegador
│   ├── index.html       Landing + panel admin (se abre con ?admin=1)
│   ├── css/custom.css   Estilos propios
│   ├── js/script.js     Lógica del cliente (reservas, galería, admin)
│   ├── img/             Imágenes propias
│   │   ├── logo.png
│   │   ├── hero.png
│   │   └── galeria/     Fotos de la galería
│   └── vendor/          Librerías de terceros (no editar)
│       ├── bootstrap/   Bootstrap 5 (CSS + JS bundle)
│       ├── fontawesome/ Font Awesome 6 (CSS + webfonts)
│       └── fonts/       Barlow Condensed y DM Sans (CSS + woff2)
├── server/index.js      Servidor Express + API REST
├── db/
│   ├── schema.sql       Tablas (se aplican al arrancar)
│   └── seed.sql         Datos iniciales de estilos
├── data/                Runtime: base SQLite y secretos (NO se versiona)
├── _sin-usar/           Imágenes que hoy no referencia ningún archivo
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
`TOKEN_SECRET`, `PORT`).

## Panel administrativo

Se abre desde la propia landing con `?admin=1` (o la ruta `/admin`). Gestiona
clientes y preferencias de corte, recordatorios por WhatsApp a los 15 días,
catálogo de estilos, cierre de caja diario, cumpleaños del mes y respaldo
JSON (exportar/importar).

## Notas

- Las imágenes de `_sin-usar/` se conservan por si se necesitan más adelante;
  ningún HTML, CSS, JS ni SQL las referencia.
- `data/` contiene datos reales de clientes y secretos: nunca se sube al repo
  (ya está en `.gitignore`).
