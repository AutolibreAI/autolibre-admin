# Despacho por WhatsApp (`/leads/pedidos/:id`, tarjeta «Despacho por WhatsApp»)

Alcance: `src/lib/partner-dispatch.ts`, `src/fn/partner-dispatch.ts`,
`src/server/partner-dispatch.repo.ts` (sólo el guard), `src/components/PartnerDispatch.tsx`, las
funciones `getPartnerDispatchDraft` / `approvePartnerDispatch` / `listQuoteRequestOutreach` y el modo
`{ dispatch: true }` de `backendError` en `src/server/backend.ts`, y el loader de
`src/routes/_authed/leads.pedidos.$quoteRequestId.tsx`. Agregada el 2026-11-04. Desde el 2026-11-19
también la corrección de servicios («Guardar clasificación»): `src/lib/quote-services.ts`,
`src/fn/quote-services.ts`, `correctQuoteRequestServices` y el modo `{ quoteServices: true }` de
`backendError`.

## Qué reemplaza

El "le escribo a tres talleres por WhatsApp a mano" que el operador hace desde «Talleres candidatos»
(`PartnerCandidates`, botón «Pedir cotización»). Con la 0142 del backend (`partner_outreach`) el
BACKEND manda un template de WhatsApp aprobado por Meta a hasta 10 talleres (0156; antes 3), sin datos de la persona,
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
| Aprobar | `POST /admin/quote-requests/:id/dispatches` `{dispatchId, partnerIds[1..10], descriptionReviewed: true}` | 202 `{dispatchId, outreach[]}`, asincrónico |
| Seguimiento | `GET /admin/quote-requests/:id/outreach` | 200, array en orden de aprobación (`[]` si nunca) |
| Corregir servicios | `PUT /admin/quote-requests/:id/services` `{serviceSlugs[1..]}` | 204 sin cuerpo (también si no cambió) |

**Ni una escritura SQL a `partner_outreach`**, y tampoco una lectura: el único SQL es el guard
(`to_regclass('public.partner_outreach')`), que corta con "falta desplegar la migración 0142" sin
hacer fetch. Un `INSERT` no le mandaría un WhatsApp a nadie.

El borrador **nunca trae coordenadas ni el WhatsApp** del taller. **El km exacto sí, desde el
2026-11-19** (decisión del usuario): `distanceKm` (float sin redondear, `null` = taller sin ubicación)
en `candidates[]`, `otherPartners[]` y `excluded[]`, y `distanceBucket` sigue. Se muestra con dos
decimales en es-AR («2,37 km», `formatDispatchDistance`); sin el campo (backend anterior) cae a la
etiqueta del bucket. **Es sólo para el admin**: al taller nunca le llega la distancia, ni en el template
ni en los detalles. Las coordenadas siguen sin derivarse de ningún lado.

## Sugeridos, otros talleres, búsqueda y descartes (2026-11-19)

- **`candidates`** («Sugeridos»): activos a ≤ 5 km que cubren algún rubro pedido, en el orden del
  backend. **`otherPartners`** («Otros talleres», misma forma): TODOS los demás activos despachables
  (fuera de radio, sin el rubro o sin ubicación), por distancia y los sin ubicación al final. Se eligen
  igual; el `POST` acepta cualquiera de las dos listas. `no_candidates` sólo aparece si las dos están
  vacías. El schema es tolerante: `otherPartners` `.default([])` y `distanceKm` `.optional()`, para
  seguir andando contra un backend sin el cambio.
- **Selección por default**: como mucho los 3 primeros sugeridos (`DEFAULT_PRESELECTED_DISPATCH`),
  aunque haya 10 lugares — tildar todo mandaría 10 WhatsApp con un click distraído. El tope de la
  selección es `min(freeSlots, MAX_DISPATCH_SLOTS = 10)`. `partnerIds` viaja en orden: sugeridos y
  después otros.
- **Búsqueda** por nombre (sin tildes ni mayúsculas, por contención: `normalizeForSearch`) sobre las
  dos listas. Buscando, también aparecen en gris los `excluded` que coinciden, con su motivo y sin
  casilla: así el operador entiende por qué alguien no se puede elegir.
- **«Descartar»** esconde un taller y lo saca de la selección. **Es estado del CLIENTE**: sin
  persistir, sin motivo, sin escribirle nada al backend. Vuelve al recargar o con «Actualizar» de la
  tarjeta (`refreshNonce` remonta la sección). «Mostrar descartados (n)» permite restaurar uno o todos
  dentro de la sesión. Lógica pura y testeada en `~/lib/partner-dispatch` (`discardReducer`,
  `dispatchRows`).

## «Guardar clasificación» corrige los SERVICIOS en el backend (2026-11-19)

Antes, «Guardar clasificación» de `PartnerCandidates` escribía FAMILIAS en
`ops.set_quote_request_rubros` (016), y **el backend nunca leyó esa tabla**: corregir no cambiaba ni
los candidatos del despacho ni el `{{2}}` del template. Ahora manda los **servicios** elegidos (el
multiselect «Servicios del pedido», acotado por los rubros) a `PUT /admin/quote-requests/:id/services`
(0155). Mientras exista, esa corrección **manda** sobre la clasificación de la IA, sin primario: es
candidato quien cubra al menos uno, y el orden de la lista es el orden en que se le nombran al taller.
Después del 204, `router.invalidate()` y el borrador se recalcula.

- **La 016 se sigue escribiendo, como espejo**: las familias DERIVADAS de los servicios
  (`familiesOfServices`). La leen la ficha (los rubros con los que se buscan candidatos) y
  `/partners/estudio` (`listQuoteRequestRubros`). Orden: backend primero; si el espejo falla, la
  corrección ya vale para el despacho y la UI avisa (`legacySynced: false`), sin tirar.
- **Lo guardado se lee de `quote_request_operator_services`** (`operatorServiceSlugs` del detalle,
  guard `to_regclass`, `null` sin la 0155). Arrancan tildados esos servicios; si no hay, los de la IA.
- Errores (`QUOTE_SERVICES_ERROR` + JSON, `readableQuoteServicesError`): 400 `VALIDATION_ERROR` con
  `serviceSlugs` (no están en el catálogo activo), 400 `INVALID_STATE_TRANSITION` (pedido cerrado),
  404 / 404 «Cannot PUT» (backend sin el endpoint), 409 (reintentar), timeout (reintentar: idempotente).

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
código. `needs_info` se pinta ámbar con pistas de qué arreglar en esta misma ficha («Identificar
vehículo», «Editar datos», «Corregir ubicación» / «Geocodificar», clasificar rubros); `rejected` (p. ej.
`request_closed`) gris.

**`missing_vehicle_catalog` se arregla con «Identificar vehículo»** (2026-11-09, tarjeta Vehículo,
`QuotePlateIdentifier` + `~/lib/quote-plate`): `PUT /admin/quote-requests/:id/plate` guarda la patente
y el backend resuelve `quote_requests.vehicle_catalog_id` con el proveedor de patentes. Sincrónico
(hasta ~10 s, timeout propio de 30 s). Respuesta `resolved` / `searching` (reintentar con la misma
patente en minutos) / `not_found` / `insufficient_data` (el modelo va a mano: **todavía no hay
selector**, aunque el backend tiene `PUT …/vehicle-catalog`). Se ofrece sólo abierto y SIN modelo:
el vehículo de un pedido no cambia (con modelo, 400 `INVALID_STATE_TRANSITION`). Ojo:
`ops.update_quote_request` también escribe `plate` sin conocer esa regla.

**Desde el 2026-11-12 el vehículo escrito también lo destraba.** La 0160 del backend suma
`quote_requests.vehicle_description` y el despacho la usa como label cuando no hay
`vehicle_catalog_id`: `missing_vehicle_catalog` (el reason conserva el nombre) salta sólo si no hay
catálogo NI descripción. «Editar datos» la escribe por SQL desde la migración 032 (antes iba a
`ops.quote_request_vehicle_text`, que el backend nunca leía). La pista dice «completá uno de los dos».

**Radio: 5 km**, no 10 — `quotes.md` del backend dice 10 y quedó viejo; el controller dice "a 5 km o
menos".

## `descriptionReviewed`

El backend exige `true`. La UI lo pide con una casilla obligatoria ("Revisé la descripción que va a
recibir el taller") al lado del texto exacto (`detailsPreview`), y con `piiWarning` muestra en ámbar
qué se ocultó. El server function siempre manda `true`: sólo llega ahí si la casilla estaba tildada.

## Respuestas, vencimiento y BAJA: ya existen en el backend — y todavía no hay sondeo

Al 2026-11-04 el backend no recibía las respuestas de los talleres. **Hoy sí** (ver `contexts/quotes.md`
del backend): el webhook entrante procesa el «Sí» / «No» del botón (y manda los detalles al que
acepta), un cron cada 15 min vence los `template_sent` sin respuesta (24 h hábiles) y reencola los
`approved` trabados, y la BAJA da de baja el WhatsApp del taller y cancela sus contactos abiertos.
La tarjeta **sigue sin sondear**: «Actualizar» (`router.invalidate()`) y una nota que lo dice. Un
sondeo como el de `/conocimiento` queda pendiente.

## Cómo verificar un cambio acá

`pnpm typecheck`. El recorrido real (borrador, aprobar, 202, reintentar con el mismo id, cada code)
necesita el backend con la 0142 y `PARTNER_DISPATCH_ENABLED=true`. Contra una base sin la 0142 la
tarjeta dice "falta desplegar" sin fetch; con el kill switch apagado, aprobar da el aviso neutro.
