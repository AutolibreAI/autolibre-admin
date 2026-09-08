# Sesiones de escáner (`/escaneres/sesiones`)

Alcance: `src/lib/scan-sessions.ts`, `src/server/scan-sessions.repo.ts`,
`src/fn/scan-sessions.ts`, `src/routes/_authed/escaneres.sesiones.tsx`, y el
layout `src/routes/_authed/escaneres.tsx` + su redirect `escaneres.index.tsx`.

La otra pestaña —la matriz de compatibilidad— es `.claude/rules/scanner-compatibility.md`.

## Qué es, y qué NO es

Es la lista cruda de `driving_sessions`: **un escaneo por fila**, todas, con lo
que cada uno trajo (DTCs, anomalías, distancia desde el borrado, VIN, batería,
métricas de manejo). Ordenable y filtrable por columna.

**No es** la matriz de `/escaneres/compatibilidad`, que AGREGA sesiones por
catálogo × variante para contestar "¿con qué autos anda este escáner?". El
`SessionsPanel` de esa matriz ya mostraba este detalle, pero sólo detrás de una
celda seleccionada; esta pestaña es la vista entera.

## El corte de estado se IMPORTA, no se recopia

`scanners.repo.ts` exporta `OK` / `NO_DATA` / `FAILED` / `PENDING` (cadenas SQL
con alias `ds.`). `scan-sessions.repo.ts` las importa para el filtro
`scanState` — va en el **WHERE interno** de la consulta, antes del envoltorio
`select * from (...) s`, porque usa el alias `ds.`.

Antes esas cadenas eran privadas de `scanners.repo.ts`. Ahora son la **única**
definición SQL del corte, compartida entre la matriz y esta lista. Si alguien
las vuelve a copiar en vez de importarlas, es un bug esperando a divergir —
misma familia que `INTERNAL_PREDICATE` entre `ops.repo.ts` y `ops.v_ai_usage`.
El cubo de cada fila (`bucket`) lo sigue calculando `sessionBucket()` en JS, que
es la contraparte de esas cadenas. → `.claude/rules/scanner-compatibility.md`

## El search param de estado se llama `scanState`, no `status` ni `state`

`status` ya lo usan `/solicitudes` y `/leads/talleres` con sus propios enums;
`state` lo usan `/vehiculos/listado` y `/usuarios`. TanStack mergea los search
params de todas las rutas, y dos enums disjuntos con la misma clave rompen el
typecheck en la ruta ajena. Calificado por dominio, como manda
`.claude/rules/notifications.md`.

`sort`/`dir` sí van pelados: es el nombre que `SortHeader` lee y `/escaneres/sesiones`
no comparte search params con ninguna otra ruta vía `<Link>` (el layout linkea
entre pestañas sin `{...prev}`, igual que `/vehiculos`).

## `JOIN` a `users`/`vehicles`, `LEFT` al catálogo

`driving_sessions.user_id` y `.vehicle_id` son NOT NULL con FK — un `LEFT`
escondería una corrupción. El catálogo es distinto: la FK de `vehicles` apunta
al SPEC, y la FK del spec al catálogo garantiza el spec, no el catálogo (misma
trampa que `scanner-compatibility.md`). Ahí sí `LEFT`, y `catalogLabel` puede
quedar `null` ("sin modelo de catálogo"). Al 2026-09-08 hay 0 huérfanos, pero el
`LEFT` se queda.

## Las anomalías salen de un jsonb, y se leen compactadas

`driving_telemetry_analysis.anomalies` es un jsonb array. La consulta NO lo
devuelve entero (cada anomalía trae `justification` + `probableCauses`, ~500
bytes): arma un `jsonb_agg` de sólo `{type, severity, pid}`, ordenado por
severidad (roja primero). La cantidad sale de `jsonb_array_length`; el desglose
`red/violet/yellow` sale de `summary->'bySeverity'` (ya lo trae contado el
backend, no se recuenta del array).

- `jsonb_typeof(t.anomalies) = 'array'` como guarda: cuando el `LEFT JOIN` no
  matchea, `t.anomalies` es `NULL` y `jsonb_array_elements(NULL)` explota.
- La severidad es el MISMO eje de tres niveles del catálogo de DTC
  (`amarillo`/`violeta`/`rojo`, ver `design-system.md`). El JSON la trae en
  inglés; se espeja cruda y un valor nuevo se muestra tal cual.
- `ANOMALY_TYPE_LABELS` traduce los 18 tipos que hoy produce el backend; uno sin
  entrada se muestra CRUDO (`anomalyTypeLabel`), nunca se esconde.

## DTCs: `session_dtc_snapshots.codes`, no `diagnostic_dtcs`

`session_dtc_snapshots` es 1:1 por sesión (verificado: 34/34, 0 duplicados) y su
columna `codes` es el array de códigos vistos. `diagnostic_dtcs` es el detalle
por código CON descripción, y sólo existe para los que se buscaron (22 filas vs
34 snapshots) — es para un drill-down, no para la lista. La lista muestra los
códigos; `dtc_count` sale de `array_length(codes, 1)` con `coalesce(…, 0)`
porque `array_length` de un array vacío o de `NULL` devuelve `NULL`.

## `battery_volts` para ordenar, `batteryVoltage` para mostrar

`driving_sessions.battery_voltage` es texto sucio (`"14.6V"`, `"12.0V"`, a veces
`null`). Se muestra crudo (mismo criterio que la aseguradora en `leads.md`) pero
para el `ORDER BY` se parsea a numérico:
`nullif(regexp_replace(x, '[^0-9.]', '', 'g'), '')::numeric`. Es una columna del
SELECT interno referenciada afuera, por eso el envoltorio.

## `speedMax` / `rpmMax` / `engineTempMax` salen de `metrics`

`driving_telemetry_analysis.metrics` es un jsonb con un objeto por PID
(`{min,max,avg,stdDev,sampleCount}`). Se extrae sólo `->>'max'` de speed, rpm y
engineTemp — lo justo para distinguir un escaneo en ralentí de uno andando.
`null` cuando no hay análisis o el PID no está. No se abre el resto de `metrics`
en la lista: eso es un detalle por sesión, y no hay pantalla de detalle todavía.

## Ni una escritura

`driving_sessions` y todo lo que cuelga de `session_id` lo escribe el backend
cuando el teléfono sube los chunks. Un escaneo es un hecho que pasó, no un
estado que el admin mueva — mismo criterio que `conversations` y `notifications`.
Si aparece un `UPDATE`/`INSERT` en `scan-sessions.repo.ts`, está mal.

## Qué NO se implementó, y por qué

- **Detalle por sesión** (`/escaneres/sesiones/:id`). Las anomalías con
  `justification` + `probableCauses`, el detalle de DTC con descripción, el
  resto de `metrics` y `summary.notEvaluable` (los estudios que no corrieron)
  quedarían bien ahí. No reemplaza ninguna consulta que hoy se corra, así que
  no va todavía — y el `SessionsPanel` de la matriz ya cubre buena parte.
- **Paginación.** 34 sesiones al 2026-09-08. Cuando moleste, el arreglo es
  mejorar la búsqueda, no agregar páginas (mismo criterio que `/usuarios`).

## Cómo verificar un cambio acá

En esta máquina: `& ".\node_modules\.bin\vite.CMD" build` (regenera
`routeTree.gen.ts` — una pestaña o `Link` nuevo sólo se valida DESPUÉS del
build) y después `& ".\node_modules\.bin\tsc.CMD" --noEmit`. Más el chequeo de
borde server-only:

```bash
grep -rl "listScanSessions\|scan-sessions.repo\|POSTGRES_DATABASE_URL" .output/public
```

Cero resultados. (Ojo: `driving_telemetry_analysis` SÍ aparece en el bundle del
cliente, pero por `CENSUS_ENTRIES` de `~/lib/users` —que lista esa tabla como
dato—, no por este repo. Es un falso positivo preexistente.)
