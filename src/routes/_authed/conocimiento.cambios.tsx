import { createFileRoute } from '@tanstack/react-router'
import { Bot, CheckCircle2, ExternalLink, UserRound, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { listKnowledgeDocumentsFn } from '~/fn/knowledge-documents'
import { MockBanner } from '~/components/MockBanner'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Textarea } from '~/components/ui/textarea'
import { formatDate, formatDateTime, formatInt } from '~/lib/format'
import { knowledgeStatusLabel } from '~/lib/knowledge-documents'
import {
  REGULATORY_CHANGE_STATUS_CLASSES,
  REGULATORY_CHANGE_STATUS_LABELS,
  REGULATORY_REASON_MAX,
  approvalProblem,
  diffLines,
  regulatoryChecks,
  rejectionProblem,
} from '~/lib/regulatory-changes'
import { cn } from '~/lib/utils'
import {
  approveRegulatoryChangeMock,
  listRegulatoryChangesMock,
  rejectRegulatoryChangeMock,
} from '~/mocks/regulatory-changes'
import type { KnowledgeDocument, KnowledgeDocumentChain } from '~/lib/knowledge-documents'
import type { RegulatoryChange } from '~/lib/regulatory-changes'

/**
 * Conocimiento › Cambios normativos.
 *
 * La cola de fichas (en amarillo) que proponen cambiar una sección de un .md
 * del asistente, con el diff y los chequeos de coherencia; aprobar o rechazar
 * es de una persona. Abajo, el historial de versiones REAL de cada documento
 * (la misma cadena que la pestaña Documentos), con la columna de changelog que
 * todavía no existe en la base.
 *
 * Las fichas son de ejemplo (`~/mocks/regulatory-changes`) y aprobar no sube
 * nada. `ssr: 'data-only'`: las fichas viven en la memoria del navegador;
 * renderizarlas en el servidor daría la semilla aunque ya se haya aprobado algo.
 */
export const Route = createFileRoute('/_authed/conocimiento/cambios')({
  ssr: 'data-only',
  loader: ({ abortController }) => listKnowledgeDocumentsFn({ signal: abortController.signal }),
  head: () => ({ meta: [{ title: 'Conocimiento · Cambios normativos — AutoLibre' }] }),
  component: RegulatoryChangesPage,
})

const FIELD_LABEL = 'text-xs font-medium uppercase tracking-wider text-muted-foreground'

function RegulatoryChangesPage() {
  const listing = Route.useLoaderData()
  const { user } = Route.useRouteContext()
  const [changes, setChanges] = useState<Array<RegulatoryChange> | null>(null)

  async function reload() {
    setChanges(await listRegulatoryChangesMock())
  }
  useEffect(() => {
    void reload()
  }, [])

  const pending = (changes ?? []).filter((c) => c.status === 'pending')
  const reviewed = (changes ?? []).filter((c) => c.status !== 'pending')

  return (
    <>
      <PageHeader
        title="Cambios normativos"
        subtitle={
          changes === null
            ? 'Cargando…'
            : `${formatInt(pending.length)} ${pending.length === 1 ? 'ficha' : 'fichas'} a revisar · ${formatInt(reviewed.length)} revisadas`
        }
        actions={<SsrTag>ssr: data-only</SsrTag>}
      />

      <MockBanner
        items={[
          'Las fichas son de ejemplo: normas, jurisdicciones, valores y URLs inventados. No hay detector ni tabla de cambios.',
          'El texto de cada sección también: el .md vigente no se puede bajar todavía.',
          'Aprobar o rechazar no guarda nada y aprobar NO sube una versión nueva del documento.',
          'El historial de versiones de abajo es real; lo que falta es el resumen de qué cambió en cada una.',
        ]}
      />

      <section className="mb-8 space-y-3">
        <h2 className="text-sm font-semibold">A revisar</h2>
        {changes === null ? (
          <p className="text-sm text-muted-foreground">Cargando fichas…</p>
        ) : pending.length === 0 ? (
          <p className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
            No hay fichas a revisar.
          </p>
        ) : (
          pending.map((c) => <ChangeCard key={c.id} change={c} actorEmail={user.email} onReviewed={reload} />)
        )}
      </section>

      {reviewed.length > 0 ? (
        <section className="mb-8">
          <details>
            <summary className="cursor-pointer select-none text-sm font-semibold">
              Revisadas ({formatInt(reviewed.length)})
            </summary>
            <div className="mt-3 space-y-2">
              {reviewed.map((c) => (
                <ReviewedLine key={c.id} change={c} />
              ))}
            </div>
          </details>
        </section>
      ) : null}

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Historial de versiones</h2>
          <p className="text-xs text-muted-foreground">
            Las versiones reales de cada documento público, más nueva primero. «Qué cambió» todavía no se
            guarda en ningún lado.
          </p>
        </div>
        {!listing.availability.available ? (
          <p className="text-sm text-muted-foreground">Esta base no tiene la tabla de documentos de conocimiento.</p>
        ) : listing.chains.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hay documentos públicos cargados.</p>
        ) : (
          listing.chains.map((chain) => <VersionHistory key={chain.rootId} chain={chain} />)
        )}
        <p className="text-xs text-muted-foreground">Fechas y horas en UTC.</p>
      </section>
    </>
  )
}

function StatusBadge({ status }: { status: RegulatoryChange['status'] }) {
  return (
    <span className={cn('rounded-md border px-2 py-0.5 text-xs', REGULATORY_CHANGE_STATUS_CLASSES[status])}>
      {REGULATORY_CHANGE_STATUS_LABELS[status]}
    </span>
  )
}

function ChangeCard({
  change: c,
  actorEmail,
  onReviewed,
}: {
  change: RegulatoryChange
  actorEmail: string
  onReviewed: () => Promise<void>
}) {
  const checks = regulatoryChecks(c)
  const diff = diffLines(c.sectionBefore, c.sectionAfter)
  const [mode, setMode] = useState<'idle' | 'approve' | 'reject'>('idle')
  const [readSource, setReadSource] = useState(false)
  const [summary, setSummary] = useState(`${c.topic}: de ${c.oldValue} a ${c.newValue} (${c.norm}).`)
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const blocked = checks.some((x) => !x.ok)

  async function approve() {
    const p = approvalProblem(c, { readSource, summary })
    setProblem(p)
    if (p) return
    try {
      await approveRegulatoryChangeMock(c.id, { reviewedBy: actorEmail, changeSummary: summary })
      await onReviewed()
    } catch {
      setProblem('Otra persona ya revisó esta ficha. Recargá.')
    }
  }

  async function reject() {
    const p = rejectionProblem(c, reason)
    setProblem(p)
    if (p) return
    try {
      await rejectRegulatoryChangeMock(c.id, { reviewedBy: actorEmail, reason })
      await onReviewed()
    } catch {
      setProblem('Otra persona ya revisó esta ficha. Recargá.')
    }
  }

  return (
    <article className="rounded-lg border border-status-yellow/40 bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{c.topic}</h3>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {c.jurisdiction} · detectada el {formatDateTime(c.detectedAt)} ·
            {c.proposedBy === 'detector' ? (
              <span className="inline-flex items-center gap-1">
                <Bot className="size-3" aria-hidden /> propuesta por el detector (IA)
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <UserRound className="size-3" aria-hidden /> cargada por una persona
              </span>
            )}
          </p>
        </div>
        <StatusBadge status={c.status} />
      </div>

      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className={FIELD_LABEL}>Valor anterior</dt>
          <dd>{c.oldValue}</dd>
        </div>
        <div>
          <dt className={FIELD_LABEL}>Valor nuevo</dt>
          <dd className="font-medium">{c.newValue}</dd>
        </div>
        <div>
          <dt className={FIELD_LABEL}>Rige desde</dt>
          <dd>{formatDate(c.effectiveFrom)}</dd>
        </div>
        <div>
          <dt className={FIELD_LABEL}>Norma</dt>
          <dd>
            {c.norm}{' '}
            <a
              href={c.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-xs text-brand hover:underline"
            >
              fuente <ExternalLink className="size-3" aria-hidden />
            </a>
          </dd>
        </div>
      </dl>

      <blockquote className="mt-3 border-l-2 border-border pl-3 text-sm italic text-muted-foreground">{c.quote}</blockquote>

      <div className="mt-4">
        <p className={FIELD_LABEL}>
          Diff propuesto · {c.documentTitle} · <span className="normal-case">{c.section}</span>
        </p>
        <pre className="mt-1.5 overflow-x-auto rounded-md border border-border bg-surface-2 py-2 text-xs leading-relaxed">
          {diff.map((d, i) => (
            <div
              key={i}
              className={cn(
                'px-3 whitespace-pre-wrap',
                d.kind === 'add' && 'bg-status-green-bg text-status-green',
                d.kind === 'del' && 'bg-status-red-bg text-status-red',
              )}
            >
              {d.kind === 'add' ? '+ ' : d.kind === 'del' ? '− ' : '  '}
              {d.text}
            </div>
          ))}
        </pre>
      </div>

      <ul className="mt-3 grid gap-1 text-xs sm:grid-cols-2">
        {checks.map((x) => (
          <li key={x.id} className={cn('flex items-center gap-1.5', x.ok ? 'text-muted-foreground' : 'text-status-red')}>
            {x.ok ? <CheckCircle2 className="size-3.5 text-status-green" aria-hidden /> : <XCircle className="size-3.5" aria-hidden />}
            {x.label}
          </li>
        ))}
      </ul>

      {mode === 'approve' ? (
        <div className="mt-4 space-y-3 rounded-md border border-border p-3">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={readSource} onCheckedChange={(v) => setReadSource(v === true)} className="mt-0.5" />
            Leí la norma en la fuente y la cita es textual.
          </label>
          <div className="space-y-1">
            <label className={FIELD_LABEL} htmlFor={`summary-${c.id}`}>
              Qué cambió (va al historial del documento)
            </label>
            <Textarea
              id={`summary-${c.id}`}
              value={summary}
              maxLength={REGULATORY_REASON_MAX}
              rows={2}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Con el backend, aprobar subiría una versión nueva de «{c.documentTitle}» con este cambio aplicado; la
            anterior sigue en uso hasta que la nueva termine de procesarse. Hoy no se sube nada.
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void approve()}>
              Aprobar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('idle')}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : mode === 'reject' ? (
        <div className="mt-4 space-y-3 rounded-md border border-border p-3">
          <div className="space-y-1">
            <label className={FIELD_LABEL} htmlFor={`reason-${c.id}`}>
              Por qué se rechaza
            </label>
            <Textarea
              id={`reason-${c.id}`}
              value={reason}
              maxLength={REGULATORY_REASON_MAX}
              rows={2}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" onClick={() => void reject()}>
              Rechazar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('idle')}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={blocked}
            title={blocked ? 'Hay chequeos sin cumplir: corregí la ficha o rechazala.' : undefined}
            onClick={() => {
              setProblem(null)
              setMode('approve')
            }}
          >
            Revisar y aprobar
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setProblem(null)
              setMode('reject')
            }}
          >
            Rechazar
          </Button>
          {blocked ? (
            <span className="text-xs text-status-red">No se puede aprobar con chequeos en rojo.</span>
          ) : null}
        </div>
      )}

      {problem ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {problem}
        </p>
      ) : null}
    </article>
  )
}

function ReviewedLine({ change: c }: { change: RegulatoryChange }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={c.status} />
        <span className="font-medium">{c.topic}</span>
        <span className="text-xs text-muted-foreground">
          {c.documentTitle} · {c.reviewedBy ?? '—'}
          {c.reviewedAt ? ` · ${formatDateTime(c.reviewedAt)}` : ''}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {c.status === 'approved' ? `Changelog: ${c.changeSummary ?? '—'}` : `Motivo: ${c.rejectionReason ?? '—'}`}
      </p>
    </div>
  )
}

function VersionHistory({ chain }: { chain: KnowledgeDocumentChain }) {
  const versions: Array<{ doc: KnowledgeDocument; label: string }> = [
    ...chain.inFlight.map((doc) => ({ doc, label: doc.status === 'failed' ? 'Falló' : 'En curso' })),
    ...(chain.current ? [{ doc: chain.current, label: 'En uso' }] : []),
    ...chain.history.map((doc) => ({ doc, label: knowledgeStatusLabel(doc.status) })),
  ]
  return (
    <details className="rounded-lg border border-border bg-card p-3">
      <summary className="cursor-pointer select-none text-sm">
        <span className="font-medium">{chain.title}</span>{' '}
        <span className="text-xs text-muted-foreground">
          · {formatInt(versions.length)} {versions.length === 1 ? 'versión' : 'versiones'}
        </span>
      </summary>
      <ol className="mt-3 space-y-2">
        {versions.map(({ doc, label }) => (
          <li key={doc.id} className="rounded-md border border-border px-3 py-2 text-xs">
            <p className="flex flex-wrap gap-x-2">
              <span className="font-medium">{label}</span>
              <span className="text-muted-foreground">subida el {formatDateTime(doc.createdAt)}</span>
            </p>
            <p className="mt-0.5 text-muted-foreground">
              Qué cambió: <span className="text-status-yellow">sin dato · falta backend</span>
            </p>
          </li>
        ))}
      </ol>
    </details>
  )
}
