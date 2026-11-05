# Miembros de un partner (tarjeta «Miembros» de `/partners/$partnerId`)

Alcance: `src/lib/partner-members.ts`, `src/server/partner-members.repo.ts`,
`src/fn/partner-members.ts`, `src/components/PartnerMembersCard.tsx`,
`revokePartnerMember` de `src/server/backend.ts`, y el loader de
`src/routes/_authed/partners.$partnerId.tsx`. Agregada el 2026-11-03. Los códigos
para reclamar suman `src/lib/partner-claim-codes.ts`,
`src/components/PartnerClaimCodesSection.tsx`, `issuePartnerClaimCode` de
`backend.ts` y `formatDateTimeBuenosAires` de `~/lib/format`.

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

## Códigos para reclamar un taller (0144) — desde el 2026-11-03

`public.partner_claim_codes`, migración **0144** del backend. Sección «Códigos para
reclamar» dentro de la tarjeta «Miembros».

- **Lectura por SQL con guard PROPIO** (`partnerClaimCodesAvailability`,
  `CLAIM_CODE_COLUMNS`): la 0144 puede faltar en una base que ya tiene la 0141, y
  los miembros siguen andando. Sin ella: "Falta desplegar la migración 0144 del
  backend (partner_claim_codes)" y no hay botón.
- **`code_hash` NO se selecciona nunca.** No hace falta y no tiene por qué viajar.
- **El estado es derivado y lo calcula Postgres** (`canjeado` / `revocado` /
  `invalidado` / `vencido` / `pendiente`, en ese orden de `CASE`), igual que
  `hours_left`: la ficha es SSR y comparar contra el reloj del navegador sería un
  mismatch de hidratación. `invalidado` se lee "invalidado (el taller consiguió
  dueño)". Orden: pendientes primero, después `created_at desc`.
- `created_by_id` y `redeemed_by_id` son `ON DELETE SET NULL`: `LEFT JOIN users` a
  los dos; la UI dice "admin borrado" / "usuario borrado" en vez de esconder.
- **Emitir es HTTP**: `POST /admin/partners/:id/claim-codes` (`AdminGuard`, sin
  cuerpo) → 201 `{ id, partnerId, code, expiresAt }`, validado con zod
  (`issuedClaimCodeSchema`, Crockford `XXXXX-XXXXX`). Nunca SQL a la tabla.
- **La UI decide ANTES de llamar**, con lo que la ficha ya cargó: archivado → sin
  botón y el motivo; dueño activo (de `partner_members`) → sin botón, "primero
  revocá al dueño"; si no, «Emitir código» (activo o pausado). El handler
  re-chequea por SQL antes del fetch (`PARTNER_CLAIM_CODES_UNAVAILABLE`,
  `CLAIM_CODE_PARTNER_ARCHIVED`, `CLAIM_CODE_PARTNER_HAS_OWNER`,
  `CLAIM_CODE_PARTNER_NOT_FOUND`).
- **El 409 `CONFLICT` cubre DOS casos** (archivado o con dueño) y sólo cambia el
  mensaje: no se ramifica por el texto. Se lee "Otro admin cambió el taller
  mientras tanto… Recargá." — el caso conocido ya lo frenó el chequeo previo, así
  que un 409 es una carrera. 404 con `Cannot POST` = backend sin el endpoint.
- **El código es un secreto al portador** (un solo uso, 7 días). Existe en claro
  una sola vez: respuesta del POST → estado del componente → diálogo. Nunca en el
  loader, la URL, localStorage, un `console.*` ni un log del servidor; el
  `ZodError` de una respuesta mala se descarta (su mensaje traería el valor) y
  sale `CLAIM_CODE_BAD_RESPONSE`. `fetch` con `cache: 'no-store'`.
- **El diálogo sólo se cierra con su botón** (sin click afuera ni Escape: cerrar
  es perderlo). Muestra el código grande con «Copiar» (con feedback y fallback si
  el portapapeles falla), el WhatsApp registrado del partner con «Mandalo SOLO a
  este número», «Abrir WhatsApp» sólo si `canonicalWhatsAppDigits` da un número
  canónico (abre el chat con el texto, no envía nada; sin forma canónica no hay
  link, no se adivina la característica), el vencimiento en hora de Buenos Aires
  (`formatDateTimeBuenosAires`: es un texto que va a alguien de afuera) y el aviso
  de que no se vuelve a ver. Cerrar limpia el estado y `router.invalidate()`
  (también se invalida apenas vuelve el 201, para que aparezca el pendiente).
- **Puede haber VARIOS pendientes a la vez**: el panel no lo impide. El primer
  canje deja al resto `superseded` (invalidado) — lo hace el backend (tarea 4.5,
  pendiente al 2026-11-03). Hasta entonces, revocar al dueño y re-emitir es el
  camino para pasar el taller a otra persona.
- **Revocar al DUEÑO invalida los códigos pendientes** (backend `884332bb`):
  el backend les setea `superseded_at` en segundo plano. Revocar a un staff no
  los toca. Es ASINCRÓNICO, así que la relectura inmediata puede verlos todavía
  pendientes: la tarjeta relee otra vez a los 1,5 s y avisa en ámbar «Los
  códigos pendientes de este taller quedaron sin efecto. Emití uno nuevo para
  el próximo dueño». No los invalides desde el panel: no hay escritura SQL acá.
- Al 2026-11-03 la 0144 existe en DEV (`autolibre_ai_hex`) con 0 filas;
  producción sin relevar. La 0141 también, con 0 filas.

## Cómo verificar un cambio acá

`tsc --noEmit`. El recorrido real (revocar, el 204 idempotente, el 404; emitir,
el 201, el 409 de carrera, el diálogo) necesita el backend con los endpoints
levantado.
