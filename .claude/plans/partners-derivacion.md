# Plan — Navegar partners para derivar pedidos

> **Estado al 2026-09-15: Fase 1 y Fase 2 IMPLEMENTADAS en código; nada
> aplicado a ninguna base todavía.** Ejecutado en la misma sesión que cerró el
> plan, sobre la rama `filtros-partners`, sin acceso a un Postgres de DEV
> (`localhost:5435` no respondía) y con el `.env` de esta máquina apuntando a
> **producción** (`current_database=autolibre`, `current_user=doadmin`, puerto
> `25060` detrás del pooler `:25061` — confirmado antes de tocar nada).
> Consecuencia: **la migración 013 quedó escrita y sin aplicar en ningún
> lado**, y el runner ya la protege — `pnpm db:migrate` exige
> `POSTGRES_MIGRATION_URL` (no `POSTGRES_DATABASE_URL`), que este `.env` ni
> siquiera define. Antes de que `/leads/pedidos/:id` pueda mostrar el panel de
> candidatos hace falta, en orden: aplicar la 013 en DEV con su suite en rojo
> primero (§7, paso 3) y recién después en producción por el puerto directo.
>
> **Fase 0 (geocodificar) se escribió (`scripts/geocode-partners.mjs`) y NO se
> corrió**: necesita una API key de geocoding que no está en este repo, y
> escribe sobre `partners` de la base real — se corre a mano, deliberadamente,
> con `--yes` y un `--actor` real.
>
> **Todos los números de este archivo salieron de producción**
> (`current_database = autolibre`, `current_user = doadmin`, vía el pooler
> `:25061`) el 2026-09-15 — ningún número de este repo significa nada sin decir
> contra qué base se sacó.
>
> Cuando las pantallas existan, las tablas de estado de acá se borran y el
> número se lee de la base (regla general del repo: si un número de la base vive
> en un `.md`, es porque todavía no tiene pantalla).

## Qué contesta

**"Me entró este pedido: ¿a qué taller se lo mando?"**

Hoy esa pregunta se contesta de memoria. `/leads/pedidos/:id` ya muestra el
pedido entero y `/partners/listado` ya muestra el directorio, pero **las dos
pantallas no se hablan**: el operador lee "Service de 100000 km, Rincón de
Milberg", se acuerda de tres talleres de Tigre y les escribe. No hay forma de
saber si había un cuarto más cerca, ni si el que eligió cubre ese rubro.

La consulta que reemplaza no es una de DBeaver — es una que **nadie puede correr
hoy**, porque el dato que la haría posible (la coordenada del partner) no
existe. Por eso la Fase 0 de este plan no es una pantalla: es cargar ese dato.

---

## 1. Con qué datos arranca (relevado el 2026-09-15, producción)

### El lado del pedido está listo; el lado del partner, no

| | Tiene coordenadas | Tiene dirección/zona texto |
|---|---|---|
| `quote_requests` (14 filas) | **10 de 14** (`location_source = 'device'`) | 14 de 14 (`location_address`), 10 con `location_locality` |
| `partners` activos (46 filas) | **0 de 46** | 43 de 46 (`address`), 46 de 46 (`coverage_zone`, NOT NULL) |

**Ésa es la asimetría que define el plan entero.** El pedido sabe dónde está la
persona con precisión de GPS; el partner no sabe dónde está. Cruzar los dos es
imposible hasta que alguien geocodifique las 43 direcciones.

Los 4 pedidos sin coordenadas son `location_source = 'typed'` — la persona
escribió la dirección en vez de dar permiso de ubicación. Tienen
`location_address` y nada más.

### Las direcciones de los partners son geocodificables

Muestra real de producción:

```
Hilarión de la Quintana 2039, Olivos
Av. Constituyentes 3267, Gral. Pacheco
España 3702, Olivos, Buenos Aires
JOSE MARIA PAIVA 1465 RINCON DE MILBERG TIGRE
Complejo Remeros Plaza - Nordelta          <- el caso difícil
```

La mayoría es `Calle Número, Localidad`. Hay un puñado de referencias a
complejos sin altura, que un geocoder resuelve al centroide del barrio o falla —
las dos cosas hay que poder distinguirlas, ver §3.

### El resto del directorio, para dimensionar

| Dato | Valor |
|---|---|
| Partners activos | **46** (0 pausados, 0 archivados) |
| Con WhatsApp | 44 · con email 30 · con horario 38 |
| **Invisibles** (sin un solo `partner_services`) | **0** — el problema que documenta `partners-coverage.md` está resuelto hoy |
| `partner_services` | 413 filas |
| `services` activos · `service_categories` activas | 79 · **17** (eran 16 cuando se escribió `partners-coverage.md`) |
| Aliados (`tier = 'founding'`) | 8 |
| Leads (`leads`) | **0 filas** |

### `modality` es una dimensión que hoy no filtra nada, y debería

| `modality` | Partners |
|---|---|
| Taller fijo | 17 |
| *(vacío)* | 13 |
| Mixto | 9 |
| A distancia | 4 |
| A domicilio | 3 |

**Un partner "A domicilio" no necesita estar cerca: va él.** Ordenar por
distancia y dejarlo abajo es un error de producto. Ver §5, trampa 4.

### Las zonas: 30 valores distintos para 46 partners

`Tigre` (8) · `San Isidro` (3) · `Boulogne / Villa Adelina` (2) · `CABA` (2) ·
`CABA, Zona Norte` (2) · `Nacional` (2) · `Olivos` (2) · `Pacheco` (2) ·
`Pilar` (2) · y 21 zonas con 1 partner cada una.

**Y acá hay una corrección al invariante de `partners-coverage.md`.** Esa rule
dice *"un partner está en exactamente una zona"*. Es cierto a nivel de FILA
(`coverage_zone` es una columna sola, así que `categoryTotals` sigue siendo
sumable y esa parte no se toca). Pero **no** es cierto a nivel semántico:
`CABA, Zona Norte`, `Zona Norte, Zona Oeste`, `Zona Oeste / Zona Norte` y
`CABA / Provincia de Buenos Aires` son partners que declaran DOS zonas en un
campo de texto.

Consecuencia directa para este plan: **un filtro de zona por igualdad exacta
deja afuera a esos partners.** El filtro tiene que ser por `ILIKE`/contención,
no por `=`. Ver §4.

---

## 2. Las cuatro decisiones tomadas

| # | Decisión | Consecuencia |
|---|---|---|
| 1 | **Las coordenadas salen de geocodificar las direcciones**, con carga a mano como respaldo | Fase 0 es un script one-off, no una pantalla. El panel NO gana una dependencia de runtime con ningún geocoder |
| 2 | **El rubro del pedido lo elige el operador al derivar, y se guarda** | Migración 013: una tabla chica en `ops` + su SP. Es el único DDL de este plan |
| 3 | **Panel de candidatos en la ficha del pedido + filtros de zona en el listado** | Dos entregas separables. La del listado es chica y no depende de la Fase 0 |
| 4 | **La derivación se registra como NOTA INTERNA, no como dato** | Cero tablas nuevas para eso: usa `ops.add_quote_request_internal_note` (011), que ya existe y ya está aplicada en producción |

### La tensión entre la 2 y la 4 es deliberada, y tiene un costo

Se guarda **la clasificación del pedido** (qué rubro era) como dato, y **la
derivación** (a qué taller se mandó) como texto.

Lo que eso habilita: contestar "¿qué rubros nos piden más?" con un `group by`.

**Lo que eso NO habilita, y hay que saberlo antes de empezar:** no se puede
contestar *"¿cuánto trabajo le mandamos a cada taller y cuánto convirtió?"* con
una consulta. Esa respuesta queda adentro de `internal_notes`, en texto libre, y
recuperarla después es parsear notas — exactamente lo que `leads.md` prohíbe
cuando dice *"si alguien arma 'ofertas' parseando las notas, está inventando
dominio"*.

Si esa pregunta se vuelve importante, el arreglo es una tabla
`ops.quote_request_referrals` con su SP, **no** un parser de notas. Queda
anotado acá para que la próxima persona no lo descubra parseando.

### Por qué `leads` no sirve para registrar la derivación

Se evaluó y se descartó con motivo técnico, no con la regla. Relevado contra el
schema:

- **`leads.user_id` es NOT NULL.** 10 de los 14 pedidos son de gente sin cuenta
  (`user_id IS NULL`). Un pedido anónimo no puede convertirse en un `lead`.
- **`leads` no tiene `quote_request_id`.** No hay forma de atar los dos.
- `leads.source` es un enum del backend que no tiene un valor para "lo derivó un
  operador desde el panel".

Forzarlo sería inventar un `user_id` o pisar el significado de `source`. Las dos
cosas corrompen una tabla que es del backend.

---

## 3. Fase 0 — Cargar las coordenadas (bloqueante de todo lo geográfico)

**No es una pantalla y no se ejecuta con el resto.** Es un script deliberado,
corrido una vez, a sabiendas, contra producción.

### El script

`scripts/geocode-partners.mjs` (nuevo). Para cada partner activo con `address`
no vacío y `latitude IS NULL`:

1. Arma la consulta: `address` + `, Argentina` si no lo trae.
2. Pega al geocoder.
3. **Si el resultado es de precisión de calle** (`ROOFTOP` / `RANGE_INTERPOLATED`
   en Google; `house`/`building` en Nominatim) → escribe por
   `ops.set_partner_location(p_partner_id, p_lat, p_lng, p_actor_id, p_note)`.
4. **Si es de precisión de barrio/localidad** (`APPROXIMATE`, centroide) → **NO
   escribe**. Lo deja en un `.csv` de revisión manual.

El paso 4 es el que importa. Un centroide de localidad puesto como si fuera la
dirección del taller hace que la pantalla ordene por distancia con números
inventados — el mismo error que `scanner-compatibility.md` documenta cuando
cuenta fallas como éxitos: **un número plausible y equivocado no se cacha
nunca.** Mejor 35 partners con coordenada buena y 11 sin coordenada, que 46 con
coordenada de la que no se puede confiar.

### El geocoder NO es una dependencia del panel

Va como variable de entorno **del script**, no de la app. `src/server/` no lo
conoce. El panel sólo LEE `partners.latitude/longitude`; de dónde salieron es
irrelevante para él.

Recomendación: **Google Geocoding API**. Para 43 direcciones el costo es
despreciable (~US$0,25) y la calidad en el conurbano bonaerense es notoriamente
mejor que Nominatim, que es donde están 40 de los 46. Nominatim sirve si no hay
key a mano, respetando su límite de 1 req/s (43 segundos de corrida).

> **Pendiente para quien ejecute: conseguir la API key.** No está en este repo y
> no se puede resolver desde acá.

### Escribe por el SP que ya existe

`ops.set_partner_location` es de la **migración 007, aplicada en producción**
(verificado: `ops.schema_migrations` tiene 001–012 completas — lo que además
cierra los dos pendientes que el `CLAUDE.md` todavía marca como abiertos para la
010 y la 011). El script no escribe `UPDATE partners` directo, por los mismos 8
guardrails de `ops-write-actions.md` — en particular el 4: **`p_actor_id` es un
admin real**, así que `ops.action_log` queda con quién cargó cada coordenada.

Y ya valida lo que hay que validar: el SP rechaza el par incompleto
(`INCOMPLETE_COORDINATES`) y los rangos de lat/lng. Un geocoder que devuelva
basura no entra.

### Las correcciones ya tienen pantalla

`PartnerFicha` tiene editor de coordenadas desde la 007. Los que queden en el
`.csv` se cargan ahí, uno por uno, sin código nuevo.

### Criterio de salida de la Fase 0

```sql
select count(*) filter (where latitude is not null) con_coords, count(*) total
  from partners where status = 'active';
```

Con **menos de ~30 de 46**, el orden por distancia miente por omisión (los sin
coordenada caen al fondo y parecen "lejos"). Por debajo de eso, la Fase 2 sale
igual pero con el orden por distancia **apagado por default** y el aviso en
pantalla. Ver §5, trampa 2.

---

## 4. Fase 1 — Filtros de zona en `/partners/listado`

**Esta fase NO depende de la Fase 0** y se puede entregar sola. Es la más chica.

### Lo que ya existe y no hay que escribir

`/partners/listado` ya filtra por **rubro** (chips de `service_categories`) y por
**servicio** (`services`), ya ordena por zona, y ya tiene el envoltorio
`select * from (...) t` que hace falta. Los search params `category` y `service`
ya están en `partnerSearchSchema` y los parámetros `$4`/`$5` ya están en
`listPartners`.

**El pedido de "filtrar por rubro" está cubierto.** Lo que falta es zona.

### Lo que se agrega

Un search param **`partnerZone`** en `partnerSearchSchema` (`src/lib/catalog.ts`)
y su predicado en `listPartners` (`src/server/partners.repo.ts`).

> **El nombre va calificado por dominio, no `zone` pelado.** Es la regla de
> `.claude/rules/notifications.md`, que ya rompió un build de producción dos
> veces: TanStack mergea los search params de TODAS las rutas en un
> `FullSearchSchema`, y el spread `{...prev}` de un updater arrastra el tipo
> ancho. Un `zone` genérico es un nombre que otra pantalla va a querer.
> `partnerStatus` ya está nombrado así, por lo mismo.
>
> Antes de escribirlo: `grep -rn "partnerZone" src/lib/*.ts` → tiene que dar
> cero.

### El predicado es por CONTENCIÓN, no por igualdad

```sql
AND ($6::text IS NULL OR t.coverage_zone ILIKE '%' || $6 || '%')
```

Porque `Zona Norte` tiene que traer también a `CABA, Zona Norte`,
`Zona Norte / CABA` y `Zona Oeste / Zona Norte` — los cuatro partners que
declaran dos zonas en un campo de texto (§1). Con `=` esos quedan invisibles
justo cuando el operador busca su zona.

### Las opciones del chip salen de la base, no de una lista

`listPartnerZones()`: `select distinct btrim(coverage_zone) … where coverage_zone
<> '' order by 1`. Mismo patrón exacto que `listDistinctChatModels`
(`chats.md`), `listFineJurisdictions` (`leads.md`) y `listNotificationFacets`
(`notifications.md`). Una zona nueva aparece en los chips sin tocar código.

**No se normaliza a zonas canónicas.** Es la decisión que `partners-coverage.md`
ya tomó y dejó escrita:

> *"Si alguien 'mejora' esto agregando un mapeo `"Pacheco" → "Zona Norte"` a
> mano, está reintroduciendo exactamente lo que se decidió no hacer."*

Con 30 valores para 46 partners, una lista de chips es larga pero legible, y es
honesta. El arreglo de verdad sigue siendo que el alta capture zona
estructurada, y eso vive en el backend.

### `setSearch` con `resetScroll: false`

Ya está así en `partners.listado.tsx` y hay que mantenerlo: tocar un chip no
debe llevar el scroll al tope. → `partners-coverage.md`.

---

## 5. Fase 2 — El panel de candidatos en `/leads/pedidos/:id`

Es el núcleo. Depende de la Fase 0 para lo geográfico (degrada sin ella, ver
trampa 2).

### El flujo

1. El operador abre `AL-1020` — *"Service de 100000 km"*, Rincón de Milberg,
   con coordenadas.
2. Elige el **rubro** en un selector. Si el pedido ya fue clasificado, viene
   preseleccionado.
3. El panel lista los **partners candidatos**: activos, que cubren ese rubro,
   ordenados por distancia al pedido.
4. Cada fila: nombre · distancia · zona · `tier` · modalidad · horario ·
   servicios que matchean · link de WhatsApp.
5. El operador escribe por WhatsApp y aprieta **"Registrar derivación"**, que
   deja la línea en el hilo de notas internas.

### La clasificación del rubro — migración 013

**Único DDL de este plan.** Una tabla en `ops`, porque `quote_requests` es del
backend y este repo no migra `public`:

```
ops.quote_request_rubro
  quote_request_id  uuid PRIMARY KEY   -- UUID pelado, sin FK a public (guardrail 6)
  category_slug     text NOT NULL      -- slug de service_categories
  service_slug      text               -- opcional, el servicio puntual
  actor_id          uuid NOT NULL
  created_at        timestamptz NOT NULL DEFAULT now()
  updated_at        timestamptz NOT NULL DEFAULT now()
```

`ops.set_quote_request_rubro(p_quote_request_id, p_category_slug, p_service_slug,
p_actor_id, p_note)` — upsert, con los 8 guardrails de `ops-write-actions.md`:
`SECURITY INVOKER`, `search_path` fijo, `assert_actor`, log adentro de la
función con `before`/`after`, sin FK cruzada, y `created_at` que **no se pisa**
en el conflicto (mismo criterio que `upsertExcludedDomain`: cuándo se clasificó
por primera vez es el dato con valor).

Tres cosas específicas de esta tabla:

- **Guardrail 7 (`FOR UPDATE`) no aplica en el alta**, igual que en la 012: es
  un upsert sobre la tabla propia, no la edición de una fila de `public`. En el
  camino de UPDATE sí se lockea la fila de `ops`.
- **Los parámetros son `text`, no el enum**, y el slug se valida contra
  `service_categories` en el cuerpo, a sentinela (`INVALID_CATEGORY_SLUG`).
  Mismo motivo que la 011: la función tiene que poder crearse en una base donde
  el catálogo todavía no esté poblado.
- **NO se valida que el rubro tenga sentido para la descripción.** El SP mueve
  datos, no decide. Si el operador clasifica "ruido al frenar" como
  Climatización, la base lo acepta — es su criterio, no el nuestro.

Su `.test.sql` con `BEGIN … ROLLBACK`, mismo patrón que 007–012. **Un stored
procedure sin probar es peor que no tenerlo.**

> Se aplica en DEV primero (`pnpm db:migrate` con la URL de `localhost:5435`) y
> recién después en producción **por el puerto directo `:25060`, nunca por el
> pooler** — el `pg_advisory_lock` del runner es de sesión y pgBouncer en modo
> transacción lo reparte entre conexiones. `.claude/rules/ai-costs.md`.

### La consulta de candidatos

`listPartnerCandidates(quoteRequestId, categorySlug, opts)` en
`partners.repo.ts`. Una sola sentencia:

```sql
SELECT p.id, p.name, p.coverage_zone, p.tier::text, p.modality, p.hours,
       p.whatsapp, p.address,
       -- Servicios de ESTE rubro que el partner cubre
       coalesce(jsonb_agg(DISTINCT jsonb_build_object('slug', s.slug, 'name', s.name))
                FILTER (WHERE s.id IS NOT NULL), '[]'::jsonb) AS matched_services,
       -- Haversine en km. NULL si falta cualquiera de los dos lados.
       CASE WHEN p.latitude IS NOT NULL AND $2::float8 IS NOT NULL
            THEN 6371 * acos(least(1, greatest(-1,
                   sin(radians($2)) * sin(radians(p.latitude)) +
                   cos(radians($2)) * cos(radians(p.latitude)) *
                   cos(radians(p.longitude) - radians($3)))))
       END AS distance_km
  FROM partners p
  JOIN partner_services ps ON ps.partner_id = p.id
  JOIN services s ON s.id = ps.service_id AND s.active
  JOIN service_categories sc ON sc.id = s.category_id AND sc.active
 WHERE p.status = 'active' AND sc.slug = $1
 GROUP BY p.id
```

**Haversine inline, sin extensión.** `postgis` y `earthdistance` están
*disponibles* en el servidor pero **no instalados** (verificado con
`pg_extension`: sólo `btree_gist`, `plpgsql`, `vector`). Instalar una extensión
es DDL global, y las extensiones caen en `public` por default — o sea, en el
schema del backend, que este repo no migra. Con 46 partners la diferencia de
performance es cero. Si algún día son 5.000, la conversación es PostGIS y es del
backend.

El `least/greatest` que envuelve al `acos` no es decorativo: el error de punto
flotante puede empujar el argumento apenas arriba de 1.0 para dos puntos
idénticos, y `acos(1.0000000001)` es `NaN` en Postgres. Un partner en la misma
esquina que el pedido saldría con distancia nula.

### El orden

`ORDER BY` por tres criterios, en este orden:

1. **`distance_km NULLS LAST`** — los sin coordenada al fondo, pero visibles.
2. **`tier`** — `founding` primero, a igualdad de distancia.
3. **`p.name`** — desempate estable, siempre último. → `partner-approval.md`.

### Las trampas de esta fase

#### 1. Un partner sin coordenada NO es un partner lejos

El mismo error que `scanner-compatibility.md` documenta como el modo de falla
de toda esa pantalla: **ausencia de evidencia no es evidencia de ausencia.** Un
`NULL` en `distance_km` significa "no sabemos dónde está", no "está a 200 km".

La celda muestra **"sin ubicación"** en gris, nunca un número ni un guión que se
pueda leer como cero. Y la fila queda en la lista: esconderla dejaría al
operador sin ver un taller que capaz era el correcto.

#### 2. Con pocas coordenadas cargadas, el orden por distancia miente por omisión

Si 11 de 46 tienen coordenada, ordenar por distancia pone 35 talleres al fondo
sin que nada diga por qué. El panel muestra **cuántos de los candidatos tienen
ubicación** (`"12 de 19 candidatos tienen ubicación cargada"`), en ámbar cuando
es menos de la mitad — ámbar y no rojo, misma escala que `stuck`, `atrasada` y
`noData`: falta un dato, no está roto nada.

Por debajo del umbral de la Fase 0, el orden por distancia arranca **apagado** y
el default es por `tier` + nombre.

#### 3. El pedido puede no tener coordenadas (4 de 14 hoy)

`location_source = 'typed'`. Ahí no hay distancia que calcular para NINGÚN
candidato. El panel cae a filtro por texto de zona contra `location_locality` /
`location_address` del pedido, y lo dice.

**No se geocodifica la dirección tipeada al vuelo.** Sería meter una dependencia
de runtime con un geocoder adentro de un loader SSR, para un dato que la app
debería haber capturado. Si molesta, el arreglo es del lado de la app.

#### 4. "A domicilio" y "A distancia" no se ordenan por distancia

3 + 4 = 7 partners activos cuya distancia es irrelevante: van ellos, o trabajan
remoto. Ordenarlos por km los hunde cuando podrían ser la mejor opción.

El panel los muestra en un **bloque aparte**, sin distancia, con su etiqueta de
modalidad. `Mixto` (9) y vacío (13) van en el bloque principal — `Mixto` porque
atiende en taller también, y vacío porque **no se asume**: 13 de 46 sin
modalidad es demasiado como para adivinar en cualquier dirección.

#### 5. `q` y los filtros del panel NO tocan el conteo de cobertura

Si el panel muestra "0 candidatos" con un filtro puesto, tiene que decir que es
por el filtro. "No hay talleres de este rubro" y "no hay talleres de este rubro
que matcheen tu búsqueda" son dos afirmaciones distintas, y la primera manda a
capturar oferta que capaz ya existe. Mismo criterio exacto que los totales de
`scanner-compatibility.md`, que a propósito no llevan el filtro de texto.

#### 6. El search param se llama `quoteRubro`

Calificado por dominio. `category` ya lo usa `/partners/listado` (`string`) y
`coverageRubros` lo usa `/partners/cobertura` (`string[]`) — y esos dos ya
existen justamente porque `string` contra `string[]` bajo la misma clave rompe
el typecheck de la ruta ajena. Un tercer nombre genérico repite el bug.

Precedencia: **el search param gana; si no está, el default es el rubro
guardado** en `ops.quote_request_rubro`. Guardar es una acción explícita, no un
efecto secundario de filtrar — filtrar para mirar no es clasificar.

#### 7. Registrar la derivación vuelve a chequear disponibilidad

La escritura es `ops.add_quote_request_internal_note` (011), y el guard
`quoteRequestsAvailability()` corre **en el handler del server function**, no
sólo en el loader. Un `fetch` directo al endpoint no pasa por la UI. Y la nota
es **de un solo renglón** — el SP concatena con salto de línea y
`parseInternalNotes` parte por línea: un salto adentro de la nota la partiría en
dos y la segunda mitad se leería como "escrita a mano, sin fecha". → `leads.md`.

#### 8. El link de WhatsApp del partner no es el mismo que el del pedido

`QuoteWhatsAppLink` valida `^549\d{10}$` sobre `contact_phone` del pedido y no
completa prefijos, porque adivinar la característica le escribe a otra persona
(`leads.md`). **El mismo criterio aplica al `whatsapp` del partner**, que es
otra columna, de otra tabla, con otro historial de carga (44 de 46 cargados,
formato no verificado). Se reusa el mismo normalizador; sin forma canónica no
hay link, y la fila lo dice.

### `adminMiddleware` en los tres server functions nuevos

`listPartnerCandidatesFn`, `setQuoteRequestRubroFn`, `listPartnerZonesFn`. Un
server function es un endpoint HTTP público y el guard de `_authed` sólo modela
lo que la UI ofrece. El de candidatos devuelve teléfono y dirección de talleres;
el de rubro **escribe**. → `users.md`, trampa 8.

### SSR

`/leads/pedidos/:id` ya es SSR completo (heredado) y **no cambia**: es una ficha
de contenido que se abre desde un link pegado en un chat de equipo y tiene que
llegar pintada. El panel de candidatos entra en el mismo loader, con
`loaderDeps` sobre `quoteRubro`. Un cambio de rubro re-corre el loader **en el
cliente**, no re-SSR — que es lo que hace viable tener el rubro en la URL sin
pagar un round trip de servidor por cada chip.

---

## 6. Archivos que toca

| Archivo | Qué |
|---|---|
| `scripts/geocode-partners.mjs` | **nuevo** · Fase 0, one-off, no se importa desde la app |
| `migrations/013_ops_rubro_de_pedido.sql` + `.test.sql` | **nuevo** · Fase 2 |
| `src/lib/catalog.ts` | `partnerZone` en `partnerSearchSchema` |
| `src/lib/quote-requests.ts` | `quoteRubro`, `setQuoteRequestRubroSchema`, `readable…Error` |
| `src/lib/partners.ts` | tipo `PartnerCandidate`, el normalizador de WhatsApp compartido |
| `src/server/partners.repo.ts` | `listPartnerZones`, `listPartnerCandidates`, predicado de zona en `listPartners` |
| `src/server/quote-requests.repo.ts` | `setQuoteRequestRubro`, lectura del rubro guardado en `findQuoteRequestDetail` |
| `src/fn/partners.ts` · `src/fn/quote-requests.ts` | los tres server functions, con `adminMiddleware` |
| `src/components/PartnerCandidates.tsx` | **nuevo** · el panel |
| `src/routes/_authed/leads.pedidos.$quoteRequestId.tsx` | monta el panel |
| `src/routes/_authed/partners.listado.tsx` | chips de zona |
| `.claude/rules/partners-coverage.md` | corregir el invariante de zona (§1) y anotar el filtro por contención |
| `.claude/rules/leads.md` | la derivación como nota, y por qué no es dato |
| `.claude/rules/ops-write-actions.md` | sección de la 013 |

---

## 7. Orden de ejecución

1. **Fase 1** (zona en el listado). Chica, independiente, entregable sola.
2. **Fase 0** (geocodificar). Necesita la API key. Se puede correr en paralelo
   con la 1 — no comparten código.
3. **013 en DEV** + su suite en rojo primero, después con la migración.
4. **Fase 2** (panel de candidatos), contra DEV.
5. **013 en producción** por el puerto directo `:25060`.

La Fase 2 se puede escribir antes de que la Fase 0 termine (build-now,
deploy-later, igual que se hizo con `quote_requests`): degrada sola y lo dice en
pantalla.

---

## 8. Qué NO se hace, y por qué

- **Normalizar `coverage_zone` a zonas canónicas.** Decisión ya tomada en
  `partners-coverage.md`, y este plan no la reabre.
- **Instalar PostGIS o `earthdistance`.** Con 46 partners no cambia nada, y
  caería en `public`, que es del backend.
- **Geocodificar en runtime** (ni pedidos ni partners). Metería un proveedor
  externo adentro de un loader SSR.
- **Inferir el rubro del texto del pedido.** Se evaluó y se descartó: una
  heurística por palabras clave sobre `"Me hace ruido cuando freno"` acierta, y
  sobre `"asdsad"` (que son varias filas reales de la base) inventa.
- **Una tabla de derivaciones.** Decisión 4. El costo está escrito en §2.
- **Notificar al partner desde el panel.** `POST /notifications/broadcast` manda
  a USUARIOS de la app (`users.id`); un partner no es un usuario. Es otra
  feature y toca el backend.
- **Un mapa.** Ordenar por distancia contesta la pregunta; dibujar el mapa es
  una dependencia de tiles, una key más, y no cambia a quién se le escribe.

---

## 9. Cómo verificar

En esta máquina (pnpm no está en el PATH):

```
& ".\node_modules\.bin\vite.CMD" build      # regenera routeTree.gen.ts PRIMERO
& ".\node_modules\.bin\tsc.CMD" --noEmit
```

En ese orden: un search param nuevo o un `Link` a una ruta nueva **sólo se
valida después del build**.

Borde server-only:

```
Get-ChildItem -Recurse .output/public -File |
  Select-String "listPartnerCandidates|POSTGRES_DATABASE_URL|haversine|GEOCODER" -List
```

Cero resultados.

Y el cuadre de la Fase 2, contra la misma base que la pantalla:

```sql
-- Candidatos de un rubro = partners activos que cubren >= 1 servicio activo suyo
select count(distinct p.id)
  from partners p
  join partner_services ps on ps.partner_id = p.id
  join services s on s.id = ps.service_id and s.active
  join service_categories sc on sc.id = s.category_id and sc.active
 where p.status = 'active' and sc.slug = '<slug>';
```

Tiene que dar exactamente las filas del panel sin filtros de texto.
