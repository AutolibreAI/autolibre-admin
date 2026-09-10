# Métricas (`/metricas`, antes `/graficos`)

Alcance: `src/routes/_authed/metricas.tsx`, `src/components/PulseCards.tsx`,
`src/lib/ops.ts` (`ADOPTION_FEATURES`, `UsageAdoption`, `ScanRecurrence`,
`ProposalStats`, `UnsolvedTasks`, `CANT_MEASURE_YET`), `src/server/ops.repo.ts`
(`usageAdoption`, `scanRecurrence`, `assistantProposalStats`, `unsolvedTasks`, y
las de siempre `adoptionSeries` / `vehicleDistribution`), `src/fn/ops.ts`
(`getUsageAdoption`, `getScanRecurrence`, `getAssistantProposalStats`,
`getUnsolvedTasks`).

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

## La sección `Preguntas` — cuatro bloques de datos + uno de huecos

El 2026-09-10 el encabezado "Adopción por función" pasó a ser la sección
`Preguntas`, que contesta (o dice por qué no se puede contestar) un pliego de
nueve preguntas de producto. La tabla de adopción es el bloque 1; los otros
tres bloques de datos tienen su propia server function y su propia consulta.

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

## Ni una escritura

`usageAdoption`, `scanRecurrence`, `assistantProposalStats` y `unsolvedTasks`
sólo cuentan. Todo lo que leen lo escribe el backend o el usuario en la app. La
única escritura del módulo `ops` sigue siendo `ops.excluded_email_domains` desde
`/operacion` (ver `ops-metrics.md`). Si aparece un `UPDATE`/`INSERT` disparado
desde `/metricas`, está mal.

## Cómo verificar un cambio acá

En esta máquina: `& ".\node_modules\.bin\vite.CMD" build` (regenera
`routeTree.gen.ts` — la ruta nueva y los `to="/metricas"` sólo se validan tras
el build) y después `& ".\node_modules\.bin\tsc.CMD" --noEmit`. Más el borde
server-only:

```bash
grep -rl "usageAdoption\|scanRecurrence\|assistantProposalStats\|unsolvedTasks\|INTERNAL_PREDICATE\|POSTGRES_DATABASE_URL" .output/public
```

Cero resultados. Y el cuadre de cada bloque: correr las mismas subconsultas con
`node .claude/skills/db-connect/query.mjs` y comparar contra lo que muestra la
pantalla. Ojo con los backticks: un comentario `--` dentro del template literal
de SQL con un `` `nombre` `` cierra el string y rompe el build con un error de
parser opaco (`Expected ',' or ')'`) — los comentarios de SQL van sin backticks.
