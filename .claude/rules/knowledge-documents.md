# Conocimiento (`/conocimiento`) — documentos públicos del RAG

Alcance: `src/lib/knowledge-documents.ts`, `src/server/knowledge-documents.repo.ts`,
`src/fn/knowledge-documents.ts`, `src/components/KnowledgeDocumentUploader.tsx`,
`src/routes/_authed/conocimiento.tsx`, y `uploadMarkdownKnowledgeDocument` en
`src/server/backend.ts`.

## Qué reemplaza

Dos cosas que se hacían a mano, y una tercera que nadie hacía:

1. El **`curl`** a `POST /knowledge-documents/markdown` con `-F file=@guia.md -F title=… -F
   relevance=global` y un token de Clerk copiado de la consola del navegador.
2. El **`select id, title, status, failure_reason from knowledge_documents`** en DBeaver para
   saber si la ingesta terminó, falló o seguía pendiente — el alta contesta `pending` y nada más.
3. Desde la 0102 del backend (versiones): **seguir `supersedes_document_id` a mano** para saber
   cuál de las N filas con el mismo título es la que el asistente usa HOY.

## Lee por SQL, escribe por HTTP

Es la tercera pantalla que escribe por HTTP contra el backend hex (después de los manuales y las
notificaciones ad-hoc), con el mismo cliente (`src/server/backend.ts`) y la misma identidad (el
token de Clerk del admin logueado).

El grep da **positivo**: `POST /knowledge-documents/markdown` existe en
`knowledge/document/presentation/knowledge-document.controller.ts` con `@UseGuards(AdminGuard)`. Y
un `INSERT` sería imposible, no sólo de más: el markdown va a Spaces (fila de `files`), el backend
valida UTF-8 y la marca `rag:skip` ANTES de subir nada, y la ingesta (trocear + vectorizar) corre
asincrónica del otro lado.

**Si aparece un `INSERT`/`UPDATE knowledge_documents` en este repo, está mal.** La lectura sí es
SQL directo (`knowledge-documents.repo.ts`), como todo el resto del panel.

Sólo `visibility = 'public'`. Los privados (la póliza de un usuario) son dato personal, no se cargan
desde acá y la pantalla no los lista.

## Cómo viaja el archivo — y por qué acá SÍ se proxea

```
<input type=file> → FormData → uploadKnowledgeDocumentFn (server fn POST, data = FormData)
                             → uploadMarkdownKnowledgeDocument (fetch multipart)
                             → POST /api/v1/knowledge-documents/markdown
```

- **TanStack Start acepta `FormData` como `data` de un server function POST.** Verificado en
  `@tanstack/start-client-core` 1.170 (`ValidateValidatorInput` deja pasar `FormData` sin exigir
  serializable) y en `server-functions-handler.js` (lo lee con `request.formData()`). El validator
  es una función `(input: FormData) => …`, no un schema de zod: zod no describe un `File`. Así no
  hace falta base64 (+33%) ni pasar el texto por `JSON.stringify`.
- **Los manuales dejaron de proxearse por el techo de 4.5MB de Vercel**
  (`vehicle-manuals.md`, trampa 2). Acá el backend corta en **1MB**
  (`MAX_MARKDOWN_FILE_SIZE_BYTES` en `files/file/application/markdown-upload.ts`), así que ese
  techo no llega a morder, y no hay presigned PUT para markdown: es un multipart de un paso. **El
  día que el backend suba su límite por encima de ~4MB, esta pantalla deja de alcanzar** y hay que
  pasar a subida directa como los manuales.
- **No se setea `content-type` en el `fetch` saliente.** `fetch` arma el boundary solo; ponerlo a
  mano sin boundary es un 400 que parece bug del backend.
- **`relevance` es siempre `'global'`.** `spec` exigiría elegir una spec COMPLETA (motor,
  combustible, caja y marchas) y no hay selector para eso. La LECTURA sí muestra cualquier
  relevance: un PDF `spec` cargado por `POST /knowledge-documents` también es público.
- **Un campo vacío NO se manda.** El backend valida con `forbidNonWhitelisted` + `@IsUUID`, así que
  `supersedesDocumentId=""` es un 400. El server function lo traduce a ausente.

Los chequeos (extensión `.md`/`.markdown`, 0 < tamaño ≤ 1MB, título 1..200) están TRES veces: en el
componente (para no hacer esperar), en el server function (el que vale del lado del panel) y en el
backend (el que vale).

## La cadena de versiones

Semántica del backend (0102):

- Un alta con `supersedesDocumentId` es una versión nueva. La anterior tiene que estar `ready` y sin
  otra versión más nueva; si no, **400 `INVALID_STATE_TRANSITION`** (la anterior está
  pending/failed) o **409** (ya reemplazada, o ya tiene un sucesor pending/ready).
- La anterior sigue sirviendo mientras la nueva está `pending`. Cuando la nueva queda `ready`, la
  anterior pasa a **`superseded`** en la misma transacción.
- Si la nueva **falla**, la anterior queda `ready` y se puede reintentar: un documento puede tener
  **VARIOS sucesores `failed`**, pero a lo sumo **UNO no fallido** (índice único parcial
  `idx_knowledge_documents_supersedes_document_id_unique … where status <> 'failed'`).

**No hay columna `superseded_by`.** El repo la deriva con una subconsulta escalar (sucesor con
`status <> 'failed'`) — subconsulta y no JOIN, porque un JOIN multiplicaría filas por cada intento
fallido. El armado de cadenas es `groupKnowledgeChains()` en `~/lib` (pura, sin Postgres):

| Campo | Qué es |
|---|---|
| `current` | la versión `ready` de la línea principal — la que el asistente usa HOY. `null` si la cadena nunca llegó a `ready` |
| `inFlight` | lo posterior a `current` (el sucesor `pending`) + los `failed` que colgaron de `current`. Sin `current`, la cabeza misma |
| `history` | las `superseded` y los `failed` que colgaron de ellas |

La **línea principal** es raíz → sucesor no fallido → …; los `failed` cuelgan y no la continúan.
Una fila cuyo padre no llegó al set (defensivo) se trata como raíz de su propia cadena en vez de
desaparecer.

### Qué ofrece la UI, y cuándo no

- **"Subir nueva versión"** sólo con `current`. Sin `current` no hay nada que reemplazar (el backend
  daría 400); una primera subida fallida se arregla subiendo un documento nuevo.
- Con un sucesor **`pending`** el botón queda **deshabilitado con el motivo a la vista**, no
  escondido (sería un 409). Un sucesor **`failed` no bloquea**: reintentar es justo para lo que
  existe el botón.
- El título se precarga con el de `current` y `supersedesDocumentId` viaja oculto.

### Refresco automático

Mientras haya algún `pending`, la ruta hace `router.invalidate()` cada 5 s (`PENDING_POLL_MS`). Se
apaga sola cuando no queda nada pendiente y se limpia al desmontar. Es un efecto: corre sólo en el
browser, así que no afecta el SSR (`true`, heredado).

## `<!-- rag:skip -->`

El backend trocea por sección (cada `###`, más la intro de cada `##`). Una sección se excluye del
RAG con `<!-- rag:skip -->` como **primera línea no vacía debajo de su título** — para notas
internas o un índice. En cualquier otro lugar es un **400 con el número de línea**, igual que un
comentario HTML sin cerrar, un documento que queda sin nada indexable o un archivo que no es UTF-8.
El diálogo lo explica al lado del input, porque es el error más probable del alta.

## Errores

`backendError(response, what, { detailed: true })` — modo **opt-in** que agrega sentinelas propias:

| Status | Sentinela | Qué dice la UI (`readableKnowledgeError`) |
|---|---|---|
| 400 | `BACKEND_BAD_REQUEST:<code>:<msg>` | el mensaje del backend **tal cual**, citado (es el único que sabe la línea del `rag:skip`). Con `code = INVALID_STATE_TRANSITION`, que la versión a reemplazar está procesando o falló |
| 401 | `BACKEND_UNAUTHENTICATED` | cerrá sesión y volvé a entrar |
| 403 | `BACKEND_FORBIDDEN` | tu usuario no es admin en el backend |
| 404 | `BACKEND_NOT_FOUND:<msg>` | el documento a reemplazar ya no existe; recargá |
| 409 | `BACKEND_CONFLICT:<msg>` | ya hay una versión nueva en curso o ya fue reemplazado; recargá |
| 413 | `BACKEND_PAYLOAD_TOO_LARGE` | supera 1 MB |

**No se volvió el default** de `backendError` a propósito: `readableManualError` interpreta
`BACKEND_ERROR:404` como "el objeto no llegó a storage" (el confirm de los manuales), y cambiar la
sentinela para todos rompía esa lectura sin que `tsc` dijera nada — son strings.

El 400 del `ValidationPipe` trae `message: string[]`; `backendError` lo junta con `; `. Los mensajes
del backend están en inglés: la UI los presenta como cita, no como texto propio.

## Disponibilidad

`knowledgeDocumentsAvailability()` chequea con `to_regclass` + `information_schema.columns` que
exista la tabla (0080) y todas las columnas que se leen, incluida `supersedes_document_id` (0102).
Sin eso la pantalla muestra qué migración falta en vez de un 500. Mismo patrón que
`quoteRequestsAvailability()`.

## Qué NO se implementó, y por qué

- **Retirar un documento sin reemplazo.** No hay endpoint en el backend (ni `DELETE`, ni un
  `PATCH` de estado). Un `UPDATE … set status = 'superseded'` por SQL se saltearía el aggregate y
  dejaría los chunks vectorizados sin que nadie sepa si el RAG los sigue viendo. Si hace falta, el
  lugar es el backend.
- **Documentos `spec`.** Necesita un selector de specs completas; hoy nadie los carga.
- **Descargar el markdown.** `GET /files/:id/url` está acotado al dueño, y el alta le SACA el dueño
  al archivo (dato de referencia). `GET /admin/files/:id/url` existe en el backend (`AdminGuard`) y
  sería el camino; no se cableó porque ninguna consulta de DBeaver lo hacía.
- **Ver los chunks** (`knowledge_document_chunks`). No había consulta previa que reemplazar.

## Cómo verificar un cambio acá

`pnpm typecheck`. La ruta nueva necesita `routeTree.gen.ts` regenerado (está en `.gitignore`); sin
build, se puede correr `@tanstack/router-generator` directo (`new Generator({ config: getConfig({
target: 'react', routesDirectory, generatedRouteTree }, root) }).run()`), que sólo toca ese archivo.
Lo que no se puede verificar sin backend levantado: el alta real, los 400 de `rag:skip` y el
recorrido `pending → ready/failed`.
