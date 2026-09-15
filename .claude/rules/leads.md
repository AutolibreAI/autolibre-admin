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
`src/components/QuoteRequestActions.tsx`.

Las escrituras del embudo de talleres (`ops.advance_lead`) NO están acá — su
regla es `.claude/rules/ops-write-actions.md`. Seguros, Multas, la LISTA de
Pedidos y las dos pestañas "todavía no" no escriben nada. La ficha de un pedido
sí (ver Pedidos, abajo).

## `/leads` es un layout, no una pantalla

`leads.tsx` sólo renderiza la barra de pestañas y un `<Outlet/>`. `leads.index.tsx`
redirige a `/leads/talleres`. Cada pestaña es un archivo con su propio `Route`,
su `validateSearch` y su modo de SSR.

Consecuencia práctica: un `Link to="/leads"` cae en el redirect (un salto de
más). Apuntá a `/leads/talleres` directo, como hace la tarjeta de Inicio.

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

Al 2026-09-14 **`to_regclass('public.quote_requests')` es `NULL` en producción**
(`autolibre` / `doadmin`) y la tabla existe en DEV con la migración 0093
aplicada. La pantalla se escribió contra la tabla real igual (build-now,
deploy-later), protegida por `quoteRequestsAvailability()`:

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

La lista sigue read-only. La ficha escribe (`QuoteRequestActions` +
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

## Cómo verificar un cambio acá

`pnpm typecheck` + `pnpm build` (el build regenera `routeTree.gen.ts`, así que
una pestaña nueva o un `Link` a una ruta nueva sólo se validan DESPUÉS del
build).
