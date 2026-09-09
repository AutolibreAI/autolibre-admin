# Métricas (`/metricas`, antes `/graficos`)

Alcance: `src/routes/_authed/metricas.tsx`, `src/components/PulseCards.tsx`,
`src/lib/ops.ts` (`ADOPTION_FEATURES`, `UsageAdoption`), `src/server/ops.repo.ts`
(`usageAdoption`, y las de siempre `adoptionSeries` / `vehicleDistribution`),
`src/fn/ops.ts` (`getUsageAdoption`).

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

## Ni una escritura

`usageAdoption` sólo cuenta. Todo lo que lee lo escribe el backend o el usuario
en la app. La única escritura del módulo `ops` sigue siendo
`ops.excluded_email_domains` desde `/operacion` (ver `ops-metrics.md`). Si
aparece un `UPDATE`/`INSERT` disparado desde `/metricas`, está mal.

## Cómo verificar un cambio acá

En esta máquina: `& ".\node_modules\.bin\vite.CMD" build` (regenera
`routeTree.gen.ts` — la ruta nueva y los `to="/metricas"` sólo se validan tras
el build) y después `& ".\node_modules\.bin\tsc.CMD" --noEmit`. Más el borde
server-only:

```bash
grep -rl "usageAdoption\|INTERNAL_PREDICATE\|POSTGRES_DATABASE_URL" .output/public
```

Cero resultados. Y el cuadre de la tabla: correr las mismas subconsultas con
`node .claude/skills/db-connect/query.mjs` y comparar contra lo que muestra la
pantalla.
