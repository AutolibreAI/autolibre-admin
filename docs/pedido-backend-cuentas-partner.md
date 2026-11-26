# Pedido al backend: vincular cuentas a talleres desde el admin (2026-11-26)

De: panel de administración (`autolibre-admin`). Para: Ramiro (backend hex).

Tarjeta: «Separar usuarios y partners en los conteos».

Relevado el 2026-11-26 sobre `main` del backend (7d632fb) y producción (sólo lectura).

## Qué hay hoy

- Ser partner es una membresía (`partner_members`, 0141), no un rol. El panel ya cuenta así: una
  cuenta con membresía activa es Partner, y deja de contar como usuario salvo que también use la app
  como dueño (auto, pedido propio o registro). → `src/lib/account-type.ts`.
- Las membresías nacen sólo por dos caminos: el canje de un código de reclamo
  (`POST /partner-claim-codes/redemptions`, lo hace la persona) y la aprobación de la solicitud que
  esa cuenta registró logueada (`application_approval`, 0150). **No hay un endpoint con `AdminGuard`
  para vincular una cuenta existente a un taller** (sólo `POST /admin/partners/:id/claim-codes` y
  `POST /admin/partner-members/:id/revoke`).
- **Ningún camino actualiza `users.role`.** Una cuenta vinculada queda con el rol que tenía.

Producción, 2026-11-26: 1.097 cuentas. 25 con membresía activa; 1 de ellas sigue con rol `user`.
18 cuentas `user` sin membresía comparten el mail con un taller o una solicitud (6 con auto): son,
casi seguro, dueños que se registraron y nunca quedaron vinculados. El panel las lista en
`/usuarios/revisar` y sólo puede marcarlas como revisadas.

## Qué falta

- [ ] **Vincular desde el admin**: `POST /admin/partners/:partnerId/members` (`AdminGuard`) con
  `{ userId, memberRole: 'owner' | 'staff' }`, `verified_via` nuevo (p. ej. `admin_link`) y
  `revoked_*` NULL. Mismas reglas que el canje: a lo sumo un dueño activo (409 `CONFLICT` si ya hay
  uno), una membresía activa por `(partner, user)` (idempotente si ya está), y que dé de baja los
  códigos pendientes cuando entra un dueño (como hoy con `PartnerMemberAdded`).
- [ ] **Que vincular actualice `users.role`**: al crear una membresía activa (por cualquiera de los
  tres caminos), si el rol es `user`, pasarlo a `partner`. Al revocar la ÚLTIMA membresía activa,
  volverlo a `user`. Nunca tocar un `admin`.
- [ ] Backfill único: las cuentas con membresía activa y rol `user` → `partner` (hoy 1).

## Listo cuando

- El panel puede vincular una cuenta de la cola con un botón (con confirmación) y deja de mostrar
  sólo «Marcar revisado».
- `select count(*) from users u where u.role = 'user' and exists (select 1 from partner_members pm
  where pm.user_id = u.id and pm.revoked_at is null)` da 0.
