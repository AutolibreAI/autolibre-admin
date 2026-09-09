# Vehículos (`/vehiculos`, antes `/catalogo`)

Alcance: `src/lib/vehicles.ts`, `src/server/vehicles.repo.ts`, `src/fn/vehicles.ts`,
`src/routes/_authed/vehiculos.tsx` (layout), `vehiculos.index.tsx`,
`vehiculos.listado.tsx`, `vehiculos.metricas.tsx`, `src/components/SortHeader.tsx`,
`src/components/VehicleCells.tsx`.

El Catálogo (pestaña 1) tiene su propia regla: `.claude/rules/vehicle-manuals.md`.

## La sección se renombró, no se movió

El 2026-09-06 `/catalogo` pasó a ser `/vehiculos`, un layout de 3 pestañas:
**Catálogo** (lo que estaba en `/catalogo`, movido tal cual a
`/vehiculos/catalogo`), **Listado**, **Flota** (la ruta sigue siendo
`/vehiculos/metricas`; la etiqueta pasó de "Métricas" a "Flota" el 2026-09-09
para no chocar con el ítem de nav de primer nivel `/metricas`). El nav dice "Vehículos"
(icono `Car`). Mismo patrón exacto que `/leads`.

`/escaneres` NO es una pestaña de acá aunque comparta el eje (los modelos del
catálogo): es un hecho acumulado, no un estado, y tiene su propio ítem de nav.

## Listado (`/vehiculos/listado`) — el padrón entero, SIN deduplicar

Una fila por `vehicles`, archivados incluidos (`state` default `'all'`). El
mismo auto cargado por dos usuarios son **dos filas a propósito**: es el dato
que la card de Inicio resume como "115 activos / 106 únicos". Deduplicar acá
escondería el problema que esa card existe para mostrar.

Es `UserVehicleSummary` de `/usuarios` llevado a global: mismas columnas
(VTV, seguro, multas, tareas, escaneos, DTCs, anomalías) más el dueño, el
odómetro y el modelo completo. La consulta va envuelta en `select * from (...) s`
por el mismo motivo que `listUsers` — casi todo son subconsultas escalares o
dependen de un LEFT JOIN del inner select, y filtrar/ordenar por ellas obliga a
envolver.

## Flota (`/vehiculos/metricas`) — la flota por MODELO del catálogo

El grano es `vehicle_catalogs`, NO el spec. Misma decisión que `/escaneres`
(`scanner-compatibility.md`): bajar al spec parte el mismo auto en dos filas
cuando dos specs difieren sólo en un campo que el proveedor no devolvió — un
número más desagregado y equivocado que no se cacha.

El `join lateral` cuenta todo lo del modelo en una pasada; `where
vs.vehicle_count > 0` deja fuera los catálogos que nadie cargó (no son flota).

**El cero de "Manuales" acá SÍ es un pendiente** (ámbar): este modelo tiene
autos y ningún manual. Es lo opuesto a la columna "Vehículos" del listado del
catálogo, donde el cero era sólo contexto. La diferencia: en Flota todas las
filas ya tienen autos, así que "0 manuales" siempre significa trabajo sin hacer.

## Predicados compartidos — si divergen, el panel miente

`vehicles.repo.ts` repite dos predicados que ya viven en otros archivos. Están
duplicados a propósito (un fragmento SQL no se comparte limpio entre repos), y
tocarlos es tocar los tres lugares:

| Predicado | Significa | También en |
|---|---|---|
| `status = 'completed' AND coalesce(total_readings,0) > 0` | escaneo que trajo datos | `scanners.repo.ts`, `users.repo.ts` |
| `status = 'pending'` (sobre `fines`) | multa adeudada | `fines.repo.ts`, `users.repo.ts` |

Si el de multas diverge, el mismo auto muestra dos montos distintos en
`/vehiculos/listado` y en `/leads/multas` sin ningún error que lo delate — misma
clase de acoplamiento que `INTERNAL_PREDICATE` entre `ops.repo.ts` y
`ops.v_ai_usage`.

## `vehicle_tax_debts` está VACÍA en producción

La columna "Deuda patente" del listado lee de `vehicle_tax_debts`
(`sum(coalesce(updated_amount, amount)) where cleared_at is null`). Al
2026-09-06 la tabla tiene **0 filas**, así que la columna sale "—" en todas
partes. Está escrita contra la tabla real —no es un placeholder— y queda lista
para cuando el backend la llene. `null` (sin datos) ≠ `$0` (consultado, sin
deuda): `AmountOrNoneCell` los distingue.

## Ni una escritura

Un `vehicle` lo crea el usuario en la app. `driving_sessions`, `fines`,
`insurances`, `vehicle_inspections` son hechos que escribe el backend. Nada de
esto lo mueve el admin. Si aparece un `UPDATE`/`INSERT` en `vehicles.repo.ts`,
está mal.

## Ordenar y filtrar

Las tres pestañas son ordenables por columna (headers = `<SortHeader>`, o sea
links: el orden ES la URL) y filtrables:

- **Catálogo**: buscar (marca/modelo/versión), filtro Tipo (auto/moto), "sin
  manual". Sort por las 5 columnas. El default `sort=model asc` reproduce el
  orden histórico (marca+modelo, año desc como desempate).
- **Listado**: buscar (patente/alias/modelo/dueño), Estado, Tipo, "VTV vencida",
  "con deuda de multas". Sort por 10 columnas.
- **Flota**: buscar, Tipo. Sort por casi todas.

### ⚠ El filtro de tipo se llama `vehicleType`, NO `type`

`/chats` ya usa `type` como search param (`diagnostico | general | all`), y
**TanStack unifica los nombres de search params entre rutas** para el spread
`{...prev}` de los updaters de `<Link search={...}>`. Dos params llamados `type`
con enums distintos rompen el typecheck de `chats.index.tsx` —una pantalla que
no tiene nada que ver— con `Type '"car"' is not assignable to '"all" |
"diagnostico" | "general"'`.

Regla: **un search param nuevo con un enum propio no puede reusar un nombre que
otra ruta ya use con otro enum.** Elegí un nombre calificado (`vehicleType`, no
`type`). El `sort` con valor `'type'` sí se puede repetir entre rutas — ahí el
choque sería sólo si los conjuntos fueran incompatibles, y `'type'` como
literal es compatible consigo mismo.

## `SortHeader` y `VehicleCells` son componentes, no copias

`src/components/SortHeader.tsx` (header de columna ordenable) y
`src/components/VehicleCells.tsx` (`ExpiryCell`, `CountOrNeverCell`,
`FineDebtCell`, `AmountOrNoneCell`, `daysUntilUtc`) salieron de
`usuarios.index.tsx` cuando el listado global los necesitó idénticos. Mismo
criterio que `Filters.tsx`: si "VTV vence en 3 días" se ve distinto en dos
pantallas, una está mal.

- `VehicleCells` **ya** lo usan `/vehiculos/listado` y `/usuarios` (refactorizado).
- `SortHeader` lo usan las pestañas nuevas de Vehículos. `usuarios.index.tsx` y
  `leads.multas.tsx` tienen un `SortableHeader`/`SortHeader` local PREVIO que
  hace lo mismo; migrarlos es pendiente mecánico, no rediseño. `firstClick` ya
  está calibrado para reproducir la semántica de cada uno (`'asc'` en usuarios,
  `'desc'` en multas).

## Cómo verificar un cambio acá

`vite build` (regenera `routeTree.gen.ts`) + `tsc --noEmit`, en ese orden — una
pestaña o `Link` nuevo sólo se valida después del build. Más el chequeo de
borde server-only: `grep -rl "listVehicles\|fleetMetrics\|join lateral" .output/public`
tiene que dar vacío.
