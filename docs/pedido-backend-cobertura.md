# Pedido al backend: mapa de cobertura AMBA (2026-10-22)

De: panel de administración (`autolibre-admin`). Para: los devs de back.

La pantalla **Partners › Cobertura** ya es el mapa del spec
(`spec-mapa-cobertura-admin.md`): zonas del AMBA por prioridad, pedidos,
partners, ranking, resumen por área y la tabla por rubro. Se armó **sin tocar
el servidor**, leyendo de endpoints que ya existían. Eso alcanza para que
funcione, pero tiene tres agujeros que desde el front no se pueden tapar.

Lo relevado salió de **producción** el 2026-10-22 (`autolibre`, `doadmin`,
puerto 25060), sólo lectura.

## Cómo funciona hoy (para que se entienda qué hay que reemplazar)

| Dato | De dónde sale hoy | Problema |
|---|---|---|
| Partners con servicios, modalidad y coordenadas | `listPartnerCandidatesFn` llamado con las 16 categorías | Ninguno grave. Es un endpoint pensado para la ficha de un pedido y acá se usa para otra cosa; deja afuera a los partners sin servicios (hoy: 0) |
| Pedidos reales, descripción, localidad | `listQuoteRequestsFn` (sin duplicados) + filtro de `cancelled_by_user` en el front | Le manda al navegador teléfono, email y nombre de hasta 500 pedidos para dibujar un mapa |
| **GPS de cada pedido** | `getQuoteRequestFn`, **una llamada por pedido**, desde el navegador | Ver punto 1 |
| Usuarios por zona | — | Ver punto 2 |

Las reglas de cálculo (rubro del pedido por palabras, centros de localidad
para los tipeados, agrupación de servicios en 10 rubros, zona por punto en
polígono, cobertura a R km, prioridad) viven en `src/lib/coverage-map.ts`,
traducidas una por una de las consultas 3.1 y 3.2 del spec.

**Cuadre contra el spec (sección 6), rubro «Todos», 5 km, 2026-10-22:**

| Criterio (datos del 21/10) | Pantalla (22/10) | Diferencia |
|---|---|---|
| 43 pedidos en el AMBA | 44 | AL-1115, entró el 22/10 a la madrugada en Lomas de Zamora |
| 23 cubiertos (53 %) | 23 (52 %) | mismo pedido |
| 92 partners con local | 92 | — |
| Salir ya: Tigre, Lanús, Pilar, Comuna 12, Almirante Brown | las mismas + Lomas de Zamora | AL-1115 lleva a Lomas a 2 sin cobertura |
| Sur: 8 pedidos, 8 sin cobertura | 9 / 9 | AL-1115 |

## 1. Un endpoint de lectura para los pedidos del mapa — el que más urge

**Hoy:** el listado de pedidos no trae `location_latitude/longitude`. La única
forma de obtener el GPS es abrir el detalle de cada pedido. Con 60 pedidos son
60 llamadas, y cada una corre unas 8 consultas (sesión, disponibilidad, el
pedido, rubros, vehículo escrito, geocode…). Medido desde esta máquina:
**~750 ms por pedido**. En el navegador van de a 4, así que los pedidos tardan
unos 10-15 segundos en aparecer en el mapa, y crece lineal con los pedidos.
Además, cada detalle trae notas internas, `raw_submission` y contacto que el
mapa no usa.

**Pedido:** lo que el spec llama `GET /admin/coverage` → `pedidos`, o sea la
consulta **3.1** tal cual está en el spec:

- pedidos reales (sin `duplicate` ni `cancelled_by_user`);
- `numero`, `fecha`, `canal`, `servicio` (rubro inferido), `lat`/`lng`
  **redondeados a 3 decimales**, `aprox`, `localidad`;
- **sin** descripción, teléfono, email ni nombre;
- sólo admins.

Con esto el front deja de pedir detalles uno por uno y deja de recibir datos
personales que no muestra. El cálculo del front no cambia: consume esas filas
en lugar de armarlas.

> Nota de arquitectura, para decidir dónde vive: el panel ya habla con
> Postgres directo (es su decisión 1). El endpoint puede ser una server
> function de solo lectura en `autolibre-admin` (`src/server/coverage-map.repo.ts`
> + `src/fn/coverage-map.ts`) en vez de un endpoint del backend hex. Cualquiera
> de las dos sirve; lo que se pidió es que este cambio no lo hiciera el front.

## 2. Usuarios por zona (domicilio de la cédula y ciudad del primer login)

**Hoy:** no hay. El spec los necesita para la prioridad **«Demanda latente»**
(zonas sin pedidos donde hay usuarios) y para las columnas «Usuarios
(domicilio)» y «Usuarios (IP)» del ranking. Sin eso, ninguna zona sale como
latente, y la pantalla lo dice.

No se puede resolver en el front: son domicilios de personas (`registration_cards.holder_address`)
y ciudades de login (`login_events.city`). Tienen que llegar **agregados por
zona**, nunca la fila.

**Pedido:** las consultas **3.3** y **3.4** del spec, que devuelven
`[{ zona_id, usuarios }]`. Los `zona_id` coinciden con los `id` de
`public/geo/zonas_amba.geojson`. Los valores especiales `caba` (CABA sin
comuna), `sin-precision` (IP genérica «Buenos Aires») y `fuera` también van:
la pantalla los muestra en las notas.

Cuando lleguen, en el front alcanza con pasarlos a `zonePriority()` (ya acepta
`usuariosDomicilio` y `usuariosIp`) y agregar las dos columnas al ranking.

## 3. Partners: un listado para el mapa (chico)

**Hoy:** se usa `listPartnerCandidatesFn` con las 16 categorías. Funciona, pero
ese endpoint está pensado para "¿a quién le mando ESTE pedido?" y:

- deja afuera a los partners activos **sin ningún servicio** (JOIN). Hoy son 0;
  la pantalla igual los cuenta aparte comparando contra el total de activos;
- acepta como máximo 16 categorías por llamada (el front ya pide por tandas).

**Pedido:** la consulta **3.2** del spec (`proveedor`, `modalidad`, `remoto`,
`lat`/`lng`, `zona_id`, `rubros`), en el mismo endpoint que el punto 1.

## Mejoras del spec (sección 7) que también son de back

Ninguna bloquea la pantalla, y todas mejoran el cálculo sin tocar el front:

1. **Rubro guardado en el pedido** (`service_slug` en `quote_requests`, o lo
   que ya clasifica el operador en `ops.quote_request_rubro`). Hoy se adivina
   por palabras: «necesito un service y revisar los frenos» queda en
   Tren delantero (gana la primera regla que matchea).
2. **Flag de pedido de prueba**, en vez de excluir por `close_reason_code = 'duplicate'`.
3. **`coverage_zone` como lista de partidos/comunas** (los ids del geojson), en
   vez de texto libre. Hoy un partner sin coordenadas sólo se ubica si su texto
   empieza con uno de los cuatro nombres que el spec trae escritos a mano
   (Villa Crespo, Tigre, Rafael Castillo, General Rodríguez).
4. **Radio de cobertura declarado** por el partner, sobre todo para los que van
   a domicilio.

## Limpieza que queda pendiente en `autolibre-admin`

`partnerCoverageBoard()` (`src/server/partners.repo.ts`) y
`getPartnerCoverageBoard` (`src/fn/partners.ts`) eran el tablero viejo. La
pantalla nueva sólo usa de ahí `totalActivePartners`, para contar los partners
sin servicios. Cuando exista el endpoint del punto 3 se pueden borrar los dos,
junto con `~/lib/partners-coverage`. No se borraron porque son código de
servidor.
