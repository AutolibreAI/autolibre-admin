# Plan — Ver y editar las reglas de vencimiento en `/notificaciones/reglas`

> **Todos los números salieron de PRODUCCIÓN el 2026-09-25**
> (`current_database = autolibre`, `current_user = doadmin`, puerto `25060`,
> por el pooler del `.env`). Solo lectura.
>
> **`../autolibre-backend-hex` sigue sin estar clonado** (`D:\AutoLibre` no lo
> tiene). La Fase 0 es justamente eso, y bloquea las escrituras — no la lectura.
>
> **Estado al 2026-09-25: §7 IMPLEMENTADA** (pasos 1–6). `vite build` +
> `tsc --noEmit` limpios, borde server-only vacío, y `tmp/probe-reglas.mjs`
> contra producción: 22 reglas, 78 avisos = 78, Historial por regla 14/14.
> Falta la pasada visual con sesión de Clerk. Una diferencia con lo escrito
> abajo: las etiquetas de documento NO se duplicaron — se reusa
> `NOTIFICATION_SOURCE_LABELS` de `~/lib/notifications` (mantenimiento sale
> "Service", igual que en el Historial).
>
> **Decidido el 2026-09-25: se hace AHORA sólo lo que no depende del backend**
> — la Fase 1 (lectura) y la Fase 4 (link al Historial). El detalle ejecutable
> está en la §7. Las escrituras (Fases 2–3) quedan esperando la respuesta del
> backend, pedida por Jira (§8). **Ni un SP sobre `notification_rules` hasta
> entonces**: sin saber si el seed del backend reactiva las reglas en cada
> deploy (pregunta 4), una pausa desde el panel podría deshacerse sola.

## Qué contesta

Hoy la pestaña «Reglas» muestra sólo las reglas que crea el panel
(`ops.notification_schedule`, migración 014: audiencia + recurrencia). Pero los
avisos que de verdad le llegan a la gente hoy salen de OTRA tabla, que ninguna
pantalla muestra: **`public.notification_rules`**, las reglas de "X días antes
de que venza el seguro / la VTV / la licencia / el mantenimiento".

Reemplaza dos cosas:

- el `select * from notification_rules` + un `count(*) … group by rule_id`
  contra `notifications` que nadie corre — hoy no hay forma de saber qué avisos
  están prendidos ni cuántas veces sonó cada uno;
- el `UPDATE notification_rules SET active = false …` a mano en DBeaver, que es
  la única forma de apagar uno.

## 1. Lo relevado

### La tabla

```
id · source_type · channel · offset_unit · offset_direction · offset_value · active · created_at · updated_at
UNIQUE (source_type, channel, offset_unit, offset_direction, offset_value)   ← la clave natural
CHECK  (offset_value >= 0)
sin trigger de updated_at
```

Enums: `offset_unit = days | km`, `offset_direction = before | after`,
`channel = push | email | sms`, `source_type` tiene 10 valores (incluye
`registration_card` y `fine`, que hoy no tienen regla).

### Las 22 reglas, todas `push` · `before` · `active`

| Documento | Offsets | Avisos generados |
|---|---|---|
| Seguro | 30 · 15 · 7 · 2 · 1 días | 45 |
| VTV | 30 · 15 · 7 · 2 · 1 días | 18 (1 y 2 días: 0) |
| Licencia | 30 · 15 · 7 · 2 · 1 días | 1 |
| Mantenimiento | 30 · 15 · 7 · 2 · 1 días + 100 · 50 km | 14 (los de km: 0) |

78 de 867 notificaciones tienen `rule_id`. Se sembraron todas el 2026-08-30 en
el mismo minuto: vienen de un seed del backend.

### Cuatro hechos que deciden el diseño

1. **El texto NO está en la tabla.** Título y cuerpo los arma el backend en
   código ("Tu seguro está por vencer" / "El seguro de tu vehículo (Allianz,
   póliza …) vence el 10/10/2026."). Desde el panel **no se puede editar el
   texto** de estas reglas — sólo cuándo suenan y si suenan. Se muestra un
   ejemplo real (la última notificación de esa regla), de sólo lectura.
   > De paso: el de mantenimiento dice **"custom de tu vehículo vence el …"** —
   > el slug crudo del servicio. Es un bug del backend; va anotado, no se arregla
   > desde acá.
2. **Las notificaciones se crean justo a tiempo, no por adelantado.** Cero
   notificaciones con `scheduled_at` futuro; todas nacen en el tick horario
   (`hh:00`) en que el offset se cumple. O sea: **un cambio en la regla corre
   desde la próxima hora**, y no hay filas pendientes que reescribir.
3. **El motor RECUPERA offsets vencidos** — al menos a veces. Un seguro cargado
   el 5/9 que vencía el 18/9 recibió el de 30 y el de 15 días juntos en el
   primer tick. Otro cargado el 22/9 (vence 26/9) recibió sólo el de 7, no los
   de 15 y 30. **No sé la regla exacta y no se adivina** (Fase 0). Importa
   porque **agregar un "45 días antes" o reactivar uno pausado puede disparar
   una ráfaga** a todos los que tienen un vencimiento en esa ventana.
4. **La deduplicación es `UNIQUE (rule_id, source_id)`** y la FK desde
   `notifications` es `ON DELETE RESTRICT`. De ahí salen dos reglas:
   - **El offset es la identidad de la regla, no un campo editable.** Un
     `UPDATE … SET offset_value = 45` sobre la de 30 haría que los 13 avisos ya
     mandados aparezcan como "de 45 días", y que los documentos que ya recibieron
     el de 30 no reciban el de 45 (el índice ya los tiene). Cambiar 30 → 45 es
     **agregar la de 45 y pausar la de 30**. La UI lo ofrece así, en un paso.
   - **Una regla con avisos no se borra** (la base ya lo impide). Se pausa.

## 2. Qué se va a poder hacer, y qué no

| Acción | Sí / No | Por qué |
|---|---|---|
| Ver todas, agrupadas por documento, con avisos generados y último envío | **Sí** | Fase 1, sin escrituras |
| Pausar / reactivar un aviso | **Sí** | `active` es el único campo mutable de verdad |
| Agregar un offset nuevo ("45 días antes", "500 km antes") | **Sí** | Alta de fila, con aviso de impacto antes de confirmar |
| "Cambiar" un offset | **Sí, como alta + pausa** | Ver hecho 4 |
| Borrar | **Sólo sin avisos generados** | FK `RESTRICT`; con historial se pausa |
| Editar el texto | **No** | Vive en el backend (hecho 1) |
| Email / SMS | **No** | El enum los tiene; nada indica que el backend los mande |
| `after` ("vencido hace 3 días") | **No, hasta la Fase 0** | Ninguna regla lo usa; no sé si el motor lo evalúa |
| Reglas para cédula o multas | **No, hasta la Fase 0** | Ídem: una regla que el motor ignora es una regla muerta en silencio |
| `km` fuera de mantenimiento | **No** | Un seguro no vence por kilómetros |

## 3. ⚠ Fase 0 — el `grep` y la lectura del motor (bloquea escrituras)

`.claude/rules/ops-write-actions.md`: *la excepción se gana con un `grep`, no se
asume.* Con el backend clonado:

```
rg -n "notification_rules|notificationRules|NotificationRule" ../autolibre-backend-hex/src
rg -n "AdminGuard" ../autolibre-backend-hex/src/notifications
```

Preguntas que hay que contestar leyendo código, no mirando datos:

1. **¿Hay un endpoint admin para reglas?** Si sí → va por HTTP con
   `src/server/backend.ts` (decisión 4b del `CLAUDE.md`) y no hay migración. Si
   no → SPs de `ops` (Fase 2).
2. **¿Qué hace el motor con un offset que ya pasó?** (hecho 3). ¿Tiene ventana?
   ¿Recupera todos? Define el aviso de impacto de la Fase 3.
3. **¿El motor lee las reglas en cada tick o las cachea al arrancar?** Si las
   cachea, un cambio no corre hasta el próximo deploy, y la pantalla lo tiene
   que decir.
4. **¿El seed de las 22 reglas corre en cada deploy?** Si es un upsert que pone
   `active = true`, **cada deploy del backend deshace las pausas del panel**.
   Es la mina más cara de este plan.
5. ¿Soporta `after`, `registration_card`, `fine`? Habilita o no esas opciones.

## 4. Fases

| Fase | Qué | Depende de |
|---|---|---|
| **0** | Clonar el backend, `grep`, contestar las 5 preguntas | — |
| **1** | **Sólo lectura.** `~/lib/notification-rules` (tipos, labels por `source_type`, `describeOffset()`), `listNotificationRules()` en un repo nuevo `notification-rules.repo.ts` (una sentencia: reglas + `count`/`max(created_at)` de `notifications` por `rule_id` + la última `title`/`body` como ejemplo), `listNotificationRulesFn` con `adminMiddleware`. La sección nueva en `/notificaciones/reglas`. | nada |
| **2** | Pausar / reactivar. Migración **018** (o HTTP, según Fase 0) | 0 |
| **3** | Agregar offset + "cambiar" (alta + pausa) + borrar sin avisos | 0, 2 |
| **4** | (opcional) `notificationRuleId` en el Historial, para que "13 avisos" sea un link | 1 |

La Fase 1 se puede hacer ya: no escribe nada.

### La pantalla (Fase 1)

`/notificaciones/reglas` pasa a tener dos secciones, en este orden:

1. **Recordatorios de vencimiento** — "los manda el sistema, hoy". Una tarjeta
   por documento (Seguro · VTV · Licencia · Mantenimiento). Adentro, una fila por
   offset: "30 días antes", estado (activo / pausado), avisos generados, último
   envío, y el ejemplo de texto con "el texto lo define el backend".
   Un offset con 0 avisos **se muestra en cero**, no se esconde (mismo criterio
   que el censo de `/usuarios`): "VTV 1 día antes: 0" es un dato.
2. **Envíos programados** — lo que ya existe (`ops.notification_schedule`), sin
   cambios.

Sin search params nuevos (22 filas no necesitan filtro), así que nada que pueda
colisionar en `FullSearchSchema`. Sin ficha propia: una regla son 5 campos.

**Vocabulario**: en código, `NotificationRule` (la tabla del backend) y
`NotificationSchedule` (la de `ops`) quedan separados y no se renombra ninguno.
En la UI, "Recordatorios de vencimiento" y "Envíos programados" — dos nombres
distintos para dos motores distintos.

### Las escrituras (Fases 2–3), si la Fase 0 dice SP

Migración `018_ops_reglas_de_vencimiento.sql` + `.test.sql`, con los 8
guardrails de siempre:

- `ops.set_notification_rule_active(p_rule_id, p_active, p_actor_id, p_note)`
- `ops.create_notification_rule(p_source_type text, p_offset_unit text, p_offset_value int, p_actor_id, p_note)`
  — `channel = 'push'` y `direction = 'before'` fijos. Parámetros `text` con el
  cast al enum adentro (mismo motivo que la 011). `unique_violation` →
  `NOTIFICATION_RULE_EXISTS` ("ya existe; si está pausada, reactivala").
  Valida `km` sólo con `maintenance_occurrence` (`INVALID_UNIT_FOR_SOURCE`) y
  que el `source_type` esté entre los que el motor soporta: una regla que nunca
  suena se valida a fondo por lo mismo que la recurrencia de la 014 — su error
  es silencioso.
- `ops.delete_notification_rule(p_rule_id, p_actor_id, p_note)` — rechaza
  `NOTIFICATION_RULE_HAS_NOTIFICATIONS` antes de que lo haga la FK con un 23503.

Dos matices a documentar en `ops-write-actions.md`:

- **Guardrail 8 invertido**, como la 015: `notification_rules` no tiene
  trigger, así que el SP escribe `updated_at`. La suite verifica que no haya
  trigger, para enterarse el día que el backend agregue uno.
- **No hay `update` del offset**, a propósito (hecho 4).

### El aviso de impacto (Fase 3)

Antes de confirmar un alta o una reactivación, la UI muestra cuántos documentos
**vigentes** tienen el vencimiento dentro de la ventana nueva y no recibieron
todavía ese aviso — o sea, cuántos podrían recibirlo en el próximo tick. El
cálculo exacto depende de la respuesta 2 de la Fase 0; si el motor no recupera,
el número es cero y el aviso lo dice.

## 5. Qué hay que actualizar en la documentación

- `.claude/rules/notifications.md`: la sección "`notification_rules` NO tiene
  `user_id`" dice *"Esta pantalla NO las muestra"* — deja de ser cierto.
- `CLAUDE.md`: la tabla de pantallas **no tiene fila para
  `/notificaciones/reglas`** (ni para la 014). Agregarla con las dos secciones.
- `ops-write-actions.md`: sección de la 018, si hay SP.

## 6. Cómo se verifica

- `vite build` + `tsc --noEmit`, y el borde server-only:
  `grep -rl "notification-rules.repo\|listNotificationRules\|POSTGRES_DATABASE_URL" .output/public` → vacío.
- Cuadre de la Fase 1: la suma de "avisos generados" de la pantalla =
  `count(*) from notifications where rule_id is not null` (78 hoy).
- La suite de la 018 en `BEGIN … ROLLBACK`, **en DEV**: el `.env` apunta a
  producción, y un `--allow-write` ahí no se corre sin pedirlo.
- Prueba real de la Fase 2: pausar una regla de 0 avisos (VTV 1 día), esperar un
  tick, verificar en `ops.action_log` y que un deploy del backend no la reactive
  (pregunta 4).

---

## 7. Lo que se hace ahora (sin backend): Fases 1 y 4

Ninguna escritura, ninguna migración. Todo es un `SELECT` sobre
`notification_rules` + `notifications`.

### Paso 1 — `src/lib/notification-rules.ts` (contrato compartido)

- `NotificationRule` = `{ id, sourceType, channel, offsetUnit,
  offsetDirection, offsetValue, active, createdAt, updatedAt,
  notificationCount, lastNotificationAt, sampleTitle, sampleBody }`.
  `lastNotificationAt`/`sampleTitle`/`sampleBody` son `null` con 0 avisos.
- `NOTIFICATION_RULE_SOURCE_LABELS`: `insurance` → Seguro,
  `vehicle_inspection` → VTV, `driver_license` → Licencia de conducir,
  `maintenance_occurrence` → Mantenimiento, y el resto del enum
  (`registration_card`, `fine`, …) con su etiqueta. Un valor sin label se
  muestra CRUDO, mismo criterio que `NOTIFICATION_TYPE_LABELS`.
- `NOTIFICATION_RULE_SOURCE_ORDER`: el orden de las tarjetas (Seguro, VTV,
  Licencia, Mantenimiento, después cualquier otro que aparezca).
- `describeOffset(rule)` → "30 días antes", "100 km antes", "3 días después".
  `offset_value = 0` → "el día que vence".
- Sin schema de search: la sección no tiene filtros (22 filas).

### Paso 2 — `src/server/notification-rules.repo.ts`

`listNotificationRules({ signal })`, **una sola sentencia** (mismo snapshot
para la regla y su conteo):

```sql
select r.id, r.source_type, r.channel, r.offset_unit, r.offset_direction,
       r.offset_value, r.active, r.created_at, r.updated_at,
       (select count(*)::int from notifications n where n.rule_id = r.id) as notification_count,
       last.created_at as last_notification_at, last.title as sample_title, last.body as sample_body
  from notification_rules r
  left join lateral (
    select n.created_at, n.title, n.body from notifications n
     where n.rule_id = r.id order by n.created_at desc limit 1
  ) last on true
 order by r.source_type, r.offset_unit, r.offset_direction, r.offset_value desc
```

- Conteo como subconsulta escalar y el ejemplo como `lateral … limit 1`: un
  `left join notifications` + `group by` multiplicaría (`users.md`, trampa 2).
- Mapeo snake→camel **explícito**, campo por campo (`mapCensus`): un
  `notification_count` mal mapeado se vería como "0 avisos", que acá se lee
  como "esta regla nunca sonó".
- `toInt()` sobre el conteo (`pg` devuelve `bigint` como string).
- Cabecera del archivo: **ni un `UPDATE`/`INSERT` acá**; las escrituras
  esperan al backend (§8).

### Paso 3 — `src/fn/notification-rules.ts`

`listNotificationRulesFn`, GET, **`adminMiddleware`**: el `sampleBody` trae
póliza y aseguradora de una persona real. Un server function es un endpoint
HTTP público.

### Paso 4 — la sección en `notificaciones.reglas.index.tsx`

- El loader pasa a `Promise.all([listNotificationSchedulesFn(…),
  listNotificationRulesFn(…)])`. El `validateSearch` sigue siendo el de
  schedules: `q` y `scheduleState` **sólo filtran la sección de abajo**, y la
  UI lo dice poniendo los filtros dentro de esa sección, no en el header.
- Header: "Reglas" con subtítulo "N recordatorios de vencimiento · M envíos
  programados".
- **Sección 1 — Recordatorios de vencimiento** ("los arma y los manda el
  backend"). Componente nuevo `src/components/NotificationRuleCards.tsx`:
  - una tarjeta por `source_type`, en el orden de
    `NOTIFICATION_RULE_SOURCE_ORDER`; título = etiqueta + "N avisos
    generados";
  - una fila por regla: offset (`describeOffset`), estado (`Activa` verde /
    `Pausada` gris, los mismos `Badge` que `ScheduleRow`), avisos generados,
    último aviso (`formatDateTime`);
  - **una fila en 0 avisos se muestra en 0**, en texto apagado, no se esconde;
  - el ejemplo de texto (título + cuerpo del último aviso) aparece UNA vez por
    tarjeta, debajo de las filas, con la nota "El texto lo define el backend —
    desde el panel no se edita". Sin avisos: "todavía no sonó ninguna".
  - Canal y dirección no son columnas (hoy todo es `push` · `antes`): se
    muestran sólo si una fila se sale de eso, como detalle en la celda del
    offset. Mismo criterio que el grupo de canal de `/notificaciones`, que se
    esconde mientras haya uno solo.
  - Pie de la sección, en ámbar (`tone="warn"`): "Pausar, agregar o cambiar
    estos avisos todavía no se puede desde acá — está pedido al backend."
- **Sección 2 — Envíos programados**: lo que ya existe, con `ScheduleComposer`
  en el encabezado de la sección (no en el de la página: es de esta sección).

### Paso 5 (Fase 4) — "N avisos" linkea al Historial

- `notificationRuleId: z.uuid().optional()` en `notificationSearchSchema`
  (`~/lib/notifications`). Calificado por dominio, nunca `ruleId` pelado
  (`notifications.md`); antes de agregarlo, `grep -rn "notificationRuleId:" src/lib`.
- `notifications.repo.ts`: `n.rule_id = $n` en el **WHERE interno**, igual que
  `userId` y `notificationBroadcastId` (columna cruda).
- Historial: cuando viene el param, un chip "Regla: Seguro · 30 días antes ✕"
  arriba de la tabla. Para armar esa etiqueta sin otra consulta, el repo del
  listado trae `rule_source_type`/`rule_offset_*` por `LEFT JOIN
  notification_rules` — `LEFT` porque la inmensa mayoría de las filas no tiene
  regla (789 de 867).
- La celda "N avisos" de cada fila es un `<Link to="/notificaciones"
  search={{ notificationRuleId: r.id }}>` con **objeto literal**, no spread
  (`partners-coverage.md`: el spread cross-route rompe el typecheck). Con 0
  avisos no es link.

### Paso 6 — documentación

- `.claude/rules/notifications.md`: reemplazar "Esta pantalla NO las muestra"
  por una sección nueva sobre `notification_rules` (los 4 hechos de la §1, que
  el texto no se edita, que el offset es identidad, el search param nuevo).
  Agregar los archivos nuevos al "Alcance".
- `CLAUDE.md`: fila de `/notificaciones/reglas` en la tabla de pantallas —
  "El `select * from notification_rules` + el `count(*) group by rule_id` que
  nadie corría (sección de vencimientos) y las reglas de `ops` de la 014
  (envíos programados)". Y la fila del Historial suma el filtro por regla.

### Verificación

1. `vite build` (regenera `routeTree.gen.ts`) y después `tsc --noEmit`.
2. Borde server-only:
   `grep -rl "notification-rules.repo\|listNotificationRules\|POSTGRES_DATABASE_URL" .output/public` → vacío.
3. Cuadres contra la base: la pantalla muestra 22 reglas; la suma de "avisos
   generados" = `count(*) from notifications where rule_id is not null` (78 al
   2026-09-25); el Historial filtrado por la regla de Seguro 30 días muestra
   exactamente su conteo (13).
4. Pasada en el navegador: las dos secciones, que un filtro de la sección de
   abajo no mueva la de arriba, y el link de "N avisos" → Historial → ✕.

## 8. Qué se le pidió al backend

Ticket de Jira con: endpoints admin para listar / pausar / reactivar / crear
reglas (o confirmación de que el panel puede escribir la tabla); que el seed no
pise `active`; qué hace el motor con offsets ya vencidos al crear o reactivar;
si lee las reglas en cada tick; soporte de `after`, cédula y multas; texto
editable por tipo de documento; el bug de "custom de tu vehículo"; y por qué
VTV 1–2 días, licencia 1–15 días y los de km tienen 0 avisos. Cuando conteste,
las Fases 2–3 se reescriben según la respuesta 1 (HTTP o SP 018).
