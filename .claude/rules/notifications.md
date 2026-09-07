# Notificaciones (`/notificaciones`)

Alcance: `src/lib/notifications.ts`, `src/server/notifications.repo.ts`,
`src/fn/notifications.ts`, `src/routes/_authed/notificaciones.index.tsx`, y el
link en el bloque `Notifications` de `src/routes/_authed/usuarios.$userId.tsx`.

## Qué consulta reemplaza

El `select * from notifications where user_id = '…'` — hoy la única forma de ver
de qué le avisamos a una persona y si le llegó. El censo de `/usuarios/:id`
cuenta esa relación pero no la muestra; `/operacion` la agrega en cuatro números
(`ok` / `failed` / `stuck` / `retrying`) y manda acá para el detalle. Esta
pantalla es la fila.

Es listado solo, **sin detalle por notificación**: una notificación no tiene
subcolección (a diferencia de un chat con sus mensajes), así que una ruta
`/notificaciones/:id` no reemplazaría ninguna consulta nueva. Si algún día hace
falta ver `provider_message_ids` o `receipts_checked_at` crudos, ahí sí.

## `status` y `delivery_status` son DOS ejes — leer uno sin el otro miente

`notifications.status` es `pending | sent | read` (el ciclo de vida de la fila).
`notifications.delivery_status` es `null | sent | failed | no_token` (qué dijo el
proveedor push). La pantalla los combina en un estado derivado —
`NOTIFICATION_STATES` en `~/lib/notifications` — y **el orden de los `WHEN` del
`CASE` importa**: `read` gana, después las marcas del proveedor, y al final el
reloj.

| Estado derivado | `status` | `delivery_status` | Qué significa |
|---|---|---|---|
| `leida` | `read` | — | La persona la abrió. |
| `entregada` | `sent` | `sent` | Aceptada por el proveedor. |
| `rechazada` | `sent` | `failed` | El proveedor la aceptó y **un receipt la rechazó después** (`receipts_checked_at`). `status` ya quedó en `sent`: es TERMINAL, no se reintenta. |
| `sin_token` | `pending` | `no_token` | Se intentó, la persona no tiene dispositivo. `notification-delivery.cron` NO toca `status`, así que **se reintenta cada minuto para siempre**. |
| `atrasada` | `pending` | `null` | Nunca se intentó y el `scheduled_at` venció hace más de 30 min. **Deducción nuestra, no un estado del dominio.** |
| `programada` | `pending` | `null` | Nunca se intentó, todavía en ventana. |
| `enviada` | `sent` | `null` | Se mandó, sin confirmación de entrega. No aparece en prod hoy; la red por si aparece. |
| `desconocida` | cualquier otro | | La combinación que el `CASE` no cubre. Se ve, no se esconde. |

**`sin_token` y `rechazada` se ven parecido y son opuestos**: uno reintenta para
siempre, el otro no reintenta nunca. Es la misma distinción que `stuck` vs
`retrying` en `.claude/rules/ops-metrics.md`, y confundirlas manda a "arreglar"
lo que el backend ya está reintentando solo.

## `atrasada` es deducción del reloj — y el umbral vive en UN lugar

`NOTIFICATION_DELAYED_AFTER_MIN = 30` en `~/lib/notifications.ts`. 30 min porque
`notification-delivery.cron` corre cada minuto: media hora sin un solo intento
no es lentitud, es el cron caído.

**`src/server/ops.repo.ts` IMPORTA esa constante** para el `stuck` de la cola de
notificaciones de `/operacion`. No están duplicadas a propósito: las dos
pantallas tienen que decir lo mismo sobre la misma notificación. Si alguien
vuelve a poner un `30` literal en `ops.repo.ts`, es un bug esperando a divergir
— misma familia que `INTERNAL_PREDICATE` entre `ops.repo.ts` y `v_ai_usage`.

Que sea derivada no es licencia para presentarla como dato del dominio: la UI la
pinta ámbar, no roja (el cron la va a reintentar; algo hay que mirar pero no
está perdida), igual que `stuck` en `/operacion` y `noData` en `/escaneres`.

> **Relevado el 2026-09-07 contra producción: 35 de 72 notificaciones estaban
> `atrasada`** — pendientes, `scheduled_at` vencido hace 1 a 7 días, sin un solo
> intento de entrega. No es un caso de borde inventado para la tabla: es el
> estado real de más de la mitad de la base, y `/operacion` ya lo estaba
> contando como `stuck`. La pantalla lo hace visible fila por fila.

## El `type` de la URL se llama `kind`, y NO es un capricho

`notificationSearchSchema` usa la clave `kind` para el filtro de
`notification_type`. `/chats` ya tiene un search param `type` que es un
`z.enum` cerrado (`all | diagnostico | general`). TanStack Router arma un tipo
**unión de TODOS los search params del router**, así que un `type: z.string()`
acá ensancha el de chats a `string` y **rompe el typecheck de
`chats.index.tsx`** en sus `<Link search={(prev) => ({ ...prev, … })}>` — un
error en un archivo que nadie tocó.

- La columna en la base y el campo de `NotificationListItem` siguen siendo
  `type`. Sólo la llave de la URL es `kind`.
- Vale para cualquier search param nuevo: **antes de nombrarlo, `grep` los
  schemas de `~/lib/*.ts`** por esa clave. Si otra ruta la usa con un tipo más
  angosto, elegí otro nombre. `q`, `sort`, `dir` se comparten sin problema
  porque coinciden en tipo (`string` / enums que cada ruta valida por su lado);
  el conflicto es `string` contra `enum`.

## El filtro de `kind` y `channel` es data-driven; el de `state` es cerrado

- `kind` y `channel`: las opciones salen de `listNotificationFacets()` —
  `select distinct` sobre la base. Un valor nuevo del enum aparece en los chips
  sin tocar código, mismo criterio que `listDistinctChatModels` en
  `chats.repo.ts`. `NOTIFICATION_TYPE_LABELS` tiene los seis valores del enum a
  mano sólo para la etiqueta legible; un valor sin label se muestra CRUDO.
- `state`: es vocabulario NUESTRO (derivado, no un enum del backend), así que la
  lista es cerrada en `~/lib/notifications` y los chips son fijos.

`facets.channels.length > 1` esconde el grupo de canal mientras haya un solo
canal (hoy todo es `push`): un filtro con una sola opción es ruido.

## El join al vehículo es LEFT en las tres patas

```sql
left join vehicles v on v.id = n.vehicle_id
left join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
left join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
```

`notifications.vehicle_id` es nullable — una notificación de licencia de
conducir (`source_type = 'driver_license'`) no tiene auto. Hoy el 100% de las
filas de prod tiene `vehicle_id`, pero un `join` (no `left`) en cualquiera de
las tres patas haría desaparecer del listado a las que no — misma trampa que
documentan `chats.md` y `scanner-compatibility.md`. `vehicles` apunta al SPEC,
no al catálogo: son dos saltos.

## `q` y todos los filtros van en el WHERE de AFUERA

Igual que `chats.repo.ts` y por el mismo motivo: `state` es una expresión
calculada (el `CASE`) y `q` busca sobre `title` / `body` / `vehicle_plate`, que
no son columnas de `notifications` — son el join o el CASE, y no existen todavía
en el nivel del WHERE interno. El envoltorio `select * from (...) s` está por
eso. **La única excepción es `user_id`**: es columna cruda de `notifications`,
así que va en el WHERE interno y acota el barrido antes de calcular nada.

## `adminMiddleware` en las tres lecturas

El cuerpo de una notificación es lo que le mostramos a la persona sobre su auto:
patente, vencimiento de documentos, códigos de falla. Un server function es un
endpoint HTTP público — mismo criterio que `users.ts` y `chats.ts`. Sin el guard
cualquier sesión válida de la app se baja el historial de avisos de cualquiera.

## Ni una escritura

`notifications` la escribe el backend (`notifications/`). Un aviso es un hecho
que pasó, no un estado que el admin mueva — mismo criterio que `driving_sessions`
y `conversations`.

Y las dos escrituras que van a tentar ya se descartaron en
`.claude/rules/ops-write-actions.md`, con motivo técnico y no con la regla:

- **Reintentar una fallida** → no-op. `notification-delivery.cron` ya reintenta
  cada minuto sin tope; `markAsFailed()` / `markAsNoToken()` no tocan `status`.
- **Cortar el loop de una `sin_token`** → no se puede honestamente:
  `notification_status` es `pending | sent | read`, **no hay estado terminal de
  falla**. El arreglo real es un valor nuevo en ese enum, que vive en el schema
  del backend. Empujar `scheduled_at` al futuro es un workaround que reescribe
  un campo del dominio para un efecto que ese campo no significa.

Si aparece un `UPDATE` / `INSERT` en `notifications.repo.ts`, está mal.

## `notification_rules` NO tiene `user_id`

Son plantillas globales (`source_type` + `offset_value`/`offset_unit`/
`offset_direction`), 22 filas todas `active` en prod. `notifications.rule_id`
apunta a la que generó una notificación de vencimiento/mantenimiento (nulo para
las event-driven como `diagnostic_available` y `vehicle_data_ready`). Esta
pantalla NO las muestra — si algún día hace falta una vista de reglas y
preferencias, es otra pantalla y otra consulta.

## Cómo verificar un cambio acá

`pnpm typecheck` + `pnpm build` (en esta máquina: `& ".\node_modules\.bin\vite.CMD" build`
y después `tsc.CMD --noEmit` — el build regenera `routeTree.gen.ts`, así que un
search param nuevo sólo se valida DESPUÉS del build). Y el chequeo de borde
server-only:

```bash
grep -rl "POSTGRES_DATABASE_URL\|sqlOne\|DERIVED_STATE" .output/public
```

Cero resultados. `~/server/notifications.repo` no está en el grafo del cliente.
