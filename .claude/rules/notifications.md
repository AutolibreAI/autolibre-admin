# Notificaciones (`/notificaciones`, `/notificaciones/envios`)

Alcance: `src/lib/notifications.ts`, `src/server/notifications.repo.ts`,
`src/fn/notifications.ts`, `src/routes/_authed/notificaciones.index.tsx`,
`src/components/BroadcastComposer.tsx`, `broadcastNotification` en
`src/server/backend.ts`, y el link en el bloque `Notifications` de
`src/routes/_authed/usuarios.$userId.tsx`.

Desde el 2026-09-16 suma dos capacidades, cada una con su sección al final de
este archivo: **armar la audiencia por condición** (`src/lib/audience.ts`,
`src/server/audience.repo.ts`, `src/components/AudienceBuilder.tsx`) y **ver los
envíos ya hechos con lo que pasó después** (`src/lib/campaigns.ts`,
`src/server/campaigns.repo.ts`, el layout `notificaciones.tsx` y las dos rutas de
`notificaciones.envios.*`).

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

## Los search params se llaman `notificationType`, `notificationState` y `notificationBroadcastId`

No es cosmética: **las dos colisiones que estos nombres esquivan ya rompieron
un build de producción**, el 2026-09-07, al mergear esta rama contra `main`.

TanStack Router arma un tipo unión de **todos** los search params del router
(`FullSearchSchema`), y el spread `{...prev}` de un updater
`<Link search={(prev) => ({ ...prev, … })}>` arrastra el tipo ancho. Dos rutas
que usan la misma clave con enums distintos rompen el typecheck **en la ruta
ajena**, no en la propia:

| Clave | Quién más la usa | Síntoma exacto |
|---|---|---|
| `kind` | `/documentos` — `z.enum(['all','cedula','registro','seguro','vtv'])` | `Type 'string' is not assignable to '"all" \| "cedula" \| …'` en `documentos.index.tsx` |
| `state` | `/vehiculos/listado` — `z.enum(['all','active','archived'])` | `Type '"active"' is not assignable to '"atrasada" \| "entregada" \| …'` en `notificaciones.index.tsx` |

Ninguno de los dos archivos había sido tocado. Y **el build de Vercel no
typecheckea**, así que en el merge el error salió por otro lado — sólo
`pnpm typecheck` los muestra.

Lo que hace esto especialmente traicionero: la versión anterior de esta rule
recomendaba `kind` como el nombre SEGURO para esquivar el `type` de `/chats`.
Lo era — hasta que `/documentos` eligió `kind` por exactamente el mismo motivo,
en otra rama. **Esquivar un nombre tomado eligiendo otro nombre genérico sólo
mueve la colisión de lugar.**

Regla que reemplaza a la anterior: **un search param con enum o tipo propio se
nombra CALIFICADO por su dominio** — `notificationType`, `notificationState`,
`vehicleType`. No `type`, no `kind`, no `state`. Un nombre genérico es un
nombre que otra pantalla va a querer.

- La columna en la base y el campo de `NotificationListItem` siguen siendo
  `type` y `state`. Sólo cambia la llave de la URL.
- `notificationBroadcastId` (uuid) filtra `source_type = 'broadcast' and
  source_id = …`, en el WHERE INTERNO igual que `user_id` (son columnas
  crudas). No se llama `broadcastId` por la misma regla, aunque hoy nadie más
  lo use.
- `q`, `sort`, `dir`, `userId` se comparten sin problema: coinciden en tipo
  (`string`, o enums que cada ruta valida por su lado). El conflicto es
  `string` contra `enum`, o dos enums disjuntos.
- Antes de nombrar uno nuevo: `grep -rn "<clave>:" src/lib/*.ts`.

## El filtro de tipo y canal es data-driven; el de estado es cerrado

- `notificationType` y `channel`: las opciones salen de `listNotificationFacets()` —
  `select distinct` sobre la base. Un valor nuevo del enum aparece en los chips
  sin tocar código, mismo criterio que `listDistinctChatModels` en
  `chats.repo.ts`. `NOTIFICATION_TYPE_LABELS` tiene los valores del enum a
  mano (siete, con `announcement`) sólo para la etiqueta legible; un valor sin
  label se muestra CRUDO.
- `notificationState`: es vocabulario NUESTRO (derivado, no un enum del backend), así que la
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
así que va en el WHERE interno y acota el barrido antes de calcular nada (lo
mismo `source_type`/`source_id` de `notificationBroadcastId`).

## `adminMiddleware` en todos los server functions

El cuerpo de una notificación es lo que le mostramos a la persona sobre su auto:
patente, vencimiento de documentos, códigos de falla. Un server function es un
endpoint HTTP público — mismo criterio que `users.ts` y `chats.ts`. Sin el guard
cualquier sesión válida de la app se baja el historial de avisos de cualquiera,
o le manda un push a quien quiera.

## La única escritura: el envío ad-hoc, por HTTP

"Nueva notificación" (`BroadcastComposer`) manda un push a usuarios elegidos a
mano. **No escribe Postgres**: llama a `POST /notifications/broadcast` del
backend hex (`AdminGuard`) con el token de Clerk del admin, desde
`broadcastNotification` en `backend.ts`. `notifications.repo.ts` sigue siendo de
solo lectura; lo que suma es el buscador de destinatarios y la lectura de vuelta.

**Por qué no un SP de `ops`**: el grep al backend da positivo, y con eso alcanza
(`ops-write-actions.md`). Pero además un `INSERT` estaría mal: se saltearía el
filtro de preferencias (`CreateNotificationsHandler` descarta a quien silenció
`announcement` en push) y `Notification.create()`, que deriva `type` de
`source_type` (`broadcast → announcement`) y trimea título y cuerpo.

Las trampas, todas verificadas contra el código del backend:

- **`broadcastId` es la clave de idempotencia y la genera el CLIENTE.** Cada fila
  queda `source_type = 'broadcast'`, `source_id = broadcastId`, y
  `idx_notifications_adhoc_source_unique (user_id, source_type, source_id)` + `ON
  CONFLICT DO NOTHING` descartan la repetida. El compositor genera UNO al abrirse
  y lo conserva tras un error, un cierre del panel o un doble click; lo regenera
  sólo después de un envío exitoso. Un timeout puede haber creado las filas:
  reintentar con el mismo id es lo que evita el push doble.
- **Mismo id + texto editado no hace nada** para quien ya tenía su fila. Si el
  intento fallido llegó al backend, esas personas se quedan con el texto viejo.
  La UI lo avisa después de un intento.
- **Un userId inexistente tira el lote ENTERO con 400** (FK `23503` →
  `VALIDATION_ERROR`; es un solo INSERT). El picker elige de nuestro SELECT, así
  que significa "se borró entre que lo elegiste y enviaste". Se traduce en
  `readableBroadcastError` (sentinela `BROADCAST_REJECTED:`).
- **204 sin cuerpo: el backend no dice cuántas creó.** Menos filas que
  elegidos es normal (silenciados, o ya existentes). La cuenta se lee de vuelta
  por `source_id` en `broadcastResult`, con el MISMO `DERIVED_STATE` que el
  listado.
- **Sin token no es error**: la fila se crea y queda `sin_token`, reintentando
  para siempre. Por eso el buscador trae `pushTokens` y el chip lo pinta ámbar
  AL ELEGIR, no después.
- **Sin deep link todavía.** La fila no lleva destino en la app; agregarlo toca
  backend y mobile, es otra feature.
- `scheduledAt` sale de un `datetime-local` (hora local del navegador) pasado a
  UTC con `toISOString()`. El schema exige futuro: el backend acepta uno pasado y
  lo manda ya, que casi siempre es un error de zona horaria sin vuelta atrás.
- Los topes (500 destinatarios, título 100, mensaje 500) espejan el DTO del
  backend. El de 500 no se configura del otro lado: el alta es un INSERT
  sincrónico.

## Las escrituras que se descartaron

Una notificación existente es un hecho que pasó, no un estado que el admin mueva
— mismo criterio que `driving_sessions` y `conversations`. Y las dos escrituras
que van a tentar ya se descartaron en
`.claude/rules/ops-write-actions.md`, con motivo técnico y no con la regla:

- **Reintentar una fallida** → no-op. `notification-delivery.cron` ya reintenta
  cada minuto sin tope; `markAsFailed()` / `markAsNoToken()` no tocan `status`.
- **Cortar el loop de una `sin_token`** → no se puede honestamente:
  `notification_status` es `pending | sent | read`, **no hay estado terminal de
  falla**. El arreglo real es un valor nuevo en ese enum, que vive en el schema
  del backend. Empujar `scheduled_at` al futuro es un workaround que reescribe
  un campo del dominio para un efecto que ese campo no significa.

Si aparece un `UPDATE` / `INSERT` en `notifications.repo.ts`, está mal — también
para crear: eso va por `backend.ts`.

## Audiencias por condición (`AudienceBuilder`) — desde el 2026-09-16

Alcance: `src/lib/audience.ts`, `src/server/audience.repo.ts`,
`previewNotificationAudience` en `src/fn/notifications.ts`,
`src/components/AudienceBuilder.tsx`.

Reemplaza el `select u.id, u.email from users u where <condición>` de DBeaver
seguido de pegar los uuid de a uno en el buscador del compositor. Con 48
usuarios sin vehículo cargado eso no se hacía: se mandaba de a uno, o no se
mandaba.

### Lo que viaja NO es SQL, y esa es toda la defensa

Una condición es `{field, op, value}` con `field` y `op` de **enums cerrados** y
`value` un entero validado por zod. La expresión SQL vive en `AUDIENCE_SQL`
(`audience.repo.ts`), un `Record` que los tipos obligan a cubrir — mismo patrón
que `SORT_COLUMNS` en `users.repo.ts`. El único dato del llamador que llega a la
consulta es `value`, y va por parámetro.

Acá pesa más que en un `ORDER BY`: un server function es un endpoint HTTP
público, y el resultado de esta consulta decide **a quiénes les suena el
teléfono**. Un campo de texto libre que llegue al `where` no es una mejora de
producto, es una inyección.

Corolario: **una condición que no está en `~/lib/audience` no se puede pedir.**
Agregarla son dos líneas (el catálogo y la expresión), nunca un input libre.

### Se combinan con Y, nunca con O

Un armador con `OR` necesita paréntesis, y un paréntesis mal puesto le manda un
push a gente que no corresponde sin que nada lo delate. Para una unión, son dos
envíos. No es una limitación a "mejorar después": es la decisión.

### `null` no matchea, y es lo que nadie espera

«Último escaneo · fue hace más de · 30 días» NO incluye a quien nunca escaneó: en
SQL eso da `null` y el `where` lo descarta. Para esa gente está el operador
«nunca pasó», que es otra condición y se elige a propósito. El corte de cada
campo está en su `hint`, que la UI muestra: el corte no se adivina.

### Los cortes no se inventan: se repiten

`scansOk` es el `completed` + `total_readings > 0` de `scanners.repo.ts`.
`chats` exige al menos un mensaje, como `usageAdoption`. `pendingFines` es el
`status = 'pending'` de `fines.repo.ts`. `isInternal` es `INTERNAL_PREDICATE`.
`lastActivity` es `lastSignalSql('u.id')` **sin piso**, para que `null` siga
significando "se registró y no hizo nada" igual que en `/usuarios`. Si alguno
diverge, dos pantallas del panel dicen dos verdades sobre el mismo usuario.

### La condición resuelve a destinatarios EXPLÍCITOS antes de enviar

"Usar estos N" trae la lista de usuarios y la vuelca en los mismos chips que el
buscador a mano; después de eso el envío es el de siempre, un `POST` con
`userIds`. **La audiencia NO se manda como condición.** Dos motivos, y cualquiera
alcanza:

- el backend recibe ids, y **un solo id inválido le tira el lote entero**;
- **quien manda ve a quién le manda antes de apretar Enviar.** Una audiencia que
  se resuelve del lado del servidor en el momento del envío le manda un push a un
  grupo que nadie miró.

Por lo mismo, cargar una condición **reemplaza** la lista en vez de sumarse:
sumar dos condiciones sería un `OR` encubierto, que es justo lo que el armador no
ofrece.

### El corte de 500 tiene que ser ESTABLE

`matched` (el total real) y `recipients` (los que entran en un envío) son dos
números distintos y los dos se muestran: mandarle a 500 de 1300 sin decirlo es la
peor versión de esta pantalla. El orden es `created_at, id` —los más viejos
primero— y eso es parte del contrato: si el corte no fuera determinista,
previsualizar dos veces armaría dos grupos distintos y el segundo envío le
repetiría el push a la mitad.

Los tres conteos salen de `count(*) over ()`, que Postgres calcula ANTES del
`limit`, en la MISMA consulta que trae las filas. Con una segunda consulta serían
dos snapshots, y el total de arriba podría no corresponderse con la lista de
abajo — que es justo el número que se lee antes de apretar Enviar.

### La vista previa es POST

Es la única lectura del módulo que no es GET: el payload es un array de
condiciones y una query string tiene tope de largo. El método sigue a la FORMA
del pedido, no a si escribe.

## Envíos (`/notificaciones/envios`, `/notificaciones/envios/:id`) — desde el 2026-09-16

Alcance: `src/lib/campaigns.ts`, `src/server/campaigns.repo.ts`,
`listNotificationCampaigns` / `getNotificationCampaign` en `src/fn/notifications.ts`,
`src/routes/_authed/notificaciones.tsx` (layout), `notificaciones.envios.index.tsx`,
`notificaciones.envios.$broadcastId.tsx`.

### Un envío no es una entidad: es un `group by source_id`

No hay tabla de campañas. Un envío es el conjunto de filas de `notifications` con
`source_type = 'broadcast'` y el mismo `source_id` — el `broadcastId` que el
compositor genera como clave de idempotencia. Todo lo que muestran las dos
pantallas se deriva de esas filas.

Lo que se gana: **un envío aparece aunque el panel se haya caído justo después de
mandarlo.** La verdad la tiene Postgres, no un registro nuestro.

Lo que se paga, y está dicho en pantalla: **no se puede saber con qué condición se
eligió la audiencia.** Eso vive en el compositor mientras está abierto. Guardarlo
sería una tabla en `ops` (el panel es dueño de ese schema) con su migración, y se
decidió explícitamente NO hacerlo el 2026-09-16. Si algún día se hace, la lista se
sigue armando desde `notifications` y la metadata entra por `LEFT JOIN`: un envío
sin fila en `ops` tiene que seguir apareciendo.

### Lo otro que no se puede medir: cuánto tardaron en leerla

`notifications` tiene `status = 'read'` pero **no una columna `read_at`** (ni
`updated_at`). Se sabe que la abrió, nunca cuándo. No se estima con
`receipts_checked_at` —que es del proveedor push, no de la persona— ni con nada
más: es un agujero del schema del backend. Mismo criterio que `CANT_MEASURE_YET`
en `metricas.md`: una fila que no se puede medir se declara, no se rellena con un
número plausible.

### `DERIVED_STATE` se EXPORTA, no se recopia

`campaigns.repo.ts` lo importa de `notifications.repo.ts`. Una segunda copia del
`CASE` haría que el mismo envío se lea distinto en la lista y en el historial, sin
ningún error que lo delate — mismo motivo por el que `scanners.repo.ts` exporta
`OK`/`NO_DATA` para `scan-sessions.repo.ts`. Consecuencia mecánica: **`$1` es
siempre el umbral de `atrasada`** en toda consulta de `campaigns.repo.ts`.

### "Qué pasó después" — las seis acciones, y por qué son las mismas siempre

`CAMPAIGN_OUTCOMES` (`~/lib/campaigns`) es una lista cerrada, con la misma forma
declarativa que `USER_ACTIVITY_SIGNALS` de `~/lib/activity`. Sin una tabla en
`ops` no hay dónde guardar "el objetivo de ESTA campaña", así que se miran las
seis siempre — y sale más honesto de lo que parece: si una campaña que pedía
cargar la VTV termina con tres personas escaneando el auto y ninguna cargando el
documento, eso también es un resultado, y un objetivo único lo habría escondido.

Cuatro cosas que el código hace y no hay que romper:

1. **El denominador es "no lo había hecho antes".** Por cada persona se traen las
   DOS preguntas (¿antes?, ¿después?) y el resumen se arma sobre quienes NO lo
   habían hecho. "12 de 48 cargaron un auto" no significa nada si 30 de esos 48 ya
   tenían uno. Sin nadie a quien le faltara, el % es `—`, no `0%`.
2. **El momento de referencia es por PERSONA** (`coalesce(sent_at, scheduled_at)`
   fila por fila), no el `min()` del lote. Casi siempre coinciden; si una fila
   quedó pendiente tres días, medir contra el envío del resto le atribuiría todo
   lo que esa persona hizo mientras tanto.
3. **Es correlación, no causa**, y la UI lo dice: no hay grupo de control y las
   seis acciones pasan solas todo el tiempo. El número igual sirve — sin él no hay
   ninguno.
4. **Las columnas se llaman `had_0` / `did_0`, por índice.** Los `key` del catálogo
   son camelCase (`pushToken`) y Postgres pliega a minúscula todo identificador sin
   comillas: `had_pushToken` volvería como `had_pushtoken` y el mapeo de vuelta
   daría `undefined`, que en esta tabla se lee como "no lo hizo" — mismo criterio
   que `mapCensus` en `users.repo.ts`.

El resumen se agrega en **JS y no en SQL** a propósito: las dos vistas (el total
de arriba y la fila por persona) tienen que salir del MISMO snapshot, o los
totales no cuadran con las filas.

`quote_requests` NO está en la lista, aunque "pidió un presupuesto" sería el
resultado más valioso: esa tabla puede no existir en la base (`leads.md`, el guard
de disponibilidad), y una consulta que explota con un 500 en una pantalla que hoy
no necesita ningún guard cuesta más que el dato que agrega.

### El índice de `/notificaciones` NO redirige

`leads.tsx` y `vehiculos.tsx` mandan a su primera pestaña porque nadie linkeaba a
la raíz. Acá sí: `usuarios.$userId.tsx` y `/operacion` apuntan a `/notificaciones`
con search params, y un redirect los haría rebotar. El índice ES el historial; la
pestaña «Historial» lleva `activeOptions={{ exact: true }}` porque
`/notificaciones/envios` empieza con `/notificaciones`.

### `campaignSort` / `campaignDir`, y el `searchKeys` de `SortHeader`

Misma regla de siempre: `sort`/`dir` ya los usa `/notificaciones` con un enum
disjunto. Para no copiar un tercer `SortHeader` local, el componente compartido
tomó una prop opcional `searchKeys`. La alternativa era duplicar el control, que
es justo lo que ese archivo existe para no tener.

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
