# Compatibilidad escáner ↔ vehículo (`/escaneres`)

Alcance: `src/lib/scanners.ts`, `src/server/scanners.repo.ts`, `src/fn/scanners.ts`,
`src/routes/_authed/escaneres.tsx`.

## Qué contesta

*"¿con qué versiones de auto funcionó este escáner, y con cuáles no?"* — para recomendarle hardware
a un cliente.

Las **tres** cosas distintas que una celda puede decir, y confundirlas es el modo de falla de toda
la pantalla:

| Celda | Significa | Color |
|---|---|---|
| vacía (`—`) | **Nunca se probó.** No dice nada sobre compatibilidad. | gris |
| `0 / N` | Se intentó N veces y **no funcionó ninguna**. Esto sí es una afirmación. | rojo |
| `K / N` | Funcionó. Verde sólo si además fueron ≥ `MIN_VEHICLES_FOR_CONFIDENCE` autos distintos. | verde |

**Ausencia de evidencia no es evidencia de ausencia**, y una tabla que las pinta igual convierte esa
falacia en una recomendación a un cliente.

## `noData`: la falla que el dominio no sabe nombrar

`driving_session_status` es `pending_chunks | completed | failed`. **`failed` tiene cero filas** al
2026-09-04, así que quedarse con el estado del dominio hace que la pantalla afirme que nunca falló
nada.

Pero la base dice otra cosa, y el corte es limpio — verificado contra producción:

| Grupo | Sesiones | `total_readings` | Duración | Firmware |
|---|---|---|---|---|
| Sirvieron | 11 | 9 – 4.571 | 0 – 24 min | `ELM327 v2.1` |
| **Engancharon sin traer nada** | **6** | **exactamente 0** | **exactamente 0 min** | **ninguno** |

**No hay un solo caso en el medio.** Eso no es un usuario que abrió y cerró la app: es el escáner
que nunca llegó a identificarse ni a leer un dato.

> **La primera versión de esta pantalla contaba esas 6 como éxitos**, porque contaba toda sesión
> `completed`. O sea que recomendaba hardware en base a fallas — exactamente el error que la pantalla
> existía para no cometer. El `TOYOTA COROLLA XEI 1.8 M/T 2013` figuraba con 7 conexiones cuando
> tiene 3 buenas y 4 fallidas.

Reglas que salen de esto:

1. **`noData` y `failed` son contadores SEPARADOS y no se suman en un solo número "fallas".** Uno lo
   afirma el backend, el otro lo deducimos nosotros. El día que el backend escriba `failed` de
   verdad hay que poder ver los dos y comparar.
2. **La UI dice en voz alta que `noData` es deducción nuestra.** Que una señal sea derivada no es
   licencia para presentarla como dato del dominio. Es la misma forma que `stuck` en `/operacion`,
   que tampoco lo escribe nadie y se deduce del reloj con umbrales documentados.
3. **El predicado va sobre `total_readings`, NO sobre `scanner_firmware is null`**, aunque hoy los
   dos partan la base idéntico. La ausencia de firmware es un **síntoma**; cero lecturas es el
   **resultado**, y es lo que sigue significando lo mismo el día que una versión de la app reporte
   firmware y falle igual.
4. **`pending_chunks` no cuenta como intento.** Todavía no hay veredicto; contarlo como fracaso
   adelanta un resultado que no pasó.

## El grano de la fila es el CATÁLOGO, y la etiqueta lleva todo

`TOYOTA COROLLA XEI 1.8 M/T 2013`, no `TOYOTA COROLLA`. Un 1.8 manual de 2013 y un 2.0 automático de
2020 son ECUs distintas: que el escáner ande con uno no dice nada del otro.

**El dato ya estaba y la primera versión no lo mostraba.** `trim` y `year` son columnas de
`vehicle_catalogs`, así que la etiqueta sale entera de la tabla que ya se estaba consultando: **no
hizo falta cambiar el grano**.

**Bajar al SPEC parece más preciso y es peor.** Verificado: `VOLKSWAGEN VENTO 2.5 2007` tiene DOS
specs que difieren únicamente en que a una le falta `engine`. Agrupando por spec, ese auto se parte
en dos filas que son el mismo auto, y la tabla afirma que el escáner se probó en dos versiones
distintas. Número plausible, más desagregado que el real, de los que no se cachan.

Combustible y caja sí salen del spec, y por eso son **listas**: un catálogo puede tener varias. Van
como detalle secundario porque para OBD el combustible importa (un GNC o un diésel no responden
igual) y la caja suele venir ya adentro del `trim` (`1.8 M/T`, `AT9 4X4`).

## Las trampas confirmadas

### 1. `count(distinct)` NO se puede derivar del nivel de abajo

Es el bug que tuvo la primera versión de `scanners.repo.ts` y por el que existe el `GROUPING SETS`.

Los tres niveles —celda, total de fila, total de columna— necesitan "cuántos autos DISTINTOS". Un
mismo auto puede haberse conectado con dos firmwares distintos, así que **sumar** las celdas de la
fila lo cuenta dos veces y **`Math.max`** lo cuenta de menos. Las dos dan un número plausible y
equivocado.

Verificado: `TOYOTA COROLLA XEI 1.8 M/T 2013` tiene celdas de `3/1 auto` y `4/1 auto`, y la fila real
es **1 auto**. Ahí `max` acierta por casualidad — si dos autos distintos usaran cada uno un firmware
distinto, diría 1 cuando la verdad es 2.

**Postgres es el único que puede contestarlo en cada nivel.** Una sola sentencia, un solo snapshot.
Misma familia de razón que el `UNION ALL` único de `ops.repo.ts`.

### 2. El pivot va en JavaScript, no en SQL

`crosstab` o un `count(*) filter (where scanner_type = '…')` por columna exigen conocer las columnas
al ESCRIBIR el SQL. Acá **las columnas son datos**: el día que aparezca un `scanner_type` nuevo, la
versión pivoteada lo ignora en silencio y la matriz miente por omisión.

### 3. `vehicles` no apunta al catálogo, apunta al SPEC

`driving_sessions.vehicle_id` → `vehicles.vehicle_catalog_spec_id` →
`vehicle_catalog_specs.vehicle_catalog_id` → `vehicle_catalogs`. Misma trampa que documenta
`catalog.repo.ts`.

Los joins al catálogo son `LEFT` aunque `vehicle_catalog_spec_id` sea NOT NULL: la FK garantiza que
el **spec** exista, no que el catálogo exista. Un `INNER` descartaría sesiones en silencio.

### 4. El eje horizontal es tipo + firmware, y la columna "no identificado" no es un escáner

`scanner_type` es un enum con **un solo valor** (`elm327`). Una matriz de una columna no es una
matriz. El firmware es lo que de hecho varía, y lo que distingue en la vida real a un clon barato de
uno que engancha.

`firmware: null` tiene su **propia columna**, y hoy es 100% fallas (0 de 6). Es lo correcto: si el
escáner nunca se identificó, no sabemos cuál era. Meterla adentro de `ELM327 v2.1` le atribuiría
fallas que capaz no son suyas; borrarla escondería seis intentos que sí pasaron. Va última en el
orden, porque no es un escáner sino la ausencia de uno.

### 5. El separador de la clave de columna es un carácter de control

`variantKey` une tipo y firmware con `\u001f`. Un firmware es texto libre que viene del dispositivo:
con un separador imprimible, un firmware llamado `elm327 x` colisiona con el tipo `elm327` +
firmware `x`.

> **Y el escape se escribe como escape.** Pasó DOS veces en la misma sesión: se pegó el byte crudo en
> el fuente, el `.ts` quedó binario para `grep` y `file`, y la edición por texto exacto dejó de
> encontrarlo. Se arregla con un script que reemplaza `String.fromCharCode(31)` por el texto
> `\u001f`. **Nunca pegar un carácter de control adentro de un archivo fuente** — ni siquiera adentro
> de un `.md` que lo esté explicando.

### 6. Los totales NO llevan el filtro de texto

`q` filtra filas; la consulta de totales corre sin él, a propósito. Si `q` los recortara, buscar
"toyota" diría "0 fallas" sobre las fallas de Toyota y se leería como "0 fallas en el sistema" — la
conclusión tranquilizadora equivocada que este módulo entero existe para no permitir.

Por la misma razón `q` **nunca** filtra columnas: dos escáneres se comparan mirándolos juntos sobre
la misma fila.

### 7. Un string de SQL no se edita con una regex

La versión obvia de los totales recortaba la columna `last_ok` de `COUNTER_COLUMNS` con un
`.replace()` sobre el propio SQL. Compila, corre, y devuelve cualquier cosa el día que alguien
reordene las columnas. Se parte en dos constantes (`COUNTER_COLUMNS` y `LAST_OK_COLUMN`) y el
problema no existe.

## El historial de una celda (`SessionsPanel` + `scannerSessions`)

Cada celda de la matriz —y el Total de cada fila, y cada tarjeta de la leyenda— es un **link** que
abre el detalle de las conexiones que hay detrás de ese número: `driving_sessions` con el join a
`users` y al catálogo, más contadores de las tablas que cuelgan de `session_id`
(`driving_session_chunks`, `diagnostic_dtcs`, `session_dtc_snapshots`, `ai_diagnostics`,
`driving_telemetry_analysis`).

### La selección vive en la URL, no en un `useState`

`catalogId` + `scanner` + `fw` en el search param, cargados por el `loader` en paralelo con la
matriz. Es la diferencia con el toggle de vehículos de `/usuarios`, que sí usa `useState` + fetch al
click: **esta pantalla es de consulta**, y `/escaneres?catalogId=…&scanner=elm327` pegado en un
ticket tiene que abrir el panel ya cargado. Tres modos según qué params haya:

| Params | Modo | Qué muestra |
|---|---|---|
| `catalogId` + `scanner` (+`fw`) | `cell` | una celda |
| sólo `catalogId` | `row` | ese modelo, todos los escáneres |
| sólo `scanner` (+`fw`) | `variant` | ese escáner, todos los autos |

`fw` **viaja siempre que viaje `scanner`** — string vacío = escáner no identificado. Sin eso, "no
filtro por firmware" y "firmware nulo" se confunden, y la celda de la columna "no identificado"
traería las conexiones de todas las demás. El filtro usa `scanner_firmware IS NOT DISTINCT FROM $x`
porque `= NULL` no matchea `NULL`.

`catalogId = 'orphan'` (literal) para la fila sin catálogo → `vc.id IS NULL`. Los joins a `users` y
`vehicles` son `JOIN` y no `LEFT`: las dos FK son NOT NULL en `driving_sessions`, la fila huérfana
es por el CATÁLOGO ausente.

### `sessionBucket()` es la TERCERA copia del corte, y se toca con las otras dos

El cubo de cada sesión del panel (`ok` / `noData` / `failed` / `pending`) lo calcula
`sessionBucket()` en `~/lib/scanners`. Las otras dos expresiones del mismo corte son las cadenas SQL
`OK` / `NO_DATA` de `scanners.repo.ts` (que la matriz agrega con `GROUPING SETS`) y el predicado de
la columna «Escaneos» de `users.repo.ts`. **No se pueden unificar** —dos son SQL, una es JS— así que
la defensa es que estén nombradas y al lado en esta rule. Si la matriz dice `0 / 4` y el panel
muestra una sesión `ok`, es que divergieron.

### Un `noData` puede haber traído un DTC, y no es contradicción

Verificado el 2026-09-07: las 4 conexiones de la celda `TOYOTA COROLLA XEI 1.8 M/T 2013` × "no
identificado" son `noData` (0 lecturas, 0 min) y **las 4 tienen un código en
`session_dtc_snapshots`** (`P0170` / `P0171`). No se contradice con el corte: `total_readings` es el
stream de telemetría en vivo, no la lectura de DTCs. El panel muestra el DTC en "Produjo" igual —
era justamente lo que no se veía antes.

### El panel va DEBAJO de la matriz, no en un modal

La pantalla es de comparación: el operador mira la fila de arriba contra el detalle de abajo. Un
modal taparía la matriz, que es el contexto que hace legible al detalle. Mismo criterio que el censo
de `/usuarios`, que tampoco abre nada flotante.

## Cómo se probó

`tmp/probe.mjs` **lee los fragmentos de SQL del propio `scanners.repo.ts`** y los rearma, en vez de
pegar una copia. Una prueba sobre una copia verifica la copia, no el código que va a correr.

Cierra con un **cuadre**: la suma de `ok` y de `noData` de todas las celdas tiene que dar exactamente
los totales. Si el `GROUPING SETS` se rompe, ese cuadre lo detecta; el ojo mirando la tabla no.

Y si esa prueba tira `SELF_SIGNED_CERT_IN_CHAIN`, es porque le falta sacar `sslmode` de la URL antes
de pasársela a `pg` — la trampa que `db.ts` ya documenta y que se vuelve a pisar cada vez que alguien
escribe un script suelto.

## Por qué no hay ventana temporal

Deliberado, y es la diferencia con `/operacion` y `/ai-costos`, que sí la tienen. La pregunta acá es
**acumulativa**: una compatibilidad no caduca a los 30 días. Con 17 sesiones, cualquier ventana
vaciaría la tabla y dejaría al operador creyendo que no hay dato.

La recencia se sirve con `lastOk` por celda, que informa sin esconder.

## `MIN_VEHICLES_FOR_CONFIDENCE`

Tres autos DISTINTOS **con éxito** para que una celda se marque en verde. **Cuatro conexiones del
mismo auto no son evidencia de que la versión sea compatible, son evidencia de que a esa persona le
anduvo.**

El piso es deliberadamente bajo y aun así hoy **no lo alcanza ninguna celda**. Que se note es el
punto. **Se sube cuando haya volumen. No se baja.**

## Ni una escritura

`driving_sessions` la escribe el backend cuando el teléfono sube los chunks. Una sesión es un hecho
que pasó, no un estado que el admin mueva. Si aparece un `UPDATE` en `scanners.repo.ts`, está mal.

## Lo que falta del lado del backend

No se arregla desde este repo:

1. **Un estado terminal de falla que se escriba de verdad.** Mientras `failed` tenga cero filas, la
   señal de fracaso es una deducción nuestra sobre `total_readings`. Funciona porque el corte hoy es
   limpio; no hay garantía de que lo siga siendo.
2. **Más valores en `scanner_type`.** Mientras haya uno solo, el eje horizontal se sostiene sobre el
   firmware, que es un proxy y no el dato.
3. **Que el escáner se identifique antes de fallar.** Las 6 sesiones sin datos tampoco reportaron
   firmware, así que no se les puede atribuir a un modelo — que es justamente lo que haría falta para
   saber cuál no comprar.
