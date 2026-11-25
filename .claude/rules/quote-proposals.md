# Propuestas en la app (`/leads/pedidos/:id`, tarjeta «Propuestas en la app»)

Alcance: `src/lib/quote-proposals.ts`, `src/server/quote-proposals.repo.ts`,
`src/fn/quote-proposals.ts`, `src/components/QuoteProposals.tsx`, las funciones
`sendQuoteProposals` / `correctQuoteProposal` / `withdrawQuoteProposal` /
`closeQuoteProposalsSearch` y el modo `{ proposal: true }` de `backendError` en
`src/server/backend.ts`, `src/lib/amounts.ts` y `src/components/QuoteContentFields.tsx`
(compartidos con `QuoteResponses`), `PartnerOption.hasWhatsapp`, y las props
`hasAppSends` de `QuoteResponses` y `QuoteTemplates`. Agregada el 2026-10-26.

## Qué reemplaza

Nada que se corriera: hasta 0120–0122 del backend la persona no veía
presupuestos en la app — el operador se los mandaba por WhatsApp (plantilla
«Presupuestos»). Con esas migraciones el backend publica hasta **3 propuestas
activas** por pedido en `public.quote_request_proposals`, con push, y la persona
elige una desde la app. Esta tarjeta es la única forma de publicarlas: el
backend no tiene otra UI de admin, y el `curl` con token de Clerk copiado a mano
sería la alternativa.

**No es `ops.quote_request_response`, y conviven** — aunque desde el 2026-10-27 aquélla ya no
tiene tarjeta y el WhatsApp sale de acá (ver la sección de esa fecha, abajo). Aquélla era lo que
contestó cada taller; ésta es lo que se carga y se le PUBLICA a la persona. Un presupuesto de `ops`
**siembra** una propuesta si el operador lo tilda en «Precargar desde
presupuestos» (`responseToProposalDraft`), nunca se publica solo. → `leads.md`,
corrección del 2026-10-26.

## Lee por SQL, escribe por HTTP — cuarta excepción a la decisión 1

El `grep` dio positivo: `AdminQuoteRequestController` con `AdminGuard` en cada
handler. Mismo cliente (`~/server/backend`) y misma identidad (token de Clerk
del admin) que manuales, notificaciones y conocimiento.

| Acción | Endpoint | Respuesta |
|---|---|---|
| Enviar 1..freeSlots | `POST /admin/quote-requests/:id/proposal-sends` `{sendId, closesSearch, proposals}` | 201 con ids |
| Corregir | `PUT /admin/quote-request-proposals/:id` (reemplazo completo, **sin push**) | 200 |
| Retirar | `POST /admin/quote-request-proposals/:id/withdraw` (idempotente) | 204 |
| Cerrar búsqueda | `POST /admin/quote-requests/:id/close-search` `{closureId}` | 204 |

**No hay GET admin**: la lectura es SQL directo en `quote-proposals.repo.ts`.
Un 204 no tiene cuerpo: leerle JSON tira.

**Si aparece un `INSERT`/`UPDATE quote_request_proposals` en este repo, está
mal.** El backend arma el push, asigna los lugares 1..3, deduplica por `sendId`,
mueve el pedido a `answered` y reescribe `proposals_count`. Un SQL se saltearía
todo eso y la persona no se enteraría.

## El guard tiene su propia forma, y no es opcional

Producción tiene `quote_request_proposals` VIEJA (sin `send_id`, sin
`withdrawn_at`): un `to_regclass` solo diría "disponible" y la lectura daría un
500. `quoteProposalsAvailability()` exige la tabla
`quote_request_proposal_sends` **y** las 9 columnas nuevas de proposals **y** las
4 de `quote_requests` (`selected_proposal_id`, `selected_at`,
`proposals_search_closed_at`, `proposals_search_closure_id`).

- Sin eso: la tarjeta dice "falta desplegar 0120–0122", sin botones; la ficha y
  `/leads/pedidos` cargan igual. El loader trae `{ available: false }` también
  en la rama sin detalle.
- **Cada escritura re-chequea el guard en el handler, ANTES del fetch**
  (`QUOTE_PROPOSALS_UNAVAILABLE`): un POST directo contra producción no llega al
  backend.
- `READ_COLUMNS`/`SELECT_COLUMNS` de `quote-requests.repo.ts` **no** se tocaron:
  leer ahí una columna de 0122 rompería el guard de pedidos en producción.

Verificado el 2026-10-26 contra producción (`doadmin`, `:25060`): `has_sends =
false`, 0 y 0 columnas → no disponible, como corresponde.

## Errores: una sentinela propia, opt-in

`backendError(..., { proposal: true })` arma
`QUOTE_PROPOSAL_ERROR:<status>:<code>:<proposalIndex>:<partnerId>:<msg>` (el
mensaje va último porque puede tener `:`). No se reusó `detailed` (conocimiento):
aplana el 404 —que acá tiene TRES significados: pedido, propuesta, partner— y
pierde `proposalIndex`/`partnerId`, que el backend manda top-level. Cambiar
`detailed` habría roto conocimiento y fotos sin que `tsc` dijera nada (son
strings).

- **`proposalIndex` es 0-based.** La UI muestra `+1` y pinta el error en ESA
  propuesta del formulario, no arriba de todo.
- Un 404 con `Cannot POST …` es la ruta que no existe: backend sin 0120–0122.
- `BACKEND_UNREACHABLE:<url>` cuando el fetch ni llegó.
- `QUOTE_PROPOSALS_NO_FREE_SLOTS`: el handler re-lee las activas antes del
  fetch. El backend rechaza el exceso con un 400 **sin code**, indistinguible de
  otro error de validación.

## Idempotencia: `sendId` y `closureId` los genera el cliente

Mismo ciclo que `broadcastId` (`notifications.md`): se genera al ABRIR, en el
handler (nunca en SSR); se conserva ante un error, un cierre del Sheet o un doble
click; se regenera **sólo** después de un éxito. Un timeout puede haber guardado
el envío: reintentar con el mismo id devuelve lo guardado y no repite el push.
Contracara, que la UI dice tras un intento fallido: mismo id + contenido
editado **no** cambia lo que ya se guardó. `inFlight` (ref) corta el doble click
en el mismo tick.

## Validaciones: tres veces, igual que siempre

zod en `~/lib/quote-proposals` (el formulario lo corre con `safeParse` para
decir qué falta), el handler (el mismo schema) y el backend (el que vale). Las
que muerden: partner XOR taller de afuera (nombre ≤ 120 + **WhatsApp
obligatorio**); con ítems los montos NO viajan; precio pareado o ninguno ("a
confirmar"); vigencia ≥ hoy en UTC; **como mucho UNA recomendada y siempre con
motivo** — y el motivo NO viaja si no es recomendada (el backend lo rechaza).
Un opcional vacío no se manda nunca: el backend rechaza `''`.

Con una recomendada ACTIVA, el formulario no deja marcar otra (sería 409): hay
que corregir o retirar la primera.

`ops` admite textos más largos (nombre e ítem 200): la precarga **recorta y
avisa**, nunca en silencio. Un presupuesto vencido no se puede tildar y dice
«vencido el …». Un partner sin WhatsApp en su ficha (`hasWhatsapp`) se avisa en
ámbar: el backend lo va a rechazar con `QUOTE_PROPOSAL_PARTNER_WITHOUT_WHATSAPP`.

## `proposals_count` tiene DOS escritores

Antes de los envíos lo escribe `ops.mark_quote_request_answered` (011, «Marcar
respondido»). **Desde el primer envío lo escribe el backend** = cantidad de
propuestas activas, y retirar lo baja. Por eso, con `hasAppSends`:

- `QuoteResponses` NO muestra el aviso ámbar "`proposals_count` ≠ presupuestos
  cargados" (ya no es la misma cuenta) y dice por qué.
- `QuoteTemplates` avisa en ámbar en «Presupuestos» si el pedido tiene cuenta:
  la persona ya los vio en la app. Avisa, no bloquea.
- `QuoteRequestActions` y `QuoteBoard` **no se tocaron**: todo envío deja el
  pedido en `answered`, y «Marcar respondido» sólo existe en `contacted`. Un
  bloqueo del tablero nunca se cumpliría.

## Cerrar búsqueda ≠ cerrar el pedido

«Cerrar búsqueda» le dice a la persona "no mandamos más propuestas". El pedido
**no** pasa a `closed`: el rótulo nunca dice «Cerrar pedido» y la confirmación lo
aclara. Con **0 activas y cuenta**, el backend le manda un push de que no
conseguimos talleres — la confirmación lo dice ANTES. Sin cuenta, dice que no hay
a quién notificar. `closureId` sigue el mismo ciclo que `sendId`.

`user_outcome = 'pending'` (eligiendo, sin elegir todavía) se muestra **«Sin
elegir»**, nunca crudo.

## ⚠ Orden de deploy en producción

`quote_request_proposals` existe en producción con la forma vieja. **La 0120 del
backend agrega columnas NOT NULL (`send_id`, `position`) y falla si la tabla
tiene filas.** Al 2026-10-26 tiene 0, pero no hay nada que lo impida: antes del
deploy del backend, `select count(*) from quote_request_proposals` en producción
tiene que dar 0. Si no, la migración del backend aborta y este panel sigue
mostrando "falta desplegar" — sin que nada del panel esté roto.

Orden: backend (0120–0122) primero; el panel puede ir antes o después, el guard
lo cubre.

## Desde el 2026-10-27: es el ÚNICO lugar de carga, y arma el WhatsApp

Pedido del operador: un solo lugar para cargar lo que consiguió, llegue el pedido por la app, la web o
WhatsApp. Tres cambios, y no se vuelven atrás sin decidirlo de nuevo:

1. **La tarjeta de Presupuestos (`ops.quote_request_response`) se sacó de la ficha** y
   `QuoteResponses.tsx` se borró. La tabla, la 015/022, el repo y los server functions de escritura
   siguen en el repo (sin pantalla): lo cargado antes se lee para **«Precargar desde presupuestos
   anteriores»** en el Sheet, y nada más. Si aparece una pantalla nueva que escriba esa tabla, está mal.
2. **El mensaje «Presupuestos» sale de las propuestas ACTIVAS** (`proposalToMessageEntry` →
   `QuoteMessageEntry` en `~/lib/quote-templates`, el único traductor). Las mismas que ve la persona
   en la app, en el orden de sus lugares. Por eso `listQuoteProposals` resuelve dirección, WhatsApp,
   horarios y slug del partner igual que `quote-responses.repo.ts` (con el guard de `partner_slugs`):
   el mensaje tiene que decir lo mismo que decía. La recomendada suma `⭐ Te lo recomendamos: <motivo>`
   con el motivo que la persona ya lee en la app; las notas internas no viajan. Una vencida no entra.
3. **Se carga sin cuenta también.** El backend guarda las propuestas de un pedido sin `user_id`; no
   le llegan a ninguna app y viajan por el WhatsApp. La UI lo dice: «Cargar propuesta» (no «Enviar»),
   y la descripción del Sheet cambia según haya cuenta.

Con eso, arriba de la ficha va `ChannelBanner`: «Entró por WhatsApp/Web/App», bien grande, y una
segunda línea que decide por **cuenta**, no por canal — un pedido `app` por el endpoint público no
tiene `user_id`, y a ése tampoco le llega nada a la app.

La columna «Propuestas» de `/leads/pedidos` y el «N propuestas» del tablero cuentan las activas de
`quote_request_proposals` (con `quoteProposalsAvailability`, no `to_regclass`); el campo sigue
llamándose `responseCount` y el sort `responses`, por compatibilidad de links.

**Lo que quedó leyendo la tabla vieja**: la sección Pedidos de `/metricas` (2b propuestas por pedido,
2d red vs afuera) sale de `ops.quote_request_response` (`metricas.md`), así que desde esta fecha deja de
crecer. Pasarla a `quote_request_proposals` es trabajo aparte.

## Completar el flujo de la persona en su nombre (2026-11-25, rama `feat/quotes-operator-completes-user-flow`)

El equipo llama a la persona y carga desde la ficha los dos pasos que dejó sin hacer en la app.
Alcance: `src/lib/quote-user-flow.ts` (reglas, payloads, errores — testeado en
`tests/quote-user-flow.test.ts`), `src/server/quote-user-flow.repo.ts`, `src/fn/quote-user-flow.ts`,
`src/components/QuoteUserFlow.tsx`, el modo `{ quoteUserFlow: true }` de `backendError`.

- **Elegir**: «Marcar como elegida por el usuario» en cada propuesta activa no elegida →
  `PUT /admin/quote-requests/:id/selected-proposal` `{proposalId}`. Sin cerrar (con cuenta o sin ella
  desde el 2026-11-25).
- **Declarar si fue**: tarjeta «¿Fue al taller?» → `POST /admin/quote-requests/:id/user-outcome`
  `{outcome, performedOn?}`. Fue / No fue / Todavía no; con «Fue», la fecha real es obligatoria
  (min = día del pedido, max = hoy, en hora de Buenos Aires). Con `answered_at` y no
  cancelado por la persona (con cuenta o sin ella desde el 2026-11-25) — **sí** con el pedido cerrado por el operador.
- **Reseñar en su nombre: NUNCA.** No hay ni va a haber acción para eso.
- ~~**Sin cuenta: ninguna acción.**~~ **Desde el 2026-11-25 sí, con las mismas reglas** (ver la
  sección siguiente). Un taller que no estaba entre las propuestas va en nota interna, no se modela.
- **Procedencia**: «Cargado por el equipo (admin, fecha)» vs «Declarado por la persona en la app»,
  junto a la elegida, al resultado (estado y tarjeta) y en el recorrido. Columnas del backend
  **con nombres tentativos**, centralizados en `QUOTE_USER_FLOW_COLUMNS` del repo: si cambian, se
  cambia ese objeto. Sin ellas en la base (guard por `information_schema`, mismo patrón que
  `quoteProposalsAvailability`) la ficha anda y dice «falta la migración del backend». Una fila con
  dato y sin fuente es anterior a la migración: se lee como la persona (era el único camino).
- **Listado**: chip «Flujo incompleto» en `/leads/pedidos` (Atención) — mismo corte que
  `hasIncompleteUserFlow`; prenderlo pasa el estado a «Todos».
- Relación con `QuoteClosureCard` / `/leads/pedidos/cierres` (b2c5e45, mocks): aquel diseña un cierre
  más rico (con quién, monto, disputa). Esto no lo conecta ni lo borra: carga los dos datos que ya
  existen, que son los que esa tarjeta lee como «lo real».

## Sin cuenta también, y la tabla «Resolución de pedidos» (2026-11-25, rama `feat/quotes-resolution-without-account`)

### Las dos acciones, con cuenta o sin ella

El backend dejó de devolver 404 para un pedido sin cuenta (`user_id` NULL: web pública y WhatsApp):
mismos endpoints, mismos bodies, mismas reglas. **404 `NOT_FOUND` = sólo pedido inexistente.** En
el panel:

- `canSelectProposalOnBehalf` = pedido no cerrado; `canDeclareOutcomeOnBehalf` = con `answered_at` y
  no cancelado por la persona. **Ninguna mira `userId`**: el operador no tiene que notar diferencia.
- «Flujo incompleto» (`hasIncompleteUserFlow` y el `where` de `listQuoteRequests`) incluye los sin
  cuenta. El chip dice «respondido, sin decir si fue».
- **Procedencia**: `provenanceSource(source, hasAccount)`. Sin cuenta es SIEMPRE el equipo — «Declarado
  por la persona en la app» no puede aparecer ahí, ni siquiera con un dato anterior a la 0169 sin
  fuente (con cuenta, ese caso sigue leyéndose como la app). Sin fuente ni autor dice «Cargado por el
  equipo», sin nombre. Lo mismo en el recorrido de la ficha y en `QuoteClosureCard`, que pasó a decir
  «Resultado (usuario)» en vez de «Lo que declaró en la app».
- Los textos que hablan de la app (la confirmación de «Marcar como elegida», la explicación de «¿Fue
  al taller?») cambian según haya cuenta. Lo que el backend NO hace sin cuenta (registro de service,
  reseñas) no se muestra ni se explica: es del backend.

### `/leads/pedidos/resolucion` — «Resolución de pedidos»

Alcance: `src/lib/quote-resolution.ts` (schema `res*`, tipos, `quoteResolutionCsv`),
`src/server/quote-resolution.repo.ts`, `src/fn/quote-resolution.ts`,
`src/routes/_authed/leads.pedidos.resolucion.tsx`, `src/lib/csv.ts` (`tests/csv.test.ts`) y
`userOutcomeReporter`/`userOutcomeReporterLabel` en `~/lib/quote-user-flow` (testeados). Link
«Resolución» en el header de `/leads/pedidos`, al lado de «Cierres y disputas».

Una fila por pedido, todos los canales, con y sin cuenta. Sólo lectura: las acciones siguen en la
ficha (link en el código `AL-n`).

- **Dos resultados, dos columnas**: «según el cliente» (`user_outcome`) y «según el equipo»
  (`outcome`, lo escribe `ops.close_quote_request`). Decisión del usuario: separados; si se
  unifican, se decide aparte.
- **UNA sentencia** (`listQuoteResolution`): lo que no es columna de `quote_requests` va como
  subconsulta escalar o `LEFT JOIN` 1:1 (propuesta elegida → partner; admin que declaró). Filtros en
  el `where` de AFUERA, como `listQuoteRequests`. `limit + 1` para saber si hay más.
- **Guards por pieza**: propuestas (`quoteProposalsAvailability`), 0169
  (`quoteUserFlowProvenanceAvailable`, nombres de `QUOTE_USER_FLOW_COLUMNS`), servicios del operador
  (0155), rubros de `ops` y servicios de IA (0124). Lo que falta sale `NULL` y la pantalla lo dice en
  ámbar; nunca un 500.
- **Contacto**: con cuenta, nombre y teléfono de `users` (si la cuenta no los tiene, los del pedido);
  sin cuenta, `contact_name`/`contact_phone` del pedido.
- **Rubro / servicio**: servicios del operador (0155) → rubros del operador (`ops.quote_request_rubro`)
  → servicios de la IA con score ≥ `AI_SERVICE_LOW_SCORE`. Operador antes que IA, como la ficha; la
  fuente va debajo.
- **Quién informó**: `userOutcomeReporter` — sin cuenta, el equipo; con cuenta sin la 0169, «no se
  sabe»; con cuenta, la columna (null = la app, anterior a la 0169).
- **Filtros** (prefijo `res`, para no chocar con los `sort`/`quoteChannel` de `/leads/pedidos`):
  canal, resultado del cliente (+ «No declaró»), del equipo (+ «Sin registrar»), taller elegido
  (todos / sin taller / de afuera / un partner — las opciones salen de la base entera, no de lo
  filtrado), rango de fecha del pedido en hora de Buenos Aires, «Flujo incompleto» (mismo corte) y
  duplicados/prueba fuera por default.
- **Sin paginación**, como `/leads/pedidos`: 500 en pantalla y el subtítulo avisa si hay más.
- **CSV**: el primer export del panel. `exportQuoteResolutionFn` trae lo filtrado ENTERO (tope 5000) y
  el navegador lo arma con `quoteResolutionCsv` → `toCsv`: separador `;` y BOM (Excel es-AR), fórmulas
  neutralizadas (`'` delante de `= + - @`), mismos rótulos que la tabla, fechas en Buenos Aires y el
  link a la ficha.

Verificado el 2026-11-25: `pnpm test` y `pnpm typecheck` en verde; la sentencia completa (todas las
piezas en `true`, con filtros) y la de opciones de taller **planifican** (`EXPLAIN`) contra la base
local con la 0169. Leer filas no se pudo (permisos): falta mirarla con datos.

## Motivo y observación de «No fue» (2026-11-25, rama `feat/quotes-not-hired-reason`)

Al declarar «No fue» en la tarjeta «¿Fue al taller?», el operador puede cargar **por qué** y una
**observación**. Sólo panel: la app no cambia, y declarar NO cierra el pedido.

- **Los dos OPCIONALES**, incluso con «Otro» (decisión del usuario). El select arranca en «Sin
  motivo»; la observación tiene tope de 1000 caracteres (recortada) con contador.
- **Contrato**: `POST /admin/quote-requests/:id/user-outcome` suma `notHiredReason` (enum
  `quote_request_not_hired_reason`: `no_budget` · `no_time` · `did_it_themselves` ·
  `hired_outside_network` · `no_longer_needed` · `took_too_long` · `other`, rótulos en
  `QUOTE_NOT_HIRED_REASON_LABELS`) y `notHiredNote`. Con otro resultado, un valor no nulo es 400:
  el zod (`declareQuoteUserOutcomeOnBehalfSchema`) lo rechaza antes y `declareOutcomeBody` no los
  manda nunca fuera de «No fue».
- **Con «No fue» viajan SIEMPRE los dos** (`null` = sin motivo / sin observación): corregir una
  declaración y dejarlo vacío BORRA lo anterior. Por eso «Corregir lo que declaró» precarga el motivo
  y la observación vigentes al volver a elegir «No fue». Cambiar a Fue/Todavía no los limpia.
- **El enum vive en `~/lib/quote-user-flow`**, no en `~/lib/quote-requests` al lado de
  `QUOTE_REQUEST_CANCELLATION_REASONS` (que es el patrón que sigue): ese archivo lo prueba
  `node --test` y no puede importar de `~/`. Un valor que el panel no conoce se muestra crudo
  (`quoteNotHiredReasonLabel`).
- **Columnas con nombres TENTATIVOS** en `QUOTE_USER_FLOW_COLUMNS`: `user_outcome_not_hired_reason`
  y `user_outcome_not_hired_note`. **Guard propio**, separado del de la procedencia (0169):
  `quoteUserFlowColumnsAvailability()` devuelve `{ provenance, notHired }` en UNA consulta a
  `information_schema`, y `quoteUserFlowProvenanceAvailable()` sigue mirando sólo las 5 de la 0169.
  Meterlas en el mismo guard habría apagado la procedencia en toda base sin la migración nueva.
- **Sin esa migración**: el formulario no ofrece motivo ni observación y **no manda las claves**
  (un backend viejo podría rechazarlas); la ficha no muestra nada; la tabla de resolución dice en
  ámbar que falta, sin columnas con dato ni filtro. Nunca un 500. La disponibilidad de las columnas
  es el proxy de «el backend ya acepta los campos»: migran en el pre-deploy del mismo despliegue.
  Con la 0169 ausente tampoco se ofrecen (el motivo viaja dentro de la procedencia).
- **Ficha**: `QuoteNotHiredDetailLine` debajo del resultado y de su procedencia, en la tarjeta y en
  «Resultado (usuario)»; el recorrido suma « · motivo: …». Sólo con `user_outcome = 'not_hired'`.
- **`/leads/pedidos/resolucion`**: columnas «Motivo (no fue)» y «Observación» (también en el CSV,
  después de «Resultado según el equipo»), y el filtro `resNotHiredReason` — Todos / «Sin motivo» /
  cada motivo. **Cualquier opción distinta de Todos acota a `user_outcome = 'not_hired'`**: «Sin
  motivo» es «no fue y no se cargó motivo», no «todo pedido sin motivo».

## Cómo verificar un cambio acá

`pnpm typecheck`. El recorrido real (enviar, precargar, corregir, retirar,
cerrar búsqueda, reintentar con el mismo `sendId`, cada code en su fila) necesita
el backend `feat/quote-proposals` levantado (`npm run start:dev`) contra DEV con
0120–0122, y verificar por SQL lo que quedó. Contra producción: la tarjeta
explica, las escrituras devuelven la sentinela sin fetch.
