# Detecciones de escáner (`/escaneres/detecciones`)

Alcance: `src/lib/detections.ts`, `src/server/detections.repo.ts`,
`src/fn/detections.ts`, `src/routes/_authed/escaneres.detecciones.tsx`, y la
tercera entrada de `TABS` en `src/routes/_authed/escaneres.tsx`.

Las otras dos pestañas: `.claude/rules/scanner-compatibility.md` (la matriz) y
`.claude/rules/scan-sessions.md` (la lista cruda de sesiones).

## Qué contesta, y qué NO

Cada fila es **un código DTC o un tipo de anomalía**, agregado sobre todos los
escaneos que trajeron datos: cuántas sesiones lo vieron, en cuántos vehículos
únicos, en cuántos modelos del catálogo, y desde/hasta cuándo.

- **No es** `/escaneres/sesiones`, que muestra los DTC y anomalías de UN escaneo
  por fila. Ésta es la vista transversal: "¿qué falla aparece más seguido en la
  flota?".
- **No es** `/escaneres/compatibilidad`, que cruza escáner × modelo.

## Los DTC y las anomalías tienen UNIVERSOS DISTINTOS — y fue un bug que casi pasa

El primer diseño contaba las dos ramas sobre el mismo corte `OK`
(`status = 'completed' AND total_readings > 0`, el de `scanner-compatibility.md`).
**Está mal para los DTC**, y lo agarró la verificación contra producción:

- Un **código DTC** se lee de `session_dtc_snapshots`, que tiene una fila por
  CADA sesión `completed` — incluso las que "engancharon sin traer nada". Un DTC
  NO es el stream de telemetría en vivo: `scanner-compatibility.md` ya lo dice
  ("`total_readings` es el stream, no la lectura de DTCs"). Al 2026-09-09,
  **`P0171` y `P0170` —los dos códigos más frecuentes— aparecen SÓLO en sesiones
  sin datos.** Con el corte `OK` desaparecían de la tabla.
- Una **anomalía** sale de `driving_telemetry_analysis`, que sólo existe cuando
  el escaneo trajo datos. Ahí el corte `OK` sí corresponde.

Por eso el CTE `scan_sessions` es **todas las `completed`** con un flag
`has_data`, y NO filtra por él: la rama DTC lo usa completo, la rama anomalía
hace `join ... and ss.has_data`. Y hay **dos pares de denominadores** en
`DetectionsView`:

| | universo | al 2026-09-09 |
|---|---|---|
| `dtcSessions` / `dtcVehicles` | sesiones `completed` | 34 / 16 |
| `anomalySessions` / `anomalyVehicles` | + `has_data` | 28 / 16 |

`DetectionTableRow` elige el par según `row.kind`. Los denominadores salen de su
propia consulta (reusa `scan_sessions`), no del `count` de las filas mostradas
—que cambia con cada filtro—, mismo criterio que los totales de
`scanner-compatibility.md`.

## El corte se RECOPIA acá, no se importa

El predicado `status = 'completed'` (y el flag `total_readings > 0`) vive también
en las cadenas `OK`/`NO_DATA` de `scanners.repo.ts`, en la columna «Escaneos» de
`users.repo.ts` y en `sessionBucket()`. Acá se reescribe a mano porque el CTE
necesita el alias sin el prefijo `ds.` que esas cadenas llevan cableado. Si algún
día se puede parametrizar ese alias, esta copia se va con ellas — misma familia
que `INTERNAL_PREDICATE` entre `ops.repo.ts` y `v_ai_usage`.

## `sesiones` vs `disparos` — una anomalía multi-PID

`session_dtc_snapshots.codes` es un conjunto por sesión, así que para un DTC
`occurrences == sessions` siempre.

Para una anomalía **no**: el mismo `type` se dispara dos veces en la misma
sesión si afecta a dos PIDs distintos (`EXCESSIVE_FLUCTUATION` sobre `maf` y
sobre `engineLoad`). Al 2026-09-09, `EXCESSIVE_FLUCTUATION` tiene 18 disparos en
14 sesiones. La columna «Sesiones» cuenta 14 (es lo comparable con el % y con
vehículos únicos); «N disparos» aparece como subtexto sólo cuando
`occurrences > sessions`. Misma forma que `stuck`/`noData`: una señal derivada
no se presenta como el dato principal.

## La severidad es `array_agg` + rank, no un valor

Hoy cada `type` de anomalía tiene una sola severidad en la base, pero la
severidad la calcula el backend por evidencia y podría variar entre sesiones.
Por eso la rama de anomalías hace `array_agg(distinct severity)` y un
`severity_rank` (rojo 3 · violeta 2 · amarillo 1) para el `ORDER BY`. El repo
ordena las severidades peor-primero en JS con `SEVERITY_RANK` y la UI las muestra
todas. Un valor de severidad nuevo del backend se muestra crudo (`rank 0`,
ordena último) — mismo criterio que los enums espejados del resto del repo.

Un **DTC no lleva severidad** en estas tablas: `severities` es `NULL` en su rama
del `UNION ALL`. Filtrar por severidad (`$1 = any(severities)`) deja fuera todos
los DTC a propósito — elegir "roja" implica "mostrame anomalías rojas".

## El título del DTC sale de un archivo local, no del backend

`src/server/dtc-codes.json` (~1MB, ~1100 entradas: `codigo`, `nombre_corto`,
`sistema`, `severidad`). `src/server/dtc-catalog.ts` lo carga a un `Map` una vez
y expone `lookupDtc(code)`.

**Por qué acá y no en el backend:** el backend NO expone un diccionario de DTC, y
`diagnostic_dtcs.standard_description` —el único lugar del schema pensado para
esto— está **100% NULL en producción** (relevado 2026-09-09, incluso P0420 /
P0171). Sin el archivo, la pantalla sólo puede mostrar el código crudo.

Es una lista de referencia del panel, mismo criterio que `MANUAL_LANGUAGES` en
`~/lib/manuals`: no inventa dominio (el código YA lo detectó un escaneo real),
le pone un título en el único lugar donde hoy se puede. **Se mantiene a mano.**
El bloque "DTCs sin título" existe para saber qué agregar.

Reglas:

- **Server-only y fuera de `~/lib`.** Son 1MB; no tienen por qué viajar al
  cliente. La ruta recibe `dtcTitle` / `dtcSystem` ya resueltos por el loader.
  El chequeo de borde tiene que confirmar que `nombre_corto` NO aparece en
  `.output/public`.
- **Un código sin entrada NO se esconde:** su fila sale con "sin título cargado"
  en ámbar, y además va al bloque de arriba.
- **`dtcFamily()`** en `~/lib/detections` sigue existiendo como respaldo: parte
  el código por su forma OBD-II (`P` = motor, 2º dígito `0`/`2` = genérico) para
  la columna "familia" cuando el catálogo no tiene ese código. La letra y el
  dígito SON la taxonomía, no hay nada que consultar.

## El bloque "DTCs sin título" se calcula SIN los filtros de la tabla

`DetectionsView.missingDtcs` sale de una tercera consulta que agrega TODOS los
códigos DTC sobre `scan_sessions` (sin `q`, sin `detectionKind`, …) y en JS deja
los que `lookupDtc` no encuentra. Es "todo lo que falta cargar", no "lo que
falta en esta vista".

Va en un **bloque aparte arriba de la tabla**, no en un chip de filtro (fue una
decisión explícita): es trabajo pendiente que hay que ver aunque la tabla esté
filtrada por otra cosa. `tone="warn"` (ámbar): falta un dato, no está roto nada
— mismo criterio que `stuck` en `/operacion`. Cada código es un `<button>` que
setea `q` + `detectionKind: 'dtc'` para verlo en la tabla.

Al 2026-09-09: **C1801 y P2300** (2 sesiones / 1 vehículo cada uno).

## El join al catálogo es LEFT, y `models` puede ser 0

`scan_sessions` sube de `vehicles` → `vehicle_catalog_specs` → `vehicle_catalogs`
con `LEFT` en las dos patas: la FK garantiza el spec, no el catálogo — misma
trampa que documentan `scanner-compatibility.md` y `chats.md`. `catalog_id`
queda `NULL` para un auto huérfano, y `count(distinct catalog_id)` lo ignora:
una detección que sólo apareció en autos sin catálogo muestra `models = 0`, y la
UI lo pinta "—". Es correcto ("0 modelos conocidos"), no un bug.

## `q` matchea el código / tipo CRUDO

`key` es `P0171` o `UNSTABLE_MAF`. La etiqueta legible de la anomalía
(`anomalyTypeLabel`, importada de `~/lib/scan-sessions`) se arma en JS, así que
buscar "inestable" no encuentra `UNSTABLE_MAF` pero "maf" o "P017" sí. Misma
limitación exacta que `scan-sessions.repo.ts` con los códigos DTC — no se
resuelve metiendo el mapa de etiquetas en el SQL.

## Search params calificados por dominio

`detectionKind` / `detectionSeverity` / `detectionFamily`, nunca `kind` /
`severity` / `family` pelados: `kind` ya lo usan `/documentos` y
`/notificaciones` con otros enums, y el merge de `FullSearchSchema` de TanStack
rompe el typecheck en la ruta ajena. → `.claude/rules/notifications.md`.
`sort`/`dir` van pelados (igual que `/escaneres/sesiones`): las pestañas linkean
sin `{...prev}`, así que no hay spread cross-route que los una.

`SORT_COLUMNS` es el `Record` cerrado que hace seguro interpolar la columna en
el `ORDER BY` — mismo patrón que `scan-sessions.repo.ts` y `listUsers`.

## Ni una escritura, ni detalle por fila

`session_dtc_snapshots` y `driving_telemetry_analysis` los escribe el backend
cuando el teléfono sube los chunks. Una detección es un hecho que pasó — mismo
criterio que `driving_sessions`, `conversations`, `notifications`. Si aparece un
`UPDATE`/`INSERT` en `detections.repo.ts`, está mal.

**No hay `/escaneres/detecciones/:key`.** El drill-down de "qué sesiones vieron
este código" ya lo cubre `/escaneres/sesiones?q=P0171`, y el detalle de una
anomalía (`justification`, `probableCauses`, `evidence`) vive en el jsonb sin
pantalla propia — si algún día hace falta, es el mismo pendiente que anota
`scan-sessions.md`.

## Cómo verificar un cambio acá

En esta máquina: `& ".\node_modules\.bin\vite.CMD" build` (regenera
`routeTree.gen.ts` — una pestaña o `Link` nuevo sólo se valida DESPUÉS del
build) y después `& ".\node_modules\.bin\tsc.CMD" --noEmit`. Más el borde
server-only:

```bash
grep -rl "listDetections\|detections.repo\|POSTGRES_DATABASE_URL\|scan_sessions\|nombre_corto" .output/public
```

Cero resultados. `~/server/detections.repo` y el `dtc-codes.json` de 1MB NO
están en el grafo del cliente. (Ojo: el STRING `src/server/dtc-codes.json`
aparece en el bundle del cliente y está bien — es copy de la UI dentro de
`escaneres.detecciones.tsx`, no el archivo. Lo que no puede aparecer es
`nombre_corto` / un título de código.)
