import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import {
  groupKnowledgeChains,
  type KnowledgeDocument,
  type KnowledgeDocumentsAvailability,
  type KnowledgeDocumentsListing,
} from '~/lib/knowledge-documents'

/**
 * Documentos de conocimiento — SÓLO LECTURA.
 *
 * `knowledge_documents` es del bounded context `knowledge/` del backend. Las
 * escrituras van por HTTP (`~/server/backend.ts`), nunca por acá: el alta sube
 * el archivo a Spaces y dispara una ingesta asincrónica que ningún INSERT
 * reproduce. Si aparece un `INSERT`/`UPDATE knowledge_documents` en este repo,
 * está mal. → `.claude/rules/knowledge-documents.md`
 */

const toIso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : String(v)
const toIntOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

/**
 * Toda columna que este repo lee. `supersedes_document_id` es la que en la
 * práctica puede faltar (0102 del backend); el resto se lista igual porque el
 * chequeo es "¿corre el SELECT?", no "¿qué migración hay?". Mismo patrón que
 * `READ_COLUMNS` de `quote-requests.repo.ts`.
 */
const READ_COLUMNS = [
  'id',
  'file_id',
  'title',
  'visibility',
  'relevance',
  'status',
  'failure_reason',
  'created_at',
  'updated_at',
  'supersedes_document_id',
] as const

/**
 * `to_regclass` y no un `select … limit 0` con try/catch, por el mismo motivo
 * que `quoteRequestsAvailability()`: un catch que se traga errores de SQL
 * termina tragándose también los reales.
 */
export async function knowledgeDocumentsAvailability(
  opts: { signal?: AbortSignal } = {},
): Promise<KnowledgeDocumentsAvailability> {
  void opts.signal

  const row = await sqlOne<{ has_table: boolean; missing: Array<string> | null }>(
    `select
       to_regclass('public.knowledge_documents') is not null as has_table,
       (select array_agg(c.col order by c.ord)
          from unnest($1::text[]) with ordinality as c(col, ord)
         where not exists (
           select 1 from information_schema.columns ic
            where ic.table_schema = 'public'
              and ic.table_name = 'knowledge_documents'
              and ic.column_name = c.col)) as missing`,
    [READ_COLUMNS],
  )

  if (!row?.has_table) return { available: false, reason: 'no_table' }
  const missing = row.missing ?? []
  if (missing.length > 0) return { available: false, reason: 'missing_columns', missingColumns: missing }
  return { available: true }
}

interface KnowledgeDocumentRow {
  id: string
  title: string
  relevance: string
  status: string
  failure_reason: string | null
  created_at: Date | string
  updated_at: Date | string
  supersedes_document_id: string | null
  superseded_by_document_id: string | null
  mime_type: string | null
  size_bytes: number | string | null
}

/**
 * Todos los documentos públicos, con el sucesor derivado.
 *
 * ── `superseded_by_document_id` NO es una columna ───────────────────────────
 *
 * El backend guarda sólo el puntero hacia atrás (`supersedes_document_id`). El
 * sucesor sale de un self-join, y se filtra `status <> 'failed'` porque un
 * documento puede tener VARIOS intentos fallidos colgando: el que continúa la
 * cadena es el único no fallido (lo garantiza el índice único parcial
 * `idx_knowledge_documents_supersedes_document_id_unique`, que tiene
 * exactamente ese predicado). El `order by … limit 1` es defensa, no
 * desempate: con el índice nunca hay dos.
 *
 * Subconsulta escalar y no JOIN, por el mismo motivo que en todo el repo: un
 * JOIN a los sucesores multiplicaría filas por cada intento fallido.
 *
 * `visibility = 'public'` en la fila Y en el sucesor no hace falta: el backend
 * exige que una versión nueva conserve el scope de la que reemplaza, así que
 * el sucesor de un público es público. Lo que sí se defiende es la lectura:
 * `groupKnowledgeChains` trata como raíz a una fila cuyo padre no llegó.
 *
 * `left join files`: `file_id` es NOT NULL con FK, pero un `JOIN` convertiría
 * una inconsistencia en una fila que desaparece sin avisar.
 */
export async function listPublicKnowledgeDocuments(
  opts: { signal?: AbortSignal } = {},
): Promise<Array<KnowledgeDocument>> {
  void opts.signal

  const rows = await sql<KnowledgeDocumentRow>(
    `
    select
      d.id,
      d.title,
      d.relevance::text as relevance,
      d.status::text as status,
      d.failure_reason,
      d.created_at,
      d.updated_at,
      d.supersedes_document_id,
      (select s.id
         from knowledge_documents s
        where s.supersedes_document_id = d.id
          and s.status <> 'failed'
        order by s.created_at desc
        limit 1) as superseded_by_document_id,
      f.mime_type,
      f.size_bytes
    from knowledge_documents d
    left join files f on f.id = d.file_id
    where d.visibility = 'public'
    order by d.created_at desc, d.id
    `,
  )

  return rows.map(
    (r): KnowledgeDocument => ({
      id: r.id,
      title: r.title,
      relevance: r.relevance,
      status: r.status,
      failureReason: r.failure_reason,
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
      supersedesDocumentId: r.supersedes_document_id,
      supersededByDocumentId: r.superseded_by_document_id,
      fileMimeType: r.mime_type,
      fileSizeBytes: toIntOrNull(r.size_bytes),
    }),
  )
}

/**
 * Lo que consume la pantalla: disponibilidad primero, y recién con la tabla
 * confirmada el SELECT y el armado de cadenas.
 */
export async function listKnowledgeDocumentChains(
  opts: { signal?: AbortSignal } = {},
): Promise<KnowledgeDocumentsListing> {
  const availability = await knowledgeDocumentsAvailability(opts)
  if (!availability.available) return { availability, chains: [] }

  const docs = await listPublicKnowledgeDocuments(opts)
  return { availability, chains: groupKnowledgeChains(docs) }
}
