# Plan — Unificar `/vehiculos/catalogo` y `/vehiculos/metricas` (Flota)

> **Todos los números de este archivo salieron de PRODUCCIÓN** el 2026-09-17.
> `POSTGRES_DATABASE_URL` apunta al pooler de DigitalOcean
> (`:25061/autolibre-pool`); la verificación dio `current_database = autolibre`,
> `current_user = doadmin`, `inet_server_port() = 25060`. Ningún número de este
> repo significa nada sin decir contra qué base se sacó (CLAUDE.md, regla 1 del
> censo).
>
> **Nada de esto está implementado.** Es el plan.

## Qué se pidió

> *"Dentro de vehículos tengo dos pestañas (catálogo y flota) que creo que
> podemos unificar en una sola."*

La conclusión de este relevamiento es que sí, y con un argumento más fuerte que
"se parecen": **son la misma consulta con dos universos distintos, y el universo
que cada una esconde es justo el dato que la otra necesita.**

---

## 1. Lo que hay hoy

| | `/vehiculos/catalogo` | `/vehiculos/metricas` (Flota) |
|---|---|---|
| Grano de la fila | `vehicle_catalogs` | `vehicle_catalogs` |
| Universo | **todos** (210) | **los que tienen autos** (180) |
| Link de la fila | `/vehiculos/catalogo/$catalogId` | **el mismo** |
| Filtros | `q`, `vehicleType`, `onlyWithoutManual` | `q`, `vehicleType` |
| Search params | `q` · `vehicleType` · `sort` · `dir` | **los mismos** |
| Columnas | Modelo · Tipo · Manuales · Variantes · Vehículos | Modelo · Tipo · Vehículos · Usuarios · Km prom. · Con VTV · Con seguro · Con multas · Deuda multas · Escaneados · Manuales |
| Consulta | `listCatalogs` (`catalog.repo.ts`) | `fleetMetrics` (`vehicles.repo.ts`) |
| Límite | `LIMIT 500` | **sin límite** |
| Orden default | `model asc` | `vehicles desc` |
| SSR | `true` | `true` |
| Escrituras | ninguna (el manual se sube en la FICHA) | ninguna |

Cuatro columnas están en las dos (Modelo, Tipo, Vehículos, Manuales) y el
`vehicle_count` de las dos se calcula distinto —subconsulta escalar en una,
`join lateral` en la otra— para dar el mismo número. **Hoy nadie garantiza que
sigan coincidiendo**: es la misma clase de acoplamiento silencioso que
`INTERNAL_PREDICATE` entre `ops.repo.ts` y `v_ai_usage`, sólo que acá ni siquiera
está anotado.

---

## 2. Los números que decidieron el diseño (producción, 2026-09-17)

```
modelos en el catálogo ......... 210
   con al menos un auto ........ 180
   sin ningún auto .............  30
autos cargados ................. 196   (11 archivados)
usuarios con auto .............. 117
manuales cargados .............    1   (sí, uno)
```

### 2.a — Los 30 modelos que Flota esconde son modelos INERTES, no modelos nuevos

`vehicles` no apunta al catálogo: apunta al **spec** (`vehicle_catalog_spec_id`,
la trampa 3 de `vehicle-manuals.md`). Así que un catálogo sin ninguna variante
cargada **no puede tener autos, ni hoy ni nunca**, hasta que alguien le cree el
spec.

Verificado, y el cruce es exacto:

| | modelos |
|---|---|
| con 0 variantes | **30** |
| con 0 autos | **30** |

Es el mismo conjunto. O sea: el `where vehicle_count > 0` de Flota es hoy, de
hecho, *"los modelos que tienen alguna variante cargada"* — y esconde 30 filas
que son un **pendiente operativo real**: el modelo existe, el usuario lo eligió
por patente, y no hay a qué colgarle el auto.

Y es un fenómeno **vivo**, no un resto histórico: los 30 se crearon entre el
2026-09-01 y el 2026-09-16, contra los 180 buenos que van del 2026-08-28 al
2026-09-17. Uno de cada siete modelos que se crea sale inerte.

**Ninguna de las dos pantallas lo muestra hoy.** Catálogo los lista mezclados con
los otros 180 sin distinguirlos; Flota los borra del resultado.

### 2.b — "Variantes" es una columna que dice `1`

| variantes | modelos |
|---|---|
| 0 | 30 |
| **1** | **174** |
| 2 | 5 |
| 3 | 1 |

174 de 210 filas dicen `1`. Como **número** no informa nada; como **cero**
informa todo (ver 2.a). Eso decide qué hacer con la columna: se va como columna
y se queda como marca en la celda del modelo + un chip de filtro.

### 2.c — "Sin manual" filtra 209 de 210

Hay **un** manual cargado en toda la base. El chip "Sin manual (N)" de Catálogo
saca exactamente una fila. El pendiente que sí discrimina es la intersección:
**179 modelos tienen autos y no tienen manual.** Eso sale solo si los chips
componen (Y entre grupos), como ya hace `/partners/listado` desde el 2026-09-17.

### 2.d — La flota casi no se agrega, y eso NO se arregla con este cambio

| autos del modelo | modelos |
|---|---|
| **1** | **166** |
| 2 | 12 |
| 3 | 2 |

166 de 180 filas de Flota son un solo auto. La pregunta *"¿cuáles son los
modelos más comunes?"* no la contesta esta tabla, porque el grano es
`marca + modelo + versión + año`:

| | autos | filas del catálogo |
|---|---|---|
| TOYOTA COROLLA | 10 | **8** |
| TOYOTA ETIOS | 9 | **6** |
| TOYOTA YARIS | 6 | **6** |
| VOLKSWAGEN VENTO | 5 | **3** |

La flota tiene 10 Corollas y la tabla los muestra como ocho filas de "1 auto".
**Eso es un problema del grano, no de la fusión**, y unificar las pestañas no lo
crea ni lo resuelve — ver §6.

---

## 3. La decisión

**Queda UNA pestaña: `Catálogo`, en `/vehiculos/catalogo`.** `/vehiculos/metricas`
se borra.

Por qué ese lado y no el otro:

- **La ficha ya cuelga de ahí** (`/vehiculos/catalogo/$catalogId`), y es a donde
  linkean las dos tablas de hoy. Mover la URL obligaría a mover la ficha, que es
  la única pantalla del panel que escribe por HTTP al backend hex
  (`vehicle-manuals.md`).
- **`vehiculos.index.tsx` ya redirige a `/vehiculos/catalogo`.** Cero cambios ahí.
- **"Catálogo" es la palabra del backend** (`vehicle_catalogs`), regla dura 7.
  "Flota" era una etiqueta de UI inventada para no chocar con el ítem de nav
  `/metricas` — desaparece el choque y desaparece la etiqueta.
- **Nadie linkea a `/vehiculos/metricas` desde afuera.** Verificado con `grep`:
  las únicas referencias son el propio archivo y la barra de pestañas.

Después de esto `/vehiculos` queda con **dos** pestañas: **Catálogo** (un modelo
por fila) y **Listado** (un auto por fila). Se quedan las dos: contestan
preguntas distintas y el `CLAUDE.md` ya tiene la fila de cada una.

> **Decisión chica, tomada acá**: `/vehiculos/metricas` **no** deja redirect. El
> precedente del repo es borrar la ruta (`/records`, `/analytics`, `/settings`,
> 2026-08-30) y el único link conocido era la propia pestaña. Un favorito viejo
> cae en 404 — lo mismo que se aceptó el 2026-09-17 al renombrar los search
> params de `/partners/listado` antes que mantener dos fuentes de verdad.

---

## 4. Cómo queda la pantalla

### 4.a — El universo es el SUPERCONJUNTO: los 210

Sin `where vehicle_count > 0`. Los 30 inertes entran con sus contadores en cero.

**Verificado que la consulta lo soporta tal cual está**: el `join lateral … on
true` de `fleetMetrics` es un agregado sin `GROUP BY`, así que devuelve
exactamente una fila aunque el modelo no tenga autos. Sacando el predicado, la
misma consulta pasa de 180 a 210 filas, 30 de ellas con `vehicle_count = 0` y
`avg_odometer = NULL`. No hay que reescribir nada del `lateral`.

Esconder filas por default es lo que hace que alguien busque un modelo, no lo
vea y concluya que no existe — la misma razón por la que esta pantalla ya avisa
cuando corta en 500.

### 4.b — Las columnas: las 11 de Flota, ni una más

| # | Columna | Viene de | Nota |
|---|---|---|---|
| 1 | Modelo | las dos | link a la ficha · marcas: `N archivados`, **`sin variantes`** |
| 2 | Tipo | las dos | |
| 3 | Vehículos | las dos | |
| 4 | Usuarios | Flota | |
| 5 | Km prom. | Flota | |
| 6 | Con VTV | Flota | |
| 7 | Con seguro | Flota | |
| 8 | Con multas | Flota | |
| 9 | Deuda multas | Flota | |
| 10 | Escaneados | Flota | |
| 11 | Manuales | las dos | **el color cambia, ver 4.d** |

**Se va `Variantes` como columna** (§2.b) y con ella su sort key `specs`. El cero
sobrevive como marca en la celda del Modelo y como chip. El detalle de las
variantes ya está a un click, en la `SpecsCard` de la ficha.

Resultado: **la tabla unificada tiene exactamente las columnas que Flota tiene
hoy.** Lo que suma la fusión no son columnas: son 30 filas, dos chips y un
color. Eso es lo que hace que el cambio sea chico y verificable.

### 4.c — Los chips componen (Y entre grupos), como `/partners/listado`

| Grupo | Chips |
|---|---|
| Tipo | Auto · Moto |
| Autos | **Con autos (180)** · **Sin autos (30)** |
| Pendientes | **Sin manual** · **Sin variantes (30)** |

"Con autos" + "Sin manual" = los 179 que son el trabajo real (§2.c). Ningún chip
esconde nada por default: vacío = todos, igual que en Partners desde el
2026-09-17.

> `Sin autos` y `Sin variantes` seleccionan hoy el MISMO conjunto (§2.a). Se
> dejan los dos igual porque son dos preguntas distintas —"nadie lo tiene" vs
> "no se le puede colgar un auto"— y el día que se cree un spec sin que nadie
> cargue el auto, dejan de coincidir. Que hoy coincidan es un dato, no una
> duplicación.

### 4.d — El cero de "Manuales" se pinta ámbar SÓLO si el modelo tiene autos

Es la parte del plan que mejora algo en vez de sólo juntar dos cosas.

Hoy las dos reglas están escritas y son opuestas, y las dos son correctas
*dentro de su universo*:

- `vehicle-manuals.md`: en Catálogo, el cero de **vehículos** es contexto — dice
  que ese modelo puede esperar.
- `vehicles.md`: en Flota, el cero de **manuales** SÍ es un pendiente, *"porque
  acá todas las filas ya tienen autos"*.

Juntando los universos, la regla que estaba implícita en el `where` tiene que
pasar a la celda:

| autos | manuales | color |
|---|---|---|
| > 0 | 0 | **ámbar** — pendiente real (179 filas) |
| > 0 | ≥ 1 | verde |
| 0 | 0 | **gris** — no urge, nadie lo tiene |

Hoy Catálogo pinta ámbar las 209 filas sin manual, 30 de las cuales no las tiene
nadie. La fusión no hereda ese ruido: lo borra.

### 4.e — Search params, orden y límite

- **Un solo schema**, `catalogSearchSchema`, con la unión de las dos `sort`:
  `model | type | vehicles | users | avgKm | withFines | fineDebt | scanned |
  manuals`. Se va `specs`.
- **Esto RESTA una `sort` del `FullSearchSchema`**, que es el merge que ya rompió
  un build (`.claude/rules/notifications.md`). Una pantalla menos con enum propio
  bajo la misma clave es una colisión menos, no una más.
- **Default `model asc`**, el de Catálogo, no el `vehicles desc` de Flota. Motivo
  concreto y no de gusto: con 166 modelos empatados en 1 auto (§2.d), ordenar por
  `vehicles desc` da un orden arbitrario a partir de la fila 15. Y la pantalla
  sigue siendo de ENTRADA: se llega buscando un modelo. El orden por flota está a
  un click del header.
- **`LIMIT 500`** (el de Catálogo; Flota no tenía). Con 210 filas no corta nada
  hoy, y el cartel de "se muestran los primeros 500" ya está escrito.
- `onlyWithoutManual` se queda. Se suman `onlyWithVehicles` / `onlyWithoutSpecs`
  (nombres calificados, nunca `state` ni `kind` pelados).

### 4.f — Los cuatro tiles de arriba

Se quedan los de Flota, con un ajuste: el primero tiene que distinguir los dos
universos que la pantalla ahora muestra juntos.

| Tile | Hoy | Unificado |
|---|---|---|
| 1 | Autos en la flota `196` | **Autos en la flota** `196` (`11 archivados`) |
| 2 | Modelos distintos `180` | **Modelos** `210` · hint: `180 con autos` |
| 3 | Usuarios con auto `117` | igual |
| 4 | Modelos en esta vista | igual |

---

## 5. Implementación

Orden sugerido: consulta → schema → pantalla → borrado. El borrado al final para
que el build nunca quede con una ruta rota en el medio.

### Paso 1 — La consulta (`src/server/vehicles.repo.ts`)

`fleetMetrics` es la que sobrevive, porque su `join lateral` ya calcula todo: la
otra necesitaría ocho subconsultas nuevas, ésta necesita dos ediciones.

1. Sacar `'vehicle_count > 0'` del `outerWhere` inicial.
2. Agregar `spec_count` al SELECT externo (la subconsulta escalar que ya está en
   `listCatalogs`).
3. Sumar al `outerWhere` los tres filtros nuevos (`onlyWithVehicles`,
   `onlyWithoutSpecs`, `onlyWithoutManual` — este último como `manual_count = 0`,
   que ya está calculado, en vez del `NOT EXISTS` de `listCatalogs`).
4. `FLEET_SORT_COLUMNS` ← sumar `manuals: 'manual_count'`; no sumar `specs`.
5. `LIMIT 500`.
6. `fleetSummary`: `total_models` pasa a ser `count(*) from vehicle_catalogs`, y
   se suma `models_with_vehicles` + `archived_vehicles`.

**Borrar `listCatalogs` de `catalog.repo.ts`.** Ese archivo se queda con
`findCatalog` (la ficha), que es lo único que le va a quedar.

> Al tocar esto: el comentario de `vehicles.repo.ts` que dice *"`where
> vs.vehicle_count > 0` deja fuera los catálogos que nadie cargó — no son
> flota"* deja de ser cierto y hay que reescribirlo, no borrarlo: el motivo por
> el que ahora SÍ entran (§2.a) es más interesante que el motivo por el que
> salían.

### Paso 2 — Tipos y schema (`src/lib/vehicles.ts`, `src/lib/manuals.ts`)

- `FleetMetricRow` ← `specCount`. Renombrarlo a `CatalogModelRow` es opcional y
  toca bastante; si se hace, se hace en este paso y no después.
- `FLEET_SORT_KEYS` ← `+manuals`, `−specs`.
- `fleetSearchSchema` ← `+onlyWithoutManual`, `+onlyWithVehicles`,
  `+onlyWithoutSpecs`; default `sort: 'model'`, `dir: 'asc'`.
- `catalogSearchSchema` y `CATALOG_SORT_KEYS` se borran de `~/lib/manuals`.
  `catalogTitle`, `VEHICLE_TYPES` y `MANUAL_LANGUAGES` se quedan (los usa la
  ficha).
- `CatalogListItem` se borra si no lo usa nadie más — verificar con `grep`.

### Paso 3 — La pantalla (`src/routes/_authed/vehiculos.catalogo.index.tsx`)

Se reescribe con el cuerpo de `vehiculos.metricas.tsx` (tiles + tabla de 11
columnas) y se le agregan: el `Input` de búsqueda que ya tenía, los tres grupos
de chips, y la celda de Manuales con el color de 4.d. Los `to=` de los
`SortHeader` pasan todos a `/vehiculos/catalogo`.

El comentario de SSR de Catálogo (*"es una pantalla de ENTRADA… `data-only` acá
te deja mirando el shell vacío"*) se queda tal cual: sigue siendo cierto y la
regla dura 6 exige que el modo esté justificado.

### Paso 4 — Borrar

- `src/routes/_authed/vehiculos.metricas.tsx`
- `TABS` de `vehiculos.tsx` ← sacar la tercera entrada; reescribir el docblock
  (dice "tres pestañas" y explica por qué la etiqueta es "Flota").
- `src/fn/vehicles.ts` ← `fleetSummaryFn` se queda (la pantalla lo sigue usando);
  revisar si `fleetMetricsFn` conviene renombrar.
- `src/fn/manuals.ts` ← `listVehicleCatalogs` se borra si la pantalla ya no lo
  llama.
- El docblock de `src/routes/_authed.tsx:146` menciona la ruta vieja.

---

## 6. Lo que este plan NO hace, a propósito

**No cambia el grano a `marca + modelo`.** Es lo que haría falta para contestar
*"¿cuáles son los modelos más comunes de la flota?"* (§2.d: 10 Corollas en 8
filas), y es tentador meterlo en la misma pasada. Queda afuera por dos motivos:

1. **La fila tiene que seguir siendo un `vehicle_catalogs`**, porque es lo que
   linkea a la ficha y lo que recibe el manual. Un grano `marca + modelo` no
   tiene ficha adónde ir.
2. **`scanner-compatibility.md` ya decidió lo contrario para su caso**, y con
   razón: aflojar el grano junta ECUs distintas. Para composición de flota el
   grano flojo es el correcto, pero es *otra pregunta*, y mezclarla con ésta
   deja una tabla que no contesta bien ninguna de las dos.

Si esa pregunta importa, el lugar natural es un bloque de "Top marcas y modelos"
ARRIBA de la tabla (agrupado por `brand || model`, sin link), o una fila más en
`/metricas`. Es una feature aparte, no parte de la fusión.

**No toca la ficha** (`/vehiculos/catalogo/$catalogId`) ni la subida de manuales.

**No toca `/vehiculos/listado`.**

---

## 7. Cómo verificar

Antes de tocar nada, y otra vez después, contra la MISMA base:

```bash
node .claude/skills/db-connect/query.mjs "select count(*) from vehicle_catalogs"
```

Los cuadres que tienen que dar:

| Chequeo | Hoy |
|---|---|
| filas de la pantalla, sin filtros | **210** |
| con el chip "Con autos" | **180** = las filas que muestra Flota hoy |
| `sum(Vehículos)` de todas las filas | **196** = `count(*) from vehicles` |
| chip "Sin variantes" | **30** |
| "Con autos" + "Sin manual" | **179** |

El primero y el tercero son el cuadre que importa: si `sum(vehicle_count)` no da
el total de `vehicles`, hay fan-out en el `lateral` — el mismo chequeo de
regresión que `vehicle-manuals.md` ya documenta para el doble salto
`vehicles → specs → catalogs`.

Y el build, en este orden (el build regenera `routeTree.gen.ts`, así que una ruta
borrada sólo se valida DESPUÉS):

```bash
node_modules/.bin/vite build && node_modules/.bin/tsc --noEmit
```

Más el borde server-only:

```bash
grep -rl "fleetMetrics\|listCatalogs\|join lateral\|POSTGRES_DATABASE_URL" .output/public
```

Cero resultados.

---

## 8. Reglas a actualizar cuando esto exista

| Archivo | Qué cambia |
|---|---|
| `CLAUDE.md` | La tabla de pantallas: se funden las filas de `/vehiculos/catalogo` y `/vehiculos/metricas`; "Layout de 3 pestañas" pasa a 2 |
| `.claude/rules/vehicles.md` | La sección "Flota" entera; el universo nuevo; la regla del color de Manuales (4.d), que hoy está partida entre este archivo y `vehicle-manuals.md`; el hallazgo de los 30 modelos inertes |
| `.claude/rules/vehicle-manuals.md` | El encabezado dice "una de sus tres pestañas"; el chip "Sin manual" ahora compone con "Con autos" |
| `.claude/rules/scanner-compatibility.md` | Nada, pero es la rule que sostiene el §6 — si alguien afloja el grano, se toca junto |
