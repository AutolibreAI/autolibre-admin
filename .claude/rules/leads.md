# Leads: las pestañas de `/leads`

Alcance: `src/routes/_authed/leads.tsx` (layout), `leads.index.tsx`,
`leads.talleres.tsx`, `leads.seguros.tsx`, `leads.multas.tsx`,
`leads.contactos.tsx`, `leads.financiacion.tsx`,
`src/lib/insurance.ts`, `src/lib/fines.ts`, `src/server/insurance.repo.ts`,
`src/server/fines.repo.ts`, `src/fn/insurance.ts`, `src/fn/fines.ts`,
`src/components/ComingSoonPipeline.tsx`. Pedidos: `leads.pedidos.index.tsx`,
`leads.pedidos.$quoteRequestId.tsx`, `src/lib/quote-requests.ts`,
`src/server/quote-requests.repo.ts`, `src/fn/quote-requests.ts`,
`src/components/QuoteRequestCells.tsx`, `src/components/QuoteRequestsUnavailable.tsx`,
`src/components/QuoteRequestActions.tsx`, `src/lib/quote-templates.ts`,
`src/components/QuoteTemplates.tsx`, `src/components/QuoteRequestComposer.tsx`,
`migrations/012_ops_crear_pedido.sql` (+ su `.test.sql`),
`src/components/PartnerCandidates.tsx`, `migrations/013_ops_rubro_de_pedido.sql`
(+ su `.test.sql`), `scripts/geocode-partners.mjs`. Presupuestos:
`src/lib/quote-responses.ts`, `src/server/quote-responses.repo.ts`,
`src/fn/quote-responses.ts`, `src/components/QuoteResponses.tsx`,
`migrations/015_ops_respuestas_de_talleres.sql` (+ su `.test.sql`),
`listPartnerOptions` de `src/server/partners.repo.ts`. La card de Inicio/Métricas:
`src/components/PulseCards.tsx`, `OpsPulse` en `src/lib/ops.ts`, `getOpsPulse`
en `src/fn/ops.ts`.

Las escrituras del embudo de talleres (`ops.advance_lead`) NO están acá — su
regla es `.claude/rules/ops-write-actions.md`, que también tiene la sección de
las migraciones 011 y 012. Seguros, Multas y las dos pestañas "todavía no" no
escriben nada. Pedidos sí: la ficha mueve estados y el listado carga pedidos a
mano (ver Pedidos, abajo).

## `/leads` es un layout, no una pantalla

`leads.tsx` sólo renderiza la barra de pestañas y un `<Outlet/>`. `leads.index.tsx`
redirige a `/leads/pedidos` (default a pedido del 2026-09-15; antes era
`/leads/talleres`, que ahora es la ÚLTIMA pestaña de `TABS`, no la primera —
el embudo del marketplace tiene 0 filas en producción). Cada pestaña es un
archivo con su propio `Route`, su `validateSearch` y su modo de SSR.

Consecuencia práctica: un `Link to="/leads"` cae en el redirect (un salto de
más). Apuntá a la pestaña que de verdad necesitás directo — la tarjeta de
Leads de Inicio sigue apuntando a `/leads/talleres` porque ES la que muestra
`leads.won`, no porque sea la default.

## "Sección de leads" acá NO es el `Lead` del backend

Esta es la trampa de vocabulario y hay que tenerla clara antes de tocar
cualquier archivo:

- **Para el backend, `Lead` es una cosa concreta**: el enum `lead_status`
  (`new | contacted | won | lost`), `lead_source`, el aggregate de `marketplace/`.
  Es el embudo usuario→taller por un presupuesto de service.
- **Acá "sección" es la vista de producto**: una línea por la que un usuario
  llega a pedirnos algo. El `Lead` del backend es UNA (la pestaña "Talleres").
  Las otras cuatro no son `Lead`s.

Por eso el código de Seguros dice `Insurance` (que es como se llama el aggregate
del otro lado — `vehicle-management/`), no `Lead`, y su repo es
`insurance.repo.ts`, no `leads.repo.ts`. Regla dura 7: el vocabulario es el del
backend. Si aparece un tipo `SeguroLead` o una función `advanceInsuranceLead`,
está mal.

## Qué pestaña tiene datos, al 2026-09-06

| Pestaña | Tabla | Estado |
|---|---|---|
| **Talleres** | `leads` | Real. Es `leads.talleres.tsx`, movido tal cual del viejo `leads.tsx`. En producción hoy tiene **0 filas** (el embudo todavía no se usó). |
| **Seguros** | `insurances` | Real. 16 pólizas vivas en producción, 3 vencen en <30 días. |
| **Multas** | `vehicle_fine_syncs` + `fines` | Real. 51 vehículos con multas consultadas, 38 con deuda, ~$69M adeudados. Ver abajo. |
| **Contactos** | — | No hay tabla. Ver abajo. |
| **Financiación** | — | El producto no existe. |
| **Pedidos** | `quote_requests` | Real desde el 2026-09-14, **pero la tabla no existe en producción** (el bounded context `quotes/` del backend no está desplegado). En DEV hay 2 filas. La pestaña lo detecta con un guard y lo dice; no muestra datos de ejemplo. Ver abajo. |

## Por qué existen dos pestañas sin datos

> Eran tres. Pedidos salió de esta lista el 2026-09-14, exactamente por el
> camino que esta sección prevé: apareció la tabla, el archivo pasó a tener
> `Route` + loader, y dejó de usar `ComingSoonPipeline`.

Es la **excepción relevada el 2026-09-06** a *"una pantalla que no reemplaza
ninguna consulta no va todavía"*. Se decidió mostrarlas como plan visible en vez
de esconderlas.

Lo que las hace admisibles y no una violación de la regla dura 8:

- **No fabrican dominio.** `ComingSoonPipeline` no tiene un array de ejemplo, ni
  una entidad inventada, ni un número. Es un cartel que dice qué línea es y qué
  falta.
- **No tienen `Route` con loader.** Cero consultas, cero server functions.

Si esto se siente como el germen de las pantallas placeholder que se borraron el
2026-08-30 (`/records`, `/analytics`, `/settings`): la diferencia es que
aquellas RENDERIZABAN datos falsos de un `placeholder-data.ts`. Estas renderizan
tres párrafos de texto y nada más. El día que una de las tres tenga tabla real,
su archivo pasa a tener `Route` + loader y deja de usar `ComingSoonPipeline`.

## Contactos a partners: por qué no se puede arrancar desde este repo

El pedido era "conteo total y por fecha de contactos directos a partners,
medidos como clicks en 'escribir por WhatsApp'".

Relevado contra el schema el 2026-09-06: **ninguna tabla registra ese tap.**

- No hay `partner_contact_clicks` ni tabla de eventos del marketplace.
- `recommendation_impressions` existe (0 filas en producción) pero registra que
  un partner se **mostró** en el ranking de learning-to-rank (`rank`, `score`,
  `features`), no que alguien lo contactó.
- `partners.whatsapp` es el número; nadie cuenta las aperturas.

El click pasa en la app mobile. Es la misma situación que la medición de tokens
de IA en `ai-costs.md`: *"el panel puede leer y agregar sin tocar el backend;
medir no"*. Para que esta pestaña exista, primero:

1. La app emite el evento al tocar "contactar por WhatsApp".
2. El backend lo persiste — una tabla append-only estilo
   `recommendation_impressions`, o un endpoint en `query/` (la capa de
   composición de lectura, que es la puerta natural del panel para reportes).

Recién ahí el panel lo lee, y el "total y por fecha" es un `count(*) … group by
date_trunc('day', …)` trivial. **No se resuelve con un array de ejemplo hasta
que haya dato** — ese array sobrevive meses y termina en producción (regla dura
8, corolario operativo).

## Seguros (`/leads/seguros`)

### Qué consulta reemplaza

El `select … from insurances where expiration_date < now() + interval '30 days'`
que hoy nadie corre sistemáticamente. Es una **lista de trabajo** (a quién
contactar para ofrecerle una alternativa), no una métrica — por eso muestra
nombre, email y patente, y por eso pasa por `adminMiddleware`.

### `days_to_expiry` sale de `expiration_date`, NUNCA de `status`

Verificado contra producción: hay pólizas en `active` a 28 días de vencer y en
`pending_renewal` a 7. A `insurances.status` (`document_status`:
`active | pending_renewal | expired`) lo mueve alguien o algún proceso del
backend, y no es un reloj confiable. Los días son aritmética sobre la fecha;
`status` viaja aparte como una columna más.

Es la misma forma que `noData` vs `failed` en `scanner-compatibility.md` y
`stuck` vs `failed` en `ops-metrics.md`: una señal derivada del reloj no se
mezcla con un estado que el dominio escribe.

### `JOIN`, no `LEFT JOIN`, a `users` y `vehicles`

`insurances.user_id` y `insurances.vehicle_id` son NOT NULL con FK. Un
`LEFT JOIN` escondería una corrupción de datos detrás de celdas vacías. Mismo
criterio que `findUserDetail` contra el catálogo del vehículo, y opuesto al
`LEFT` de `chats.md` (ahí el vehículo entero es opcional; acá no).

### La aseguradora es texto libre y sucio — se muestra crudo

14 valores distintos para 16 filas: `SANCOR SEGUROS` / `Sancor` / `Sancor
Seguros` / `SANCOR COOPERATIVA DE SEGUROS LIMITADA` conviven. No hay forma de
normalizar sin inventar un mapeo, así que se muestra tal cual viene. Mismo
criterio que el `insurer` sin tocar, el `model` de `chats.md` y el
`scanner_firmware` de escáneres: si el proveedor del dato no lo estandariza,
nosotros tampoco lo adivinamos.

### El PDF no se descarga

`insurances.file_id` puede apuntar a un `files` con el PDF de la póliza. La
columna "PDF" sólo **informa** si existe. `GET /files/:id/url` del backend está
acotado al DUEÑO del archivo (el usuario), así que un admin recibiría 404. Mismo
límite exacto que los manuales de catálogo (`vehicle-manuals.md`, trampa 1) — y
no se arregla desde este repo.

### `nullif(btrim(coalesce(x,'')), '')` en cada campo de texto

`insurer`, `coverage_type`, `insured_name`, `plate`, `vin`, `engine_number`
pueden venir vacíos (string, no `NULL`) del import de datos. Se normalizan a
`null` en el SELECT para que la UI muestre "—" y no una celda con un espacio.
Misma razón por la que todo chequeo de campo faltante en este repo se escribe
`coalesce(x,'') = ''`.

### Los cuatro contadores están siempre, incluso en cero

`SummaryTiles` es una superficie de monitoreo (mismo criterio que las tarjetas
de cola de `/operacion`), no la lista de pendientes de Inicio. Y los cortes son
**fijos** (vencidas / ≤30 / 31–90), no siguen la ventana elegida en los chips:
son un panorama, no el resultado del filtro.

### Ni una escritura

Una póliza es un hecho que el backend escribe cuando el usuario la carga en la
app. Mismo criterio que `driving_sessions` y `conversations`. Si aparece un
`UPDATE`/`INSERT` en `insurance.repo.ts`, está mal.

## Multas (`/leads/multas`)

Alcance: `src/lib/fines.ts`, `src/server/fines.repo.ts`, `src/fn/fines.ts`,
`src/routes/_authed/leads.multas.tsx`.

### Qué reemplaza, y por qué no es lo mismo que las columnas de `/usuarios`

Las columnas «Multas consultadas» / «Monto adeudado» de `users.md` contestan
"¿qué debe ESTE auto?" dentro de la ficha de UN usuario. Esta pestaña es la
vista **transversal**: todos los autos con multas consultadas, ordenables por
deuda. La consulta que nadie corre porque cruza `vehicle_fine_syncs` → `fines` →
`vehicles` → `users`.

### El grano es el VEHÍCULO consultado, no la multa

Se parte de `vehicle_fine_syncs` (1:1 por vehículo, PK `vehicle_id`): las filas
son "los autos a los que se les consultó". Un auto consultado sin multas es una
fila con `debtAmount = 0` — se muestra, no se esconde: acá **todas** las filas
fueron consultadas, así que `$0` significa inequívocamente "consultado, sin
deuda" (el `null` de la ficha de usuario no existe en esta pantalla).

### El predicado de "adeudado" es el mismo que en `users.repo.ts`

`sum(fines.amount)` con `status = 'pending'`. Si este corte y el de
`listUserVehicleSummaries` divergen, el panel dice dos montos distintos para el
mismo auto. Al 2026-09-06 las 240 multas de producción están todas `pending`.

### `round(sum(amount))::bigint` — no `::bigint` a secas

`fines.amount` es `numeric`. `::bigint` directo trunca; `round()` primero. Las
multas argentinas son enteras de pesos, así que redondear no pierde nada real y
evita un `$2.315.337,6` fantasma.

### El `ORDER BY` sale de un `Record` cerrado

El pedido fue "ordenar por todas las columnas". `SORT_COLUMNS` en `fines.repo.ts`
mapea cada `FineSortKey` (enum de zod) a una expresión SQL. Es lo único que hace
seguro interpolar la columna y `dir` en el `ORDER BY` — mismo patrón exacto que
`SORT_COLUMNS` de `listUsers`. Un `ORDER BY $1` con parámetro no existe en `pg`.

### El envoltorio `select * from (...) s`

`debt_amount`, `fine_count`, `jurisdictions`, `days_since_consult` y
`oldest_infraction` son subconsultas del SELECT. Todos los filtros —y el orden
por `jurisdictions`, que es un `text[]`— van en el `where`/`order by` de AFUERA,
sobre el alias. Mismo motivo que `users.repo.ts` y `chats.repo.ts`: no repetir
cada subconsulta en el filtro.

### Los chips de jurisdicción salen de la base

`listFineJurisdictions()` hace `select distinct jurisdiction` — hardcodear las 9
del enum `fine_jurisdiction` mostraría chips que nunca filtran nada (en
producción hay 7). Mismo patrón que `listDistinctChatModels` en `chats.md`.

### `daysSinceConsult` y "desactualizada" son lectura NUESTRA del reloj

Una consulta vieja no vio las multas nuevas: la deuda mostrada puede ser de
menos. Pasado `FINE_STALE_AFTER_DAYS` (30) la fila lo dice en voz alta y el chip
"Desactualizada" filtra por eso. Es la misma forma que `stuck` en `/operacion` y
`noData` en `/escaneres`: una señal derivada no se presenta como dato del
dominio.

### Ni una escritura

Una multa la escribe el backend al sincronizar con el proveedor. Es un hecho, no
un estado que el admin mueva. Si aparece un `UPDATE`/`INSERT` en `fines.repo.ts`,
está mal.

## Pedidos (`/leads/pedidos`, `/leads/pedidos/:id`)

### Qué reemplaza

`scripts/sql/listar-pedidos-de-presupuesto-abiertos.sql` de
`autolibre-backend-hex` (borrado el 2026-09-15), que el operador corría en DBeaver (`… where status <>
'closed' order by created_at`). El default de la pestaña es ese corte y ese
orden (`quoteStatus=open`, `createdAt asc`); los cerrados —que el script no
muestra y nadie mira— están a un chip. La ficha reemplaza el `select * … where
id = '…'` de antes de llamar.

### La card "Pedidos totales" de Inicio y `/metricas` — desde el 2026-09-17

`PulseRow` (`.claude/rules/metricas.md`, compartida entre `/dashboard` y
`/metricas`) mostraba "Leads ganados" (`pulse.leads.won`, el embudo de
talleres) como cuarta card. Se reemplazó por "Pedidos totales"
(`pulse.quotes`, `QuoteRequestPulse` en `~/lib/quote-requests`): `leads` tiene
0 filas en producción y `quote_requests` es la línea de captación real.
`pulse.leads` NO se sacó del contrato de `OpsPulse` — `MarketplaceBreakdown` de
`/dashboard` lo sigue usando aparte de esta fila, para el desglose del
marketplace.

**El número mostrado es `total − duplicates`, no `total`.** Verificado el
2026-09-17 contra producción: de 17 pedidos, **15 están cerrados con
`close_reason_code = 'duplicate'`** — el operador los usa para marcar cuando
la misma persona (o un doble submit) generó más de una fila. Mostrar el crudo
diría "17 pedidos" cuando en la práctica hay 2. `quoteRequestPulse()` en
`quote-requests.repo.ts` trae los dos números en una sentencia; la resta la
hace la UI, no el SQL, para que el hint pueda decir cuántos se excluyeron.

`quoteRequestPulse()` llama a `quoteRequestsAvailability()` ANTES de contar —
mismo motivo que `listQuoteRequestsFn`: un `SELECT` contra una tabla
inexistente explota al planificarse, un `to_regclass` en la misma sentencia no
lo evita. Con `available: false` la card muestra "—" y el hint lo dice, en vez
de romper Inicio por una tabla que otra base todavía no migró.

**El corte de duplicados es una constante COMPARTIDA** —
`NOT_DUPLICATE_PREDICATE` en `quote-requests.repo.ts`
(`close_reason_code is distinct from 'duplicate'`)— entre `quoteRequestPulse()`
y `quoteRequestSeries()` (la sección Pedidos de `/metricas`,
`.claude/rules/metricas.md`, desde el 2026-09-23). Si divergiera, "pedidos de
esta semana" contaría distinto en la card de Inicio y en el gráfico de
`/metricas`, del mismo conjunto de filas — misma clase de acoplamiento que
`INTERNAL_PREDICATE` entre `ops.repo.ts` y `ops.v_ai_usage`.

### `QuoteRequest` ≠ `Lead`

El aggregate es `QuoteRequest` (bounded context `quotes/`, tabla
`quote_requests`). Un `Lead` es el usuario yendo hacia UN taller que ya eligió;
un `QuoteRequest` es la persona pidiendo "¿cuánto sale esto?" y el operador
saliendo a buscar talleres. El código dice `QuoteRequest` / `quote-requests`,
nunca `Lead` (regla dura 7).

### ⚠ "Una sola tabla, sin presupuestos por taller" — CORREGIDO el 2026-09-22

Esta sección decía: *"El MVP del backend **sacó** `quotes` y `quote_messages`.
No hay una fila por oferta ni por partner: lo que el operador consiguió vive en
`proposals_count` y en el texto libre de `internal_notes`."*

**Eso dejó de ser cierto**, y hay que decirlo fuerte porque esa premisa está
citada en tres lugares más del repo (el comentario de cabecera de
`~/lib/quote-requests`, el de `~/lib/quote-templates` y la sección "la
escritura que se decidió NO hacer" de la migración 013). Relevado contra
PRODUCCIÓN (`current_database = autolibre`, `current_user = doadmin`, puerto
25060):

```
public.quote_request_proposals   EXISTE
public.quote_request_files       EXISTE  (purpose: problem_photo | budget)
enum quote_request_proposal_currency = ARS | USD
```

El backend volvió a poner el aggregate entre el 2026-09-15 (fecha del último
`grep`, que dio negativo) y el 2026-09-22, con otro nombre —**`proposal`**, el
mismo sustantivo de `quote_requests.proposals_count`— y con más forma que la
idea vieja: rango de precio en vez de precio, moneda, vigencia, nota interna
por presupuesto.

**La regla de fondo no cambió, cambió de qué lado cae el caso.** Lo que sigue
prohibido es exactamente lo mismo: si alguien arma "ofertas" parseando
`internal_notes`, está inventando dominio. Lo que ahora SÍ se puede es leerlas
de una tabla.

### …pero esa tabla NO es la del backend, y también hay que decirlo fuerte

Una primera versión de esta feature escribió `public.quote_request_proposals`.
**Se descartó el mismo día**, al mirar un mensaje real del operador. La tabla
del backend no puede representar la mitad de los casos:

| Lo que el mensaje real necesita | `quote_request_proposals` |
|---|---|
| Una respuesta **sin precio** (un diagnóstico, "traelo y lo vemos") | `amount_min` es NOT NULL con `CHECK (amount_min > 0)` — **estricto**, así que ni siquiera admite 0 |
| Dirección y teléfono de un taller que **no está en el directorio** | sólo tiene `partner_id` o `provider_name` |

En el mensaje que motivó el cambio, los TRES talleres contestaron sin precio y
uno no estaba en el directorio. No es un caso de borde: es el caso.

Así que lo que el panel escribe es **`ops.quote_request_response`**, nuestra
(migración 015). Que la tabla del backend exista no la vuelve la tabla del
dominio de esto: describe *una oferta con precio*, y lo que el operador maneja
es *la respuesta de un taller*, de la cual el precio es un atributo a veces
ausente. Y al 2026-09-22 **nada lee `quote_request_proposals`** —0 filas en
producción, todo se lo manda el operador por WhatsApp a mano— así que no hay
dos verdades que sincronizar.

El camino de vuelta está escrito, con el `INSERT … SELECT` y todo, en la
cabecera de la migración: el día que el backend acepte precio nulo y sume el
contacto del taller de afuera, el subconjunto con precio se backfillea y esto
se retira.

Lo que sigue sin tabla, y por eso sigue siendo nota interna, es la
**derivación** ("a qué taller le mandé este pedido") — ver `PartnerCandidates`.
Un presupuesto es lo que el taller contestó; una derivación es que se lo
mandamos. No son lo mismo y sólo una tiene dónde vivir.

### El guard de disponibilidad, y por qué no es opcional

**Al 2026-09-14 `to_regclass('public.quote_requests')` era `NULL` en
producción** (`autolibre` / `doadmin`) y la tabla sólo existía en DEV con la
migración 0093 aplicada. **Al 2026-09-15 ya no**: relevado contra la misma
base (`current_user = doadmin`, puerto `25060`), `quote_requests` existe en
producción con 3 filas, `location_address` incluido. El backend mergeó la
rama entre esas dos fechas. La pantalla se escribió contra la tabla real desde
el principio igual (build-now, deploy-later), protegida por
`quoteRequestsAvailability()` — el guard sigue estando ahí por las bases que
todavía no migraron (una preview vieja, un fork), no porque producción lo siga
necesitando:

- `no_table` → la tabla no existe.
- `missing_0093` → existe pero le falta alguna de las columnas que el repo LEE
  (`READ_COLUMNS`; en la práctica las de la 0093: `public_number`,
  `close_reason_code`, `cancellation_*`, `proposals_count`, `user_outcome*`).

El chequeo corre **en el handler del server function**, no sólo en el loader:
un `fetch` directo al endpoint contra producción sería si no un 500 con el texto
de Postgres. Se usa `to_regclass` + `information_schema.columns` y NO un
`select … limit 0` con try/catch — un catch que se traga errores de SQL termina
tragándose los reales. La UI (`QuoteRequestsUnavailable`) dice cuál de las dos
cosas falta, sin datos de ejemplo (regla dura 8).

**`READ_COLUMNS` se toca junto con `SELECT_COLUMNS`.** Si se lee una columna
nueva y no se agrega a la lista, el guard dice "disponible" y la pantalla
explota igual.

### `outcome` y `user_outcome` son dos ejes, y `NULL` ≠ `no_response`

- `outcome` (`hired | not_hired | no_response`) lo carga el OPERADOR después de
  preguntarle a la persona. **`NULL` = todavía no se preguntó**, que no es
  `no_response` ("se preguntó y no contestó"). El chip se llama "Sin preguntar".
- `user_outcome` (`hired | not_hired`) + `user_outcome_at` lo DECLARA la persona
  desde la app.

Van en dos columnas y no se combinan: pueden no coincidir, y esa discrepancia es
un dato.

### `closed` incluye las cancelaciones del usuario

`status = 'closed'` mezcla "el operador cerró el caso" con
`close_reason_code = 'cancelled_by_user'` (la persona se fue sola, desde
`received` o `contacted`, con `cancellation_reason` + `cancellation_comment`
propios). El resumen cuenta `cancelledByUser` aparte y hay un chip
"Cancelados por el usuario". `closed_reason` es la nota INTERNA del operador;
`cancellation_comment` es texto de la persona. No se confunden en la ficha.

### "Sin contactar" es lectura nuestra del reloj

Abierto + `contacted_at IS NULL` + más viejo que
`QUOTE_UNCONTACTED_AFTER_HOURS` (24 h). Ámbar, no rojo — misma forma que
`stuck` y `atrasada`. El predicado vive en UNA función
(`uncontactedPredicate`) que usan la columna del listado y la tarjeta del
resumen; el umbral entra por parámetro (`make_interval`), no interpolado.

### `public_number` es sólo para mostrar

`AL-{public_number}` (identity desde 1001) es lo que la persona le dicta al
operador por teléfono. La identidad es el uuid: los links van por `id`, y `q`
matchea el código con `('AL-' || public_number) ilike …`.

### El link de WhatsApp sólo sale con el teléfono canónico

`QuoteWhatsAppLink` (listado y ficha) abre `wa.me/<teléfono>` con un saludo que
nombra el `AL-n`. `QuoteRequest.create()` del backend normaliza `contact_phone`
a `549` + 10 dígitos "para WhatsApp", pero una fila rehidratada puede volver con
el valor viejo (`15 2512-0472`, está en su spec). `quoteWhatsAppUrl` saca
separadores y exige `^549\d{10}$`: **completar un prefijo sería adivinar la
característica, y adivinarla mal le escribe a otra persona.** Sin forma
canónica no hay link; la ficha lo dice, la tabla no (el número ya se ve).

Abrir el chat no escribe nada: no marca contactado. Eso sigue siendo el botón.

### Las notas internas están en hora de Buenos Aires

`internal_notes` es un log append-only: el script
`agregar-nota-interna-a-pedido-de-presupuesto.sql` agrega
`YYYY-MM-DD HH24:MI — <nota>` con `now() AT TIME ZONE
'America/Argentina/Buenos_Aires'`. `parseInternalNotes()` separa el sello y lo
muestra **crudo**, con "(Buenos Aires)": no trae offset, y reinterpretarlo con la
zona UTC de `~/lib/format` lo correría tres horas. Una línea escrita a mano sin
prefijo se muestra entera, sin sello — no se descarta. Los timestamps de las
columnas (`created_at`, `contacted_at`…) sí son UTC, y la ficha lo dice.

### `user_id` es NULL más seguido de lo que parece

Web y WhatsApp no tienen cuenta, **y un POST público con `channel = app`
tampoco**. Por eso el join a `users` es `LEFT` y la UI dice "anónimo", no
"sin usuario" como si fuera un error.

### El vehículo lo vincula el operador, y puede quedar mal

`vehicle_id` (nullable) lo setea el operador a mano, y puede apuntar a un auto
**archivado** o **de otra cuenta**. La patente que tipeó la persona (`plate`)
queda aparte. Tres flags en ámbar, ninguno corrige nada:

- `vehicle_owner_mismatch` — `v.user_id IS DISTINCT FROM qr.user_id`, **sólo con
  los dos lados presentes**. Un pedido de WhatsApp (sin cuenta) con auto
  vinculado es lo normal, no un mismatch.
- `plate_mismatch` — la patente tipeada vs la del vehículo, normalizadas
  (`upper` + sólo alfanuméricos).
- archivado.

Los tres joins al vehículo son `LEFT` (vehículo → spec → catálogo, dos saltos
porque `vehicles` apunta al SPEC — `vehicle-manuals.md`, trampa 3).

### No hay columna de moneda

`declared_amount` es `numeric(12,2)` — lo que la persona dice que le cotizaron
en otro lado. Se asume ARS y se muestra con `formatArs`, que corta centavos: no
es un monto contable. Llega de `pg` como string; `toNum` preserva el `null`
("no declaró" ≠ `$0`).

### Es dato personal, y hay una deuda legal abierta

Teléfono, email, nombre y una descripción en texto libre, muchas veces de gente
**sin cuenta** (o sea, que ni aceptó los términos en la app). Las dos lecturas
pasan por `adminMiddleware`. Y el backend marcó como **bloqueante para
producción** la deuda de Ley 25.326 (datos personales) de este flujo: que la
pantalla esté lista no significa que el flujo pueda salir. No es decisión de
este repo.

### Search params calificados

`quoteStatus` / `quoteChannel` / `quoteOutcome` / `quoteUncontacted`. `status`
ya lo usan `/solicitudes` y `/leads/talleres`, `channel` `/notificaciones`.
→ `.claude/rules/notifications.md`.

### `leads.pedidos.index.tsx`, no `leads.pedidos.tsx`

Con un `leads.pedidos.tsx` con componente, `leads.pedidos.$quoteRequestId.tsx`
queda anidado adentro y renderiza en un `<Outlet/>` que la tabla no tiene: cambia
la URL y no la pantalla. Mismo patrón que `chats.index.tsx` +
`chats.$conversationId.tsx`.

### Las escrituras son SPs de `ops`, con botones en la ficha

La fila del listado no mueve estados (el listado sólo carga pedidos nuevos, ver
"Cargar un pedido a mano"). La ficha escribe (`QuoteRequestActions` +
`QuoteRequestNoteComposer`) por los **stored procedures de `ops` de la 011**
(`ops-write-actions.md`, sección 011), con el actor de la sesión. Botón por
estado: `received` → contactado; `contacted` → respondido con cantidad (0 vale);
abiertos → cerrar y nota interna; `closed` → ninguno, y lo dice. Reemplazan a los
cuatro scripts que el backend tenía en `scripts/sql/` y borró el 2026-09-15.

- **El guard corre también antes de cada SP**, en el handler, con sentinela
  `QUOTE_REQUESTS_UNAVAILABLE:`. La 011 se aplica aunque la tabla no exista
  (parámetros `text`), así que la función está y recién revienta al ejecutarse.
  Sin tabla la ficha corta en `QuoteRequestsUnavailable` y no hay botones, pero
  un `fetch` directo al endpoint no pasa por la UI.
- **`cancelled_by_user` no se ofrece.** `operatorCloseReasonSchema` lo excluye
  del enum derivado de `QUOTE_REQUEST_CLOSE_REASONS`; el SP igual lo rechaza.
- **Nota de auditoría ≠ nota interna.** El campo opcional de las tres
  transiciones es `p_note` → `ops.action_log`, y se rotula así. La nota interna
  es otro formulario, al pie del hilo que alimenta.
- **Una nota interna es UN renglón.** El SP concatena con salto de línea y
  `parseInternalNotes` parte por línea: un salto adentro de la nota la partiría,
  y la segunda mitad se leería como "sin fecha — escrita a mano". El schema
  colapsa los espacios en blanco antes de viajar.
- **El error vive en un componente que no se desmonta.** Una
  `INVALID_QUOTE_REQUEST_TRANSITION` (la persona canceló desde la app mientras
  el operador miraba) recarga la ficha para mostrar el estado real, y ese estado
  desmonta el formulario que falló. Por eso los dos componentes quedan montados
  en todos los estados, cerrado incluido, y el mensaje queda en ellos.
- **Cerrar pide confirmación en línea** con el resumen de lo que viaja, y
  bloquea los campos mientras tanto. "Sin preguntar" viaja `NULL`, no
  `no_response`.

El backend **no tiene** un endpoint con `AdminGuard` en `src/quotes` para esas
transiciones (sólo las del usuario: crear, cancelar, declarar resultado),
re-verificado con `grep` el 2026-09-15. Si algún día aparece, va por HTTP y
los SP se retiran. Si aparece un `UPDATE quote_requests` en
`quote-requests.repo.ts`, está mal.

### Plantillas de mensajes (`<QuoteTemplates/>`) — viven en la FICHA, no en el listado

`src/lib/quote-templates.ts` (la lista `QUOTE_TEMPLATES` + `renderQuoteTemplate()`)
+ `src/components/QuoteTemplates.tsx` (la UI, con pestañas cuando hay más de una
plantilla). Texto para copiar y pegar al contactar a la persona o al taller —
no toca `quote_requests` ni ninguna otra tabla (a diferencia de
`QuoteRequestActions`, que escribe por los SPs de la 011).

**Cuelga de `leads.pedidos.$quoteRequestId.tsx`, no de `leads.pedidos.index.tsx`.**
Primera versión la puso en el listado con placeholders `[corchetes]` a
completar a mano — estaba mal: una plantilla sin un pedido puntual al que
referirse no tiene con qué rellenarse sola, y esa es justo la utilidad. Vive en
la ficha, donde ya está cargado el `QuoteRequestDetail` de UN pedido.

`renderQuoteTemplate(template, detail)` reemplaza los `{{placeholders}}` de la
plantilla cruda con los datos de ESE `detail` — código público
(`quotePublicCode`), patente, vehículo (`catalogLabel` si el operador vinculó
uno con catálogo), descripción y zona. Un dato que el pedido no tiene sale como
aviso `[entre corchetes]` en el texto renderizado, no como un vacío silencioso
— eso es lo único que le queda al operador para completar a mano, y sólo
cuando de verdad falta.

**"Zona" SÍ tiene columna** — corregido el 2026-09-15 contra la base real. Esta
regla decía "`QuoteRequest` no tiene columna de zona/dirección" y era un
supuesto no verificado: `quote_requests` tiene `location_source` (`device` /
`typed`), `location_address`, `location_locality`, `location_province`,
`location_latitude/longitude/accuracy_meters` — probablemente de una migración
posterior a la 0093, no documentada acá porque no se había leído todavía. El
repo sólo lee `location_address` (ya viene armado como string legible por el
backend, ej. `"Av. Italia, Dique Luján, Provincia de Buenos Aires"`), agregada
a `READ_COLUMNS` y al SELECT de `findQuoteRequestDetail` en
`quote-requests.repo.ts`, y expuesta como `QuoteRequestDetail.locationAddress`.
**No se agregó al listado** (`QuoteRequestListItem`): sólo la usa la plantilla
de la ficha, y sumarla ahí sería leer una columna que ninguna pantalla
muestra — regla general del repo, no `select *`.

**Dos plantillas, y dos estilos de placeholder a propósito.** "Apertura" usa
`{{con_llaves}}` (auto-rellena contra `detail`). "Presupuesto" —agregada el
2026-09-15— usa `[con_corchetes]` para proveedor, precio, dirección, horarios,
whatsapp y "otros detalles": son datos de UN presupuesto de UN taller, y
`autolibre-backend-hex` sacó `quotes`/`quote_messages` del MVP (`.claude/rules/leads.md`,
sección "Una sola tabla, sin presupuestos por taller" más abajo) — no hay
columna de la que leerlos, ni la va a haber sin ese aggregate de vuelta. El
regex de `renderQuoteTemplate` sólo matchea `{{llaves}}`, así que un
`[corchete]` en el texto fuente pasa intacto — es la señal visual de "esto lo
completa el operador", y agregar un placeholder nuevo a una plantilla existente
es tan simple como elegir el estilo correcto: `{{llave}}` si hay una columna en
`QuoteRequestDetail`, `[corchete]` si no la hay y no la va a haber.

Editar el texto ya renderizado en el textarea antes de copiar es un borrador de
un solo uso —vive en el estado del componente (`edits`, por `id` de
plantilla)— y nunca escribe `QUOTE_TEMPLATES`. Cambiar de pedido (el componente
se remonta con la ficha) o recargar la página lo pierde a propósito: la
plantilla es la fuente de verdad, esto es un borrador de un solo uso.

### Por qué no hay control de estado en el listado

`origin/config-pedidos` traía otra 011 (`ops.advance_quote_request`: un SP que
movía de cualquier estado a cualquier estado) y un `QuoteStatusControl` en cada
fila del listado. Se descartó en el merge del 2026-09-15, con motivos técnicos
—ver `ops-write-actions.md`, "La 011 que se descartó"—; de esa rama quedaron
las plantillas, la lectura de `location_address` y Pedidos como pestaña default.

Si vuelve la idea de acciones rápidas en la fila, llaman a los MISMOS SPs que la
ficha. Un segundo camino de escritura para la misma transición es justo lo que
se sacó.

### Cargar un pedido a mano (`<QuoteRequestComposer/>`) — desde el 2026-09-15

Segunda escritura de la pantalla: `ops.create_quote_request` (migración 012,
`migrations/012_ops_crear_pedido.sql`) inserta una fila nueva en
`quote_requests` para el pedido que llega de forma INFORMAL — llamada, en
persona, un referido — y por eso nunca pasó por el POST público de
app/web/whatsapp del backend.

`<QuoteRequestComposer/>` (`src/components/QuoteRequestComposer.tsx`) es el
botón "Cargar pedido" en el header de `leads.pedidos.index.tsx` — no vive en
la ficha porque no hay ficha todavía hasta que el pedido existe.
`createQuoteRequest()` en `quote-requests.repo.ts` llama al SP;
`createQuoteRequestFn` en `fn/quote-requests.ts` es el borde RPC, con el mismo
guard de disponibilidad que el resto.

#### Por qué un SP y no el endpoint público de creación — a diferencia de 011, ACÁ el backend SÍ tiene un camino

Éste es el primer caso de este archivo donde el backend tiene forma de crear
un `quote_request` (el POST público que usan app/web/whatsapp) y el panel
IGUAL usa un SP. No es una contradicción con la regla de "si el backend tiene
el camino, va por HTTP" (decisiones 4/4b del `CLAUDE.md`): ese POST es
ANÓNIMO por diseño — así se auto-atienden usuarios sin cuenta — y llamarlo
desde el panel dejaría la fila sin ningún rastro de qué admin la cargó. El SP
es lo que hace posible `ops.action_log` acá; el endpoint público ni siquiera
sabe que existe ese concepto.

**El `grep` al backend se corrió en el merge del 2026-09-15** (la rama no lo
había podido correr): `src/quotes` sólo tiene el `@Public() @Post()` anónimo y
el `@Post('app')` del usuario autenticado — ningún alta con `AdminGuard`. La
excepción aplica. El comentario de cabecera de la `.sql` todavía dice lo
contrario y nombra `ops.advance_quote_request` (descartado): no se editó para no
romperle el checksum a una base donde ya se haya aplicado.

#### El canal es una aproximación — no hay valor "informal" en el enum

`quote_request_channel` (relevado con `pg_enum`, no asumido) sólo tiene
`app | web | whatsapp`. Es un enum de `public`, del backend — este repo no lo
puede ampliar con un cuarto valor. El formulario pide elegir uno de los tres
igual (default `whatsapp`) en vez de inventar un valor que rompería el tipo;
el texto de ayuda en el compositor lo dice. La fila queda marcada aparte como
cargada a mano (ver abajo), así que el canal elegido no miente sobre CÓMO se
enteró el operador — es sólo la aproximación más cercana que el dominio del
backend permite representar.

#### `enteredManually` — leído de `raw_submission`, no de una columna nueva

`raw_submission` es NOT NULL y las submissions reales traen el body crudo del
cliente ahí. Un pedido cargado a mano no tiene ese body, así que en vez de
`'{}'::jsonb` (que se leería como "vino vacía, raro") el SP guarda
`{"source": "admin_manual_entry", "enteredBy": …, "enteredAt": …}` — metadata
real sobre el origen de la fila. `SELECT_COLUMNS` en `quote-requests.repo.ts`
deriva `entered_manually` de ahí (`raw_submission->>'source' = '
admin_manual_entry'`) para el listado Y la ficha; el listado lo muestra como
"Cargado a mano" bajo el código, la ficha lo suma al subtítulo. No hay columna
nueva que el backend tuviera que agregar.

#### Sin vincular usuario ni vehículo, a propósito — todavía

El compositor no ofrece buscar una cuenta o un auto existente para linkear
`user_id`/`vehicle_id`: hoy NINGUNA pantalla de `/leads/pedidos` tiene ese
picker — el operador vincula el vehículo a mano por SQL, como documenta
"El vehículo lo vincula el operador" más arriba. Agregar ese picker es
funcionalidad nueva y separada, no parte de cargar el pedido.

#### Sin idempotencia, a propósito

A diferencia de `BroadcastComposer` (que manda push a decenas de personas y
por eso necesita un `broadcastId` para no duplicar un envío masivo), acá un
double-submit crea como mucho UN pedido de más — mismo costo que cargarlo dos
veces en DBeaver. El componente usa un `inFlight` ref para el click doble;
no hay clave de idempotencia contra el servidor.

Si aparece un `INSERT INTO quote_requests` suelto en `quote-requests.repo.ts`
(en vez de pasar por `ops.create_quote_request`), está mal.

### El orden por default es el más nuevo primero — desde el 2026-09-15

Antes era `createdAt asc` (el más viejo arriba, leído como cola de trabajo —
"lo que más esperó va primero"). Pedido explícito: ahora es `createdAt desc`,
así que lo que acaba de entrar —incluido lo recién cargado a mano— es lo
primero que se ve al abrir la pantalla. `firstClick` del header "Pedido"
también pasó a `'desc'`, para que saltar a esa columna desde otra active el
mismo orden que el default. El orden viejo sigue disponible: clickear el
header de "Pedido" invierte.

### Derivar a un taller (`<PartnerCandidates/>`) — desde el 2026-09-15

Alcance: `src/components/PartnerCandidates.tsx`, `ops.set_quote_request_rubro`
(migración 013), `listPartnerCandidates` + `listPartnerZones` de
`src/server/partners.repo.ts`. Nace de
`.claude/plans/partners-derivacion.md`, que tiene el detalle completo — la
regla que sigue es el resumen operativo.

Contesta *"me entró este pedido: ¿a qué taller se lo mando?"*, hoy resuelto de
memoria por el operador. Cuelga de la FICHA (`leads.pedidos.$quoteRequestId.tsx`),
no del listado — necesita el pedido puntual (su rubro, su coordenada) al que
referirse.

**Dos escrituras, deliberadamente de forma distinta:**

- **Clasificar el rubro** es DATO: `ops.set_quote_request_rubro` guarda en
  `ops.quote_request_rubro` (no en `quote_requests` — ver
  `ops-write-actions.md`, sección de la 013). Habilita "¿qué rubros nos piden
  más?" con un `group by`.
- **Registrar la derivación** ("a qué taller se lo mandé") es NOTA INTERNA:
  reusa `ops.add_quote_request_internal_note` (011), el mismo hilo que ya
  muestra la ficha. **No hay una tabla de derivaciones** — no se puede
  contestar "¿cuánto le mandamos a cada taller y cuánto convirtió?" con una
  consulta, sólo leyendo el texto de las notas. Mismo límite que ya documenta
  más arriba "Una sola tabla, sin presupuestos por taller": si esa pregunta se
  vuelve importante, el arreglo es una tabla nueva con su SP, no un parser de
  `internal_notes`.

**El search param se llama `quoteRubro`**, calificado por dominio:
`partnerCategories` ya lo usa `/partners/listado` (`string[]`, desde el
2026-09-17) y `coverageRubros` lo usa `/partners/cobertura` (`string[]`) bajo
la misma clave semántica — un tercer nombre genérico repetiría la colisión de
`.claude/rules/notifications.md`. Cambiar el chip de rubro sólo cambia qué se
está MIRANDO (no persiste nada); la precedencia es **el search param gana, si
no está el default es el rubro guardado** en `ops.quote_request_rubro`.

### Filtrar candidatos por zona y por aliado — desde el 2026-09-17, filtros de CLIENTE

`.claude/plans/cambios-2026-09-17.md`, punto C. Al 2026-09-17, **0 de 48
partners activos tienen coordenadas cargadas** en producción (la Fase 0 del
plan de abajo sigue sin correrse): `distanceKm` es `null` para todos, el
`ORDER BY` cae al desempate por tier/nombre, y con hasta 48 candidatos por
rubro el operador no tiene con qué acotar la lista salvo mirarla entera. Zona
(chips multiselect, contra `listPartnerZonesFn` — la MISMA lista que el chip
de zona de `/partners/listado`) y "Solo aliados" (`tier = 'founding'`)
resuelven eso.

Los dos van en `useState` de `PartnerCandidates.tsx`, **no en la URL**: a
diferencia de `quoteRubro`, que cambia la CONSULTA (el loader vuelve a pedir
candidatos de ese rubro), zona y aliado sólo PODAN lo que ya vino —como mucho
48 filas—, así que no hay round trip que ahorrar ni consulta que repetir.
Consecuencia aceptada: un link pegado no reproduce el filtro, sólo el rubro.
Si algún día eso importa, sube a la URL con nombres calificados
(`quoteCandidateZones`, `quoteCandidateTier`) — nunca `zone`/`tier` pelados.

Zona filtra por **contención** (`coverageZone.toLowerCase().includes(...)`),
igual que el filtro homónimo del listado y por el mismo motivo: varios
partners declaran dos zonas en el mismo campo de texto, y una igualdad exacta
los dejaría invisibles justo cuando el operador busca una de las suyas. "Solo
aliados" PODA la lista, no la reordena — `founding` ya es el desempate del
`ORDER BY` del repo, y convertirlo además en un criterio de orden del cliente
dejaría dos criterios peleando.

Los dos carteles ("X de N candidatos tienen ubicación", el aviso de share
bajo) se recalculan sobre la lista YA FILTRADA (`visibleCandidates`, no
`candidates`): si siguieran contando sobre el total, dirían "3 de 48" cuando
en pantalla sólo hay 5 filas visibles por el filtro de zona.

**Un partner sin coordenada no es un partner lejos.** `listPartnerCandidates`
calcula la distancia con Haversine inline (sin `postgis`/`earthdistance`:
disponibles pero no instaladas, e instalarlas es DDL global de `public`) y
devuelve `distanceKm: null` cuando falta la coordenada del partner O la del
pedido — nunca una distancia inventada. La UI lo muestra "sin ubicación" en
gris, mismo criterio que las celdas vacías de `scanner-compatibility.md`. Los
partners con `modality` "A domicilio" o "A distancia" (texto libre, no un
enum — ver `isRemoteModality` en `~/lib/partners`) van en un bloque aparte sin
distancia: ordenarlos por km los hundiría cuando podrían ser la mejor opción.

**El WhatsApp del partner usa el MISMO normalizador que el del pedido**
(`canonicalWhatsAppDigits` en `~/lib/partners`, del que `quoteWhatsAppUrl`
también depende): sin la forma canónica `549` + 10 dígitos, no hay link — 
adivinar el código de área le escribiría a otra persona.

La Fase 0 del plan (geocodificar las direcciones de los 43 partners sin
coordenadas) es un script one-off (`scripts/geocode-partners.mjs`), corrido a
mano, fuera del panel — no una dependencia de runtime. Sin ella el panel de
candidatos funciona igual, sólo que con menos partners ubicados (lo dice en
pantalla si son menos de la mitad).

### Presupuestos (`<QuoteResponses/>`) — desde el 2026-09-22

Alcance: `src/lib/quote-responses.ts`, `src/server/quote-responses.repo.ts`,
`src/fn/quote-responses.ts`, `src/components/QuoteResponses.tsx`, la migración
015 (`ops-write-actions.md`) y `listPartnerOptions` de `partners.repo.ts`.

Contesta *"¿qué me contestó cada taller para este pedido?"*. El operador llama
o escribe, carga lo que le dijeron, y con eso arma UN mensaje de WhatsApp para
que la persona elija y **coordine el turno directamente con el taller**.

Reemplaza los dos lugares pobres donde eso vivía: una línea de `internal_notes`
("Taller X: $180.000, turno el jueves") y el número suelto de `proposals_count`.
Vive en la FICHA, no en el listado — mismo criterio que `QuoteTemplates` y
`PartnerCandidates`.

#### `response` en el código, "presupuesto" en la UI

Regla dura 7 no obliga a llamar igual a dos cosas distintas: obliga a lo
contrario. `proposal` es el sustantivo del backend para una oferta CON precio
(`quote_requests.proposals_count`), y una fila de acá puede no tenerlo. La UI
dice "Presupuestos" porque es la palabra del equipo — misma divergencia
deliberada que `tier` ↔ "Aliado" y `service_categories` ↔ "Rubro".

Si aparece un `QuoteProposal` en `ops`, está mal: dos tablas casi homónimas con
significados distintos es el peor de los mundos. Y **no confundir con
`assistant_proposals`**, que son las propuestas del chat de IA
(`metricas.md`, bloque 3).

#### El precio tiene TRES estados, y los tres dicen cosas distintas

| Valor | Significa | En el mensaje |
|---|---|---|
| `NULL` | el taller no pasó precio (un diagnóstico, "traelo y vemos") | **no hay renglón 💵** |
| `0` | sin cargo / bonificado | `💵 Sin cargo` |
| `> 0` | el precio, cerrado (`min = max`) o rango | `💵 $ 45.000 a $ 60.000` |

Ésta es la razón de ser de la tabla propia: el CHECK del backend es
`amount_min > 0` y NOT NULL, así que los dos primeros estados **no existen**
ahí. "Diagnóstico sin cargo" es literalmente lo que contestó uno de los
talleres del mensaje que motivó todo esto.

Un renglón "precio: a confirmar" se lee como un error nuestro; uno que no está,
no. Por eso `formatQuoteAmount` devuelve `null` y el renglón desaparece, en vez
de un "—".

El monto se tipea en castellano rioplatense (`parseAmount`): el punto es
separador de miles y la coma es decimal, al revés que `Number()`, que leería
`180.000` como ciento ochenta.

#### Un presupuesto es de UN taller, y el taller es de una de dos clases

`chk_ops_qrr_provider_identified` es `num_nonnulls(partner_id, provider_name) = 1`
— el mismo invariante que el backend eligió para su tabla, copiado a propósito
para que el backfill futuro no tenga que limpiar nada.

- **Del directorio**: se guarda el `partner_id` y **nada más**. Dirección,
  teléfono y horarios se leen de `partners` al mostrar, así que siguen al
  directorio si los corrigen. `chk_ops_qrr_contact_only_for_outsiders` rechaza
  una copia tipeada: una segunda verdad que envejece sola es peor que un join.
- **De afuera**: nombre, dirección y teléfono tipeados. **Esto es lo que no
  tenía dónde vivir**, y sin ello el mensaje no puede decirle a la persona
  adónde ir.

El selector ofrece sólo partners `active` (`listPartnerOptions`), aunque el SP
acepte uno pausado: **el SP valida representabilidad, el selector es decisión de
producto.** Un presupuesto viejo de un taller que después se pausó se sigue
leyendo y editando bien, y la fila lo avisa en ámbar.

#### El buscador de taller filtra en el CLIENTE

50 partners activos al 2026-09-22, y ya vienen enteros en el loader. Filtrar
sobre un array de 50 es instantáneo y no tiene estados de carga, de error ni de
carrera — a diferencia del picker de destinatarios de `BroadcastComposer`, que
SÍ va al servidor con debounce porque su universo son miles de usuarios. El día
que el directorio tenga cientos, esto pasa a ser un `searchPartnersFn` con la
misma forma que aquél.

Usa `normalizeForMatch` de `~/lib/catalog` (saca acentos y puntuación), así que
"perez" encuentra "Pérez" y "cars service" encuentra "H&G Cars Service".

**Tipear NO vincula.** Escribir "Autech" deja un taller de AFUERA llamado
Autech aunque Autech esté en el directorio: `partner_id` sólo se setea
eligiendo de la lista. Adivinar el id por nombre es lo que
`partner-approval.md` ya desaconseja con `nameCollisions` —dos partners se
pueden llamar igual—, así que en vez de adivinar el campo dice en qué modo está
y, si el texto coincide exacto con un partner, ofrece vincularlo en un click.

#### El orden es EDITORIAL, no por precio

`position`, con flechas ↑↓ en cada fila. En el mensaje real el primero era el
que daba diagnóstico sin cargo y en el día, no el más barato — y ninguno de los
tres tenía precio, así que ordenar por importe habría dado un orden arbitrario.

Reordenar manda la lista COMPLETA de ids al SP, no un "mové éste uno arriba":
con un movimiento relativo, dos pestañas reordenando a la vez dejan un orden
que ninguna pidió. El SP rechaza una lista incompleta, con duplicados o con
ajenos.

#### Una vencida NO entra en el mensaje

`splitQuoteResponsesForMessage` (en `~/lib/quote-templates`) parte la lista en
`included` / `expired`. Mandar un precio caducado es peor que mandar uno menos.

**Se dice en pantalla, en los dos lados** (la tarjeta y el compositor del
mensaje): un renglón que desaparece sin explicación es un bug desde el lado del
operador. `expired` lo calcula Postgres —la ficha es SSR completo y comparar
contra el reloj del navegador daría un mismatch de hidratación por fila, mismo
patrón que `age_minutes` en `/actividad`— y `null` (sin vigencia declarada) no
es `false` (vigente): la UI los distingue.

`valid_until` es un `date`, así que se mapea con un `toPlainDay` propio y no
con `toISOString().slice(0,10)` — `pg` lo entrega a medianoche LOCAL del
proceso y esa conversión devuelve el día ANTERIOR al este de UTC (la trampa que
`ai-costs.md` documenta para la serie diaria).

#### `proposals_count` y la cantidad de filas son DOS números, y no se sincronizan

`quote_requests.proposals_count` es del recorrido del pedido: lo escribe
`ops.mark_quote_request_answered` (011), que además lo exige para pasar a
`answered`. La 015 **no lo toca** — sincronizarlo con un `count(*)` sería mover
el estado del pedido de costado, sin pasar por su guarda de estado.

- `<QuoteResponses/>` avisa en **ámbar** cuando no coinciden. Es el síntoma de
  "cargué los presupuestos y me olvidé de marcarlo respondido".
- `<QuoteRequestActions/>` SIEMBRA el campo de «Marcar respondido» con la
  cantidad cargada, como valor inicial y nada más. Con cero cargados arranca
  VACÍO, no en "0" — mandar un cero que nadie escribió diría "llamamos y no
  conseguimos nada".

#### Se puede cargar en un pedido cerrado, y es a propósito

El SP no exige que el pedido esté abierto: una respuesta que llegó tarde es un
hecho real, y un presupuesto no es un estado. La ficha avisa en ámbar. El SP
valida representabilidad; la regla de negocio vive donde cambiar de opinión no
cuesta una migración.

#### Lo que NO entra todavía: el PDF

`quote_request_files` existe en el backend, con `purpose = 'budget'`. Adjuntar
el PDF necesita que el archivo llegue a DigitalOcean Spaces, y **ninguna
cantidad de SQL sube un archivo a un bucket** (`vehicle-manuals.md`). Es una
feature aparte, con el flujo de subida directa en cuatro llamadas. Decidido
fuera de alcance el 2026-09-22.

### El mensaje de WhatsApp (`<QuoteTemplates/>`, plantilla «Presupuestos»)

La forma sale de un mensaje que el operador mandó de VERDAD, no de una idea de
cómo debería ser. Eso decidió cuatro cosas que de otro modo se habrían elegido
al revés:

1. **UN mensaje, con todo lo necesario para avanzar** — dirección y teléfono
   del taller incluidos. El turno lo coordina la persona con el taller, no
   nosotros. Se evaluó partirlo en dos ("elegí" y después "coordiná") y se
   descartó: ese segundo paso no existe.
2. **Numerado**, para que la respuesta pueda ser "el 2".
3. **Cada renglón existe sólo si hay dato.** 📍 dirección · 📞 teléfono ·
   🕘 horarios (sólo del directorio) · 💵 precio · 📅 vigencia · el párrafo.
4. **La recomendación final es un `[corchete]`.** "Si querés avanzar rápido, X
   te da el diagnóstico sin costo" es juicio del operador sobre ese caso;
   ninguna plantilla la puede escribir sin inventar.

Cuatro detalles del armado que se descubrieron CORRIENDO el render
(`tmp/probe-mensaje.mjs`), no leyéndolo:

- **`{{intro}}` es el párrafo entero, no `{{cantidad}}` suelto.** Con un solo
  taller, "el detalle de cada uno para que elijas" no se sostiene (no hay entre
  qué elegir); con cero, "respuesta de cero talleres" se lee como un bug
  nuestro. Son tres redacciones en `introSentence()`.
- **El nombre del auto se destaca en Title Case** (`NISSAN NOTE` → `Nissan
  Note`), con los tokens de hasta 3 caracteres intactos (VW, BMW, KIA, 208).
  Es presentación y no toca el dato; sin eso el mensaje grita. Se usa
  `catalogShortLabel` (marca + modelo) y no `catalogLabel`: versión y año son
  precisión en una tarjeta y ruido en un WhatsApp.
- **El "por …" cita la descripción CRUDA del pedido.** El operador suele
  parafrasearla y queda mejor, pero parafrasear no lo puede hacer el panel sin
  inventar: se cita textual y se reescribe en el cuadro, que es editable.
- **Las fechas van con `formatDate`**, el mismo formateador del resto del
  panel, no el `YYYY-MM-DD` crudo.

**El botón manda lo EDITADO**, no el render original: si mandara el original,
el operador editaría el cuadro y se preguntaría por qué llegó otra cosa.

El link sale con el MISMO criterio de teléfono que todo el repo
(`canonicalWhatsAppDigits`: `549` + 10 dígitos, sin adivinar la característica).
Sin botón hay **dos** causas y se explican por separado —el teléfono del pedido
no es canónico, o el mensaje pasa `WHATSAPP_TEXT_MAX`— porque una se arregla
corrigiendo el teléfono y la otra acortando el texto: un solo "no se puede"
mandaría a buscar mal.

`WHATSAPP_TEXT_MAX` (3.500) no es un límite de WhatsApp —un mensaje admite
decenas de miles— sino del largo de URL que tolera el navegador al abrir el
link, que no está especificado en ningún lado. Con cuatro talleres el mensaje
ronda los 900 caracteres.

`responses` baja como PROP desde el loader de la ficha, que ya las trae para la
tarjeta: pedirlas de nuevo sería otro snapshot, y el texto que se manda podría
no ser la lista que se ve dos tarjetas más abajo.

### El `AL-xxxx` en TODAS las plantillas — desde el 2026-09-23

Hasta acá sólo «Apertura» tenía `{{codigo}}`; «Presupuestos» no. Es la única
forma de trazar un pedido días después, con varias conversaciones encima, así
que se agregó ahí también (en el saludo) y quedó como una condición de las
cuatro plantillas que hoy existen.

**Guardrail en tiempo de módulo, no sólo una convención escrita**: al cargar
`~/lib/quote-templates`, un `filter` sobre `QUOTE_TEMPLATES` busca alguna sin
`{{codigo}}` en su `content` y, si encuentra una, **tira** con los `id` que
faltan. La próxima plantilla que alguien agregue sin el código no pasa
inadvertida — rompe fuerte apenas el módulo se importa, en vez de en silencio.
Se evaluó un chequeo a nivel de tipos (un template literal type que exija la
substring) y se descartó: TypeScript no puede expresar "esta string contiene
esta substring" de forma legible, y el `throw` en tiempo de módulo cubre el
mismo caso con mucho menos ceremonia.

### Dos plantillas más, para pedir cotización a un TALLER — desde el 2026-09-23

`cotizacion_red` («Pedir cotización — red») y `cotizacion_nuevo` («Pedir
cotización — taller nuevo»). A diferencia de «Apertura» y «Presupuestos», que
van a la PERSONA del pedido, estas dos llevan un tercer campo,
`audience: 'taller'`, en `QuoteTemplate` — y eso cambia dos cosas.

**Viaja MENOS dato, a propósito.** Nombre de la persona, teléfono, dirección
exacta y patente quedan afuera: el taller no los necesita para cotizar, y
mandárselos sin que haga falta es la misma deuda de Ley 25.326 que el backend
marcó como bloqueante para este flujo (ver más abajo, "Es dato personal"). Lo
que sí viaja: `{{codigo}}`, `{{vehiculo_taller}}` (`catalogLabel` con versión
y año, TitleCased, SIN patente — a diferencia de `{{vehiculo}}` que es para la
persona y sí la lleva), `{{pedido}}` y `{{localidad}}`.

**`{{localidad}}` es la línea entera, y desaparece entera si no hay dato.**
No es "Zona: {{localidad}}" con el prefijo fuera del placeholder — es
`{{localidad}}` sola en su propio renglón del template, y su valor ya trae el
`* Zona: …` armado. `renderQuoteTemplate` filtra, ANTES de sustituir, toda
línea cuyo único contenido sea un placeholder de `OPTIONAL_LINE_KEYS` (hoy
sólo `localidad`) que resolvió a `''` — mismo criterio que los renglones
📍📞 de `responsesBlock()`, sólo que ahí se arman a mano y acá el texto fuente
es estático. Localidad sale de `quote_requests.location_locality` (columna
nueva para el repo, sumada a `READ_COLUMNS` y al SELECT del detalle **junto**
con el tipo — `leads.md` ya avisa que leer una columna sin sumarla al guard
hace que el guard mienta), no de `location_address`: la dirección exacta es
justo lo que no tiene que viajar.

**`{{vehiculo_taller}}` sin vehículo o sin catálogo cae en un corchete**
(`[marca modelo versión año]`), nunca en una línea que desaparece — a
diferencia de `localidad`, el auto es el dato central del pedido y omitirlo
en silencio dejaría un mensaje que no dice para qué es.

**`audience: 'taller'' apaga el botón de WhatsApp genérico de
`<QuoteTemplates/>`.** Ese botón usa `canonicalWhatsAppDigits(detail.contactPhone)`
— el teléfono de la PERSONA. Con las plantillas nuevas activas, mandar por ahí
sería escribirle a quien no corresponde. `QuoteTemplates.tsx` sólo calcula
`digits`/`waUrl` cuando `active.audience === 'persona'`; para `'taller'` el
texto de "sin botón" cambia (dice que el envío va por el candidato elegido,
no por acá) y sólo queda copiar.

### Botón "Pedir cotización" en cada candidato de `PartnerCandidates`

El envío real de la plantilla «red» pasa por acá, no por el botón genérico de
arriba: cada fila de `PartnerCandidates` ya resolvía un link "WhatsApp" con un
saludo fijo (`partnerWhatsAppUrl`); desde el 2026-09-23 suma un segundo botón,
"Pedir cotización", que abre `wa.me/<taller>` con `renderQuoteTemplate` de la
plantilla `cotizacion_red` YA renderizada para ESE pedido (`whatsAppMessageUrl`,
mismo tope `WHATSAPP_TEXT_MAX`) — se calcula UNA vez en `PartnerCandidates`
(no depende del candidato) y se pasa a cada `CandidateRow`. Mismo criterio de
teléfono que todo el repo: sin `549` + 10 dígitos canónicos, no hay botón.

Para el taller NUEVO no hay botón: no está en el directorio, no tenemos su
número. El operador lo copia desde `<QuoteTemplates/>` y lo pega en su
WhatsApp con el número que consiga por fuera.

**Abrir el chat no escribe nada** — ni nota interna, ni derivación. Igual que
el link "WhatsApp" que ya existía. Si se quiere que quede registro de "a quién
le pedí cotización", el camino es el mismo de siempre: una nota interna a
mano vía "Registrar derivación", a un click de acá. Hacerlo automático
afirmaría que se mandó un mensaje que sólo se abrió — el link puede quedar sin
enviar en la pestaña de WhatsApp Web.

### La ficha, revisada el 2026-09-25 (`.claude/plans/pedidos-ficha-2026-09-25.md`)

Seis cambios sobre `/leads/pedidos/:id`, en cuatro fases. Relevado antes de
empezar: de los pedidos `app` de producción (los únicos con `vehicle_id`
real), el número de motor está vacío en `vehicles` en el 100% de los casos —
de ahí el bloque Vehículo de la Fase 4.

**Una sola nota que queda: el hilo.** Se sacaron del formulario la nota de
auditoría (`p_note`, iba a `ops.action_log` y nadie la leía después), «nota
interna del cierre» (`closed_reason`) y «nota del resultado» (`outcome_note`)
de `QuoteRequestActions`, y la nota interna POR presupuesto de
`<QuoteResponses/>`. Lo ya cargado en esos campos antes del cambio se sigue
mostrando (en el recorrido, o como texto de sólo lectura en la fila) — no se
borró nada, se dejó de pedir. Cerrar un pedido ahora tiene un solo campo de
texto, que se agrega al hilo **en la misma operación** que el cierre
(`p_internal_note` de `ops.close_quote_request`, migración 016 — ver
`.claude/rules/ops-write-actions.md`): antes eran dos llamadas, y la segunda
podía fallar (la persona canceló desde la app entre medio) dejando una nota
de un cierre que nunca pasó.

**Presupuestos, en formato compacto.** `ResponseRow` pasó de una tarjeta de
varias líneas a una fila: `N · nombre (+Aliado/pausado)` con el precio
alineado a la derecha y tabular, vigencia al lado, el detalle recortado a 2
líneas con «ver más», y dirección/teléfono/horario en una segunda línea
chica y truncada. Las acciones (↑↓/Editar/Borrar) son iconos siempre
visibles —no un menú que se abre, y no ocultos hasta el hover: el plan pidió
que sean accesibles por teclado, y un control que sólo aparece con el mouse
encima no lo es—. `QuoteResponse` sumó `partnerTier` (antes sólo se sabía si
era del directorio) para poder mostrar el badge «Aliado» en la fila.

**Rubros: multiselect, no un solo valor.** `ops.set_quote_request_rubro`
(013, un rubro por pedido) se reemplazó por `ops.set_quote_request_rubros`
(016, el CONJUNTO — un pedido puede pedir "frenos y suspensión", y el
candidato correcto es el que cubre el máximo de rubros pedidos, no sólo uno).
`quoteRubro` (string) pasó a `quoteRubros` (`string[]`, `multiSelectParam`).
`listPartnerCandidates` ordena primero por `matched_category_count DESC`,
recién después por distancia. `PartnerCandidates` usa el `MultiSelect` nuevo
(ver abajo) para elegir rubros y para el filtro de zona —antes chips sueltas,
que no escalaban a las ~30 zonas del directorio—, y cada fila de candidato
muestra qué rubros de los PEDIDOS cubre (`matchedCategories`), no sólo sus
servicios.

**`<MultiSelect/>` (`src/components/MultiSelect.tsx`), nuevo componente
compartido.** Trigger con resumen ("Motor, Frenos +1"), popover con casillas +
buscador (filtra en el cliente, `normalizeForMatch`), «Limpiar», contador.
Usa dos primitivas de shadcn agregadas para esto —`ui/popover.tsx` y
`ui/checkbox.tsx`, sin sombra por `design-system.md`—. Genérico a propósito:
no sabe nada de rubros ni de zonas, así que la próxima pantalla que necesite
"elegir varios de una lista cerrada" lo reusa en vez de reinventar chips.

**Plantillas de mensaje, editables desde el panel (migración 017).** Hasta
acá `QUOTE_TEMPLATES` era una constante de código: cambiar una palabra era un
commit. Ahora son versiones en `ops.quote_message_template_version`
(append-only: "editar" inserta una versión nueva, "volver atrás" reenvía el
contenido de una vieja). Las 4 de siempre quedan como SEMILLA — si una clave
no tiene ninguna versión guardada, se usa la del código; la primera edición
crea la versión 1. `listQuoteMessageTemplatesFn` hace el merge semilla+base
en el SERVIDOR, así que `QuoteTemplates` y `PartnerCandidates` (el botón
"Pedir cotización", que busca `cotizacion_red`) dejan de importar
`QUOTE_TEMPLATES` directo — las dos tienen que usar la MISMA versión,
editada o no. El editor (`Sheet` con «Editar plantilla» / «Nueva plantilla»)
tiene título, audiencia, textarea con el texto crudo, botones de variable
que insertan `{{llave}}` en el cursor (`TEMPLATE_VARIABLES`, catálogo cerrado
por audiencia — `persona` y `taller` no comparten todas), vista previa
renderizada con el pedido abierto, e historial con «usar esta versión». El
guardrail de `{{codigo}}` obligatorio se repite en TRES lugares ahora: el
`throw` en tiempo de módulo sobre la semilla, el `CHECK` de la tabla + el SP
(única barrera real para lo editado desde el panel), y zod del lado del
cliente. → `.claude/rules/ops-write-actions.md`, migración 017.

**Bloque «Vehículo» de sólo lectura (Fase 4).** Visible siempre que el pedido
tenga `vehicle_id`, sea o no `app`. VIN, número de motor **con la fuente**
(`vehicles` → cédula → seguro, en ese orden — nunca `vehicles` solo, porque
relevado el 2026-09-25 está vacío ahí en el 100% de los 8 pedidos `app` de
producción), kilometraje, los DTCs del ÚLTIMO escaneo con título
(`lookupDtc()`, mismo catálogo que `/escaneres/detecciones`), y una
`<MaintenanceTasks/>` plegable con las tareas de ESE auto. `null` ≠ `0` en
los DTCs: sin escaneo nunca no hay fecha; escaneado y sin códigos sí la
tiene. **De paso corrigió un bug real**: `listUserVehicleSummaries`
(`/usuarios`) contaba `diagnostic_dtcs` —sólo los códigos que alguien
BUSCÓ— en vez de `session_dtc_snapshots.codes` —todos los que trajo la
sesión—, mismo error que `.claude/rules/scan-detections.md` ya documentaba
para otra pantalla. Los dos ahora leen la misma fuente; si vuelven a
divergir, `/usuarios` y esta ficha van a decir dos números de DTC distintos
para el mismo auto.

`Tasks`/`TaskRow`/`TaskStateTag` se extrajeron de `/usuarios/:id` a
`src/components/MaintenanceTasks.tsx` (renombrado `MaintenanceTasks` en el
export) para que las dos pantallas compartan la forma — si "vencida" se ve
distinto en una de las dos, una está mal.

## Cómo verificar un cambio acá

`pnpm typecheck` + `pnpm build` (el build regenera `routeTree.gen.ts`, así que
una pestaña nueva o un `Link` a una ruta nueva sólo se validan DESPUÉS del
build).
