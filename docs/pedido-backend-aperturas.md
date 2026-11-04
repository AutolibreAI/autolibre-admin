# Pedido al backend: usuarios activos por aperturas de la app (2026-11-03)

De: panel de administración (`autolibre-admin`). Para: Ramiro (backend hex) y quien tenga la app
mobile.

Tarjeta: [Usuarios activos por aperturas](https://trello.com/c/MNJ5XinV).

Relevado en producción el 2026-11-03 (`autolibre`, `doadmin`, puerto 25060), sólo lectura.

## Qué hay hoy

- No existe ningún registro de «abrió la app». Métricas › «Usuarios activos» cuenta personas que
  **hicieron algo** que queda escrito (las 16 ramas de `/actividad`) más las que renovaron el token
  push, que guarda sólo la última apertura por teléfono. La pantalla lo aclara en ámbar.
- La sección «Aperturas de la app» (DAU / WAU / MAU, stickiness, aperturas con valor, retención
  D1 / D7 / D30 por semana de alta) está armada contra datos de ejemplo.

## Qué falta

- [ ] **Evento** `app_open` desde la app al pasar a primer plano: `userId`, `occurredAt`,
  `platform`, `appVersion`, `fromNotificationId` (nullable: la apertura vino de tocar una
  notificación).
- [ ] **Tabla** `app_opens` append-only con esos campos, índice `(user_id, occurred_at)`. O PostHog
  con export a Postgres: el cruce con «hizo algo de valor» y con las notificaciones necesita los
  dos datos en el mismo lugar.
- [ ] **Lecturas** (sólo conteos, sin cuentas internas):
  - `GET /admin/app-opens/summary?window=7|30|90`: serie diaria de DAU, WAU y MAU.
  - `GET /admin/app-opens/retention`: cohortes por semana de alta con D1, D7 y D30.
  - `GET /admin/app-opens/valuable`: activos que además escanearon, chatearon (con mensaje),
    crearon un pedido o cargaron un documento el mismo día.

## Permisos

Sólo admins (`AdminGuard`). **No debe devolver** filas por persona ni `userId`: son métricas
agregadas.

## Listo cuando

- La sección «Aperturas de la app» deja el cartel de ejemplo y su DAU de hoy coincide con un
  `count(distinct user_id)` sobre `app_opens` del día (hora de Buenos Aires).
- El efecto de una notificación puede contar «abrió la app desde la notificación».

## Preguntas abiertas

1. ¿«Activo con valor» incluye sólo esas cuatro acciones o también cargar vehículo y consultar
   multas?
2. ¿Retención sobre la fecha de alta o sobre la primera apertura registrada?
3. ¿PostHog o tabla propia?
