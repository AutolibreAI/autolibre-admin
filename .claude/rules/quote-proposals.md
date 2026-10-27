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

## Cómo verificar un cambio acá

`pnpm typecheck`. El recorrido real (enviar, precargar, corregir, retirar,
cerrar búsqueda, reintentar con el mismo `sendId`, cada code en su fila) necesita
el backend `feat/quote-proposals` levantado (`npm run start:dev`) contra DEV con
0120–0122, y verificar por SQL lo que quedó. Contra producción: la tarjeta
explica, las escrituras devuelven la sentinela sin fetch.
