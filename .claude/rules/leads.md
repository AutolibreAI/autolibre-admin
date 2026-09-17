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
(+ su `.test.sql`), `scripts/geocode-partners.mjs`. La card de Inicio/Métricas:
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

### `QuoteRequest` ≠ `Lead`

El aggregate es `QuoteRequest` (bounded context `quotes/`, tabla
`quote_requests`). Un `Lead` es el usuario yendo hacia UN taller que ya eligió;
un `QuoteRequest` es la persona pidiendo "¿cuánto sale esto?" y el operador
saliendo a buscar talleres. El código dice `QuoteRequest` / `quote-requests`,
nunca `Lead` (regla dura 7).

### Una sola tabla, sin presupuestos por taller

El MVP del backend **sacó** `quotes` y `quote_messages`. No hay una fila por
oferta ni por partner: lo que el operador consiguió vive en `proposals_count`
(obligatorio al pasar a `answered`) y en el texto libre de `internal_notes`. Si
alguien arma "ofertas" parseando las notas, está inventando dominio.

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

**El search param se llama `quoteRubro`**, calificado por dominio: `category`
ya lo usa `/partners/listado` (`string`) y `coverageRubros` lo usa
`/partners/cobertura` (`string[]`) bajo la misma clave semántica — un tercer
nombre genérico repetiría la colisión de `.claude/rules/notifications.md`.
Cambiar el chip de rubro sólo cambia qué se está MIRANDO (no persiste nada);
la precedencia es **el search param gana, si no está el default es el rubro
guardado** en `ops.quote_request_rubro`.

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

## Cómo verificar un cambio acá

`pnpm typecheck` + `pnpm build` (el build regenera `routeTree.gen.ts`, así que
una pestaña nueva o un `Link` a una ruta nueva sólo se validan DESPUÉS del
build).
