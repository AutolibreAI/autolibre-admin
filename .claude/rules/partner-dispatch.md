# Despacho por WhatsApp (`/leads/pedidos/:id`, tarjeta «Despacho por WhatsApp»)

Alcance: `src/lib/partner-dispatch.ts`, `src/fn/partner-dispatch.ts`,
`src/server/partner-dispatch.repo.ts` (sólo el guard), `src/components/PartnerDispatch.tsx`, las
funciones `getPartnerDispatchDraft` / `approvePartnerDispatch` / `listQuoteRequestOutreach` y el modo
`{ dispatch: true }` de `backendError` en `src/server/backend.ts`, y el loader de
`src/routes/_authed/leads.pedidos.$quoteRequestId.tsx`. Agregada el 2026-11-04.

## Qué reemplaza

El "le escribo a tres talleres por WhatsApp a mano" que el operador hace desde «Talleres candidatos»
(`PartnerCandidates`, botón «Pedir cotización»). Con la 0142 del backend (`partner_outreach`) el
BACKEND manda un template de WhatsApp aprobado por Meta a hasta 3 talleres, sin datos de la persona,
y al que acepta le manda los detalles. Esta tarjeta muestra el borrador, lo aprueba y sigue cada
contacto.

**`PartnerCandidates` queda, a propósito.** La derivación manual sigue siendo el camino cuando el
despacho está apagado (el default) o el pedido no está listo. No se fusionan: uno elige a mano entre
todos los partners del rubro, el otro aprueba lo que el backend calculó.

## Lee y escribe por HTTP — sexta excepción a la decisión 1

El grep dio positivo: `AdminPartnerOutreachController` (`src/quotes/partner-outreach/presentation/`)
y `AdminQuoteRequestOutreachController` (`src/query/get-quote-request-outreach/`), `AdminGuard` en
cada handler. Mismo cliente (`~/server/backend`) e identidad (token de Clerk del admin) que manuales,
notificaciones, conocimiento, propuestas y logo.

| Acción | Endpoint | Respuesta |
|---|---|---|
| Borrador | `GET /admin/quote-requests/:id/dispatch-draft` | 200, cálculo puro, no guarda nada |
| Aprobar | `POST /admin/quote-requests/:id/dispatches` `{dispatchId, partnerIds[1..3], descriptionReviewed: true}` | 202 `{dispatchId, outreach[]}`, asincrónico |
| Seguimiento | `GET /admin/quote-requests/:id/outreach` | 200, array en orden de aprobación (`[]` si nunca) |

**Ni una escritura SQL a `partner_outreach`**, y tampoco una lectura: el único SQL es el guard
(`to_regclass('public.partner_outreach')`), que corta con "falta desplegar la migración 0142" sin
hacer fetch. Un `INSERT` no le mandaría un WhatsApp a nadie.

El borrador **nunca trae km, coordenadas ni el WhatsApp** del taller: sólo `distanceBucket`. No los
derives de otro lado para "completar" la tarjeta.

Aprobar **no cambia el estado del pedido** (sigue en el que estaba): no toca `QuoteRequestActions`
ni `QuoteBoard`.

## El server function de lectura nunca tira

`getPartnerDispatchFn` pide borrador y seguimiento en paralelo y devuelve cada uno como
`{ ok: true, data } | { ok: false, error }`. Uno puede fallar (backend sin la ruta, 5xx) sin
llevarse al otro, y la ficha nunca da 500 por esta tarjeta. Sin la 0142 en la base: `{ available:
false }`. Las respuestas 2xx se validan con zod; una forma desconocida es
`PARTNER_DISPATCH_BAD_RESPONSE`, nunca un crash.

Los enums ampliables (motivos, estados, entrega, falla, tipo de mensaje) se aceptan como `string` y
se muestran CRUDOS si el espejo de `~/lib/partner-dispatch` no los conoce.

## Errores: modo `{ dispatch: true }`, y por qué lee el `code` ANTES del 403

`backendError` corta 401/403 en `BACKEND_UNAUTHENTICATED`/`BACKEND_FORBIDDEN` antes de mirar el
cuerpo. Acá eso estaría mal: el **kill switch** (`PARTNER_DISPATCH_ENABLED`, apagado por default)
contesta **403 `FEATURE_DISABLED`**, y aplanarlo diría "no sos admin". El modo `dispatch` va antes
de ese corte y arma `PARTNER_DISPATCH_ERROR:` + JSON `{status, code, reasons, partnerIds, freeSlots,
message}` (JSON porque hay listas; los `details` del backend vienen top-level). Lo lee
`parsePartnerDispatchError`. Los otros modos no se tocaron: otras pantallas parsean sus strings.

| Code | Qué dice la UI |
|---|---|
| `FEATURE_DISABLED` (403) | **neutro, no rojo**: "El despacho automático está desactivado en el backend". Sólo afecta al POST |
| `FORBIDDEN` (403) | tu usuario no es admin para el backend |
| `INVALID_STATE_TRANSITION` (400) | el pedido está cerrado |
| `DISPATCH_NOT_READY` (400) + `reasons` | qué falta, con las etiquetas de readiness |
| `PARTNER_NOT_ELIGIBLE` (400) + `partnerIds` | borrador viejo: se marcan esos candidatos y se pide «Actualizar» |
| `NO_FREE_SLOTS` (409) + `freeSlots` | otra aprobación tomó los lugares |
| `DISPATCH_ID_CONFLICT` (409) | ese id ya se usó con otros talleres |
| `NOT_FOUND` (404) | el pedido no existe |
| 404 sin code, «Cannot GET/POST» | el backend desplegado no tiene el despacho (0142) |
| 400 sin code (ValidationPipe) | el mensaje del backend, citado |

## `dispatchId`: lo genera el CLIENTE

Mismo ciclo que `sendId` (`quote-proposals.md`): se genera al abrir la confirmación (en el handler,
nunca en SSR), se conserva ante un error o un doble click (`inFlight` ref), y se regenera SÓLO
después de un éxito. Mismo id + mismos partners = 202 otra vez, sin duplicar. **Si después de un
fallo cambió la selección, se genera un id nuevo**: el mismo id con otros talleres sería
`DISPATCH_ID_CONFLICT`. La UI lo dice después de un intento fallido.

El aviso de éxito/error vive en el componente de arriba (montado con `key` por pedido), no en la
sección del borrador: la sección se remonta cuando cambia el borrador (firma = readiness + lugares +
candidatos), y el aviso tiene que sobrevivir a `router.invalidate()` — misma lección que
`QuoteRequestActions`.

## Readiness

`ready` · **`needs_info`** · `rejected`. Ojo: el mensaje que acompañó el cambio del backend decía
`not_ready`; el código (`partner-dispatch-draft-response.dto.ts`) dice `needs_info`, y manda el
código. `needs_info` se pinta ámbar con pistas de qué arreglar en esta misma ficha («Editar datos»,
«Corregir ubicación» / «Geocodificar», clasificar rubros); `rejected` (p. ej. `request_closed`) gris.

**Radio: 5 km**, no 10 — `quotes.md` del backend dice 10 y quedó viejo; el controller dice "a 5 km o
menos".

## `descriptionReviewed`

El backend exige `true`. La UI lo pide con una casilla obligatoria ("Revisé la descripción que va a
recibir el taller") al lado del texto exacto (`detailsPreview`), y con `piiWarning` muestra en ámbar
qué se ocultó. El server function siempre manda `true`: sólo llega ahí si la casilla estaba tildada.

## Lo que el backend todavía no hace — por eso no hay sondeo

Al 2026-11-04 el backend no recibe las respuestas de los talleres (webhook entrante), no corre el
cron de vencimiento ni procesa la BAJA. El seguimiento cambia poco y no hay refresco automático: un
botón «Actualizar» (`router.invalidate()`) y una nota que lo dice. Cuando lleguen las respuestas, se
evalúa un sondeo como el de `/conocimiento`.

## Cómo verificar un cambio acá

`pnpm typecheck`. El recorrido real (borrador, aprobar, 202, reintentar con el mismo id, cada code)
necesita el backend con la 0142 y `PARTNER_DISPATCH_ENABLED=true`. Contra una base sin la 0142 la
tarjeta dice "falta desplegar" sin fetch; con el kill switch apagado, aprobar da el aviso neutro.
