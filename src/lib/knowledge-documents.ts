import { z } from 'zod'

/**
 * Documentos de conocimiento del RAG (`knowledge_documents`) — los PÚBLICOS.
 *
 * ── Qué es esto y de quién es ───────────────────────────────────────────────
 *
 * `knowledge_documents` es del bounded context `knowledge/` de
 * `autolibre-backend-hex`. El panel LEE por SQL (como todo el resto) y ESCRIBE
 * por HTTP (`POST /knowledge-documents/markdown`, `AdminGuard`): el grep al
 * backend da positivo, y además el alta no es un INSERT — el markdown se sube a
 * Spaces, se valida (UTF-8, `<!-- rag:skip -->` bien puesto) y la ingesta
 * (trocear + vectorizar) corre asincrónica del otro lado. Ninguna cantidad de
 * SQL hace eso. → `.claude/rules/knowledge-documents.md`
 *
 * Sólo los `visibility = 'public'`: los privados (la póliza de un usuario) son
 * datos personales, no se cargan desde acá y esta pantalla no los muestra.
 *
 * ── La cadena de versiones ──────────────────────────────────────────────────
 *
 * Desde la 0102 del backend, un alta con `supersedesDocumentId` es una VERSIÓN
 * NUEVA de otro documento. La anterior sigue sirviendo mientras la nueva está
 * `pending`; recién cuando la nueva queda `ready` la anterior pasa a
 * `superseded`, en la misma transacción. Si la nueva falla, la anterior queda
 * como estaba y se puede reintentar — o sea que un documento puede tener VARIOS
 * sucesores `failed`, pero a lo sumo UNO no fallido (índice único parcial
 * `idx_knowledge_documents_supersedes_document_id_unique`).
 *
 * No hay columna `superseded_by`: el sucesor se deriva con un self-join. Por
 * eso `supersededByDocumentId` lo calcula el repo, y es SIEMPRE el sucesor no
 * fallido — un intento fallido no reemplaza a nadie.
 */

// ── Espejos del backend ──────────────────────────────────────────────────────
//
// Repetidos acá para rechazar ANTES del round trip. Son espejos, no la
// autoridad: el backend los vuelve a validar y su chequeo es el que vale.

export const KNOWLEDGE_DOCUMENT_STATUSES = ['pending', 'ready', 'failed', 'superseded'] as const
export type KnowledgeDocumentStatus = (typeof KNOWLEDGE_DOCUMENT_STATUSES)[number]

export const KNOWLEDGE_DOCUMENT_STATUS_LABELS: Record<KnowledgeDocumentStatus, string> = {
  pending: 'Procesando',
  ready: 'Lista',
  failed: 'Falló',
  superseded: 'Reemplazada',
}

/**
 * `knowledge_relevance` del backend. El panel sólo OFRECE `global` al subir
 * (un markdown de conocimiento general: códigos DTC, normativa, guías), pero
 * puede LEER cualquiera — un documento `spec` cargado por `POST
 * /knowledge-documents` con un PDF también es público y tiene que verse.
 */
export const KNOWLEDGE_RELEVANCES = ['global', 'spec', 'vehicle'] as const
export type KnowledgeRelevance = (typeof KNOWLEDGE_RELEVANCES)[number]

export const KNOWLEDGE_RELEVANCE_LABELS: Record<KnowledgeRelevance, string> = {
  global: 'General',
  spec: 'Por versión mecánica',
  vehicle: 'Por vehículo',
}

/**
 * Un valor de enum que el panel no conoce se muestra CRUDO, no se esconde —
 * mismo criterio que el idioma de los manuales. Un enum nuevo del backend no
 * puede convertirse en una fila en blanco.
 */
export function knowledgeStatusLabel(status: string): string {
  return (KNOWLEDGE_DOCUMENT_STATUS_LABELS as Record<string, string>)[status] ?? status
}

export function knowledgeRelevanceLabel(relevance: string): string {
  return (KNOWLEDGE_RELEVANCE_LABELS as Record<string, string>)[relevance] ?? relevance
}

/**
 * `MAX_MARKDOWN_FILE_SIZE_BYTES` en
 * `autolibre-backend-hex/src/files/file/application/markdown-upload.ts`.
 *
 * A diferencia de los manuales, ACÁ el archivo sí pasa por un servidor nuestro
 * (el server function lo reenvía como multipart), así que el techo de 4.5MB del
 * cuerpo de una Serverless Function de Vercel también aplica. No muerde: 1MB
 * de markdown es texto de sobra, y el multipart agrega bytes, no multiplica.
 * El día que el backend suba este número por encima de ~4MB, esta pantalla
 * deja de alcanzar y hay que pasar a subida directa como los manuales.
 */
export const MAX_KNOWLEDGE_MARKDOWN_BYTES = 1 * 1024 * 1024

export const MAX_KNOWLEDGE_MARKDOWN_KB = MAX_KNOWLEDGE_MARKDOWN_BYTES / 1024

/** Extensiones que el backend acepta. Se compara en minúscula. */
export const KNOWLEDGE_MARKDOWN_EXTENSIONS = ['.md', '.markdown'] as const

/** `@MaxLength(200)` de `CreateMarkdownKnowledgeDocumentFieldsDto.title`. */
export const MAX_KNOWLEDGE_TITLE_LENGTH = 200

export function hasMarkdownExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  return KNOWLEDGE_MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

// ── Contratos de lectura ─────────────────────────────────────────────────────

export interface KnowledgeDocument {
  id: string
  title: string
  relevance: string
  status: string
  /** Sólo con `status = 'failed'`: el motivo que grabó la ingesta. */
  failureReason: string | null
  createdAt: string
  updatedAt: string
  /** La versión ANTERIOR que este documento reemplaza (columna real). */
  supersedesDocumentId: string | null
  /**
   * La versión SIGUIENTE no fallida (derivada con self-join; no es columna).
   * Existe apenas se registra la nueva, aunque todavía esté `pending`.
   */
  supersededByDocumentId: string | null
  /** Del `LEFT JOIN files`: sirve para distinguir un markdown de un PDF. */
  fileMimeType: string | null
  fileSizeBytes: number | null
}

/**
 * Una cadena de versiones, ya ordenada para pintar.
 *
 *  - `current`: la versión que HOY sirve el RAG — `ready` y no reemplazada. Es
 *    `null` cuando la cadena nunca llegó a `ready` (la primera subida está
 *    procesando o falló).
 *  - `inFlight`: lo que está en curso o falló sobre `current` (o, sin
 *    `current`, la cabeza misma), más nuevo primero. Un `failed` acá no bloquea
 *    nada: el backend deja reintentar.
 *  - `history`: las versiones reemplazadas y los intentos fallidos que
 *    colgaron de ellas, más nuevo primero.
 */
export interface KnowledgeDocumentChain {
  /** El id de la primera versión: estable mientras la cadena crece. */
  rootId: string
  title: string
  current: KnowledgeDocument | null
  inFlight: Array<KnowledgeDocument>
  history: Array<KnowledgeDocument>
  /** El `updated_at` más nuevo de la cadena, para ordenar las tarjetas. */
  lastActivityAt: string
}

/**
 * ¿La pantalla puede leer la tabla?
 *
 * `knowledge_documents` nace en la 0080 del backend y `supersedes_document_id`
 * en la 0102. Una base sin cualquiera de las dos haría explotar el SELECT en la
 * primera consulta — así que se chequea antes, igual que
 * `quoteRequestsAvailability()`.
 */
export type KnowledgeDocumentsAvailability =
  | { available: true }
  | { available: false; reason: 'no_table' }
  | { available: false; reason: 'missing_columns'; missingColumns: Array<string> }

export type KnowledgeDocumentsListing =
  | { availability: { available: true }; chains: Array<KnowledgeDocumentChain> }
  | {
      availability: Exclude<KnowledgeDocumentsAvailability, { available: true }>
      chains: []
    }

// ── Armar las cadenas ────────────────────────────────────────────────────────

const newestFirst = (a: KnowledgeDocument, b: KnowledgeDocument) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)

/**
 * De filas sueltas a cadenas.
 *
 * Es una función pura y vive en `~/lib` a propósito: la semántica de "cuál es
 * la versión vigente" es la parte delicada de la pantalla, y así se puede leer
 * (y probar) sin Postgres.
 *
 * El recorrido sigue la LÍNEA PRINCIPAL — raíz → sucesor no fallido → … — que
 * el índice único parcial del backend garantiza lineal. Los sucesores
 * `failed` cuelgan de un nodo de la línea y no la continúan.
 *
 * Defensas, porque la tabla la escribe otro repo:
 *  - Una fila cuyo `supersedesDocumentId` apunta a algo que no está en el set
 *    (por ejemplo, a un documento privado) se trata como raíz de su propia
 *    cadena, en vez de desaparecer.
 *  - Un ciclo (imposible por el CHECK de no-autoreferencia y el orden de
 *    alta, pero barato de cortar) se corta con `seen`.
 */
export function groupKnowledgeChains(docs: ReadonlyArray<KnowledgeDocument>): Array<KnowledgeDocumentChain> {
  const byId = new Map(docs.map((d) => [d.id, d]))
  const childrenOf = new Map<string, Array<KnowledgeDocument>>()

  for (const d of docs) {
    if (d.supersedesDocumentId && byId.has(d.supersedesDocumentId)) {
      const list = childrenOf.get(d.supersedesDocumentId) ?? []
      list.push(d)
      childrenOf.set(d.supersedesDocumentId, list)
    }
  }

  const roots = docs.filter((d) => !d.supersedesDocumentId || !byId.has(d.supersedesDocumentId))

  return roots
    .map((root): KnowledgeDocumentChain => {
      const seen = new Set<string>()
      const mainLine: Array<KnowledgeDocument> = []
      const failedOff = new Map<string, Array<KnowledgeDocument>>()

      let node: KnowledgeDocument | undefined = root
      while (node && !seen.has(node.id)) {
        seen.add(node.id)
        mainLine.push(node)

        const children: Array<KnowledgeDocument> = childrenOf.get(node.id) ?? []
        failedOff.set(
          node.id,
          children.filter((c) => c.status === 'failed'),
        )
        // El sucesor no fallido. Se prefiere el que el SQL calculó; si no
        // vino (fila vieja, sucesor fuera del set), el primero no fallido.
        const nextId: string | null | undefined =
          node.supersededByDocumentId ?? children.find((c) => c.status !== 'failed')?.id
        node = nextId ? byId.get(nextId) : undefined
      }

      const current = mainLine.find((d) => d.status === 'ready') ?? null

      const inFlight: Array<KnowledgeDocument> = []
      const history: Array<KnowledgeDocument> = []

      if (current) {
        const currentIndex = mainLine.indexOf(current)
        mainLine.forEach((d, i) => {
          if (i < currentIndex) history.push(d)
          else if (i > currentIndex) inFlight.push(d)
        })
        for (const [parentId, failed] of failedOff) {
          ;(parentId === current.id ? inFlight : history).push(...failed)
        }
      } else {
        // Nunca llegó a `ready`: lo que no está reemplazado está en curso (o
        // falló, y eso es lo que hay que ver); lo reemplazado es historia. En
        // la práctica es una sola fila — sin `ready` no se puede versionar.
        for (const d of mainLine) (d.status === 'superseded' ? history : inFlight).push(d)
        for (const failed of failedOff.values()) history.push(...failed)
      }

      inFlight.sort(newestFirst)
      history.sort(newestFirst)

      const all = [...mainLine, ...[...failedOff.values()].flat()]
      const lastActivityAt = all.reduce(
        (max, d) => (d.updatedAt > max ? d.updatedAt : max),
        root.updatedAt,
      )

      return {
        rootId: root.id,
        // El título de lo que hoy sirve; sin eso, el de la versión más nueva.
        title: current?.title ?? (mainLine[mainLine.length - 1] ?? root).title,
        current,
        inFlight,
        history,
        lastActivityAt,
      }
    })
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.rootId.localeCompare(b.rootId))
}

/** ¿Hay algo procesándose? Es lo que prende el refresco automático. */
export function hasPendingKnowledgeDocument(chains: ReadonlyArray<KnowledgeDocumentChain>): boolean {
  return chains.some((c) => c.inFlight.some((d) => d.status === 'pending'))
}

// ── Borde de escritura ───────────────────────────────────────────────────────

/**
 * Los campos NO-archivo del alta. El markdown viaja como `File` dentro de un
 * `FormData` y se valida aparte, porque zod no describe un binario que en el
 * servidor es un `File` de Node y en el cliente uno del DOM.
 *
 * `relevance` no está: el panel sólo sube `global` y lo fija el borde HTTP.
 * `supersedesDocumentId` ausente = documento nuevo; presente = versión nueva.
 */
export const knowledgeUploadFieldsSchema = z.object({
  title: z.string().trim().min(1).max(MAX_KNOWLEDGE_TITLE_LENGTH),
  supersedesDocumentId: z.uuid().optional(),
})

export type KnowledgeUploadFields = z.infer<typeof knowledgeUploadFieldsSchema>
