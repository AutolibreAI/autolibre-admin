import { useRef, useState, type ReactNode } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { RefreshCw, Send } from 'lucide-react'
import { approvePartnerDispatchFn } from '~/fn/partner-dispatch'
import {
  MAX_DISPATCH_SLOTS,
  READINESS_REASON_HINTS,
  deliveryStatusLabel,
  distanceBucketLabel,
  exclusionReasonLabel,
  failureReasonLabel,
  messageDirectionLabel,
  messageKindLabel,
  outreachStatusLabel,
  outreachStatusTone,
  piiKindLabel,
  readablePartnerDispatchError,
  readinessReasonLabel,
  readinessStatusLabel,
  type DispatchCandidate,
  type DispatchDraft,
  type OutreachRow,
  type OutreachTone,
  type PartnerDispatchResult,
} from '~/lib/partner-dispatch'
import { Button } from '~/components/ui/button'
import { Card, CardContent } from '~/components/ui/card'
import { Checkbox } from '~/components/ui/checkbox'
import { formatDateTime, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * «Despacho por WhatsApp» — el backend le manda a hasta 3 talleres un template
 * de WhatsApp con el pedido (sin datos de la persona), y el que acepta recibe
 * los detalles. Acá se ve el borrador, se aprueba y se sigue cada contacto.
 * → `.claude/rules/partner-dispatch.md`
 *
 * ── Lee y escribe por HTTP ─────────────────────────────────────────────────
 *
 * El borrador y el seguimiento vienen del loader (`getPartnerDispatchFn`), la
 * aprobación va al backend con el token del admin, y después se RELEE el
 * loader (`router.invalidate()`): sin movimiento optimista.
 *
 * ── `dispatchId`: lo genera el CLIENTE ─────────────────────────────────────
 *
 * Mismo ciclo que `sendId` en `QuoteProposals`: se genera al abrir la
 * confirmación (en el handler, nunca en SSR), se conserva ante un error o un
 * doble click, y se regenera SÓLO después de un éxito. Un timeout pudo haber
 * aprobado: reintentar con el mismo id y los mismos talleres devuelve lo mismo
 * sin duplicar. Si después de un fallo cambió la selección, se arma un id
 * nuevo: el mismo id con otros talleres sería `DISPATCH_ID_CONFLICT`.
 *
 * ── El mensaje sobrevive a la relectura ───────────────────────────────────
 *
 * El componente queda montado en todos los estados (la ruta lo monta con
 * `key` por pedido), así que un `router.invalidate()` después de un error o de
 * un éxito no se lleva el aviso — misma lección que `QuoteRequestActions`.
 */
export function PartnerDispatch({ quoteRequestId, data }: { quoteRequestId: string; data: PartnerDispatchResult }) {
  const router = useRouter()
  const [refreshing, setRefreshing] = useState(false)
  // El último resultado de una aprobación. Vive acá, no en el bloque de
  // candidatos, para que una relectura que cambia el borrador no lo borre.
  const [notice, setNotice] = useState<Notice | null>(null)

  const refresh = async () => {
    setRefreshing(true)
    try {
      await router.invalidate()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <Card className="mb-4">
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-1.5 font-heading text-base font-semibold">
              <Send className="size-4 text-muted-foreground" aria-hidden />
              Despacho por WhatsApp
            </h2>
            <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">
              El backend le manda el pedido a hasta {formatInt(MAX_DISPATCH_SLOTS)} talleres cercanos, sin datos de la
              persona. El que acepta recibe los detalles. Vos elegís a quiénes y aprobás.
            </p>
          </div>
          {data.available ? (
            <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
              <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} aria-hidden />
              Actualizar
            </Button>
          ) : null}
        </div>

        {!data.available ? (
          <p className="max-w-prose text-sm text-muted-foreground">
            Falta desplegar la migración 0142 del backend (<code className="font-mono">partner_outreach</code>). Hasta
            entonces no se puede despachar desde acá; derivá a mano desde «Talleres candidatos».
          </p>
        ) : (
          <>
            {notice ? <NoticeBox notice={notice} /> : null}

            {data.draft.ok ? (
              <DraftSection
                key={draftKey(data.draft.data)}
                quoteRequestId={quoteRequestId}
                draft={data.draft.data}
                staleIds={notice?.kind === 'error' ? notice.staleIds : []}
                onNotice={setNotice}
                onRefresh={refresh}
              />
            ) : (
              <ErrorBlock error={data.draft.error} what="el borrador" />
            )}

            <section className="space-y-2 border-t border-border pt-4">
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Seguimiento</h3>
              {data.outreach.ok ? (
                data.outreach.data.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Todavía no se despachó este pedido.</p>
                ) : (
                  <ul className="space-y-3">
                    {data.outreach.data.map((row) => (
                      <li key={row.id}>
                        <OutreachBlock row={row} />
                      </li>
                    ))}
                  </ul>
                )
              ) : (
                <ErrorBlock error={data.outreach.error} what="el seguimiento" />
              )}
              <p className="text-xs leading-relaxed text-muted-foreground">
                No se actualiza solo: el backend todavía no recibe las respuestas de los talleres. Tocá «Actualizar»
                para ver el estado más reciente. Las horas son UTC.
              </p>
            </section>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * La firma del borrador: cuando cambian los candidatos o los lugares (una
 * relectura), la sección se remonta y la selección vuelve al default. Lo que
 * tiene que sobrevivir —el aviso— vive en el padre.
 */
const draftKey = (d: DispatchDraft) =>
  `${d.readiness.status}|${d.freeSlots}|${d.candidates.map((c) => c.partnerId).join(',')}`

type Notice =
  | { kind: 'success'; text: string }
  | { kind: 'error'; text: string; staleIds: Array<string> }
  | { kind: 'disabled'; text: string }

function NoticeBox({ notice }: { notice: Notice }) {
  if (notice.kind === 'success')
    return (
      <p role="status" className="rounded-md border border-status-green/30 bg-status-green-bg px-3 py-2 text-sm text-status-green">
        {notice.text}
      </p>
    )
  if (notice.kind === 'disabled')
    return (
      <p role="status" className="rounded-md border border-border bg-secondary px-3 py-2 text-sm leading-relaxed">
        {notice.text}
      </p>
    )
  return (
    <p role="alert" className="rounded-md border border-destructive/30 px-3 py-2 text-sm leading-relaxed text-destructive">
      {notice.text}
    </p>
  )
}

function ErrorBlock({ error, what }: { error: string; what: string }) {
  const readable = readablePartnerDispatchError(new Error(error))
  return readable.disabled ? (
    <p className="rounded-md border border-border bg-secondary px-3 py-2 text-sm leading-relaxed">{readable.text}</p>
  ) : (
    <p role="alert" className="text-sm leading-relaxed text-destructive">
      No pudimos leer {what}. {readable.text}
    </p>
  )
}

function Warn({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-status-yellow/30 bg-status-yellow-bg px-3 py-2 text-sm leading-relaxed text-status-yellow">
      {children}
    </div>
  )
}

// ── El borrador ─────────────────────────────────────────────────────────────

function DraftSection({
  quoteRequestId,
  draft,
  staleIds,
  onNotice,
  onRefresh,
}: {
  quoteRequestId: string
  draft: DispatchDraft
  staleIds: Array<string>
  onNotice: (n: Notice | null) => void
  onRefresh: () => Promise<void>
}) {
  const ready = draft.readiness.status === 'ready'
  const maxSelectable = Math.max(0, Math.min(draft.freeSlots, MAX_DISPATCH_SLOTS))

  // Default: todos los candidatos tildados cuando está listo, hasta los lugares libres.
  const [selected, setSelected] = useState<Array<string>>(() =>
    ready ? draft.candidates.slice(0, maxSelectable).map((c) => c.partnerId) : [],
  )
  const [reviewed, setReviewed] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dispatchId, setDispatchId] = useState<string | null>(null)
  // La selección con la que falló el último intento: si cambia, el id viejo no sirve.
  const [failedSelection, setFailedSelection] = useState<string | null>(null)
  const inFlight = useRef(false)

  const selectionKey = [...selected].sort().join(',')
  const canApprove = ready && reviewed && selected.length >= 1 && selected.length <= maxSelectable

  const toggle = (id: string, on: boolean) => {
    setSelected((prev) => (on ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)))
    setConfirming(false)
  }

  const openConfirm = () => {
    // En el handler, nunca en el render: `crypto.randomUUID()` no corre en SSR.
    if (!dispatchId || (failedSelection !== null && failedSelection !== selectionKey)) {
      setDispatchId(crypto.randomUUID())
      setFailedSelection(null)
    }
    setConfirming(true)
  }

  const approve = async () => {
    if (!canApprove || !dispatchId || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    // El orden de la selección es el de los candidatos del borrador.
    const partnerIds = draft.candidates.map((c) => c.partnerId).filter((id) => selected.includes(id))
    try {
      const result = await approvePartnerDispatchFn({ data: { quoteRequestId, dispatchId, partnerIds } })
      const n = result.outreach.length
      onNotice({
        kind: 'success',
        text: `Despacho aprobado: ${n === 1 ? 'un taller' : `${formatInt(n)} talleres`}. El backend manda los WhatsApp en segundo plano; el seguimiento está abajo.`,
      })
      setDispatchId(null)
      setFailedSelection(null)
      setConfirming(false)
      await onRefresh()
    } catch (cause) {
      const readable = readablePartnerDispatchError(cause)
      setFailedSelection(selectionKey)
      onNotice(
        readable.disabled
          ? { kind: 'disabled', text: readable.text }
          : {
              kind: 'error',
              text: `${readable.text} Si reintentás con los mismos talleres no se duplica; si cambiás la selección, el panel arma un despacho nuevo.`,
              staleIds: readable.staleIds,
            },
      )
      setConfirming(false)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const reasons = draft.readiness.reasons
  const hints = reasons.map((r) => READINESS_REASON_HINTS[r]).filter((h): h is string => h !== undefined)
  const selectedNames = draft.candidates.filter((c) => selected.includes(c.partnerId)).map((c) => c.name)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span>
          <span className="text-muted-foreground">Rubros: </span>
          {draft.rubros.length === 0 ? (
            <span className="text-muted-foreground">sin clasificar</span>
          ) : (
            draft.rubros.map((r, i) => (
              <span key={r.slug}>
                {i > 0 ? ', ' : ''}
                <span className={r.primary ? 'font-medium' : undefined}>{r.name}</span>
                {r.primary ? <span className="text-xs text-muted-foreground"> (principal)</span> : null}
              </span>
            ))
          )}
        </span>
        <span>
          <span className="text-muted-foreground">Zona: </span>
          {draft.locality ?? <span className="text-muted-foreground">sin localidad</span>}
        </span>
        <span className="text-muted-foreground">
          {formatInt(draft.freeSlots)} {draft.freeSlots === 1 ? 'lugar libre' : 'lugares libres'} de {formatInt(MAX_DISPATCH_SLOTS)}
        </span>
      </div>

      {draft.readiness.status === 'needs_info' ? (
        <Warn>
          <p className="font-medium">{readinessStatusLabel('needs_info')} para despachar:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {reasons.map((r) => (
              <li key={r}>{readinessReasonLabel(r)}</li>
            ))}
          </ul>
          {hints.length > 0 ? <p className="mt-1.5">{hints.join(' ')}</p> : null}
        </Warn>
      ) : draft.readiness.status !== 'ready' ? (
        <div className="rounded-md border border-border bg-secondary px-3 py-2 text-sm leading-relaxed">
          <p className="font-medium">{readinessStatusLabel(draft.readiness.status)}</p>
          {reasons.length > 0 ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
              {reasons.map((r) => (
                <li key={r}>{readinessReasonLabel(r)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {draft.piiWarning ? (
        <Warn>
          <p>{draft.piiWarning.message}</p>
          {draft.piiWarning.kinds.length > 0 ? (
            <p className="mt-1">Detectado: {draft.piiWarning.kinds.map(piiKindLabel).join(', ')}. Se reemplazó por «[dato oculto]».</p>
          ) : null}
        </Warn>
      ) : null}

      <section className="space-y-1">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Lo que recibe el taller que acepta
        </h3>
        <p className="whitespace-pre-wrap rounded-md border border-border bg-surface-2 px-3 py-2 text-sm leading-relaxed">
          {draft.detailsPreview.text}
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Candidatos</h3>
        {draft.candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin candidatos a 5 km o menos que cubran el rubro principal.</p>
        ) : (
          <ul className="space-y-2">
            {draft.candidates.map((c) => (
              <li key={c.partnerId}>
                <CandidateRow
                  candidate={c}
                  checked={selected.includes(c.partnerId)}
                  disabled={
                    !ready || busy || (!selected.includes(c.partnerId) && selected.length >= maxSelectable)
                  }
                  stale={staleIds.includes(c.partnerId)}
                  onChange={(on) => toggle(c.partnerId, on)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {draft.excluded.length > 0 ? (
        <section className="space-y-1">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Excluidos</h3>
          <ul className="space-y-0.5 text-sm">
            {draft.excluded.map((x) => (
              <li key={`${x.partnerId}-${x.reason}`}>
                <span className={x.name ? undefined : 'text-muted-foreground'}>{x.name ?? 'Taller sin nombre'}</span>
                <span className="text-muted-foreground"> · {exclusionReasonLabel(x.reason)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {ready ? (
        <div className="space-y-3 rounded-md border border-border px-3 py-3">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={reviewed}
              onCheckedChange={(v) => {
                setReviewed(v === true)
                setConfirming(false)
              }}
              disabled={busy}
            />
            <span>Revisé la descripción que va a recibir el taller.</span>
          </label>

          {confirming ? (
            <div className="space-y-2">
              <p className="text-sm leading-relaxed">
                Se le manda el primer contacto por WhatsApp a{' '}
                <span className="font-medium">{selectedNames.join(', ')}</span>. Ocupa{' '}
                {selected.length === 1 ? 'un lugar' : `${formatInt(selected.length)} lugares`} del pedido y no cambia su
                estado. No se puede deshacer.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={approve} disabled={!canApprove || busy}>
                  {busy ? 'Aprobando…' : 'Sí, despachar'}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
                  Cancelar
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" size="sm" onClick={openConfirm} disabled={!canApprove || busy}>
                Aprobar despacho
              </Button>
              {!canApprove ? (
                <span className="text-xs text-muted-foreground">
                  {!reviewed
                    ? 'Tildá que revisaste la descripción.'
                    : selected.length === 0
                      ? 'Elegí al menos un taller.'
                      : `Como mucho ${formatInt(maxSelectable)} ${maxSelectable === 1 ? 'taller' : 'talleres'}.`}
                </span>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function CandidateRow({
  candidate: c,
  checked,
  disabled,
  stale,
  onChange,
}: {
  candidate: DispatchCandidate
  checked: boolean
  disabled: boolean
  stale: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2',
        stale ? 'border-destructive/40' : 'border-border',
      )}
    >
      <label className="flex items-start gap-2">
        <Checkbox className="mt-0.5" checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium">{c.name}</span>
            <span className="text-xs text-muted-foreground">{distanceBucketLabel(c.distanceBucket)}</span>
            {stale ? <span className="text-xs text-destructive">ya no es candidato — actualizá</span> : null}
          </span>
          <span className="mt-0.5 block text-xs">
            {c.coveredRubros.length > 0 ? (
              <span className="text-muted-foreground">Cubre: {c.coveredRubros.join(', ')}</span>
            ) : null}
            {c.uncoveredRubros.length > 0 ? (
              <span className="text-status-yellow">
                {c.coveredRubros.length > 0 ? ' · ' : ''}No cubre: {c.uncoveredRubros.join(', ')}
              </span>
            ) : null}
          </span>
        </span>
      </label>
      <details className="mt-1.5 pl-6 text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Ver el mensaje que recibe</summary>
        <p className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-surface-2 px-3 py-2 text-sm leading-relaxed">
          {c.templatePreview.text}
        </p>
      </details>
    </div>
  )
}

// ── El seguimiento ──────────────────────────────────────────────────────────

const TONE_CLASSES: Record<OutreachTone, string> = {
  success: 'border-status-green/30 bg-status-green-bg text-status-green',
  warn: 'border-status-yellow/30 bg-status-yellow-bg text-status-yellow',
  danger: 'border-status-red/30 bg-status-red-bg text-status-red',
  neutral: 'border-border bg-secondary text-muted-foreground',
}

function OutreachBlock({ row }: { row: OutreachRow }) {
  const stamps: Array<[string, string | null]> = [
    ['aprobado', row.approvedAt],
    ['enviado', row.templateSentAt],
    ['respondió', row.respondedAt],
    ['vence', row.expiresAt],
  ]
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('text-sm font-medium', row.partnerName ? undefined : 'text-muted-foreground')}>
          {row.partnerName ?? 'Taller borrado'}
        </span>
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 text-[11px] font-medium',
            TONE_CLASSES[outreachStatusTone(row.status)],
          )}
        >
          {outreachStatusLabel(row.status)}
        </span>
        {row.deliveryStatus ? (
          <span className="text-xs text-muted-foreground">entrega: {deliveryStatusLabel(row.deliveryStatus)}</span>
        ) : null}
        {row.failureReason ? (
          <span className="text-xs text-status-red">{failureReasonLabel(row.failureReason)}</span>
        ) : null}
        {row.whatsappConversationId ? (
          // Al hilo por el UUID de la conversación: el número NUNCA va a la URL.
          <Link
            to="/whatsapp/$conversationId"
            params={{ conversationId: row.whatsappConversationId }}
            className="ml-auto text-xs text-brand hover:underline"
          >
            Abrir conversación
          </Link>
        ) : null}
      </div>
      <p className="mt-1 flex flex-wrap gap-x-3 text-xs tabular-nums text-muted-foreground">
        {stamps
          .filter((s): s is [string, string] => s[1] !== null)
          .map(([what, at]) => (
            <span key={what}>
              {what} {formatDateTime(at)}
            </span>
          ))}
      </p>
      {row.messages.length > 0 ? (
        <ol className="mt-2 space-y-1.5">
          {row.messages.map((m, i) => {
            const outbound = m.direction === 'outbound'
            return (
              <li key={`${m.at}-${i}`} className={cn('flex', outbound ? 'justify-end' : 'justify-start')}>
                <div
                  className={cn(
                    'max-w-[85%] rounded-md border px-3 py-1.5',
                    outbound ? 'border-border bg-surface-2' : 'border-border bg-card',
                  )}
                >
                  <p className="text-[11px] text-muted-foreground">
                    {messageDirectionLabel(m.direction)} · {messageKindLabel(m.kind)} · {formatDateTime(m.at)}
                  </p>
                  <p className={cn('whitespace-pre-wrap text-sm', m.text === null && 'text-muted-foreground')}>
                    {m.text ?? '(sin texto)'}
                  </p>
                </div>
              </li>
            )
          })}
        </ol>
      ) : null}
    </div>
  )
}
