# Radicación de vehículos

Alcance: `src/lib/vehicle-location.ts`, `src/server/vehicle-location.ts`,
`src/server/pba-localities.json`, `scripts/fetch-pba-localities.mjs`,
`src/components/VehicleLocationBreakdown.tsx`, `LocationCell` en
`src/components/VehicleCells.tsx`, y los puntos donde se enchufa:
`listVehicles` / `listCatalogUsers` (`vehicles.repo.ts`),
`listUserVehicleSummaries` (`users.repo.ts`), `/vehiculos/listado`, los
desplegables de `/vehiculos/catalogo` y `/usuarios`, y el bloque "Dónde están
radicados" de `/metricas`. Plan de origen: `.claude/plans/radicacion-vehiculos.md`.

## Qué consulta reemplaza

La que nadie arma: `vehicles` → `vehicle_plate_lookups` por patente, abrir el
jsonb, y para PBA pasar la localidad a partido a mano para saber si es AMBA.

## De dónde sale el dato, y qué NO es

`vehicle_plate_lookups.payload->'data'->'currentLocation'` = `{city, province}`.
`UNIQUE (plate)`, así que el join por `v.plate = vpl.plate` es 1:1 (sin
fan-out). Al 2026-09-24, 213 de 233 autos tienen lookup; la patente matchea tal
cual (normalizarla no sumaba ninguna).

**Es el domicilio del TITULAR según el registro**, a la fecha de
`data.sourceDate` (muchas son de 2022). No es dónde vive ni dónde usa el auto
nuestro usuario. La pantalla de métricas lo dice; no lo saques.

`data.locations` es historial y NO se usa.

## AMBA = los 40 municipios, y fue decisión de producto

Decidido el 2026-09-24: "conurbano"/"AMBA" = CABA + los **40 municipios de la
Región Metropolitana**, no los 24 partidos del INDEC. Pilar, Escobar, La Plata,
Luján, General Rodríguez… son AMBA. La lista vive en UNA constante,
`AMBA_PARTIDOS` en `~/lib/vehicle-location`. Cambiar la definición es tocar esa
lista y nada más — no agregues un segundo corte en otro lado.

## Los tres niveles del clasificador

`classifyLocation(province, city)` en `src/server/vehicle-location.ts`:

1. **Provincia**: normalizada contra las 24 jurisdicciones + las formas
   alternativas que el proveedor usa de hecho (`CAPITAL FEDERAL` /
   `Ciudad Autónoma de Buenos Aires`, `NEUQUEN` / `Neuquén`). Esto NO es el
   mapeo adivinado que `partners-coverage.md` prohíbe para `coverage_zone`: la
   lista es oficial y cerrada, sólo se corrige forma. Un valor no reconocido
   queda `sin_clasificar` y se muestra CRUDO.
2. **Partido** (sólo PBA): localidad → partido con el dataset de Georef
   (`pba-localities.json`, `asentamientos` de la provincia 06). Maneja el
   texto sucio del proveedor: segmentos (`VILLA LUZURIAGA-LA MATANZA` → se
   intersecan los dos), `GRAL.`/`PDO.`/`BS.AS.`, y el carácter U+FFFD que ya
   vino ROTO (`LAN?S OESTE`) como comodín de un carácter.
3. **Región**: `caba` · `amba_pba` · `resto_pba` · `interior` ·
   `sin_clasificar` · `sin_dato`.

### La regla de ambigüedad — no la relajes

Una localidad que existe en varios partidos:

- todos de la MISMA región → esa región, `partido = null` (`DEL VISO` es José
  C. Paz y Pilar: los dos AMBA);
- regiones DISTINTAS → `sin_clasificar`, salvo que haya alias.

**Nunca se elige un partido por orden de aparición.** Ese es el error que
convierte un "no sé" en un número plausible y equivocado.

### Los alias

`PLACE_ALIASES`: lo que Georef no resuelve (nombre corto del barrio —
`BOULOGNE`, `DON TORCUATO`— o barrios que no tiene — `NORDELTA`, `ACASSUSO`).
Cada entrada lleva su motivo al lado. **`BELLA VISTA → San Miguel` es la única
que no sale del dato**: el nombre existe en San Miguel (AMBA) y en Hipólito
Yrigoyen (interior). Si aparece un auto de Hipólito Yrigoyen, ese alias lo
ubica mal.

El bloque ámbar "Localidades sin clasificar" de `/metricas` lista lo que falta
cargar — mismo criterio que "DTCs sin título" en `/escaneres/detecciones`.
Al 2026-09-24: **cero**, sobre 118 pares crudos contra producción.

## SQL agrupa por el crudo, JS clasifica

El dataset y la normalización en SQL serían una tabla de referencia en `ops` y
una migración. Los pares crudos distintos son pocos (118), así que:

1. `loadLocationTable()` hace `select distinct` de los pares y los clasifica en JS;
2. `locationJoin(params, table)` los inyecta como `unnest(...)` de seis arrays
   paralelos, y cada consulta filtra, ordena y agrupa por `loc_region` /
   `loc_province` / `loc_partido` como si fueran columnas.

Mismo patrón que el pivot de `/escaneres`. Tres detalles que muerden:

- **`locationJoin` empuja los arrays a `params` y calcula sus `$n`** desde el
  largo actual: llamalo DESPUÉS de empujar los parámetros que ya usás, o no
  toques `params` a mano entre medio. Asume `vehicles` con alias `v`.
- **La ciudad viaja como `''`, no `null`**: el `on` compara
  `coalesce(city, '')` de los dos lados, y `null = null` no matchea.
- Un par que aparezca entre las dos consultas cae en `sin_clasificar` por el
  `coalesce` — la fila no desaparece.

`jsonb_typeof(...) = 'object'` es la guarda: el `payload` no es contrato
nuestro, y si el proveedor cambia la forma el auto sale `sin_dato`, no un 500.

## Dónde se ve

- **`/vehiculos/listado`**: columna "Radicación" (ordenable por región →
  provincia → partido, nunca por el texto crudo), y dos filtros multiselect
  `vehicleRegions` / `vehicleProvinces` — calificados por dominio
  (`notifications.md`), con `multiSelectParam` de `~/lib/catalog`. Vacío = sin
  filtro. Las opciones de provincia salen de la base (`listProvinceOptions`),
  no de las 24 fijas.
- **Desplegables** de `/vehiculos/catalogo` y `/usuarios`: la misma columna
  (`LocationCell`), sin filtro. Si se ve distinto en dos lados, uno está mal.
- **`/metricas`**, "Dónde están radicados": AMBA (CABA + Conurbano con
  desplegable a partidos) · Resto de Buenos Aires (a partidos) · Interior (por
  provincia) · Sin clasificar · Sin dato. Grano **vehículo** (decidido: importa
  más que el usuario), autos activos de usuarios reales (`INTERNAL_PREDICATE`),
  con patentes únicas al lado. Dos %: sobre el total y sobre los que tienen
  dato. Tabla fija, sin search params.

## Los cuadres

Corrido el 2026-09-24 contra producción (`doadmin`, puerto 25060) con
`tmp/probe-radicacion.mjs`, que carga los módulos reales con vite:

- listado sin filtros = `count(*) from vehicles` (233 = 233);
- filtro AMBA = CABA + `amba_pba` (155);
- suma de filas de métricas = autos activos reales (207 = 207).

`tmp/probe-radicacion-pba.mjs` imprime cada localidad de PBA con su partido,
para revisar a ojo después de tocar el clasificador o los alias.

**Un probe con `createServer` de vite lleva `cacheDir` propio**
(`tmp/.vite-probe`). Sin eso comparte `node_modules/.vite` con el dev server,
le regenera las deps optimizadas, y el navegador queda en el skeleton de carga
con `504 (Outdated Optimize Dep)` en la consola — pasó el 2026-09-24 con
`/metricas`, y parecía un bug de la pantalla. Los probes viejos de `tmp/`
(`probe.mjs`, `probe-growth-tz.mjs`…) no lo tienen: si los corrés con el dev
server levantado, reiniciá el dev server después.

## Ni una escritura

`vehicle_plate_lookups` la escribe el backend al consultar una patente. Si
aparece un `UPDATE`/`INSERT` sobre esa tabla desde el panel, está mal.

## Cómo verificar un cambio acá

`vite build` + `tsc --noEmit`, y el borde server-only:

```bash
grep -rl "pba-localities\|classifyLocation\|loadLocationTable\|Boulogne Sur Mer\|POSTGRES_DATABASE_URL" .output/public
```

Cero resultados: el JSON de 70KB y el clasificador no viajan al cliente.

**Ojo al escribir este archivo con una herramienta que acepte JSON**: un
`\u0300` o `\uFFFD` en el contenido puede llegar al disco como el carácter
literal, no como el escape — el agente decodifica los escapes de su propia
entrada, tanto al escribir un archivo como al pasar un script por la shell.
Pasó dos veces al crear este módulo (el clasificador y esta misma regla). El
arreglo que funcionó: armar la barra con `chr(92)` en Python. Chequeo después
de tocar el archivo: `grep -n 'u0300'` tiene que encontrar el escape en el
`norm()`, y no puede quedar ningún carácter de control ni U+FFFD literal.
