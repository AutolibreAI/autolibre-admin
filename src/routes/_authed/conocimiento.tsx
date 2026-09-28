import { createFileRoute } from '@tanstack/react-router'
import { BookOpen, DatabaseZap } from 'lucide-react'
import {
  knowledgeRelevanceLabel,
  knowledgeStatusLabel,
  type KnowledgeDocument,
  type KnowledgeDocumentChain,
  type KnowledgeDocumentsAvailability,
} from '~/lib/knowledge-documents'
import { listKnowledgeDocumentsFn } from '~/fn/knowledge-documents'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Badge } from '~/components/ui/badge'
import { formatBytes, formatDateTime, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * Conocimiento (`/conocimiento`) — los documentos PÚBLICOS del RAG del
 * asistente.
 *
 * ── Qué reemplaza ───────────────────────────────────────────────────────────
 *
 * El `curl -F file=@guia.md -F title=… -F relevance=global` a
 * `POST /knowledge-documents/markdown` con un token de Clerk copiado a mano, y
 * después el `select id, title, status, failure_reason from
 * knowledge_documents …` en DBeaver para saber si la ingesta terminó, falló o
 * sigue pendiente. Con versiones (0102) se sumaba un tercero: seguir
 * `supersedes_document_id` a mano para saber cuál de las N filas con el mismo
 * título es la que el asistente usa HOY.
 *
 * Lee por SQL y escribe por HTTP, igual que el catálogo de manuales.
 * → `.claude/rules/knowledge-documents.md`
 */
export const Route = createFileRoute('/_authed/conocimiento')({
  /**
   * SSR completo (heredado). Es una pantalla de contenido chica —decenas de
   * documentos, no miles— sin nada lento que streamear, y no tiene estado que
   * viva en el browser: el diálogo de alta arranca cerrado y el refresco
   * automático es un efecto que recién corre después de hidratar. Mismo
   * criterio que `/feedback`.
   *
   * Sin `validateSearch`: la pantalla no tiene filtros ni orden elegible. Un
   * search param que no existe no hace falta validarlo.
   */
  loader: ({ abortController }) => listKnowledgeDocumentsFn({ signal: abortController.signal }),
  head: () => ({ meta: [{ title: 'Conocimiento — AutoLibre' }] }),
  component: KnowledgePage,
})

function KnowledgePage() {
  const listing = Route.useLoaderData()

  if (!listing.availability.available) {
    return (
      <>
        <PageHeader title="Conocimiento" actions={<SsrTag>ssr: full</SsrTag>} />
        <KnowledgeUnavailable availability={listing.availability} />
      </>
    )
  }

  const { chains } = listing
  const readyCount = chains.filter((c) => c.current).length

  return (
    <>
      <PageHeader
        title="Conocimiento"
        subtitle={`${formatInt(chains.length)} ${chains.length === 1 ? 'documento público' : 'documentos públicos'} · ${formatInt(readyCount)} en uso por el asistente`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      {chains.length === 0 ? (
        <EmptyKnowledge />
      ) : (
        <div className="space-y-3">
          {chains.map((chain) => (
            <ChainCard key={chain.rootId} chain={chain} />
          ))}
        </div>
      )}

      <p className="mt-4 text-xs text-muted-foreground">Fechas y horas en UTC.</p>
    </>
  )
}

/**
 * El vacío se EXPLICA, no se esconde — mismo criterio que la lista de
 * manuales. Sin datos de ejemplo (regla dura 8).
 */
function EmptyKnowledge() {
  return (
    <div className="rounded-lg border border-border bg-card px-6 py-12 text-center">
      <BookOpen className="mx-auto size-5 text-muted-foreground" aria-hidden />
      <p className="mt-3 text-sm font-medium">Todavía no hay documentos públicos de conocimiento</p>
      <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">
        Un documento público es texto de referencia —códigos de falla, normativa, guías— que el
        asistente de IA puede citar al contestarle a cualquier usuario. Sin ninguno, el asistente
        contesta sólo con lo que sabe el modelo y con los datos del auto de cada persona.
      </p>
    </div>
  )
}

function KnowledgeUnavailable({
  availability,
}: {
  availability: Exclude<KnowledgeDocumentsAvailability, { available: true }>
}) {
  return (
    <div className="max-w-prose rounded-lg border border-border bg-card p-6">
      <div className="flex items-center gap-2 text-muted-foreground">
        <DatabaseZap className="size-4 shrink-0" aria-hidden />
        <span className="text-xs font-medium uppercase tracking-wider">No desplegado en esta base</span>
      </div>
      <p className="mt-3 text-sm leading-relaxed">
        La base de conocimiento del asistente todavía no está desplegada en esta base.
      </p>
      <p className="mt-3 border-t border-border pt-3 text-sm leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Qué falta: </span>
        {availability.reason === 'no_table' ? (
          <>
            la tabla <code className="font-mono text-foreground">knowledge_documents</code> no existe.
            La crea la migración 0080 de <code className="font-mono">autolibre-backend-hex</code>.
          </>
        ) : (
          <>
            la tabla existe pero le faltan columnas que esta pantalla lee (las versiones llegan con la
            migración 0102 del backend):{' '}
            {availability.missingColumns.map((c, i) => (
              <span key={c}>
                {i > 0 ? ', ' : ''}
                <code className="font-mono text-foreground">{c}</code>
              </span>
            ))}
            .
          </>
        )}
      </p>
    </div>
  )
}

/**
 * Colores del ramp de estado de mobile, igual que `ApplicationStatusBadge`.
 * `ready` va en verde de marca porque es el único estado que significa "el
 * asistente lo está usando": es un resultado, no un paso.
 */
const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-status-yellow-bg text-status-yellow border-status-yellow/20',
  ready: 'bg-brand-soft text-brand border-brand/25',
  failed: 'bg-status-red-bg text-status-red border-status-red/20',
  superseded: 'bg-secondary text-muted-foreground border-border',
}

function KnowledgeStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={STATUS_STYLES[status] ?? 'bg-secondary text-muted-foreground border-border'}
    >
      {knowledgeStatusLabel(status)}
    </Badge>
  )
}

/** Tipo y tamaño del archivo fuente: un markdown se distingue de un PDF. */
function fileLabel(doc: KnowledgeDocument): string | null {
  const parts: Array<string> = []
  if (doc.fileMimeType) parts.push(doc.fileMimeType === 'text/markdown' ? 'markdown' : doc.fileMimeType)
  if (doc.fileSizeBytes !== null) parts.push(formatBytes(doc.fileSizeBytes))
  return parts.length ? parts.join(' · ') : null
}

function ChainCard({ chain }: { chain: KnowledgeDocumentChain }) {
  const { current } = chain
  const total = (current ? 1 : 0) + chain.inFlight.length + chain.history.length

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold break-words">{chain.title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {knowledgeRelevanceLabel(chain.relevance)}
            {' · '}
            {formatInt(total)} {total === 1 ? 'subida' : 'subidas'}
          </p>
        </div>
      </div>

      <div className="mt-3">
        {current ? (
          <DocumentLine doc={current} label="En uso" />
        ) : (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            Ninguna versión quedó lista todavía: el asistente no usa este documento.
          </p>
        )}
      </div>

      {chain.inFlight.length > 0 ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            {current ? 'Versiones nuevas' : 'Subida'}
          </p>
          {chain.inFlight.map((doc) => (
            <DocumentLine key={doc.id} doc={doc} />
          ))}
          {current && chain.inFlight.some((d) => d.status === 'pending') ? (
            <p className="text-xs text-muted-foreground">
              Mientras la nueva se procesa, el asistente sigue usando la versión en uso. Recién
              cuando la nueva queda lista, la anterior pasa a reemplazada.
            </p>
          ) : null}
        </div>
      ) : null}

      {chain.history.length > 0 ? (
        <details className="group mt-3">
          <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">
            Historial ({formatInt(chain.history.length)})
          </summary>
          <div className="mt-2 space-y-2">
            {chain.history.map((doc) => (
              <DocumentLine key={doc.id} doc={doc} muted />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  )
}

function DocumentLine({
  doc,
  label,
  muted = false,
}: {
  doc: KnowledgeDocument
  label?: string
  muted?: boolean
}) {
  const file = fileLabel(doc)

  return (
    <div className={cn('rounded-md border border-border px-3 py-2', muted && 'bg-surface-2')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {label ? <span className="text-xs font-medium">{label}</span> : null}
        <KnowledgeStatusBadge status={doc.status} />
        <span className="text-xs tabular-nums text-muted-foreground">
          subida el {formatDateTime(doc.createdAt)}
          {doc.updatedAt !== doc.createdAt ? ` · actualizada el ${formatDateTime(doc.updatedAt)}` : ''}
        </span>
        {file ? <span className="text-xs text-muted-foreground">{file}</span> : null}
      </div>
      {muted || !label ? (
        <p className="mt-1 truncate text-xs text-muted-foreground" title={doc.title}>
          {doc.title}
        </p>
      ) : null}
      {doc.status === 'failed' ? (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-status-red">
          {doc.failureReason ?? 'Falló sin motivo registrado.'}
        </p>
      ) : null}
    </div>
  )
}
