# Sesiones de escáner (`/escaneres/sesiones`, `/escaneres/sesiones/:sessionId`)

Alcance: `src/lib/scan-sessions.ts`, `src/server/scan-sessions.repo.ts`,
`src/fn/scan-sessions.ts`, `src/routes/_authed/escaneres.sesiones.index.tsx`,
`src/routes/_authed/escaneres.sesiones.$sessionId.tsx`, y el layout
`src/routes/_authed/escaneres.tsx` + su redirect `escaneres.index.tsx`.

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
en la lista: eso es un detalle por sesión — ver la sección de abajo, ya tiene
pantalla.

## Ni una escritura

`driving_sessions` y todo lo que cuelga de `session_id` lo escribe el backend
cuando el teléfono sube los chunks. Un escaneo es un hecho que pasó, no un
estado que el admin mueva — mismo criterio que `conversations` y `notifications`.
Si aparece un `UPDATE`/`INSERT` en `scan-sessions.repo.ts`, está mal.

## Detalle por sesión (`/escaneres/sesiones/:sessionId`), agregado el 2026-09-13

Ya no es "qué falta" — es la pantalla. La fecha de cada fila del listado (y de
cada `SessionCard` del `SessionsPanel` de la matriz) linkea acá. Reemplaza la
reconstrucción manual con un `select` por tabla que hacía falta para ver TODO
lo que una sesión produjo: no sólo los contadores de la fila, el jsonb entero.

`getScanSessionDetail()` en `scan-sessions.repo.ts` corre CINCO consultas en
paralelo (la sesión + join a catálogo; `driving_session_chunks`;
`diagnostic_dtcs`; `driving_telemetry_analysis`; `ai_diagnostics`) — no una
JOIN gigante, porque las últimas tres son 1\:N (`ai_diagnostics` tiene hasta 2
filas por sesión, verificado contra producción) y una sola sesión no necesita
el envoltorio `select * from (...) s` que sí hace falta en un listado.

### El análisis de telemetría se trae DOS VECES con distinto detalle, y es correcto

`listScanSessions` (la fila) trae el jsonb RECORTADO —`{type, severity, pid}`
por anomalía, sólo 3 claves de `metrics`— porque cargar `justification` +
`probableCauses` + `evidence` por cada una de las N filas de la tabla sería
~500 bytes de más por fila que nadie lee ahí. `getScanSessionDetail` trae el
jsonb COMPLETO porque acá SÍ se lee. No son la misma consulta parametrizada por
un flag "traer todo": son dos consultas separadas a propósito, cada una del
tamaño que su pantalla necesita.

`speedMax`/`rpmMax`/`producedTelemetryAnalysis` del detalle se DERIVAN del
resultado de `driving_telemetry_analysis` en JS (¿hay fila? ¿qué dice
`metrics.speed.max`?) en vez de pedirlos de nuevo por columna — evita una
sexta consulta redundante.

### `evidence` no puede tipar `Record<string, unknown>`

Cada tipo de anomalía trae una forma de `evidence` distinta (RPM:
`sessionMax`/`sessionMin`; fuel trim: `combinedFrom`, un array de strings) y no
vale la pena tipar cada variante para mostrarla como texto. La tentación es
`Record<string, unknown>` — **no compila**: TanStack Start valida en tipos que
todo lo que devuelve un server function sea serializable
(`ValidateSerializableMapped`), y `unknown` no lo es. El error no aparece en el
archivo con el bug: aparece en `fn/scan-sessions.ts`, en la firma de
`createServerFn`, y de ahí se propaga como si el `Route.useLoaderData()` de la
pantalla entera fuera `{}` — un error de tipos que parece no tener nada que ver
con la causa real. `ScanEvidenceValue` (`string | number | boolean | null |
Array<string>`) es la unión cerrada que sí sirve.

### Narrowing de una propiedad NO sobrevive un `.map()` anidado

`s.telemetry` es `ScanTelemetryAnalysis | null`. Narrowearlo una vez arriba
(`!s.telemetry ? <p/> : <TelemetrySection telemetry={s.telemetry} .../>`) y
volver a escribir `s.telemetry.algo` DENTRO de un callback de `.map()` no
compila con `noUncheckedIndexedAccess` + `strict`: TS descarta el narrowing de
una propiedad de objeto al cruzar el borde de una función anidada, porque no
puede garantizar que no cambió mientras tanto (una variable local SÍ sobrevive
ese cruce; una propiedad, no). El arreglo no es repetir `s.telemetry &&` en
cada callback — es sacar el bloque a un componente aparte
(`TelemetrySection`) que recibe `telemetry: ScanTelemetryAnalysis` ya
no-nullable como prop. Mismo motivo por el que `SEVERITY_LABEL[sev]` con
`noUncheckedIndexedAccess` devuelve `string | undefined` aun con `sev` tipado
como el literal exacto de sus claves — un `Record<string,string>` genérico
indexado siempre puede volver `undefined` bajo ese flag; el fallback
`?? sev` (mismo patrón que ya usaba `SEVERITY_LABEL[a.severity] ?? a.severity`)
lo resuelve sin retipar el mapa.

### El título del DTC se resuelve iguales que en `/escaneres/detecciones`

`dtcDetails` usa el MISMO `lookupDtc()` de `~/server/dtc-catalog` — no una
segunda copia del catálogo. `standardDescription` (`diagnostic_dtcs.standard_
description`) se muestra igual aunque esté 100% NULL en producción hoy (ver
`scan-detections.md`): es la columna que el backend dejó pensada para esto, y
el día que se cargue tiene que aparecer sin tocar este archivo.

### Ni una escritura acá tampoco

Mismo criterio que el resto de este archivo: la pantalla es de lectura
completa. Si aparece un `UPDATE`/`INSERT` en `getScanSessionDetail`, está mal.

## ⚠ El listado es `escaneres.sesiones.index.tsx`, NO `escaneres.sesiones.tsx`

Corregido el 2026-09-25. Con el listado en `escaneres.sesiones.tsx`, la ficha
`escaneres.sesiones.$sessionId.tsx` quedaba anidada ADENTRO del listado, que
no tiene `<Outlet/>`: cualquier link o click a una sesión cambiaba la URL y la
pantalla seguía mostrando la tabla. La ficha existía desde el 2026-09-13 y no
se podía abrir desde ningún lado. Sin error, ni en el build ni en la consola.

Es la misma trampa que `leads.md` documenta para `leads.pedidos.index.tsx` y la
que esquiva `chats.index.tsx`. **Regla: si una ruta `x.$id.tsx` es la ficha de
un listado, el listado es `x.index.tsx`.** Chequeo: en `routeTree.gen.ts`, el
`getParentRoute` de la ficha tiene que ser el layout (`AuthedEscaneresRoute`),
nunca la ruta del listado.

## La ficha, revisada el 2026-09-25

**Se entra clickeando la fila entera**, no sólo la fecha — en el listado, en el
panel de la matriz y en el de detecciones, con el mismo hook
(`~/components/useSessionRowClick`). El `<Link>` de la fecha se queda para
teclado, botón del medio y pestaña nueva; el click se ignora si cae en otro
control de la fila (el link del usuario, copiar el id) o si hay texto
seleccionado.

Orden de la ficha: resumen (estado, duración, lecturas, DTCs, **distancia desde
borrado** con "no informada" ≠ `0 km`, km del auto, batería, escáner, vehículo
con combustible/caja, usuario) → DTCs → **un gráfico por PID** → anomalías →
historia del auto (sus otros escaneos + el último mantenimiento HECHO hasta el
día del escaneo) → IA → datos técnicos plegados.

- **Los DTC se listan desde el snapshot**, todos con título (`dtcCodeInfo`,
  `lookupDtc`). Antes la tabla sólo tenía los de `diagnostic_dtcs` (los que
  alguien buscó) y los demás quedaban como chips sin título.
- **Un PID es un gráfico de RANGO** (`~/components/PidRangeChart`), no una
  curva: la base sólo guarda `{min,max,avg,stdDev,sampleCount}` por PID. Las
  lecturas crudas están en DigitalOcean Spaces y **el panel no las lee —
  decidido el 2026-09-25, nada que tenga que ver con DigitalOcean**. La ficha
  lo dice en pantalla.
- **Etiquetas, unidades y límites físicos de cada PID** viven en
  `~/lib/scan-pids` (`PID_INFO`), compartido con `/escaneres/comparar`. Una
  clave nueva del backend se muestra cruda y ordena al final.
- **Lectura dudosa** (`implausibleReason`, `isSuspectSession`): un PID fuera de
  su rango físico se pinta ámbar; 3 o más en la misma sesión la marcan entera
  como basura. Calibrado contra producción: 2 sesiones enteras (motor a 181 °C,
  227 km/h y 8.280 rpm clavados, trims en −100) y 3 PIDs sueltos en su byte
  crudo extremo. Se marca, no se esconde.
- `vehicleOdometerKm` es el km ACTUAL del auto: la base no guarda el km por
  sesión, y la ficha lo aclara.
- El mantenimiento es `performed_at <= día del escaneo` en hora de Buenos Aires
  (`performed_at` es la fecha que tipeó la persona), y viaja como texto
  `YYYY-MM-DD` armado en SQL: es un `date`, y pasarlo por `Date` corre el día.

## Qué NO se implementó, y por qué

- **Paginación** en el listado. 34 sesiones al 2026-09-08. Cuando moleste, el
  arreglo es mejorar la búsqueda, no agregar páginas (mismo criterio que
  `/usuarios`).

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
