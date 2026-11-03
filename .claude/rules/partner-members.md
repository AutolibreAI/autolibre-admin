# Miembros de un partner (tarjeta «Miembros» de `/partners/$partnerId`)

Alcance: `src/lib/partner-members.ts`, `src/server/partner-members.repo.ts`,
`src/fn/partner-members.ts`, `src/components/PartnerMembersCard.tsx`,
`revokePartnerMember` de `src/server/backend.ts`, y el loader de
`src/routes/_authed/partners.$partnerId.tsx`. Agregada el 2026-11-03.

## Qué es

Las cuentas de la app vinculadas a un taller: `public.partner_members`, migración
**0141** del backend. Una fila = un usuario (`user_id`) con un rol (`owner` |
`staff`) en un partner. A lo sumo un dueño activo y una membresía activa por
`(partner, user)` (índices únicos parciales del backend).

## Lee por SQL, con guard; escribe SÓLO por HTTP

- **Lectura**: `listPartnerMembers` (SQL directo), detrás de
  `partnerMembersAvailability()` — `to_regclass('public.partner_members')` +
  `information_schema.columns` de TODAS las columnas que se leen
  (`MEMBER_COLUMNS`). Sin la 0141 la tarjeta dice "Falta desplegar la migración
  0141 del backend (partner_members)" y no muestra botones; nunca un 500. **Si
  se lee una columna nueva, se suma a `MEMBER_COLUMNS` el mismo día.**
- **Escritura**: `POST /admin/partner-members/:id/revoke` (`AdminGuard`), sin
  cuerpo, con el token de Clerk del admin. **Nunca SQL a `partner_members`**:
  si aparece un `INSERT`/`UPDATE` en este repo, está mal.
- El handler de `revokePartnerMemberFn` re-chequea el guard ANTES del fetch
  (`PARTNER_MEMBERS_UNAVAILABLE`) y verifica por SQL que el miembro sea del
  `partnerId` de la ficha (`PARTNER_MEMBER_NOT_IN_PARTNER`): un id suelto del
  payload no se revoca a través de la ficha de otro taller.

## Semántica que no hay que romper

- **Activo = `revoked_at IS NULL`.** No hay columna de estado; no la inventes.
- **`verified_via` es un enum ABIERTO** (hoy `admin_code`, viene
  `whatsapp_otp`). Un valor sin etiqueta en
  `PARTNER_MEMBERSHIP_VERIFICATION_LABELS` se muestra CRUDO. Los enums viajan
  `::text` desde el SQL por eso.
- **`revoked_by_id` puede ser NULL en una fila revocada** (FK `ON DELETE SET
  NULL`: el admin que revocó se borró). La UI dice "admin borrado", no esconde la
  fila. `LEFT JOIN` a `users r`; a `users u` (el miembro) es `JOIN`, porque
  `user_id` es NOT NULL.
- **El 204 es idempotente y sin cuerpo**: no se lee JSON, y después de un éxito
  se hace `router.invalidate()` para releer de SQL — no se asume el estado.
- Orden: activos primero, dueño antes que staff, después `created_at desc`.

## Errores

`backendError(..., { detailed: true })` → `readablePartnerMemberError`. 404 con
`Cannot POST` = backend sin el endpoint; cualquier otro 404 = "Ese miembro ya no
existe; recargá". 403 = el usuario no es admin en el backend.
`BACKEND_UNREACHABLE` nombra `AUTOLIBRE_BACKEND_URL`.

## Pendiente

- **Códigos para reclamar un taller** (emitirle a alguien un código para ser
  dueño): migración aparte del backend, **número a confirmar**, sin pantalla.
  Mientras tanto, revocar al dueño deja el taller sin dueño y la confirmación lo
  dice.
- Al 2026-11-03 la 0141 existe en DEV (`autolibre_ai_hex`) con 0 filas; producción
  sin relevar.

## Cómo verificar un cambio acá

`tsc --noEmit`. El recorrido real (revocar, el 204 idempotente, el 404) necesita
el backend con el endpoint levantado.
