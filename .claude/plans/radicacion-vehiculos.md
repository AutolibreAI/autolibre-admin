# Radicación de vehículos

Plan del 2026-09-24. Rama `radicacion-vehiculos`.

**Estado: implementado el 2026-09-24** (fases 0 a 3). La regla viva es
`.claude/rules/vehicle-location.md`; este plan queda como registro de la
decisión. Diferencias con lo planeado: la tabla clasificada se inyecta en SQL
con `unnest` de arrays (`locationJoin`) en vez de resolver el filtro a pares
en JS, así filtro, orden y agrupado usan el mismo mecanismo; y con los alias
cargados quedaron **cero** localidades sin clasificar.

Pedido: la ubicación (radicación) de cada vehículo, leída de
`vehicle_plate_lookups.payload`, como (1) columna visible en las tablas de
vehículos, (2) filtro, y (3) bloque de `/metricas` que muestre dónde están
radicados nuestros autos — por provincia, separando CABA / conurbano / resto
de PBA, y con AMBA como subtotal.

## Qué consulta reemplaza

Ninguna que se corriera: es "la consulta que nadie arma". Para saber dónde
están los autos hay que cruzar `vehicles` → `vehicle_plate_lookups` por
patente, abrir el jsonb y, para PBA, pasar la localidad a partido a mano.

## Decisiones tomadas (con el dueño de producto, 2026-09-24)

1. **AMBA = CABA + los 40 municipios de la Región Metropolitana**, no los 24
   partidos del INDEC. "Conurbano" en la UI = esos 40. Los 40:
   - los 24 del INDEC: Almirante Brown, Avellaneda, Berazategui, Esteban
     Echeverría, Ezeiza, Florencio Varela, General San Martín, Hurlingham,
     Ituzaingó, José C. Paz, La Matanza, Lanús, Lomas de Zamora, Malvinas
     Argentinas, Merlo, Moreno, Morón, Quilmes, San Fernando, San Isidro, San
     Miguel, Tigre, Tres de Febrero, Vicente López;
   - más 16: Berisso, Brandsen, Campana, Cañuelas, Ensenada, Escobar,
     Exaltación de la Cruz, General Las Heras, General Rodríguez, La Plata,
     Luján, Marcos Paz, Pilar, Presidente Perón, San Vicente, Zárate.
   La lista vive en UNA constante (`AMBA_PARTIDOS`), con este motivo en su
   comentario. Cambiar de definición es tocar esa lista, nada más.
2. **Grano de métricas: VEHÍCULO**, no usuario.
3. **Dataset oficial de localidades**: autorizado. Georef (datos.gob.ar),
   `asentamientos?provincia=06` — 2.358 asentamientos de PBA con su
   departamento (= partido). Se usa `asentamientos` y no `localidades` (895)
   porque es superconjunto: trae barrios que la otra no.

## El dato, relevado el 2026-09-24 contra producción

(`current_database = autolibre`, `current_user = doadmin`, puerto 25060)

- `vehicle_plate_lookups`: 222 filas, **UNIQUE (plate)** → el join es 1:1, sin
  fan-out. `payload = {success, data}`; la radicación es
  `data.currentLocation = {city, province}`. `data.locations` es historial: no
  se usa.
- **213 de 233 vehículos tienen lookup**, matcheando `v.plate = l.plate` tal
  cual (la normalización no suma ninguno). Los 20 restantes son "sin dato" y
  se muestran, no se esconden.
- **Provincia sucia pero cerrada**: 22 valores crudos para ~17 provincias
  (`CAPITAL FEDERAL` / `Ciudad Autónoma de Buenos Aires`, `NEUQUEN` /
  `Neuquén`, `CORDOBA` / `Córdoba`, `RIO NEGRO` / `Río Negro`). Las 24
  jurisdicciones son una lista oficial cerrada, así que normalizar acá NO es
  el mapeo adivinado que `partners-coverage.md` prohíbe para `coverage_zone`.
  Un valor que no matchea se muestra CRUDO.
- **La ciudad es LOCALIDAD, no partido**, y viene sucia: `MARTINEZ`,
  `NORDELTA`, `VILLA LUZURIAGA-LA MATANZA`, `T. SUAREZ - EZEIZA`,
  `GRAL.PACHECO`, y **5 filas con U+FFFD** (`LAN�S OESTE`) — el carácter ya
  vino roto del proveedor.
- `data.sourceDate`: 181 de 222 son anteriores a 2025. Es la fecha del dato
  del registro, no de la consulta.

### Prueba del clasificador (probe sobre el dataset, 2026-09-24)

Sobre los 105 autos de PBA: **94 clasifican sin ambigüedad**, 2 ambiguos, 9
sin match.

| Caso | Causa | Arreglo |
|---|---|---|
| `GRAL.PACHECO`, `MONTE GRANDE PDO. E.ECHEVERRIA` | normalización del probe | abreviaturas `GRAL.`/`PDO.` + probar por segmentos y prefijo |
| `BOULOGNE`, `DON TORCUATO`, `ACASSUSO`, `NUEVE DE ABRIL`, `NORDELTA` | nombre corto o barrio que el dataset no tiene | alias explícitos (≈6 líneas) |
| `DEL VISO` → José C. Paz \| Pilar | homónimo | **no importa**: los dos son AMBA, la región sale igual |
| `BELLA VISTA` → San Miguel \| Hipólito Yrigoyen | homónimo | alias explícito a San Miguel. Es la única decisión que no sale del dato |

Regla del clasificador: **ambiguo con la MISMA región → se resuelve la región
y el partido queda vacío; ambiguo con regiones distintas → "sin clasificar"**
salvo que haya alias. Nunca se elige un partido por orden de aparición.

## Fase 0 — el clasificador (sin UI)

- `src/server/pba-localities.json`: el dataset recortado a `{nombre,
  departamento}` (~80KB). **Server-only y fuera de `~/lib`**, mismo criterio
  que `dtc-codes.json`. Se regenera con un script one-off
  (`scripts/fetch-pba-localities.mjs`), no a mano.
- `src/lib/vehicle-location.ts` (liviano, compartido): `PROVINCES` (las 24,
  con etiquetas), `AMBA_PARTIDOS`, `VEHICLE_REGIONS` (`caba`, `amba_pba`,
  `resto_pba`, `interior`, `sin_clasificar`, `sin_dato`) y sus etiquetas.
- `src/server/vehicle-location.ts`: `classifyLocation(province, city)` →
  `{ province, partido, region }`. Normaliza (NFD sin acentos, mayúsculas,
  puntuación, `GRAL.`→`GENERAL`, `PDO.`), prueba el string entero, después
  cada segmento de `-`/`,`, después el nombre como partido; U+FFFD es comodín
  de un carácter. Alias en un `Record` al lado, con comentario por entrada.
- **SQL agrupa por el crudo, JS clasifica** — mismo patrón que el pivot de
  `/escaneres`. Un fragmento compartido `VEHICLE_LOCATION_JOIN` (LEFT JOIN a
  `vehicle_plate_lookups` + `jsonb_typeof` como guarda: si el proveedor
  cambia la forma, sale "sin dato", no un 500). Sin migración, sin datos de
  referencia en `ops`.
- `listLocationGaps()`: los pares crudos `(province, city)` que quedan "sin
  clasificar", para el bloque ámbar (Fase 2).

## Fase 1 — columna y filtro

- **`/vehiculos/listado`**: columna "Radicación" (`San Isidro · AMBA`, o
  provincia sola fuera de PBA/CABA; "sin dato" gris). Ordenable por región y
  provincia (entra al `Record` cerrado de sort).
- **Filtros multiselect** `vehicleRegions` y `vehicleProvinces` — calificados
  por dominio (`notifications.md`). Opciones de provincia data-driven (las que
  existen en la base). Array vacío = sin filtro.
- El filtro va así: JS resuelve región/provincia elegida → lista de pares
  crudos que clasifican ahí → SQL filtra con `(prov, city) = any(...)` sobre
  dos arrays paralelos (o `unnest`). "Sin dato" = `l.id is null`.
- Misma columna, sin filtro, en el desplegable de `/vehiculos/catalogo`
  (`listCatalogUsers`) y en el toggle de `/usuarios`
  (`listUserVehicleSummaries`), para que el mismo auto se lea igual.

## Fase 2 — `/metricas`, bloque "Dónde están radicados"

Grano vehículo, autos activos por default (mismo criterio que `fleetScope`),
excluidas las cuentas internas (`INTERNAL_PREDICATE` por el dueño). Dos
columnas: **vehículos** (crudo) y **patentes únicas** (el mismo auto cargado
por dos usuarios cuenta una vez, como la card de Inicio), con %.

```
AMBA                      (subtotal)
  CABA
  Conurbano (40 municipios)
Resto de Buenos Aires
<cada provincia del interior, por cantidad desc>
Sin clasificar            (ámbar, sólo si > 0)
Sin dato                  (sin consulta por patente)
```

- Cuadre: la suma de las filas hoja = total de vehículos del universo.
- Debajo, bloque ámbar "Localidades sin clasificar" (como "DTCs sin título"),
  calculado sin filtros: lo que falta agregar a los alias.
- Nota en pantalla: **radicación = domicilio del titular según el registro**,
  no dónde vive o usa el auto nuestro usuario (si el auto se vendió o está a
  nombre de un familiar, no es él), y el dato puede ser viejo (`sourceDate`).

## Fase 3 — docs

`.claude/rules/vehicle-location.md` (el clasificador, AMBA = 40, el guard del
jsonb, "SQL agrupa, JS clasifica", la regla de ambigüedad), sección en
`vehicles.md` y en `metricas.md`, filas en la tabla de pantallas del
`CLAUDE.md`.

## Lo que NO hace

- **Ninguna escritura.** `vehicle_plate_lookups` la escribe el backend.
- No normaliza `coverage_zone` de partners con este clasificador. Sería
  tentador, pero es otra decisión — anotada, no hecha.
- No geolocaliza (no hay coordenadas en el payload).

## Verificación

`vite build` + `tsc --noEmit`; borde server-only:
`grep -rl "pba-localities\|classifyLocation\|POSTGRES_DATABASE_URL" .output/public`
→ vacío. Probe cargando el módulo real con vite: todos los pares crudos de la
base clasificados, cuadre de la tabla de métricas contra `count(*)` de
`vehicles`.
