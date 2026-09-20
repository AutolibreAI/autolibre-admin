# Plan — Notificaciones automáticas (reglas recurrentes)

> **Estado al 2026-09-20: Fases 1–3 IMPLEMENTADAS y verificadas; Fase 0 y Fase 4
> siguen abiertas a propósito.** `../autolibre-backend-hex` sigue sin clonar en
> esta máquina, así que la §3 (quién autentica un envío que nadie disparó)
> sigue sin decidirse — es la única razón por la que el motor (Fase 4) no
> existe todavía. Lo que SÍ existe: una regla se puede crear, editar, pausar,
> reanudar y borrar desde `/notificaciones/reglas`, y **ninguna le manda un
> push a nadie** — el guardrail de "nace pausada" está en el propio SP, no
> sólo en la UI.
>
> - **Migración 014** (`ops.notification_schedule` +
>   `ops.notification_schedule_run`, los 4 SP con auditoría): escrita y su
>   suite de 60 casos corrida en rojo-y-verde dentro de un `BEGIN…ROLLBACK`
>   contra producción (no había Postgres de DEV disponible en
>   `localhost:5435` en el momento de escribir esto) — **nada quedó aplicado**,
>   verificado después con `select proname from pg_proc … like
>   '%notification_schedule%'` devolviendo vacío. Falta aplicarla de verdad en
>   DEV primero, y recién después en producción por el puerto directo `:25060`.
> - **`~/lib/notification-schedules`, `~/server/schedules.repo`,
>   `~/fn/schedules`**: el catálogo de recurrencia (unión discriminada, nunca
>   un cron string), y las llamadas a los 4 SP.
> - **UI**: tercera pestaña «Reglas» en `/notificaciones`, el listado
>   (`notificaciones.reglas.index.tsx` + `ScheduleComposer`), la ficha
>   (`notificaciones.reglas.$scheduleId.tsx`) con edición completa,
>   pausar/reanudar y borrar (bloqueado si ya tiene corridas). `AudienceBuilder`
>   ganó un modo `schedule` que expone `conditions` al padre en vez de resolver
>   a destinatarios explícitos — reusa el mismo catálogo de audiencias, no uno
>   nuevo.
> - `pnpm build` (regenera `routeTree.gen.ts`) + `pnpm typecheck` pasan limpio;
>   `grep -rl "schedules.repo|POSTGRES_DATABASE_URL|sqlOne" .output/public` da
>   vacío. **No se pudo hacer una pasada de browser con sesión real** (el login
>   de Clerk no es accesible desde este entorno) — falta una verificación visual
>   manual antes de darlo por cerrado del todo.
>
> Todo lo que sigue abajo es el plan ORIGINAL, sin editar — sigue siendo la
> referencia de diseño. Lo de arriba es el diario de qué se hizo.
>
> **Todos los números de este archivo salieron de PRODUCCIÓN** el 2026-09-20
> (`current_database = autolibre`, `current_user = doadmin`, puerto `25060`),
> por el pooler del `.env`. Ningún número de este repo significa nada sin decir
> contra qué base se sacó.
>
> **`../autolibre-backend-hex` NO está clonado en esta máquina** (`D:\AutoLibre`
> tiene `autolibre-admin` y nada más). Por eso el `grep` que
> `.claude/rules/ops-write-actions.md` exige antes de cualquier escritura nueva
> **no se pudo correr**, y la §3 —la única decisión bloqueante de este plan—
> queda abierta a propósito. La excepción se gana con un `grep`, no se asume.

## Qué contesta

**"Esto hay que avisarlo siempre, no una vez."**

Hoy `/notificaciones` manda un push ad-hoc: el operador arma la audiencia con
`AudienceBuilder`, mira los destinatarios y aprieta Enviar. Eso resolvió el
envío único. Lo que no resuelve es el caso de arriba: *"a todos los que no
cargaron el auto, recordáselo día por medio a las 19"*, *"a los que no tienen
seguro, los domingos a las 18"*.

Hoy eso se hace **acordándose**. Y acordarse a las 19:00 día por medio no es un
proceso: es una persona que la primera semana lo hace y la tercera no.

La consulta que reemplaza no es una de DBeaver. Es la que **nadie corre porque
no es una consulta**: es un cron que no existe.

---

## 1. Con qué datos arranca (producción, 2026-09-20)

### El padrón y las dos audiencias del ejemplo

| | Usuarios | Con dispositivo push |
|---|---|---|
| Total | **179** (175 `user`, 4 `admin`, todos `clerk`) | — |
| Sin ningún vehículo no archivado | **54** | **26** |
| Sin ninguna póliza no archivada | **151** | (no relevado) |

Las dos condiciones del ejemplo **ya existen en el catálogo de audiencias**:
`vehicles = 0` y `insurances = 0` en `~/lib/audience`. No es casualidad — es la
mitad del trabajo ya hecho, y la §4 se apoya entera en eso.

### Lo que ya está construido y se reusa tal cual

| Pieza | Qué aporta |
|---|---|
| `~/lib/audience` + `~/server/audience.repo` | El catálogo cerrado de 29 condiciones, su SQL y `previewAudience()`. **La regla recurrente no necesita un lenguaje de condiciones nuevo: necesita guardar el que ya hay.** |
| `broadcastNotification()` en `~/server/backend` | El `POST /notifications/broadcast` con idempotencia por `broadcastId`. |
| `/notificaciones/envios` + `~/lib/campaigns` | Un envío es un `group by source_id`. **Cada corrida de una regla va a aparecer ahí sola**, con sus seis métricas de "qué pasó después", sin escribir una línea. |
| Las migraciones 007–013 y `ops.action_log` | El patrón de SP con auditoría: dónde queda registrado quién creó, pausó o borró una regla. |

### El estado de entrega hoy, que es la advertencia del plan

```
sent    / sent      378
pending / no_token   47   ← reintentando cada minuto, para siempre
sent    / failed     45
pending / null       35   ← «atrasada»
```

**47 filas ya están en `sin_token`**, y `notification-delivery.cron` las va a
reintentar eternamente porque `notification_status` no tiene estado terminal de
falla (`.claude/rules/notifications.md`). Ahora volvé a mirar la tabla de
arriba: **de los 54 usuarios sin vehículo, 28 no tienen dispositivo.** Una regla
día por medio para esa audiencia fabrica 28 filas zombi por corrida — ~90
corridas en seis meses, ~2.500 filas nuevas reintentándose por minuto.

Eso no es un caso de borde: es el resultado por default. La §8 lo frena.

---

## 2. Lo que NO puede hacer el trabajo, y por qué (relevado, no supuesto)

### `public.notification_rules` no sirve — es otra cosa

Tiene 22 filas activas y el nombre invita, pero su forma lo descarta:

```
source_type · channel · offset_unit · offset_direction · offset_value · active
```

Es **un offset contra la fecha de un documento** ("7 días antes de que venza la
VTV"). No tiene hora del día, no tiene recurrencia, no tiene audiencia: el
disparador es la fila de `insurances` / `vehicle_inspections`, no el reloj.
Meter "domingos 18hs a los que no tienen seguro" ahí sería redefinir una tabla
del backend desde este repo.

### `INSERT INTO notifications` desde un SP de `ops` — descartado, y ya estaba

Es lo primero que va a tentar, y `.claude/rules/notifications.md` ya lo prohíbe
con motivo técnico y no con la regla: un INSERT directo **se saltea el filtro de
preferencias** (`CreateNotificationsHandler` descarta a quien silenció
`announcement` en push) y **las invariantes de `Notification.create()`**, que
deriva `type` de `source_type` y trimea título y cuerpo.

Dato que lo hace sonar inofensivo y no lo es: `user_notification_preferences`
tiene **0 filas** hoy, así que el filtro no descarta a nadie *todavía*. Una
regla automática que lo saltee empieza a mentir el día que alguien silencie
anuncios — y ese día nadie va a estar mirando este plan.

---

## 3. ⚠ La decisión bloqueante: quién autentica un envío que nadie disparó

**Todo el resto de este plan es mecánico. Esto no.**

`broadcastNotification()` obtiene el bearer con `auth().getToken()` de Clerk —
el token del **admin logueado que apretó el botón**. Es a propósito: la request
viaja con la identidad de una persona real, mismo criterio que `p_actor_id` en
los SP de `ops` (cabecera de `backend.ts`).

Una notificación automática, por definición, **no tiene a nadie apretando el
botón**. `auth()` no existe adentro de un cron. Y `POST /notifications/broadcast`
está bajo `AdminGuard`.

Tres caminos, y hay que elegir uno antes de escribir la primera línea:

| | Camino | Qué cuesta | Qué riesgo trae |
|---|---|---|---|
| **A** | **Identidad de servicio en Clerk.** Un usuario Clerk `bot@…` con fila en `users` (`role = 'admin'`, `auth_provider = 'clerk'`), y el cron mintea su token con `CLERK_SECRET_KEY` (ya está en el `.env`). | Sólo panel. Ninguna línea del backend. | **Hay que VERIFICAR que Clerk permita mintear un session token de un usuario desde el Backend API en el plan que tenemos** — no está confirmado y no se asume. Y crea un 5º admin en producción (hoy son 4): un admin que no es una persona, cuyo token abre todo lo que abre un admin. |
| **B** | **El backend acepta una credencial de máquina** para ese endpoint (header secreto, o M2M de Clerk). | Trabajo en el backend, con su TDD. | Ninguno nuevo del lado del panel. Es el camino honesto si A no se puede. |
| **C** | **El scheduler entero se muda al backend**: el panel guarda la regla, el backend la evalúa y la manda. | Lo más caro: hay que reimplementar `AUDIENCE_SQL` (29 condiciones, 12 tablas) del otro lado. | Duplicar el catálogo de audiencias es la peor versión: dos definiciones de "usuario sin seguro" que divergen sin que nada avise — la misma clase de acoplamiento que `INTERNAL_PREDICATE`. |

**Recomendación: A si verifica, B si no. C no**, salvo que el backend ya tenga
un concepto de audiencia — lo cual hay que gregar, porque no está clonado.

**El `grep` obligatorio antes de decidir**, cuando el repo esté clonado:

```
rg -n "AdminGuard|@Public\(\)" ../autolibre-backend-hex/src/notifications
rg -n "broadcast|schedule|recurring|cron" ../autolibre-backend-hex/src/notifications
```

Si el backend YA tiene un envío recurrente con audiencia, este plan cambia de
forma entera: el panel guarda y muestra, no ejecuta.

---

## 4. El modelo de la recurrencia: catálogo cerrado, nunca un cron string

La tentación es un campo de texto con `0 19 */2 * *`. Dos motivos para no:

1. **Es el mismo argumento que `AUDIENCE_SQL`.** Lo que viaja por HTTP tiene que
   ser un enum cerrado con un entero validado, no una expresión que el servidor
   interpreta. Acá el resultado de interpretarla mal es un push a la hora
   equivocada, a la gente equivocada, y para siempre.
2. **`*/2` en día-del-mes NO es "día por medio".** Es "los días 1, 3, 5 … 31", y
   el 31 al 1 son **dos días seguidos**. Quien escribe eso creyendo que dijo
   "cada 48hs" se entera en marzo. La trampa es del formato cron, no nuestra: no
   la importemos.

### La forma propuesta (`~/lib/notification-schedules`)

```
kind: 'daily' | 'everyNDays' | 'weekly' | 'monthlyDay'
  daily        → todos los días
  everyNDays   → cada N días, N ∈ [2, 90], contados desde `startsOn`
  weekly       → días de la semana elegidos (array de 0–6)
  monthlyDay   → un día del mes, 1–28 (nunca 29–31: febrero)
atHour   : 0–23
atMinute : 0 | 15 | 30 | 45     ← cuartos, no 0–59: nadie necesita las 19:07
```

- **`everyNDays` necesita un ancla** o "día por medio" no es determinístico. El
  ancla es `starts_on` (una `date`) y la ocurrencia es
  `(fecha − starts_on) % N = 0`. Sin ancla, cualquier cosa que corra el cálculo
  medio día invierte la paridad y la regla salta un día sin que nadie lo note.
- **La zona es Buenos Aires, fija y no configurable.** "19hs" es 19hs acá. Se
  calcula con `AT TIME ZONE 'America/Argentina/Buenos_Aires'`, **nunca con `-3`
  a mano** — mismo criterio que el sello de `internal_notes`
  (`.claude/rules/leads.md`). Argentina hoy no tiene horario de verano; escribir
  `-3` es apostar a que no vuelva.

Los dos ejemplos del pedido quedan:

```
sin vehículo  → { kind: 'everyNDays', n: 2, atHour: 19, atMinute: 0 }
sin seguro    → { kind: 'weekly', weekdays: [0], atHour: 18, atMinute: 0 }
```

---

## 5. Dónde vive el estado: migración 014, dos tablas de `ops`

`ops` es del panel: lo crea, lo migra y lo consulta, y el backend no lo conoce
(decisión 3 del `CLAUDE.md`). Una regla de notificación es **operación del
panel** —nadie de la app la lee— así que va acá, igual que
`ops.quote_request_rubro`.

```
ops.notification_schedule
  id                uuid pk
  name              text      -- cómo la llama el equipo, para la lista
  title, body       text      -- el texto del push (mismos topes: 100 / 500)
  conditions        jsonb     -- el array de AudienceCondition, tal cual
  recurrence        jsonb     -- la forma de la §4
  starts_on         date
  ends_on           date null -- fecha de corte dura, opcional
  max_per_user      int  null -- tope de veces que ESTA regla le habla a una persona
  require_device    bool      -- default TRUE, ver §8
  exclude_internal  bool      -- default TRUE
  active            bool      -- nace en FALSE, ver §8.7
  created_at, updated_at, created_by   -- `created_by` es uuid pelado, sin FK

ops.notification_schedule_run
  id             uuid pk      -- ES el broadcastId, ver §7
  schedule_id    uuid         -- FK dentro de `ops`, esa sí se puede
  occurrence_at  timestamptz  -- la ocurrencia que esta corrida cubre
  status         text         -- 'pending' | 'sent' | 'skipped' | 'failed'
  matched        int null     -- cuántos matchearon
  sent_count     int null     -- cuántos entraron al POST
  skip_reason    text null    -- 'empty_audience' | 'over_limit' | 'no_device'
  error          text null
  started_at, finished_at
  unique (schedule_id, occurrence_at)   ← el freno de la doble corrida
```

Guardrails que aplican tal cual, de `.claude/rules/ops-write-actions.md`:
migración versionada (nunca DDL a mano), `SECURITY INVOKER`, `search_path` fijo,
**`p_actor_id` de la sesión y jamás del payload**, log en `ops.action_log`
adentro de la función, **ninguna FK cruza a `public`** (`created_by` es uuid
pelado) y suite `.test.sql` en `BEGIN … ROLLBACK`.

El guardrail 7 (`FOR UPDATE`) **sí** aplica acá para editar o pausar una regla —
es un UPDATE sobre una fila existente, a diferencia de la 012.

**La `unique (schedule_id, occurrence_at)` es la pieza central.** Dos corridas
del cron sobre la misma ocurrencia chocan el índice y la segunda no hace nada.
Vercel puede invocar un cron dos veces; ese índice es lo que hace que eso no
duplique un push.

---

## 6. El motor: un cron que pregunta "¿hay algo vencido?"

`GET /api/cron/notificaciones`, autenticado con `CRON_SECRET` (el header que
manda Vercel Cron), **no** con `apiSessionMiddleware`: no hay sesión que leer.

Por cada regla activa:

1. Calcular la última ocurrencia cuya hora ya pasó (según §4, en hora de Buenos
   Aires) y que no tenga fila en `notification_schedule_run`.
2. Insertar la fila `pending`. Si choca la unique, **salir**: otra invocación ya
   la tomó.
3. Resolver la audiencia con `previewAudience()`, el MISMO código que usa el
   compositor manual. Aplicar los frenos de la §8.
4. `broadcastNotification({ broadcastId: run.id, userIds, title, body })`.
5. Marcar la corrida `sent`, con `matched` y `sent_count`.

**Frecuencia: horaria.** Con cron horario una regla de las 19:00 dispara a las
19:0x y la audiencia se resuelve **en ese momento** — quien cargó el auto a las
18:40 ya no la recibe, que es exactamente lo que tiene que pasar.

> **Verificar el plan de Vercel antes de comprometerse.** Hobby limita los cron
> jobs a una corrida diaria; la granularidad fina es de Pro. Si sólo hay Hobby,
> el plan B es un cron diario que **materializa por adelantado** las ocurrencias
> de las próximas 24hs usando el `scheduledAt` futuro que
> `POST /notifications/broadcast` ya acepta — el cron de entrega del backend
> pone la hora exacta. El costo de ese plan B es real y va dicho en pantalla:
> **la audiencia queda congelada hasta 24hs antes del envío**, así que alguien
> que carga el auto a la tarde recibe igual el recordatorio de las 19.

**No hay recuperación de ocurrencias viejas.** Si el cron estuvo caído dos días
se manda la ocurrencia vigente y las perdidas se saltean: mandar tres
recordatorios juntos porque el scheduler volvió es peor que no mandar ninguno.
La corrida saltada queda como fila con su `skip_reason`, visible.

---

## 7. Idempotencia: la corrida ES el `broadcastId`

`ops.notification_schedule_run.id` se usa como `broadcastId` del POST. Eso
encadena las dos defensas que ya existen:

- la `unique (schedule_id, occurrence_at)` impide crear dos corridas para la
  misma ocurrencia;
- `idx_notifications_adhoc_source_unique (user_id, source_type, source_id)` +
  el `ON CONFLICT DO NOTHING` del backend impide crear dos filas para la misma
  persona dentro de la misma corrida.

Un reintento después de un timeout **reusa el mismo `run.id`** y es un no-op
para quien ya tenía su fila. Es exactamente el contrato que `BroadcastComposer`
ya sostiene a mano; acá sale gratis porque la fila de la corrida es el ancla.

**No generar el `broadcastId` con `gen_random_uuid()` en el momento del POST**:
ahí un reintento crearía un id nuevo y mandaría el push dos veces.

---

## 8. Los frenos, y ninguno es opcional

Una notificación automática es la única cosa de este panel que le puede hablar a
179 personas sin que nadie la mire. Lo que sigue no es prolijidad:

1. **`require_device` en TRUE por default.** Suma `pushTokens >= 1` a la
   audiencia resuelta. Sin esto, la regla del ejemplo fabrica 28 filas
   `sin_token` por corrida, reintentándose por minuto para siempre (§1). Se
   puede apagar, y el formulario dice qué pasa si se apaga.
2. **`exclude_internal` en TRUE por default** — `isAdmin` y `isInternal`
   negados. Los dos ya están en el catálogo.
3. **`max_per_user`.** Cuántas veces esta regla le puede hablar a la misma
   persona, en total; se cuenta con `notifications.source_id IN (corridas de
   esta regla)`. Sin tope, "sin vehículo" le pega a los mismos 54 cada 48hs
   hasta que se borren la app — y borrarse la app también los saca de la
   audiencia, así que el número se ve cada vez mejor mientras el producto se
   cae.
4. **Cooldown global entre reglas.** Nadie recibe más de un push AUTOMÁTICO cada
   X horas, cruzando todas las reglas. Con dos reglas que caen un domingo a las
   18 y a las 19 la persona recibe dos pushes en una hora, y ninguna de las dos
   reglas está mal por separado. Se mira contra `notifications` con `source_id`
   de cualquier corrida.
5. **Audiencia vacía → `skipped`, no error.** Es el final feliz: ya no queda
   nadie sin cargar el auto.
6. **Audiencia > `BROADCAST_MAX_RECIPIENTS` (500) → `skipped` con `over_limit`,
   y avisa.** No se trunca en silencio: *"mandarle a 500 de 1300 sin decirlo es
   la peor versión de esta pantalla"* (`.claude/rules/notifications.md`). Con
   179 usuarios no pasa hoy; el día que pase, la respuesta es partir en lotes a
   propósito, no descubrirlo después.
7. **Una regla nueva nace PAUSADA.** Se crea, se previsualiza, se activa. Un
   formulario que manda el primer push al apretar Guardar es una mina.

---

## 9. La UI: tercera pestaña, y ninguna pantalla nueva de resultados

`/notificaciones` es hoy un layout de dos pestañas (Historial · Envíos). Se suma
**Reglas** (`/notificaciones/reglas`), más `/notificaciones/reglas/:id` para la
ficha. El índice sigue sin redirigir, por lo que ya dice `notificaciones.tsx`.

- **El armador de audiencia es `AudienceBuilder`, el mismo componente**, con una
  diferencia que hay que respetar: en el envío manual la condición **resuelve a
  ids explícitos antes de enviar** y quien manda ve a quién le manda. Acá eso es
  imposible por definición —la audiencia de dentro de tres días todavía no
  existe— y el sustituto es la vista previa: *"hoy matchean 54; 26 tienen
  dispositivo"*, recalculada al abrir la ficha. **La ficha tiene que decir en
  voz alta que ese número es de hoy y que cada corrida usa el de su momento.**
- **El resultado de cada corrida NO necesita pantalla nueva.** Cada corrida es
  un `source_id` de `notifications`, así que `/notificaciones/envios` ya la
  muestra con sus seis métricas de "qué pasó después". Lo único que falta es
  distinguir manual de automática: un `LEFT JOIN` de `campaigns.repo.ts` contra
  `ops.notification_schedule_run` por `broadcast_id`, con el nombre de la regla.
  **`.claude/rules/notifications.md` ya bendijo esa forma exacta** ("la lista se
  sigue armando desde `notifications` y la metadata entra por `LEFT JOIN`: un
  envío sin fila en `ops` tiene que seguir apareciendo").
- Search params calificados: `scheduleState`, nunca `state` ni `status` —
  `state` ya lo usan `/vehiculos/listado` y `/usuarios`, y el merge de
  `FullSearchSchema` rompe el typecheck **en la ruta ajena**.

---

## 10. Lo que este plan NO construye, y por qué

- **Texto personalizado por persona** ("cargá el seguro de tu Vento").
  `POST /notifications/broadcast` recibe `userIds` + UN `title`/`body` para todo
  el lote, y las 302 filas `broadcast` de producción tienen `vehicle_id` NULL.
  Es la Fase 2 que `.claude/rules/notifications.md` ya dejó anotada, y necesita
  backend.
- **Disparadores por evento** ("cuando alguien carga un auto, a las 48hs mandale
  X"). Eso no es un reloj, es un trigger de dominio: vive en el backend, al lado
  de `notification_rules`.
- **Deep link al abrir el push.** La fila no lleva destino; toca backend y
  mobile.
- **A/B de texto.** Sin `read_at` en `notifications` no se puede medir apertura
  (`.claude/rules/notifications.md`): un A/B sin métrica es elegir a ojo con más
  pasos.
- **Condiciones con O.** El armador no las tiene y no es un olvido: un paréntesis
  mal puesto le manda un push a quien no corresponde. Si hace falta una unión,
  son dos reglas.

---

## 11. Orden de ejecución

| Fase | Qué | Bloquea |
|---|---|---|
| **0** | Clonar `autolibre-backend-hex` y correr el `grep` de la §3. Decidir A o B. Verificar el plan de Vercel (cron horario o diario). | **Todo.** Sin esto no se escribe nada. |
| **1** | Migración 014: dos tablas + los SP de alta / edición / pausa / baja con `ops.action_log`, y su `.test.sql` en `BEGIN … ROLLBACK`. Aplicar en DEV primero; producción a mano por el puerto **directo** `:25060`, nunca por el pooler. | 2 |
| **2** | `~/lib/notification-schedules` (la forma de la §4, con zod), `~/server/schedules.repo`, `~/fn/schedules`. Sin cron todavía: reglas que se crean, se listan y se previsualizan, y no mandan nada. | 3 |
| **3** | La pestaña Reglas + la ficha, reusando `AudienceBuilder`. | 4 |
| **4** | El endpoint de cron, los frenos de la §8 y la entrada en `vercel.json`. **Se prueba con una regla apuntada a UNA cuenta interna antes de apuntarla a nadie más.** | 5 |
| **5** | El `LEFT JOIN` en `campaigns.repo.ts` para que `/notificaciones/envios` diga de qué regla vino cada corrida. | — |

Las fases 1–3 se pueden escribir **sin resolver la §3**: una regla guardada que
todavía no dispara no le manda un push a nadie. Sólo la fase 4 necesita la
decisión tomada.

---

## 12. Cómo se verifica

En esta máquina: `& ".\node_modules\.bin\vite.CMD" build` (regenera
`routeTree.gen.ts` — la pestaña nueva y sus `Link` sólo se validan DESPUÉS del
build) y después `& ".\node_modules\.bin\tsc.CMD" --noEmit`. Más el borde
server-only:

```bash
grep -rl "schedules.repo\|AUDIENCE_SQL\|CRON_SECRET\|POSTGRES_DATABASE_URL" .output/public
```

Cero resultados.

Y las tres pruebas que no son de tipos:

1. **La suite de la 014**, con el patrón de 007–013: en rojo primero (sin la
   migración) y después con la migración adentro de la misma transacción.
2. **El cálculo de ocurrencias, contra el reloj.** `everyNDays` con `n = 2`
   sobre un `starts_on` fijo tiene que dar los días correctos cruzando fin de
   mes y fin de año — que es justo donde `*/2` de cron falla (§4).
3. **Una corrida real contra una regla de una sola cuenta interna**, verificando
   en `notifications` que creó exactamente una fila y que una segunda invocación
   del cron no crea ninguna.
