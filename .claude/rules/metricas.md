# Métricas (`/metricas`, antes `/graficos`)

Alcance: `src/routes/_authed/metricas.tsx`, `src/components/PulseCards.tsx`,
`src/components/GrowthChart.tsx`, `src/lib/ops.ts` (`ADOPTION_FEATURES`,
`UsageAdoption`, `VehicleDebtAdoption`, `ScanRecurrence`, `ProposalStats`,
`UnsolvedTasks`, `CANT_MEASURE_YET`, `METRICS_TZ`,
`ONBOARDING_VEHICLE_WINDOW_MIN`, `OnboardingSeries`), `src/server/ops.repo.ts`
(`usageAdoption`, `vehicleDebtAdoption`, `scanRecurrence`,
`assistantProposalStats`, `unsolvedTasks`, `onboardingSeries`, y las de
siempre `adoptionSeries` / `vehicleDistribution`), `src/fn/ops.ts`
(`getUsageAdoption`, `getVehicleDebtAdoption`, `getScanRecurrence`,
`getAssistantProposalStats`, `getUnsolvedTasks`, `getOnboardingSeries`). La
sección Pedidos vive en `src/lib/quote-requests.ts` (`QuoteRequestSeries`),
`src/server/quote-requests.repo.ts` (`quoteRequestSeries`,
`NOT_DUPLICATE_PREDICATE`) y `src/fn/quote-requests.ts`
(`getQuoteRequestSeriesFn`) — documentado acá porque la pantalla es
`/metricas`, no `/leads`; `leads.md` sólo tiene el predicado compartido.

## El rename fue sólo un prefijo

El 2026-09-09 `/graficos` pasó a `/metricas` y subió al 2º lugar del menú
(pegada a Inicio, fuera del bloque de dominio — las dos son la lectura
transversal del panel). Todo lo que ya documentaba `ops-metrics.md` sobre
`adoptionSeries` y `vehicleDistribution` sigue valiendo tal cual. El `id` de
ruta, el `head` title, los cinco `to="/metricas"` de los `SortHeader` y el
nombre `metricasSearchSchema` cambiaron; nada más de esas dos secciones.

## `PulseRow` se COMPARTE con Inicio, no se recopia

Las 4 cards del pulso (`src/components/PulseCards.tsx`) vivían inline en
`dashboard.tsx`. `/metricas` necesita las mismas cuatro, con los mismos números
y el mismo link. Se extrajeron a un componente en vez de duplicarlas — mismo
criterio que `Filters.tsx` / `VehicleCells.tsx` / `SortHeader.tsx`: si una card
se ve distinta en dos pantallas, una está mal y no hay forma de saber cuál.

Las dos pantallas llaman `getOpsPulse` por su cuenta (Inicio con streaming,
Métricas dentro de su `Promise.all` de loader). Es una consulta barata sobre
tablas chicas; no se comparte la llamada, se comparte el render.

## La tabla de adopción: una sola sentencia, siempre

`usageAdoption()` cuenta, por función de la app, cuántos usuarios reales la
usaron alguna vez. Las ~12 subconsultas van en UN `SELECT` con un CTE
`real_users`, no en 12 consultas sueltas. Mismo argumento que el censo de
`users.repo.ts` y el `UNION ALL` de `queueHealth`: comparten el snapshot de
Postgres, así que los % son comparables entre sí. Con 12 consultas separadas una
fila insertada en el medio del barrido entra en un contador y no en otro.

### "Usuario real" no se reinventa

El denominador (`totalUsers`) usa `INTERNAL_PREDICATE` negado — el MISMO
predicado que `adoptionPulse` y `ops.v_ai_usage` (dominio del email contra
`ops.excluded_email_domains`). Si diverge, el denominador de esta tabla y el
"Usuarios reales" de las cards de arriba dejan de coincidir en la misma
pantalla.

### Los predicados de cada fila, y por qué

- **`chat`**: conversación CON al menos un mensaje. Una conversación vacía no es
  uso — 48 de 70 en prod no tienen ninguno (ver `chats.md`).
- **`vtv`**: sólo `file_id IS NOT NULL`. Las filas `source = 'provider'` de
  `vehicle_inspections` son un lookup a una API por patente, no algo que el
  usuario cargó — coherente con `documents.md`.
- **`maintenanceDone`**: ocurrencia con `performed_at` — una tarea registrada
  como hecha, no una pendiente autogenerada por el plan.
- **`notified`**: `delivery_status = 'sent'` — le llegó, no que se encoló.
- **`fineSync` / `scan`**: se alcanzan por el vehículo, así que joinean
  `vehicles` → `user_id` (`vehicle_fine_syncs` no tiene `user_id`).
- **`maintenanceUpcoming`**: ocurrencia con `performed_at IS NULL` y al menos un
  vencimiento cargado (`due_date` o `due_km`). Es "lo que se recordó" — la cara
  de la fila 2 distinta de `maintenanceDone` ("lo que ya hizo") y
  `maintenancePlan` ("el plan recurrente").
- **`odometer`**: `vehicles` con `coalesce(odometer_value, 0) > 0` — cargó el km
  del auto alguna vez. Es adopción como ESTADO; la recurrencia (`vehicle_audit_logs`)
  no se puede medir, ver el bloque 5.
- **`anyDocument`**: OR de seguro / cédula / licencia / VTV (`file_id IS NOT NULL`),
  **no una suma** — sumar contaría dos veces a quien cargó dos. Misma definición
  exacta de "es OCR" que las cuatro filas de documentos que ya existen.
- **`proposalAccepted`**: `assistant_proposals` con `status = 'accepted'`. Es la
  fila 6 hecha adopción: qué % aceptó algo que le propuso el chat.
- El resto (`vehicle`, `insurance`, `regCard`, `license`, `push`,
  `maintenancePlan`): cualquier fila de esa tabla para el usuario.

### El mapeo snake→camel es explícito

`counts` en `usageAdoption` se escribe key por key, igual que `mapCensus`: un
`Object.entries` compila igual el día que se renombre una columna del SELECT y
devuelve `0` en silencio — que en esta tabla se lee como "nadie usa esa
función", la mentira más cara que puede decir.

`ADOPTION_FEATURES` en `~/lib/ops` es la única lista de claves + etiquetas
(mismo patrón que `QUEUE_LABELS` / `CENSUS_ENTRIES`). Agregar una función es una
línea ahí + una subconsulta en `usageAdoption`.

## La tabla NO es ordenable, a propósito

Orden fijo por `pct` descendente, calculado en el componente. Sin `SortHeader`,
sin search param. Consecuencia buena: no hay una clave de URL nueva que pueda
colisionar con otra ruta en el merge de `FullSearchSchema`
(`.claude/rules/notifications.md`), y `ssr: 'data-only'` se mantiene sin tocar
nada. La tabla "vehículos por usuario" de más abajo SÍ es ordenable — esa ya
tenía sus search params (`sort`/`dir`/`fleetScope`) desde que era `/graficos`.

`pct` se deriva en JS (`users / total * 100`), no en SQL — no arrastrar casts de
`double precision`, igual que `vehicleDistribution`.

## Sin ventana temporal

La pregunta es acumulativa ("¿alguna vez usó X?"), igual que la matriz de
`/escaneres`. Una ventana de 30 días vaciaría la tabla y se leería como "nadie
usa nada". Los gráficos de crecimiento de la misma pantalla SÍ tienen unidad
temporal — es otra pregunta (velocidad, no estado).

## Bloque 1b — Deuda de patente y de multas, por VEHÍCULO

Agregado el 2026-09-17. Contesta, en absoluto y en %: de los autos a los que
se les llegó a **consultar** cada deuda, ¿a cuántos les dio positivo? A
diferencia de la tabla de adopción, el grano es el vehículo (no el usuario) y
el denominador de cada `%` es `queried` (los consultados), **no** el padrón
entero — un auto nunca consultado no es "sin deuda", es "no sabemos", y
meterlo en el denominador diluiría el número con silencio. `vehicleDebtAdoption()`
en `ops.repo.ts` trae las dos filas en una sola sentencia.

- **Patente** (`vehicle_tax_debts`): el universo NO es "toda fila de esa
  tabla" — es los vehículos con una consulta **completada** del módulo
  `tax_debt` en `vehicle_data_queries` (`status = 'completed'`). Sólo una
  consulta terminada confirma o descarta la deuda; `queued`/`processing`/
  `failed` todavía no dicen nada. `vehicle_tax_debts` sólo tiene fila cuando
  SÍ hay deuda —verificado el 2026-09-17 contra producción: toda fila con
  `cleared_at IS NULL` y saldo > 0 es subconjunto exacto de los vehículos con
  consulta completada (0 filas de deuda por fuera)— así que "consultado y sin
  fila en `vehicle_tax_debts`" se lee como "consultado, sin deuda". Mismo
  criterio null-vs-0 que `fine_debt_amount` en `listUserVehicleSummaries`
  (`users.repo.ts`).
- **Multas** (`fines`): el universo es `vehicle_fine_syncs` (1:1 por
  `vehicle_id`, la ÚLTIMA sincronización) — el mismo corte que ya usan
  `/leads/multas` y la columna de multas de `/usuarios`. `status = 'pending'`
  es lo adeudado (`paid` saldada, `appealed` en disputa), igual que en
  `fines.repo.ts`. Si este predicado diverge del de `fines.repo.ts` /
  `users.repo.ts`, el panel dice dos montos distintos del mismo auto — misma
  clase de acoplamiento que `INTERNAL_PREDICATE`.

Al 2026-09-17 contra producción: patente 18/46 consultados (39,1%), multas
82/114 consultados (71,9%). Sin `SortHeader` ni search param, mismo criterio
que la tabla de adopción — son dos filas fijas, no una lista para reordenar.

## La sección `Preguntas` — cinco bloques de datos + uno de huecos

El 2026-09-10 el encabezado "Adopción por función" pasó a ser la sección
`Preguntas`, que contesta (o dice por qué no se puede contestar) un pliego de
nueve preguntas de producto — más la deuda por vehículo del bloque 1b, que se
sumó después y no es parte de ese pliego original. La tabla de adopción es el
bloque 1; los demás bloques de datos tienen su propia server function y su
propia consulta.

### Cada bloque comparte el snapshot de su propia consulta, no entre bloques

`usageAdoption` sigue siendo UNA sentencia (invariante 1) porque sus ~16 filas
se comparan entre sí. `scanRecurrence`, `assistantProposalStats` y
`unsolvedTasks` son consultas separadas **a propósito**: cada una contesta una
pregunta distinta, sus números no se comparan contra los de otro bloque, así
que un `now()` por bloque no rompe nada. `assistantProposalStats` sí junta sus
dos consultas (estados + `distinct type`) en un `Promise.all` — son la misma
pregunta.

### Bloque 2 — Recurrencia de escaneo (`scanRecurrence`)

Grano = usuario, universo = **TODAS** las `driving_sessions`, no sólo las que
trajeron datos: la pregunta es "¿quiere saber cómo está su auto?", y un intento
fallido también es esa intención. Es la diferencia con el corte `OK` de
`scanner-compatibility.md`, que sí filtra `total_readings > 0` porque contesta
otra cosa (compatibilidad de hardware).

`span_days` = `max(started_at)::date - min(started_at)::date` por usuario. Es 0
para quien escaneó una vez o todo el mismo día — la columna se muestra "—" para
el bucket de 1 escaneo (no hay lapso que medir). Sin ventana temporal, igual que
la tabla de adopción. El cuadre: `sum(scans * users)` = `count(*)` de
`driving_sessions`.

### Bloque 3 — Qué produce el chat (`assistantProposalStats`)

`assistant_proposals` agrupadas por `status` — los TRES estados se muestran
aunque uno quede en cero (es `/usuarios`, no Inicio: el cero es el síntoma).

**El bloque dice EN VOZ ALTA que `assistant_proposal_type` tiene un solo valor,
`maintenance`.** Es media respuesta a la pregunta 6: "pedidos" y "búsqueda de
proveedores" desde el chat no es que no se usen — **no se pueden representar**.
Mostrar sólo "5 propuestas de mantenimiento" dejaría creer que las otras dos
existen y dan cero. `types` sale de `select distinct` para que un valor nuevo
del enum aparezca solo (mismo patrón que `listDistinctChatModels`).

### Bloque 4 — Tareas sin solución (`unsolvedTasks`)

Universo: `maintenance_occurrences` con `plan_id IS NULL` (la creó una persona,
no la autogeneró un plan) y `NOT archived`. Cadena: `service_slug` →
`services.slug` → `partner_services` → `partners` activos.

**Los tres resultados NO se fusionan**, y ése es el punto:

| `kind` | Predicado | Significa | Va a |
|---|---|---|---|
| `no_service` | `service_slug IS NULL` | La app no supo clasificar lo que se escribió | equipo de producto (bug de la app) |
| `no_partner` | 0 partners activos para ese servicio | Sabemos qué necesita, no tenemos a quién mandarlo | equipo de marketplace (hueco) |
| `covered` | ≥ 1 partner activo | — · con exactamente 1 se marca "punto único de falla" | — |

Fusionar `no_service` con `no_partner` sería el error clásico: **"no lo
entendimos" y "no lo tenemos" van a equipos distintos.**

- `service_task_slug` NO entra en el corte — es el detalle dentro del rubro, y
  para saber si podemos derivar alcanza con el rubro.
- La fila `no_partner` enlaza a `/partners/cobertura?coverageRubros=<categoría>`.
  El slug del search param es de **categoría** (`services.category_id` →
  `service_categories.slug`), no de servicio — por eso `unsolvedTasks` devuelve
  `categorySlug` además de `serviceSlug`. `coverageRubros` es un `<Link>` con
  objeto literal (no spread), así que compila cross-route
  (`.claude/rules/partners-coverage.md`).
- Orden: `no_service` primero SIEMPRE, después por `activePartners` ascendente
  (huecos arriba), desempate por tareas descendente.

### Bloque 5 — Lo que todavía no se puede medir (`CANT_MEASURE_YET`)

Lista **CERRADA** en `~/lib/ops`, bloque `tone="warn"` (ámbar: falta un dato, no
está roto nada) — mismo criterio que "DTCs sin título" en
`/escaneres/detecciones`. Cuatro preguntas del pliego necesitan que el backend
escriba un dato que hoy no persiste (`fine_lookups` UNIQUE por patente,
`leads`/`lead_status` sin estado de presupuesto, `vehicle_audit_logs` con 0
filas, `assistant_proposal_type` con un solo valor). **Ninguna se arregla desde
este repo, y ninguna se "arregla" inventando un proxy** — mismo criterio que la
medición de tokens de IA (`ai-costs.md`) y los clicks de WhatsApp a partners
(`leads.md`). El bloque existe para que no se vuelva a preguntar en tres meses.

### Descartado a propósito

**El bloque de talleres fuera de la red** (`maintenance_occurrences.workshop`,
texto libre, 18 talleres distintos y sólo 3 matchean un partner activo por
nombre exacto). Se evaluó como respuesta parcial a la pregunta 4 y se decidió
NO construirlo: el match por nombre exacto es heurística
(`Lille` vs `Lille Adrogué`), y contestar "¿hay disposición a cambiar de
taller?" con "dónde fue a hacer el service" es cambiar la pregunta por otra que
se parece. La pregunta 4 queda en "no se puede medir" (bloque 5).

## Crecimiento agrupa en hora de Buenos Aires — decidido el 2026-09-23

**Es la sección de este archivo que MÁS diverge del resto del panel.** Todo lo
demás (`ai_usage_daily` de `/ai-costos`, `age_minutes` de `/actividad`, los
`created_at` que se muestran crudos) sigue en UTC. Sólo `growthSeries()`
(Usuarios y Vehículos), `onboardingSeries()` y `quoteRequestSeries()` agrupan
en `METRICS_TZ` (`America/Argentina/Buenos_Aires`, constante en `~/lib/ops`).

El motivo: con UTC, un alta o un pedido de las 21–24 h de Buenos Aires caía
agrupado en el día siguiente — silencioso, sin ningún error que lo delate.

**Por qué las tres, y no sólo la nueva.** El denominador de "Altas con
vehículo" (abajo) es la MISMA serie de altas que el gráfico de Usuarios de al
lado — si uno agrupara en Buenos Aires y el otro en UTC, el "de N altas" del %
no cuadraría con la barra de al lado en el mismo día. Así que `growthSeries()`
se movió también, aunque ya existía.

El patrón para agrupar en zona local sin correr el bucket: `date_trunc($1, ts
at time zone $2)` — convierte el `timestamptz` a la hora de PARED de esa zona
(un `timestamp` sin zona) y trunca ESO, sin una segunda conversión. El bucket
sale con `to_char(…, 'YYYY-MM-DD')` directo desde ese `timestamp` — **nunca**
volver a pasarlo por `timestamptz` en el camino (JS, otra consulta): esa
conversión sí correría el día 3 horas, la misma trampa que documenta
`ai-costs.md` para la serie diaria de costos.

## Altas con vehículo en el mismo proceso

`onboardingSeries(unit)` en `ops.repo.ts`. Contesta algo que nadie medía: de
los usuarios reales que se registraron en un período, ¿cuántos cargaron su
primer auto EN EL MISMO PROCESO, no días después?

- **La ventana es `ONBOARDING_VEHICLE_WINDOW_MIN = 10` minutos**, un corte
  relevado (no elegido para que el número quede lindo): mediana real 1,5 min
  entre el alta y el primer `vehicles.created_at`, ningún auto anterior al
  usuario, y la curva se aplana después de los 10 min (124 de 143 con auto
  entran a los ≤30 min). Entra por `make_interval(mins => $n)`, nunca
  interpolada (`ops-metrics.md`, trampa 7).
- **El período es el del ALTA del usuario**, no el del auto — la pregunta es
  "de los que se registraron acá, ¿cuántos cargaron rápido?", no "cuántos autos
  se cargaron acá" (eso ya lo contesta el gráfico de Vehículos).
- `min(v.created_at)` es subconsulta ESCALAR por usuario, no `JOIN` +
  `group by` — mismo motivo que `users.md` (trampa 2): un `JOIN` multiplicaría
  la fila del usuario por cada auto.
- El primer auto cuenta aunque después se haya archivado — mismo criterio que
  `adoptionSeries` (fue un registro real en su momento).
- La barra es apilada (sin auto / con auto en el alta), la línea es el % con
  auto, con escala fija a 100 (`lineMax` de `GrowthChart`).

## Pedidos

Cuatro series sobre `quote_requests` + `ops.quote_request_response`, todas con
el mismo `unit` de Crecimiento (sin search param nuevo). `quoteRequestSeries(unit)`
vive en `quote-requests.repo.ts`, no acá — pero la pantalla es `/metricas`, así
que la regla vive acá.

### El universo: sin duplicados, cohorte por creación

`NOT_DUPLICATE_PREDICATE` (`close_reason_code is distinct from 'duplicate'`)
es una constante COMPARTIDA con `quoteRequestPulse()` — la misma que hace que
la card "Pedidos totales" de `PulseRow` no cuente los duplicados
(`.claude/rules/leads.md`). Si diverge, "pedidos de esta semana" dice un
número en la card de Inicio y otro en el gráfico de acá abajo, del mismo
conjunto de filas.

Los cancelados por el usuario SÍ cuentan como recibidos (llegaron) pero SALEN
de `pendingContact`/`pendingAnswer`: un pedido que la persona canceló antes de
que el operador actúe está resuelto, no pendiente.

**El filtro corre en `base`, así que alcanza a las CUATRO series, no sólo a
2a.** `resp` (las filas de `ops.quote_request_response`) se agrega aparte y
recién se une a `base` por `quote_request_id` — una respuesta de un pedido
duplicado simplemente no tiene con qué unirse, porque ese `id` nunca entró a
`base`. No hace falta (ni existe) un segundo filtro sobre `resp`: 2b y 2d
excluyen duplicados por construcción, no por un `WHERE` adicional que alguien
podría olvidar.

**El período es el de creación del PEDIDO, no el de la respuesta.** Así "los
pedidos de esta semana" es el mismo conjunto en las cuatro series, aunque una
propuesta se haya cargado semanas después — la agregación de
`ops.quote_request_response` se hace ANTES del join a `base`, por
`quote_request_id`, para no repetir el mismo motivo de fan-out que
`onboardingSeries`.

### 2b y 2d salen de `ops.quote_request_response`, NO de `proposals_count`

Relevado el 2026-09-23: para un mismo pedido, `proposals_count` (lo que el
operador tipeó a mano al marcar respondido) y la cantidad de filas en
`ops.quote_request_response` (lo que cargó taller por taller) **no
coinciden** — son dos números que ya no se sincronizan
(`.claude/rules/leads.md`, sección 015: "`proposals_count` y la cantidad de
filas son DOS números"). Se eligió la tabla de `ops` porque es la única que
permite separar red de afuera (2d), y porque es el detalle real, no el conteo
tipeado aparte.

### El promedio de propuestas es sobre los pedidos ENVIADOS, no sobre todos los recibidos

**Corregido el 2026-09-23, antes de aplicarse a ningún dato real.** La primera
versión de `avgProposalsPerRequest` dividía `proposalsTotal / received` — el
promedio sobre TODOS los pedidos del bucket, contando como cero a los que
todavía no tienen ninguna propuesta cargada. Es la pregunta equivocada: lo que
el equipo quiere ver es *cuántas propuestas les estamos mandando a los
clientes*, y eso es un promedio sobre a quién le mandamos algo, no sobre todo
lo que entró (un pedido que llegó ayer y todavía no se trabajó no debería
arrastrar el promedio hacia abajo).

`avgProposalsPerRequest = proposalsTotal / pedidosConPropuesta`, y **`null`**
(no `0`) cuando `pedidosConPropuesta` es 0 — el promedio no está definido, no
es cero. Mismo criterio que `medianHoursToContact`/`medianHoursToAnswer`:
`GrowthChart` ya sabe cortar la línea en un `null` en vez de caer a cero.

### El guard tiene DOS niveles, y el segundo cambia la FORMA de la consulta

`available` (¿existe `quote_requests`?) y `responsesAvailable` (¿está aplicada
la 015?) son chequeos independientes. Sin `quote_requests`, no hay nada que
graficar. Con `quote_requests` pero sin la 015, **2a y 2c se calculan
igual** (no dependen de `ops.quote_request_response`) y **2b/2d muestran un
aviso** — la pantalla NO explota ni esconde las dos series que sí puede
calcular.

Por eso `quoteRequestSeries()` tiene DOS formas de la consulta, no una con un
`LEFT JOIN` condicional: no se puede referenciar
`ops.quote_request_response` en la sentencia y esperar que Postgres la ignore
si la tabla no existe — explota al planificarse, mismo motivo que
`quoteRequestsAvailability()` ya documenta para `quote_requests`.

### `pendingContact`/`pendingAnswer` se apilan RESTANDO, no se grafican sueltos

La barra de "Cuánto tardamos" apila `pendingContact` ("sin contactar") +
`max(pendingAnswer - pendingContact, 0)` ("contactados, sin responder"). Sin
la resta, un pedido sin contactar se contaría dos veces (aparece en las dos
métricas). El `max(…, 0)` es un cinturón: si algún día un pedido queda
`answered_at IS NULL` con `contacted_at` también nulo pero excluido de una y no
de la otra por un cambio de predicado, la resta no debería dar negativa, pero
tampoco debe romper el gráfico si pasa.

### El "tiempo hasta respondido" es APROXIMADO, y la pantalla lo dice

No existe un timestamp de "se mandó el mensaje": abrir el link de WhatsApp
(`leads.md`, plantilla «Presupuestos») no escribe nada. Lo que se mide es hasta
`answered_at` — que sella `ops.mark_quote_request_answered` (011) cuando el
OPERADOR marca respondido, no cuando la persona lo recibe. La pantalla dice
"hasta marcado respondido", nunca "hasta enviado". Medir el envío real es
trabajo aparte: un evento en `ops` al tocar el botón de WhatsApp — y ni así
sería "envió", sería "abrió WhatsApp".

## Ni una escritura

`usageAdoption`, `vehicleDebtAdoption`, `scanRecurrence`,
`assistantProposalStats`, `unsolvedTasks`, `onboardingSeries` y
`quoteRequestSeries` sólo cuentan. Todo lo que leen lo escribe el backend o el
usuario en la app. La única escritura del módulo `ops` sigue siendo
`ops.excluded_email_domains` desde `/operacion` (ver `ops-metrics.md`). Si
aparece un `UPDATE`/`INSERT` disparado desde `/metricas`, está mal.

## Cómo verificar un cambio acá

En esta máquina: `& ".\node_modules\.bin\vite.CMD" build` (regenera
`routeTree.gen.ts` — la ruta nueva y los `to="/metricas"` sólo se validan tras
el build) y después `& ".\node_modules\.bin\tsc.CMD" --noEmit`. Más el borde
server-only:

```bash
grep -rl "usageAdoption\|vehicleDebtAdoption\|scanRecurrence\|assistantProposalStats\|unsolvedTasks\|onboardingSeries\|quoteRequestSeries\|INTERNAL_PREDICATE\|POSTGRES_DATABASE_URL" .output/public
```

Cero resultados. Y el cuadre de cada bloque: correr las mismas subconsultas con
`node .claude/skills/db-connect/query.mjs` y comparar contra lo que muestra la
pantalla. Para `onboardingSeries`/`quoteRequestSeries` conviene cargar el
módulo real con vite (mismo patrón que `tmp/probe.mjs` de `activity-feed.md`)
y sumar los buckets: `sum(signups)` = usuarios reales, `sum(received)` =
`count(*)` de `quote_requests` sin duplicados. Ojo con los backticks: un
comentario `--` dentro del template literal de SQL con un `` `nombre` `` cierra
el string y rompe el build con un error de parser opaco (`Expected ',' or
')'`) — los comentarios de SQL van sin backticks.
