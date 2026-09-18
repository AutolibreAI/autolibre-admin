# Vehículos (`/vehiculos`, antes `/catalogo`)

Alcance: `src/lib/vehicles.ts`, `src/server/vehicles.repo.ts`, `src/fn/vehicles.ts`,
`src/routes/_authed/vehiculos.tsx` (layout), `vehiculos.index.tsx`,
`vehiculos.listado.tsx`, `src/components/SortHeader.tsx`,
`src/components/VehicleCells.tsx`.

El Catálogo (pestaña 1, `vehiculos.catalogo.index.tsx` + `vehiculos.catalogo.$catalogId.tsx`)
tiene su propia regla: `.claude/rules/vehicle-manuals.md`.

## La sección se renombró dos veces, y la segunda fusionó dos pestañas en una

El 2026-09-06 `/catalogo` pasó a ser `/vehiculos`, un layout de 3 pestañas:
Catálogo, Listado y Flota (`/vehiculos/metricas`). El nav dice "Vehículos"
(icono `Car`). Mismo patrón exacto que `/leads`.

**El 2026-09-17 Catálogo y Flota se fusionaron en una sola pestaña,
`/vehiculos/catalogo`.** `/vehiculos/metricas` no existe más y **no deja
redirect** — mismo criterio que `/records`/`/analytics`/`/settings`
(2026-08-30): nadie linkeaba a esa pestaña desde afuera. La sección quedó con
**dos** pestañas: Catálogo y Listado.

El motivo no fue "se parecían": eran **la misma consulta con dos universos
distintos**, y el universo que cada una escondía era justo el dato que la otra
necesitaba. El detalle completo del relevamiento y la decisión están en
`.claude/plans/vehiculos-catalogo-flota.md`; esta sección es el resumen que
hay que mantener sincronizado con el código.

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

## Catálogo (`/vehiculos/catalogo`) — el catálogo entero, con su flota

`fleetMetrics()` en `vehicles.repo.ts` es la consulta que sobrevivió a la
fusión (la del listado viejo, `listCatalogs`, se borró). El grano es
`vehicle_catalogs`, NO el spec — misma decisión que `/escaneres`
(`scanner-compatibility.md`): bajar al spec parte el mismo auto en dos filas
cuando dos specs difieren sólo en un campo que el proveedor no devolvió — un
número más desagregado y equivocado que no se cacha.

### El universo es el SUPERCONJUNTO: los 210 modelos, no sólo los que tienen auto

Hasta el 2026-09-17 la consulta filtraba `vehicle_count > 0` ("no son flota").
Se sacó al fusionar: esconder por default los modelos sin auto es lo que hace
que alguien busque un modelo, no lo vea y concluya que no existe. El `join
lateral … on true` es un agregado sin `GROUP BY`, así que sigue devolviendo
exactamente una fila por catálogo aunque no tenga autos — sacar el filtro no
tocó nada del `lateral`.

### Los modelos sin auto son un pendiente operativo REAL, no un resto histórico

`vehicles` apunta al SPEC, no al catálogo (`vehicle-manuals.md`, trampa 3): un
catálogo sin ninguna variante cargada no puede tener autos, **ni hoy ni
nunca**, hasta que alguien le cree el spec. Verificado el 2026-09-17 contra
producción: el conjunto de modelos con 0 variantes y el de modelos con 0 autos
son **exactamente el mismo**, 30 sobre 210. Y es un fenómeno vivo, no un resto:
esos 30 se crearon en las dos semanas previas, contra los 180 buenos que vienen
de antes — uno de cada siete modelos que se crea sale inerte (el usuario lo
eligió por patente y no hay a qué colgarle el auto).

La pantalla trata esto como dos preguntas separadas —`onlyWithoutVehicles`
("nadie lo tiene") y `onlyWithoutSpecs` ("no se le puede colgar un auto")—
aunque hoy seleccionen el mismo conjunto: el día que se cree un spec sin que
nadie cargue el auto todavía, dejan de coincidir, y conflacionarlas en un solo
filtro perdería esa distinción justo cuando empezara a importar.

### El color de "Manuales" depende de DOS columnas, no de una

Antes de la fusión cada pantalla tenía su propia regla, y las dos eran
correctas *dentro de su universo* y opuestas entre sí: en el listado viejo el
cero de "vehículos" era contexto (ese modelo podía esperar); en Flota el cero
de "manuales" SÍ era un pendiente, porque ahí todas las filas ya tenían autos.

Juntando los universos, la regla que estaba implícita en el `where` de Flota
pasa a la celda:

| Vehículos | Manuales | Color | Significa |
|---|---|---|---|
| > 0 | 0 | **ámbar** | pendiente real — tiene autos y nadie le cargó el manual |
| > 0 | ≥ 1 | verde | — |
| 0 | 0 | **gris** | no urge, todavía nadie tiene este modelo |
| 0 | ≥ 1 | verde | (caso raro: el manual se cargó antes que el primer auto) |

Antes de la fusión el listado viejo pintaba ámbar las 209 filas sin manual, 30
de las cuales no las tenía nadie. La regla de arriba borra ese ruido.

## Predicados compartidos — si divergen, el panel miente

`vehicles.repo.ts` repite predicados que ya viven en otros archivos. Están
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

Las dos pestañas son ordenables por columna (headers = `<SortHeader>`, o sea
links: el orden ES la URL) y filtrables:

- **Catálogo**: buscar (marca/modelo/versión), Tipo (auto/moto), Autos (con /
  sin), Pendientes (sin manual / sin variantes). Sort por las 9 columnas
  numéricas más Modelo y Tipo. El default `sort=model asc` — no `vehicles
  desc`: con 166 de 210 modelos empatados en 1 auto, ordenar por flota da un
  orden arbitrario a partir de la fila 15, y esta pantalla sigue siendo de
  ENTRADA (se llega buscando un modelo).
- **Listado**: buscar (patente/alias/modelo/dueño), Estado, Tipo, "VTV vencida",
  "con deuda de multas". Sort por 10 columnas.

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

### El schema del Catálogo se llama `fleetSearchSchema`, y es a propósito

Al fusionar las dos pantallas se conservó `fleetMetrics()` (la consulta con el
`join lateral`, que ya traía todo lo que el listado viejo necesitaba agregar
con ocho subconsultas nuevas) y con ella su schema, `fleetSearchSchema` en
`~/lib/vehicles`. `catalogSearchSchema` / `CATALOG_SORT_KEYS` de `~/lib/manuals`
se borraron. El nombre no se cambió a `catalogSearchSchema` para no tocar dos
archivos por un cambio cosmético — la ruta que lo usa es la que manda el
significado, no el nombre del símbolo.

## `SortHeader` y `VehicleCells` son componentes, no copias

`src/components/SortHeader.tsx` (header de columna ordenable) y
`src/components/VehicleCells.tsx` (`ExpiryCell`, `CountOrNeverCell`,
`FineDebtCell`, `AmountOrNoneCell`, `daysUntilUtc`) salieron de
`usuarios.index.tsx` cuando el listado global los necesitó idénticos. Mismo
criterio que `Filters.tsx`: si "VTV vence en 3 días" se ve distinto en dos
pantallas, una está mal.

- `VehicleCells` **ya** lo usan `/vehiculos/listado` y `/usuarios` (refactorizado).
- `SortHeader` lo usan las dos pestañas de Vehículos. `usuarios.index.tsx` y
  `leads.multas.tsx` tienen un `SortableHeader`/`SortHeader` local PREVIO que
  hace lo mismo; migrarlos es pendiente mecánico, no rediseño. `firstClick` ya
  está calibrado para reproducir la semántica de cada uno (`'asc'` en usuarios,
  `'desc'` en multas).

## Cómo verificar un cambio acá

`vite build` (regenera `routeTree.gen.ts`) + `tsc --noEmit`, en ese orden — una
pestaña o `Link` nuevo sólo se valida después del build. Más el chequeo de
borde server-only: `grep -rl "listVehicles\|fleetMetrics\|join lateral" .output/public`
tiene que dar vacío.

El cuadre que importa después de tocar `fleetMetrics`: `sum(vehicle_count)` de
todas las filas tiene que dar `count(*) from vehicles` (196 al 2026-09-17). Si
no cuadra, hay fan-out en el `lateral` — mismo chequeo de regresión que
`vehicle-manuals.md` ya documenta para el doble salto `vehicles → specs →
catalogs`.
