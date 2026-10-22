# Cobertura AMBA (`/partners/cobertura`) — el mapa de demanda contra oferta

Alcance: `src/lib/coverage-map.ts`, `src/components/CoverageMap.tsx`,
`src/routes/_authed/partners.cobertura.tsx`, `public/geo/zonas_amba.geojson`,
el link de "Tareas sin solución" en `src/routes/_authed/metricas.tsx`.
Spec: `spec-mapa-cobertura-admin.md` (2026-10-22). Pedido a los devs:
`docs/pedido-backend-cobertura.md`.

Reemplazó el 2026-10-22 a la matriz zona-de-texto × 16 categorías (lo que
`partners-coverage.md` llama "el tablero de cobertura"). Esa sección de
`partners-coverage.md` describe código que ya no tiene pantalla.

## Qué contesta

"¿Adónde salgo a buscar partners, y de qué rubro?". Cruza los pedidos reales
con los partners por partido del AMBA y comuna de CABA. Un pedido está
**cubierto** con 3 o más partners con local, con su rubro, a ≤ R km.

## v1 sin endpoint propio, y lo que eso cuesta

Decidido el 2026-10-22: **la v1 no toca el servidor**. Lee de server
functions que ya existían:

| Dato | Server function | Por qué ésa |
|---|---|---|
| Partners: servicios, modalidad, coordenadas | `listPartnerCandidatesFn`, con TODAS las categorías (por tandas de 16) | Es la única que trae los servicios de cada partner. `listPartners` trae sólo categorías, y los 10 rubros NO salen de las categorías (ver abajo) |
| Pedidos reales | `listQuoteRequestsFn` (`quoteShowDuplicates: false`) − `cancelled_by_user` | — |
| GPS de cada pedido | `getQuoteRequestFn`, uno por pedido, **desde el navegador** | El listado no trae `location_latitude/longitude` |
| Partners activos totales | `getPartnerCoverageBoard().totalActivePartners` | Para contar los que no tienen servicios (candidatos los deja afuera) |

El costo: **~750 ms por pedido** (8 consultas por detalle). Van de a 4
(`GPS_CONCURRENCY`; el pool es de 5) y en tandas de 6 para no redibujar el
mapa por cada uno. Los pedidos aparecen de a poco y la conclusión de arriba
dice que todavía está armándose. Hay cache de módulo: cambiar rubro, radio o
vista no vuelve a pedir nada.

**El día que exista el endpoint del spec (sección 3), esto se reemplaza**: las
funciones de `~/lib/coverage-map` que traducen SQL a JS (`inferPedidoRubro`,
`toCoveragePedido`, `toCoverageProveedor`) se van y el resto consume las filas
del endpoint. No sumes un cuarto camino de lectura mientras tanto.

## Los 10 rubros NO son las 16 categorías

Agrupan servicios de categorías distintas: «Gomería móvil» (Asistencia) va a
Neumáticos, «Baterías» (Repuestos) va a Electricidad, «Mecánico a domicilio»
(Asistencia) a Mecánica. Por eso el rubro de un partner sale del NOMBRE de cada
servicio (`SERVICE_RUBRO`, copiado del `CASE` de 3.2). Un servicio que no está
ahí (Grúa, Seguros, Tasación…) no da rubro, y la pantalla lista cuáles son: un
servicio renombrado en el catálogo dejaría de contar sin ningún error.

En la UI de esta pantalla "rubro" son estos 10, no las categorías del resto de
`/partners`. Es lo que pidió el spec, y la tabla por rubro los muestra con su
nombre completo en el `title`.

## Las reglas copiadas del spec, y dónde se apartan del resto del repo

- **Rubro del pedido por palabras** (`PEDIDO_RUBRO_RULES`, mismo orden que el
  `CASE`; sin match → Mecánica). No usa `ops.quote_request_rubro` (lo que
  clasifica el operador): el spec manda inferir, y los criterios de aceptación
  salen de ahí. Es la primera mejora de la sección 7 del spec.
- **Pedido tipeado → centro de localidad** (`LUGARES`, 21 lugares). No usa la
  coordenada geocodificada de la 021 por el mismo motivo. Un pedido tipeado de
  una localidad que no está en la lista queda "sin ubicación".
- **GPS redondeado a 3 decimales** antes de calcular nada.
- **Cuatro partners sin coordenadas se ubican por texto** (`ZONE_BY_TEXT`:
  Villa Crespo, Tigre, Rafael Castillo, General Rodríguez). Es una excepción
  acotada a "no normalizar `coverage_zone`" (`partners-coverage.md`): son
  nombres de localidad que el spec trae escritos, no "Zona Norte". **No se
  agrega un quinto**: el arreglo es cargarle la coordenada al partner.
- **Remoto** = `A distancia`, o `Mixto`/`A domicilio` sin coordenadas. No entra
  a ninguna zona (salvo por texto) y sólo suma a la cobertura de Trámites.
- **Distancia equirectangular**, no Haversine como `listPartnerCandidates`: el
  spec la define así y a 10 km la diferencia es despreciable. No "unifiques"
  una con la otra: los números del spec dejarían de cuadrar.

## Prioridad y usuarios

`zonePriority()` sigue el orden de la sección 4.5. «Demanda latente» necesita
usuarios por zona (domicilio de la cédula, ciudad del login), que **no hay de
dónde leer sin el endpoint** — son datos personales y tienen que llegar
agregados. La función ya acepta `usuariosDomicilio`/`usuariosIp`; mientras
lleguen nulos esa rama no se cumple nunca, y la pantalla lo dice en las notas
y en "Cómo se calcula". No se estima con otra cosa.

## El geojson es estático

`public/geo/zonas_amba.geojson` (54 zonas: 39 partidos + 15 comunas, `id`
slug, `nombre`, `area`). Lo baja el navegador; no viaja en el bundle ni pasa
por el servidor. `parseZones()` descarta un feature con otra forma en vez de
romper. Punto en polígono par-impar sobre TODOS los anillos; Leaflet dibuja
con `fillRule: 'evenodd'` para que el mapa y el cálculo coincidan en un
MultiPolygon.

## El mapa

`CoverageMap` sigue las reglas de `PartnerMap` (import de Leaflet adentro del
efecto, círculos y no el PNG con sombra, colores de tokens, tooltips por
`textContent`). La diferencia: el mapa se crea UNA vez y las capas se
redibujan por firma del contenido, así cambiar de rubro o radio no mueve la
vista. Ir a una zona es explícito (`flyNonce`): clic en el ranking o en la
matriz vuela; clic en el mapa sólo resalta la fila.

## Search params

Calificados `coverage*` (`coverageView`, `coverageRubro`, `coverageRadius`,
`coverageZona`, `coverageSort`, `coverageDir`) — `view`, `sort`, `rubro`
pelados chocan con otras rutas (`notifications.md`). `q` se comparte.
`coverageRubros` (el array de categorías del tablero viejo) ya no existe; el
link de Métricas ("Tareas sin solución" → `no_partner`) abre la tabla por
rubro con el rubro del servicio (`serviceRubro`).

## Ni una escritura

Todo es lectura. Si aparece una escritura disparada desde esta pantalla, está
mal.

## Cómo verificar un cambio acá

`vite build` + `tsc --noEmit`, y `node tmp/probe-cobertura.mjs`: carga los
repos y `~/lib/coverage-map` reales, arma los mismos datos que el loader y
imprime los números de la sección 6 del spec. Contra producción el
2026-10-22: 44 pedidos en el AMBA, 23 cubiertos (52 %), 92 partners con local,
6 «Salir ya» (las 5 del spec + Lomas de Zamora por AL-1115, que entró ese día),
Sur 9/9. Datos del spec: 21/10 (43 · 23 · 92 · 5 · 8/8).
