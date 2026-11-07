# Bandeja de WhatsApp (`/whatsapp`) — plan del panel

Estado: **plan, sin código de UI**. Esperando el contrato congelado de `autolibre-backend-hex`
(sesión `wpp-chat`, 2026-11-06). Contrato tentativo y estados de UI: los dos mensajes de esa sesión.

## Lo que hay hoy en el panel (relevado 2026-11-06)

- **El navegador NUNCA habla con el backend.** Todo pasa por server functions (`src/fn/*`) que llaman
  a `src/server/backend.ts`, el único cliente HTTP, con `bearerToken()` = `auth().getToken()` de Clerk
  del lado del SERVIDOR. El backend no tiene CORS (`vehicle-manuals.md`).
- Despacho por WhatsApp: `src/components/PartnerDispatch.tsx`, `src/fn/partner-dispatch.ts`,
  `dispatchFetch` + modo `{ dispatch: true }` de `backendError`, zod en `src/lib/partner-dispatch.ts`.
  Es el molde a copiar (sentinela JSON con status/code, `BACKEND_UNREACHABLE`, timeout, `cache: no-store`).
- Datos: **no hay TanStack Query**. Loaders de TanStack Router + `router.invalidate()`. El único
  sondeo es `/conocimiento` (`setInterval` + `invalidate`, se apaga solo).
- Idempotencia del cliente ya resuelta 3 veces (`broadcastId`, `sendId`, `dispatchId`):
  `crypto.randomUUID()` en el handler, se conserva ante error, se regenera sólo tras éxito.
- `/chats` ya existe y son los chats de IA → la ruta nueva es `/whatsapp`, search params `whatsapp*`.

## Pantallas

- `whatsapp.tsx` — layout de dos columnas (lista | hilo). En mobile, una u otra.
- `whatsapp.index.tsx` — lista sola + "elegí una conversación".
- `whatsapp.$conversationId.tsx` — hilo (UUID en la URL, NUNCA el número). SSR `'data-only'`:
  primera página por loader, después todo vive en estado del cliente.
- Ítem de nav «WhatsApp» con badge de no leídas (si el backend lo da barato).

## Componentes

`InboxList` · `InboxRow` (título = partners o número, preview por `kind`, hora, badge, ventana) ·
`Thread` (separadores de día, scroll hacia arriba carga páginas viejas) · `MessageBubble` (por `kind`:
text / template resumido / button_reply / unsupported / purged; autor = `sentBy.name` o «AutoLibre
(automático)»; estado sending→sent→delivered→read | failed | unknown) · `Composer` (contador de
ventana, estados deshabilitados) · `WindowBanner` / `OptedOutBanner`.

## Datos y sondeo

- Server functions en `src/fn/whatsapp-inbox.ts`, todas `adminMiddleware`; cliente en `backend.ts`
  (`whatsappFetch`, modo de error propio `{ whatsapp: true }` → `WHATSAPP_INBOX_ERROR:` + JSON).
- **El mock vive en UN archivo**: `src/server/whatsapp-inbox.mock.ts`, elegido en el server function
  con `WHATSAPP_INBOX_MOCK=1` (sólo DEV). La UI siempre pasa por el borde real.
- Estado del cliente: `useReducer` con `Map<id, Message>` / `Map<id, Conversation>`. **Merge por id,
  el que llega reemplaza** (at-least-once). Orden por `(createdAt, id)`.
- Sondeo (no `router.invalidate`, que rehace el loader y pierde el merge):
  - lista `changes` cada 10 s; hilo abierto `messages/changes` cada 4 s;
  - pausa con `document.hidden`; al volver, un tick inmediato;
  - un solo request en vuelo por stream (`AbortController`), backoff 2× hasta 60 s ante error;
  - cursor `after` guardado en ref; si el backend lo da vencido → recarga completa.
- Fase 2: el «timbre» SSE sólo dispara el MISMO tick. El sondeo queda como red de seguridad (60 s).

## Envío optimista

1. Enviar → `clientMessageId = crypto.randomUUID()`, burbuja `sending` con ese id. Lock `inFlight`.
2. 201/200 → reemplazar la burbuja por el DTO del backend (match por `clientMessageId`).
3. Red caída / timeout / 503 → la burbuja queda «no se pudo confirmar» con «Reintentar» que reusa EL
   MISMO id y texto. Texto editado = id nuevo.
4. 422 OUTSIDE_SESSION_WINDOW / RECIPIENT_OPTED_OUT → burbuja `failed` con el motivo, composer pasa
   al estado deshabilitado correspondiente sin esperar al próximo tick.
5. `unknown` → nunca auto-reenvío; se dice «no sabemos si salió».

## Marca de leído

`PUT /read` con el `createdAt` (o id, ver pedidos) del mensaje más nuevo RENDERIZADO, debounce 1,5 s,
sólo con la pestaña visible y el hilo scrolleado al fondo. Nunca "now".

## PII

Número: sin `console.*`, sin search params (búsqueda por número → body POST o nada en fase 1), sin
analytics, y `backendError` del modo whatsapp no copia el mensaje del backend si puede traer el número.

## Contrato — CONGELADO el 2026-11-06

Los 14 pedidos del panel se aceptaron. Las formas exactas están en `src/lib/whatsapp-inbox.ts` (zod),
una por endpoint (1 lista · 2 cambios · 3 por partner · 4 hilo · 5 cambios del hilo · 6 leído ·
7 envío). Lo que más fácil se pisa:

- El envío manda **`body`**, no `text` (del lado del panel sigue siendo `text`; `backend.ts` traduce).
- La respuesta del envío es el **mensaje esparcido** + `outcome`/`failureReason`/`serverNow`, sin la
  conversación. `messages/changes` tampoco trae la conversación: la trae el feed de la lista.
- Las listas se llaman `items`; el cursor de inicio del sondeo, `changesAfter`; el del hilo camina
  hacia atrás y se llama `nextCursor`.
- 503 = `SERVICE_UNAVAILABLE`; 400 `INVALID_CURSOR` → recarga completa.
- Las filas de `GET /admin/quote-requests/:id/outreach` traen `whatsappConversationId` (en el panel,
  `.optional()` hasta que el backend despliegue): «Abrir conversación» en `PartnerDispatch`.

## Rate limit — resuelto el 2026-11-06

El backend limitaba a **60 req/min por IP**, global, y todos los admins salen por las IPs de Vercel.
Resolución del backend: `/api/v1/admin/*` pasa a ~**600/min por IP**; el resto sigue en 60. Sigue
siendo por IP y NO por usuario, a propósito: el limitador corre antes de verificar el token, así que
una clave por usuario sería falsificable. Del lado del panel no cambia nada: sondeo de la lista cada 10 s con un hilo abierto y cada 15 s sin hilo, el del
hilo sólo cuando el feed de la lista trae esa conversación, y backoff 2× hasta 60 s ante cualquier
error (429 incluido). Un 429 en el envío es reintentable con el mismo `clientMessageId`.

## Estado al 2026-11-06

Scaffold completo contra el mock (`src/mocks/whatsapp-inbox.ts`, elegido en `src/fn/whatsapp-inbox.ts`
con `import.meta.env.DEV && WHATSAPP_INBOX_MOCK !== '0'`). `tsc` limpio. **Sin verificar en el
navegador** (pide login de Clerk). Para pasar al backend real: borrar el mock y el `if` de
`useMock()`. Pendiente: el badge de no leídas en el nav y el link desde la ficha del partner
(`getWhatsAppConversationsByPartnerFn` ya existe).
