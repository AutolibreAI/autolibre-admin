# Comparar escaneos (`/escaneres/comparar`)

Alcance: `src/lib/scan-compare.ts`, `src/lib/scan-pids.ts`,
`src/server/scan-compare.repo.ts`, `src/fn/scan-compare.ts`,
`src/routes/_authed/escaneres.comparar.tsx`, `src/components/PidRangeChart.tsx`,
y la cuarta entrada de `TABS` en `src/routes/_authed/escaneres.tsx`.

Agregada el 2026-09-25 (`.claude/plans/escaneos-pedidos-actividad-2026-09-25.md`, parte C).

## Qué consulta reemplaza

La que nadie arma: abrir el jsonb `driving_telemetry_analysis.metrics` de N
escaneos del mismo modelo y compararlos a ojo. Pregunta tipo del dueño de
producto: *"¿cuál es el LTFT normal de un Vento 2.5?"* — y detrás, comparar
autos iguales o parecidos que difieren en algo (DTCs, km, mantenimiento, año,
caja, combustible).

## Qué dato hay, y qué NO

Por escaneo y por PID, el resumen `{min, max, avg, stdDev, sampleCount}`. **Las
curvas en el tiempo NO**: viven en DigitalOcean Spaces
(`driving_session_chunks.object_key`) y se decidió el 2026-09-25 no tocar nada
de DigitalOcean (ni credenciales ni lectura). Para "¿cuál es el valor normal?"
alcanza con la media de cada escaneo; la pantalla lo explica en voz alta.

Si algún día aparece un endpoint del backend que devuelva la serie, el lugar
para las curvas es la selección de escaneos de esta pantalla.

## "Similar" son tres niveles, sin adivinar

| Nivel | Predicado | Vento 2.5 2007, al 2026-09-25 |
|---|---|---|
| `exact` | mismo `vehicle_catalogs.id` | 7 escaneos · 2 autos |
| `version` | misma marca + modelo + `trim`, cualquier año | 12 · 3 (2007 + 2015) |
| `model` | misma marca + modelo | 13 · 4 (+ 1.4TSI 2019) |

`vehicle_catalog_specs.engine` está vacío en la mayoría de los catálogos
escaneados: no sirve para agrupar por cilindrada. Parsear "2.5" del `trim`
sería adivinar. **Si alguien agrega un nivel "misma cilindrada" leyendo el
texto, está reintroduciendo el mapeo adivinado** que `partners-coverage.md` ya
descarta para `coverage_zone`.

`LEVEL_PREDICATE` es un `Record` cerrado (el nivel viene de un enum de zod) y
compara con `upper(btrim(coalesce(…)))` de los dos lados.

## El universo

Escaneos con análisis de telemetría: `JOIN` a `driving_telemetry_analysis` (sin
análisis no hay `metrics`). Es un subconjunto del corte `OK` de
`scanners.repo.ts` — el análisis sólo existe si el escaneo trajo datos — así
que no hace falta importar ese predicado.

El catálogo es `JOIN`, a diferencia del resto de `/escaneres` (`LEFT`): la
pregunta ES por modelo, y un auto sin catálogo no tiene contra qué compararse.

Cuadre: `sum(sessions)` de `listComparableCatalogs()` = `count(*)` de
`driving_telemetry_analysis` (52 = 52 al 2026-09-25).

## La selección va en el CLIENTE

El loader depende SÓLO de `compareCatalogId` + `compareLevel`. Autos, escaneos,
PIDs, agrupado y "incluir dudosos" filtran en el cliente la lista que ya vino
(decenas de filas). Así tildar un auto no vuelve al servidor, y el valor típico,
los gráficos y la tabla salen siempre del mismo snapshot. `metrics` viaja
entero por la misma razón. El día que un grupo tenga cientos de escaneos, esto
se replantea.

Search params calificados `compare*` (→ `notifications.md`). Vacío = todos (o
los PIDs default), nunca "ninguno". Cambiar de modelo o de nivel limpia autos y
escaneos: los ids elegidos pertenecían al grupo anterior.

## "Valor típico": por escaneo Y por auto

Cada tarjeta de PID muestra la mediana de las medias **por escaneo** (con IQR)
y la mediana **por auto** (un valor por auto: la mediana de sus escaneos). No es
redundante: el Vento 2007 de producción tiene 6 escaneos creíbles y el 2015
tiene 5, y "por escaneo" deja que el que más escaneó defina el "normal". El
número grande es el de por auto.

Debajo de `MIN_VEHICLES_FOR_CONFIDENCE` (3 autos, de `~/lib/scanners`, el mismo
piso que la matriz de compatibilidad) el valor típico sale en gris con "poca
evidencia". Al 2026-09-25 casi ningún grupo lo pasa, y que se note es el punto.

## Comparar es AGRUPAR, no pintar

El design system no tiene una paleta categórica que pase el validador de
accesibilidad (`dataviz`): Action Dark y los grises fallan el piso de croma, y
los colores de estado están reservados. Así que una característica **parte las
filas en bloques**, cada uno con su franja IQR y su mediana. Default: por auto.

- **Mantenimiento previo**: hubo uno HECHO en los
  `COMPARE_MAINTENANCE_WINDOW_DAYS` (90) días anteriores. Corte nuestro, y es
  correlación — la pantalla lo dice.
- **Km**: `odometer_value` es el km ACTUAL del auto, no el del día del escaneo;
  `0` cuenta como no cargado (igual que `/vehiculos/listado`).

## Lecturas dudosas

`~/lib/scan-pids`: `implausibleReason(pid, m)` (fuera del rango físico de
`PID_INFO`) e `isSuspectSession` (3+ PIDs imposibles). Una sesión dudosa se
excluye por default con el conteo a la vista y un chip para incluirla; un PID
dudoso suelto de una sesión sana no entra a las medianas pero se dibuja en
ámbar. Un valor dudoso **no estira el eje**: un LTFT en −100 aplastaría al
resto contra el borde; si se sale, la fila lo marca con una flecha.

## `PidRangeChart`

Compartido con la ficha de un escaneo. Un eje por PID (una unidad por gráfico,
nunca dos), números visibles en cada fila además del `title` al pasar el mouse,
sin sombras. Construido con divs posicionados en % (no SVG): se adapta al ancho
sin recalcular nada.

## Ni una escritura

Todo lo que lee lo escribe el backend al subir un escaneo. Si aparece un
`UPDATE`/`INSERT` en `scan-compare.repo.ts`, está mal.

## Cómo verificar un cambio acá

`vite build` + `tsc --noEmit`, el borde server-only:

```bash
grep -rl "compareScanSessions\b\|scan-compare.repo\|listComparableCatalogs\b" .output/public
```

cero resultados, y `node tmp/probe-escaneos.mjs`, que carga los módulos reales
con vite (con `cacheDir` propio) y compara los tres niveles del Vento 2.5 contra
producción.
