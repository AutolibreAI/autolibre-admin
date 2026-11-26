# Tipos de cuenta: usuarios vs partners (`~/lib/account-type`) — desde el 2026-11-26

Alcance: `src/lib/account-type.ts`, `src/server/account-type.repo.ts`, la columna y el filtro
«Tipo de cuenta» de `/usuarios`, `/usuarios/revisar`, `getAccountTypeCensusFn` /
`listAccountReviewQueueFn` / `markAccountReviewedFn` en `src/fn/users.ts`, la card del pulso
(`PulseRow`, prop `accounts`), `migrations/043_ops_revision_de_cuentas.sql`. Pedido al back:
`docs/pedido-backend-cuentas-partner.md`.

## La regla

Los proveedores nuevos crean una cuenta y después dan de alta el taller: quedan en `users`. Hasta el
2026-11-26 se contaban como usuarios.

- **Partner** = membresía activa en `partner_members` (`revoked_at IS NULL`). **Nunca `users.role`**:
  es un solo valor y queda desactualizado (ningún camino del backend lo actualiza al vincular).
- **Uso como dueño** = auto no archivado, o pedido propio (`quote_requests.user_id`) no `duplicate`,
  o registro de conducir no archivado.
- **Admin** = `role = 'admin'`, fuera de todos los conteos (gana aunque sea partner).
- Tipos: Usuario · Partner · Partner + dueño · Admin. **Cuenta como usuario = Usuario + Partner + dueño.**
- Las cuentas internas (`INTERNAL_PREDICATE`) siguen siendo otro eje: "usuario real" = no interno Y
  cuenta como usuario → `realUserPredicate()` (alias `u`).

La suma de los cuatro tipos es el total de cuentas por construcción (un `CASE` sin hueco). Métricas
la imprime debajo del pulso.

## Dónde se aplica — si aparece un conteo de `users` que no pasa por acá, cuenta talleres

`adoptionPulse` (Usuarios reales, 7 d, 30 d), `adoptionSeries` (altas de usuarios y autos),
`onboardingSeries`, `vehicleDistribution`, `usageAdoption`, `channelPeople` (`appUsers`; un taller puro
se trata como interno: sus contactos no son "gente sin cuenta"), `businessUserMonths` y
`businessScalars` (`/negocio`), `activeUsersSeries` y `activeUserIdsSince`, y el denominador por
usuario de Costos de IA.

**No** se tocó el armador de audiencias de `/notificaciones`: tiene copia en SQL (033) y sumar una
condición «tipo de cuenta» es una migración espejo (`notifications.md`). Hoy no filtra por tipo.

## Las piezas opcionales van por contexto

`accountTypeContext()` mira `partner_members`, `quote_requests.close_reason_code` y
`driver_licenses.archived`. Sin `partner_members` nadie sale Partner (y Métricas lo dice). Un `exists`
contra una tabla que no existe explota al planificar aunque esté en una rama muerta: por eso el SQL
se ARMA según el contexto, no se escribe con un `case`.

## La cola «Revisar cuentas» (`/usuarios/revisar`)

(a) `possible_partner`: rol `user`, sin membresía, con mail igual (`lower(btrim)`) al de un taller o
una solicitud, o teléfono cuyos últimos 10 dígitos coinciden con el WhatsApp de un taller.
(b) `stale_role`: membresía activa y rol que no es `partner` ni `admin`.

- **El backend no tiene camino para vincular desde el admin** (`git grep` 2026-11-26: sólo códigos de
  reclamo que canjea la persona y revocar). Acción: «Marcar revisado» con nota (`ops.account_review`,
  043, una fila por cuenta+caso, sin fila = pendiente; «Volver a pendiente» borra). Cuando exista el
  endpoint, el botón es «Vincular» con confirmación y llama por HTTP.
- **Mail y teléfono sólo acá** (y en la ficha del usuario, como siempre). `adminMiddleware`.
- Producción 2026-11-26: (a) 18 cuentas, 6 con auto; (b) 1. `users.phone` vacío en todas: el cruce
  por teléfono hoy no encuentra nada, está por si se llena.

## Cómo verificar

`tmp/probe-cuentas.mjs` (con `dotenv/config` y `cacheDir` propio) carga los repos reales e imprime el
censo, el pulso, la adopción, los canales, las series y la cola. Producción 2026-11-26: 1.097 =
1.062 + 24 + 2 + 9; usuarios reales 1.064 en las cinco lecturas.
