import { useMemo, useRef, useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { ArrowLeft, Check, Copy, MessageCircle } from 'lucide-react'
import { z } from 'zod'
import { getFollowupFn, setFollowupSentFn } from '~/fn/quote-followup'
import { attributePartnerFeeFn } from '~/fn/partner-fees'
import { declareQuoteUserOutcomeOnBehalfFn, selectQuoteProposalOnBehalfFn } from '~/fn/quote-user-flow'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Textarea } from '~/components/ui/textarea'
import { formatDateTimeBuenosAires } from '~/lib/format'
import {
  FOLLOWUP_QUICK_REPLIES,
  FOLLOWUP_TABS,
  FOLLOWUP_TAB_LABELS,
  buildFollowupContacts,
  fmtAuto,
  fmtFecha,
  fmtPhone,
  matchesFollowupSearch,
  que,
  talleres,
  type FollowupContact,
  type FollowupOrder,
  type FollowupTab,
} from '~/lib/quote-followup'
import {
  QUOTE_NOT_HIRED_REASONS,
  QUOTE_NOT_HIRED_REASON_LABELS,
  canDeclareOutcomeOnBehalf,
  readableDeclareOutcomeError,
  readableSelectProposalError,
  type QuoteNotHiredReason,
} from '~/lib/quote-user-flow'
import { readablePartnerFeeError } from '~/lib/partner-fees'
import type { PartnerOption } from '~/lib/partners'
import { cn } from '~/lib/utils'

/**
 * Seguimiento de pedidos (`/leads/pedidos/seguimiento`) — el porteo del
 * prototipo de Nicolás: escribirle a cada persona con pedidos sin resultado,
 * saber a quién ya se le escribió (guardado para todo el equipo, 041) y cargar
 * cómo terminó desde la misma tarjeta. → `~/lib/quote-followup`
 *
 * Cargar el resultado reusa los caminos que ya existen: declarar «fue / no fue
 * / todavía no» en nombre de la persona (HTTP al backend, igual que la ficha),
 * marcar la propuesta elegida si el pedido sigue abierto, y si no, anotar el
 * taller en la atribución de Liquidaciones (038) — así alimenta el cobro.
 *
 * SSR completo: "hoy" lo calcula el servidor; los mensajes dependen de él.
 */
const searchSchema = z.object({
  followupTab: z.enum(FOLLOWUP_TABS).catch('prop').default('prop'),
})

export const Route = createFileRoute('/_authed/leads/pedidos/seguimiento')({
  validateSearch: searchSchema,
  loader: () => getFollowupFn(),
  head: () => ({ meta: [{ title: 'Seguimiento de pedidos — AutoLibre' }] }),
  component: FollowupPage,
})

function FollowupPage() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [q, setQ] = useState('')
  const [hideSent, setHideSent] = useState(false)

  const contacts = useMemo(() => buildFollowupContacts(data.rows, data.today), [data.rows, data.today])
  const tab = search.followupTab
  const inTab = (t: FollowupTab) => (t === 'all' ? contacts : contacts.filter((c) => c.group === t))
  const visible = inTab(tab).filter((c) => (!hideSent || !c.sent) && matchesFollowupSearch(c, q))
  const done = contacts.filter((c) => c.sent).length
  const orders = contacts.reduce((s, c) => s + c.pedidos.length, 0)

  return (
    <>
      <Link to="/leads/pedidos" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" aria-hidden /> Pedidos
      </Link>
      <PageHeader
        title="Seguimiento de pedidos"
        subtitle={`Pedidos desde el 1 de septiembre sin resultado cargado · ${contacts.length} personas, ${orders} pedidos`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      {!data.sendsAvailable && (
        <p className="mb-4 rounded-lg border border-status-yellow/30 bg-status-yellow-bg px-4 py-2 text-xs text-status-yellow">
          Falta aplicar la migración 041: «Marcar enviado» no se puede guardar en esta base.
        </p>
      )}

      <div className="mb-2 flex items-baseline gap-2">
        <span className="font-heading text-4xl font-bold tabular-nums">{done}</span>
        <span className="text-sm text-muted-foreground">de {contacts.length} personas con el mensaje enviado</span>
      </div>
      <div className="mb-6 h-2 overflow-hidden rounded-full border border-border bg-surface-2">
        <div className="h-full bg-status-green" style={{ width: contacts.length ? `${(100 * done) / contacts.length}%` : '0' }} />
      </div>

      <details className="mb-4 rounded-lg border border-border bg-card px-4 py-3">
        <summary className="cursor-pointer font-heading text-sm font-semibold">Respuestas según lo que te contesten</summary>
        <div className="mt-3 space-y-3">
          {FOLLOWUP_QUICK_REPLIES.map((r) => (
            <div key={r.when} className="border-t border-border pt-2 text-sm">
              <p className="font-medium">{r.when}</p>
              <p className="text-xs text-muted-foreground">{r.admin}</p>
              <p className="my-1">{r.text}</p>
              <CopyButton text={r.text} label="Copiar respuesta" />
            </div>
          ))}
        </div>
      </details>

      <div className="sticky top-0 z-10 -mx-4 mb-4 border-b border-border bg-background px-4 py-2">
        <div className="flex flex-wrap gap-1.5">
          {FOLLOWUP_TABS.map((t) => {
            const list = inTab(t)
            return (
              <button
                key={t}
                type="button"
                aria-pressed={tab === t}
                onClick={() => void navigate({ search: { followupTab: t }, replace: true, resetScroll: false })}
                className={cn(
                  'rounded-full border px-3 py-1 text-sm',
                  tab === t ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card',
                )}
              >
                {FOLLOWUP_TAB_LABELS[t]}{' '}
                <span className="opacity-75">
                  {list.filter((c) => !c.sent).length}/{list.length}
                </span>
              </button>
            )
          })}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nombre, pedido, auto o teléfono"
            className="h-9 min-w-64 flex-1 rounded-md border border-input bg-surface px-3 text-sm"
          />
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <input type="checkbox" checked={hideSent} onChange={(e) => setHideSent(e.target.checked)} /> Ocultar enviados
          </label>
        </div>
      </div>

      <div className="space-y-3">
        {visible.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No hay personas en este filtro.
          </p>
        ) : (
          visible.map((c) => (
            <ContactCard key={c.key} contact={c} canSave={data.sendsAvailable} options={data.partnerOptions} today={data.today} />
          ))
        )}
      </div>
    </>
  )
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  return (
    <Button
      size="sm"
      variant="outline"
      className="shadow-none"
      onClick={() =>
        navigator.clipboard
          .writeText(text)
          .then(() => setState('ok'))
          .catch(() => setState('fail'))
      }
    >
      <Copy className="size-4" aria-hidden /> {state === 'ok' ? 'Copiado' : state === 'fail' ? 'No se pudo copiar' : label}
    </Button>
  )
}

const GROUP_BADGE: Record<FollowupContact['group'], string> = {
  prop: 'border-brand bg-brand-soft text-brand',
  sin: 'border-status-violet bg-status-violet-bg text-status-violet',
  f0: 'border-status-yellow bg-status-yellow-bg text-status-yellow',
}

function ContactCard({
  contact: c,
  canSave,
  options,
  today,
}: {
  contact: FollowupContact
  canSave: boolean
  options: ReadonlyArray<PartnerOption>
  today: string
}) {
  const router = useRouter()
  const [msg, setMsg] = useState(c.msg)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const wa = c.waDigits ? `https://wa.me/${c.waDigits}?text=${encodeURIComponent(msg)}` : null

  const toggleSent = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await setFollowupSentFn({ data: { quoteRequestIds: c.pedidos.map((p) => p.id), sent: !c.sent } })
      await router.invalidate()
    } catch (e) {
      setError(`No se pudo guardar: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <article className={cn('space-y-2 rounded-xl border border-border p-4', c.sent ? 'bg-surface-2' : 'bg-card')}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-heading text-base font-semibold">{c.nombre ?? 'Sin nombre'}</span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs">
          {c.lastSentAt && (
            <span className="text-status-green">
              Enviado {formatDateTimeBuenosAires(c.lastSentAt)}
              {c.lastSentBy ? ` por ${c.lastSentBy}` : ''}
            </span>
          )}
          <Badge variant="outline" className={GROUP_BADGE[c.group]}>
            {FOLLOWUP_TAB_LABELS[c.group]}
          </Badge>
          {c.reciente && <Badge variant="outline">Reciente</Badge>}
          {c.newOrder && <Badge variant="outline">Pedido nuevo</Badge>}
        </span>
      </div>

      <ul className="space-y-1 text-sm text-muted-foreground">
        {c.pedidos.map((p) => (
          <OrderLine key={p.id} order={p} options={options} today={today} />
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium tabular-nums">{fmtPhone(c.key)}</span>
        <CopyButton text={`+${c.key}`} label="Copiar teléfono" />
        {wa ? (
          <Button asChild size="sm" variant="outline" className="shadow-none">
            <a href={wa} target="_blank" rel="noreferrer">
              <MessageCircle className="size-4" aria-hidden /> Abrir chat
            </a>
          </Button>
        ) : (
          <span className="text-xs text-status-yellow">El teléfono no se pudo normalizar para WhatsApp.</span>
        )}
      </div>

      <Textarea rows={4} value={msg} onChange={(e) => setMsg(e.target.value)} aria-label={`Mensaje para ${c.nombre ?? 'la persona'}`} />
      <div className="flex flex-wrap gap-2">
        <CopyButton text={msg} label="Copiar mensaje" />
        <Button size="sm" variant={c.sent ? 'outline' : 'default'} className="shadow-none" disabled={busy || !canSave} onClick={() => void toggleSent()}>
          {c.sent ? (
            <>
              <Check className="size-4" aria-hidden /> Enviado · desmarcar
            </>
          ) : (
            'Marcar enviado'
          )}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </article>
  )
}

function OrderLine({ order: p, options, today }: { order: FollowupOrder; options: ReadonlyArray<PartnerOption>; today: string }) {
  const [open, setOpen] = useState(false)
  const ts = talleres(p)
  const extra = p.elegido
    ? ` · eligió ${p.elegido}`
    : ts.length
      ? ` · ${ts.length} propuesta${ts.length > 1 ? 's' : ''}: ${ts.join(', ')}`
      : p.cierre === 'no_workshops_found'
        ? ' · sin mecánicos en la zona'
        : ' · sin propuestas cargadas'
  return (
    <li>
      <Link to="/leads/pedidos/$quoteRequestId" params={{ quoteRequestId: p.id }} className="font-semibold text-foreground hover:underline">
        AL-{p.n}
      </Link>{' '}
      · {fmtFecha(p.fecha)} · {fmtAuto(p.auto) || 'auto sin dato'}
      {p.plate ? ` (${p.plate})` : ''} · {que(p)}
      {extra}
      {p.outcome === 'no_response' ? ' · ya sin respuesta en la Fase 0' : ''}{' '}
      <button type="button" className="text-brand hover:underline" onClick={() => setOpen((v) => !v)}>
        {open ? 'Cerrar' : 'Cargar resultado'}
      </button>
      {open && <ResultForm order={p} options={options} today={today} />}
    </li>
  )
}

type Who = '' | `p:${string}` | `d:${string}`

function ResultForm({ order: p, options, today }: { order: FollowupOrder; options: ReadonlyArray<PartnerOption>; today: string }) {
  const router = useRouter()
  const [outcome, setOutcome] = useState<'hired' | 'not_hired' | 'pending' | ''>('')
  const [day, setDay] = useState(today)
  const [who, setWho] = useState<Who>('')
  const [reason, setReason] = useState<QuoteNotHiredReason | ''>('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const inFlight = useRef(false)

  const canDeclare = canDeclareOutcomeOnBehalf({ userId: null, status: p.status, answeredAt: p.answeredAt, closeReasonCode: p.cierre })
  const proposalPartners = new Set(p.proposals.map((x) => x.partnerId).filter(Boolean))

  if (!canDeclare)
    return (
      <p className="mt-1 text-xs text-status-yellow">
        Este pedido no tiene respuesta del equipo registrada: el backend no deja declarar el resultado. Cargalo desde la{' '}
        <Link to="/leads/pedidos/$quoteRequestId" params={{ quoteRequestId: p.id }} className="underline">
          ficha
        </Link>{' '}
        (cerrar con resultado).
      </p>
    )

  const save = async () => {
    if (inFlight.current || !outcome) return
    inFlight.current = true
    setBusy(true)
    setMsg(null)
    try {
      await declareQuoteUserOutcomeOnBehalfFn({
        data: {
          quoteRequestId: p.id,
          outcome,
          ...(outcome === 'hired' ? { performedOn: day } : {}),
          ...(outcome === 'not_hired' ? { notHiredReason: reason || null, notHiredNote: note.trim() || null } : {}),
        },
      })
      let extra = ''
      if (outcome === 'hired' && who) {
        try {
          if (who.startsWith('p:') && p.status !== 'closed') {
            await selectQuoteProposalOnBehalfFn({ data: { quoteRequestId: p.id, proposalId: who.slice(2) } })
          } else {
            const partnerId = who.startsWith('d:')
              ? who.slice(2)
              : (p.proposals.find((x) => x.id === who.slice(2))?.partnerId ?? null)
            if (partnerId) await attributePartnerFeeFn({ data: { quoteRequestId: p.id, partnerId, note: 'Cargado desde Seguimiento' } })
            else extra = ' El taller es de afuera del directorio: no queda atribuido para el cobro.'
          }
        } catch (e) {
          const r = readableSelectProposalError(e)
          extra = ` El resultado quedó guardado, pero no el taller: ${r?.text ?? readablePartnerFeeError(e instanceof Error ? e.message : String(e))}`
        }
      }
      setMsg({ ok: true, text: `Guardado.${extra}` })
      await router.invalidate()
    } catch (e) {
      setMsg({ ok: false, text: readableDeclareOutcomeError(e)?.text ?? `No se pudo guardar: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border bg-surface p-3 text-sm text-foreground">
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            ['hired', 'Fue'],
            ['not_hired', 'No fue'],
            ['pending', 'Todavía no'],
          ] as const
        ).map(([v, l]) => (
          <button
            key={v}
            type="button"
            aria-pressed={outcome === v}
            onClick={() => setOutcome(v)}
            className={cn('rounded-md border px-3 py-1', outcome === v ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}
          >
            {l}
          </button>
        ))}
      </div>
      {outcome === 'hired' && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Fecha del trabajo
            <input type="date" max={today} min={p.fecha} value={day} onChange={(e) => setDay(e.target.value)} className="h-9 rounded-md border border-input bg-surface px-2 text-sm text-foreground" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Con quién
            <select value={who} onChange={(e) => setWho(e.target.value as Who)} className="h-9 min-w-56 rounded-md border border-input bg-surface px-2 text-sm text-foreground">
              <option value="">No sé / no lo dijo</option>
              {p.proposals.length > 0 && (
                <optgroup label="Propuestas del pedido">
                  {p.proposals.map((x) => (
                    <option key={x.id} value={`p:${x.id}`}>
                      {x.name}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Otro taller del directorio">
                {options
                  .filter((o) => !proposalPartners.has(o.id))
                  .map((o) => (
                    <option key={o.id} value={`d:${o.id}`}>
                      {o.name}
                    </option>
                  ))}
              </optgroup>
            </select>
          </label>
        </div>
      )}
      {outcome === 'not_hired' && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Motivo
            <select value={reason} onChange={(e) => setReason(e.target.value as QuoteNotHiredReason | '')} className="h-9 rounded-md border border-input bg-surface px-2 text-sm text-foreground">
              <option value="">Sin motivo</option>
              {QUOTE_NOT_HIRED_REASONS.map((r) => (
                <option key={r} value={r}>
                  {QUOTE_NOT_HIRED_REASON_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          <input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Observación (opcional)" className="h-9 min-w-64 flex-1 rounded-md border border-input bg-surface px-2" />
        </div>
      )}
      <Button size="sm" disabled={busy || !outcome || (outcome === 'hired' && !day)} onClick={() => void save()}>
        Guardar resultado
      </Button>
      <p className="text-xs text-muted-foreground">
        Se guarda como cargado por el equipo en nombre de la persona. Con «Fue» o «No fue» el pedido sale de esta lista.
      </p>
      {msg && <p className={cn('text-xs', msg.ok ? 'text-status-green' : 'text-destructive')}>{msg.text}</p>}
    </div>
  )
}
