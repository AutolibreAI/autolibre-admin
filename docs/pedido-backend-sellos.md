# Pedido al backend: sellos de proveedores (2026-11-03)

De: panel de administración (`autolibre-admin`). Para: Ramiro (backend hex).

Tarjeta: [Sellos de proveedores](https://trello.com/c/QcG4ngc8).

Relevado en producción el 2026-11-03 (`autolibre`, `doadmin`, puerto 25060), sólo lectura.

## Qué hay hoy

- **Aliado** es real: `partners.tier = founding`, se cambia desde Perfil en la ficha.
- Redes de talleres y aseguradoras: la tarjeta «Sellos» de la ficha (asignar, verificar, revocar,
  historial, vencido calculado contra hoy) y la pestaña Partners › Sellos (importar el CSV de una
  red y cruzarlo contra los proveedores) son de ejemplo: no se guarda nada.
- El cruce del CSV es real y determinístico: teléfono normalizado (igual que Comercial), dirección
  normalizada, nombre exacto. Nunca por parecido. CUIT se lee pero no cruza: `partners.cuit` no
  existe.

## Qué falta

- [ ] Tabla `seals`: `id`, `slug`, `name`, `kind` (`alliance | network | insurer`),
  `requires_expiry boolean`.
- [ ] Tabla `partner_seals`: `partner_id`, `seal_id`, `status` (`pending | verified | revoked`;
  `expired` se deduce de `expires_at`), `source`, `verified_at`, `expires_at`, `granted_by`,
  `revoked_at`, `revoked_by`. Un vigente por proveedor y por sello.
- [ ] `partners.cuit` (nullable) para cruzar listados por CUIT.
- [ ] `POST /admin/partners/:id/seals` (asignar), `POST /admin/partner-seals/:id/verify`,
  `POST /admin/partner-seals/:id/revoke`.
- [ ] `POST /admin/seal-imports`: filas YA cruzadas y confirmadas por una persona en el panel
  (`partnerId`, `sealId`, `status`, `source`, `expiresAt`). El backend no vuelve a cruzar.
- [ ] Lectura de sellos por proveedor para el filtro del catálogo de la app.

## Permisos

Sólo admins (`AdminGuard`), auditado con el actor de la sesión. La lectura pública (catálogo de la
app) sólo devuelve sellos `verified` y no vencidos.

## Listo cuando

- Asignar, verificar y revocar un sello desde la ficha sobrevive a recargar, con historial.
- Importar un CSV de una red deja asignados los proveedores confirmados, y ninguno dos veces.
- La app puede filtrar el catálogo por sello.

## Preguntas abiertas

1. ¿Aliado pasa a ser un sello más (y `tier` se retira) o conviven?
2. ¿Qué redes y aseguradoras vienen en el primer listado, y qué columnas trae el CSV?
3. ¿El listado de una red alcanza para «verificado», o siempre entra «pendiente»?
4. ¿Un sello vencido se muestra en la app como vencido o desaparece?
