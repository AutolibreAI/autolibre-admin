import { useMemo, useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { Check, MessageCircle, Undo2 } from 'lucide-react'
import { listFreePlanNoticesFn, setFreePlanNoticeFn } from '~/fn/partner-free-plan-notice'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { formatArs, formatDateTimeBuenosAires, formatInt } from '~/lib/format'
import { PARTNER_FEE_CONFIG } from '~/lib/partner-fees-config'
import {
  FREE_PLAN_NOTICE_CHANNELS,
  FREE_PLAN_NOTICE_CHANNEL_LABELS,
  FREE_PLAN_NOTICE_NOTE_MAX,
  FREE_PLAN_NOTICE_STATES,
  FREE_PLAN_NOTICE_STATE_LABELS,
  freePlanNoticeChannelLabel,
  freePlanNoticeProgress,
  freePlanNoticeSearchSchema,
  freePlanNoticeWhatsAppUrl,
  matchesFreePlanNoticeFilters,
  readableFreePlanNoticeError,
  type FreePlanNoticeChannel,
  type FreePlanNoticeRow,
  type FreePlanNoticeSearch,
} from '~/lib/partner-free-plan-notice'
import { cn } from '~/lib/utils'

/**
 * `/partners/plan-gratis` — «Aviso plan gratis» (migración 042).
 *
 * El plan gratis cambió: el primer trabajo que le llevamos a un proveedor es
 * gratis, y desde el segundo se cobra un fee fijo por trabajo. Esta pantalla
 * es la lista de proveedores con plan gratis HOY (plan efectivo, la misma regla
 * que Propuestas) y el tilde de «ya está avisado», con quién, cuándo, canal y
 * nota. Reemplaza la planilla/chat donde se iba anotando a quién se le avisó.
 *
 * No toca Liquidaciones ni `partner-fees-config` (`PRIMER_CLIENTE_GRATIS` sigue
 * apagado): sólo registra el aviso. → `.claude/rules/partner-free-plan-notice.md`
 *
 * SSR completo (`true`, heredado): es una tabla de decenas de filas, la fecha
 * del aviso se formatea en hora de Buenos Aires con zona pineada (mismo string
 * en servidor y cliente) y no hay nada lento que streamear. Los filtros podan
 * en el cliente sobre lo que ya vino.
 */
export const Route = createFileRoute('/_authed/partners/plan-gratis')({
  validateSearch: freePlanNoticeSearchSchema,
  loader: () => listFreePlanNoticesFn(),
  head: () => ({ meta: [{ title: 'Aviso de cobro · Partners — AutoLibre' }] }),
  component: FreePlanNoticeView,
})

function FreePlanNoticeView() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const setSearch = (patch: Partial<FreePlanNoticeSearch>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true, resetScroll: false })

  const rows = data.available ? data.rows : []
  const visible = useMemo(() => rows.filter((r) => matchesFreePlanNoticeFilters(r, search)), [rows, search])
  const progress = useMemo(() => freePlanNoticeProgress(rows, search), [rows, search])

  const header = (
    <PageHeader
      title="Aviso del cambio de cobro"
      subtitle={`Sin planes: primer trabajo gratis; desde el segundo, ${formatArs(PARTNER_FEE_CONFIG.FEE_POR_TRABAJO)} por trabajo o un paquete`}
      actions={<SsrTag>ssr: full</SsrTag>}
    />
  )

  if (!data.available) {
    return (
      <>
        {header}
        <Card className="shadow-none">
          <CardContent className="py-6 text-sm">
            {data.reason === 'migration' ? (
              <>
                Falta aplicar la migración <code>042_ops_aviso_plan_gratis.sql</code> en esta base (la aplica el deploy
                de producción; en DEV, <code>pnpm db:migrate</code>). Sin ella no hay dónde guardar quién está avisado.
              </>
            ) : (
              <>
                Esta base no tiene el billing del backend (<code>subscription_plans</code> /{' '}
                <code>partner_subscriptions</code>): no se puede saber qué proveedores tienen plan gratis.
              </>
            )}
          </CardContent>
        </Card>
      </>
    )
  }

  const state = search.freePlanNoticeState ?? 'all'
  const pct = progress.total === 0 ? 0 : Math.round((progress.notified / progress.total) * 100)

  return (
    <>
      {header}

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <span className="font-heading text-2xl font-bold tabular-nums">
          {formatInt(progress.notified)} de {formatInt(progress.total)}
        </span>
        <span className="text-sm text-muted-foreground">
          avisados {search.freePlanNoticePaused ? '(activos y pausados)' : '(proveedores activos)'}
        </span>
        <div className="h-2 min-w-32 flex-1 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Buscar</span>
          <Input
            key={search.q ?? ''}
            defaultValue={search.q ?? ''}
            placeholder="Nombre, zona o teléfono"
            className="h-8 w-56"
            onBlur={(e) => setSearch({ q: e.target.value.trim() || undefined })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setSearch({ q: e.currentTarget.value.trim() || undefined })
            }}
          />
        </div>
        <FilterGroup label="Estado">
          {FREE_PLAN_NOTICE_STATES.map((s) => (
            <Chip
              key={s}
              active={state === s}
              tone={s === 'sin_avisar' ? 'warn' : 'brand'}
              onClick={() => setSearch({ freePlanNoticeState: s === 'all' ? undefined : s })}
            >
              {FREE_PLAN_NOTICE_STATE_LABELS[s]}
            </Chip>
          ))}
        </FilterGroup>
        <FilterGroup
          label="Canal"
          onClear={search.freePlanNoticeChannel ? () => setSearch({ freePlanNoticeChannel: undefined }) : undefined}
        >
          {FREE_PLAN_NOTICE_CHANNELS.map((c) => (
            <Chip
              key={c}
              active={search.freePlanNoticeChannel === c}
              onClick={() =>
                setSearch({ freePlanNoticeChannel: search.freePlanNoticeChannel === c ? undefined : c })
              }
            >
              {FREE_PLAN_NOTICE_CHANNEL_LABELS[c]}
            </Chip>
          ))}
        </FilterGroup>
        <FilterGroup label="Proveedores">
          <Chip
            active={search.freePlanNoticePaused === true}
            onClick={() => setSearch({ freePlanNoticePaused: search.freePlanNoticePaused ? undefined : true })}
          >
            Incluir pausados
          </Chip>
        </FilterGroup>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Proveedor</th>
              <th className="px-3 py-2 font-medium">Zona</th>
              <th className="px-3 py-2 font-medium">WhatsApp</th>
              <th className="px-3 py-2 font-medium">Aviso</th>
              <th className="px-3 py-2 font-medium">Acción</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                  {rows.length === 0 ? 'No hay proveedores activos ni pausados.' : 'Ningún proveedor coincide con los filtros.'}
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <NoticeRow key={`${r.partnerId}:${r.notice ? r.notice.notifiedAt : 'none'}`} row={r} />
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Desde el 2026-11-26 no hay planes: el cambio aplica a todos los proveedores activos (y pausados, si los
        sumás). Los archivados no se listan. Para corregir el canal o la nota, destildá y volvé a marcar: el historial queda.
      </p>
    </>
  )
}

function NoticeRow({ row: r }: { row: FreePlanNoticeRow }) {
  const router = useRouter()
  const [mode, setMode] = useState<'idle' | 'marking' | 'unmarking'>('idle')
  const [channel, setChannel] = useState<FreePlanNoticeChannel | null>(null)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const waUrl = freePlanNoticeWhatsAppUrl(r.whatsapp, r.name)

  async function submit(notified: boolean) {
    if (saving) return
    if (notified && !channel) {
      setError('Elegí por dónde lo avisaste.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const trimmed = note.trim() || undefined
      await setFreePlanNoticeFn({
        data: notified
          ? { partnerId: r.partnerId, notified: true, channel: channel!, note: trimmed, expectedNotified: false }
          : { partnerId: r.partnerId, notified: false, note: trimmed, expectedNotified: true },
      })
      setMode('idle')
      await router.invalidate()
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause)
      setError(readableFreePlanNoticeError(raw))
      // Otro operador lo cambió: releer para mostrar el estado real.
      if (raw.startsWith('FREE_PLAN_NOTICE_CHANGED')) void router.invalidate()
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="px-3 py-2">
        <Link
          to="/partners/$partnerId"
          params={{ partnerId: r.partnerId }}
          className="font-medium text-foreground underline-offset-2 hover:underline"
        >
          {r.name}
        </Link>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {r.tier === 'founding' ? <Badge variant="outline">Aliado</Badge> : null}
          {r.status === 'paused' ? <Badge variant="outline">pausado</Badge> : null}
        </div>
      </td>
      <td className="px-3 py-2 text-muted-foreground">{r.zone ?? '—'}</td>
      <td className="px-3 py-2">
        {waUrl ? (
          <a
            href={waUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
            title="Abre WhatsApp con el aviso ya escrito (no envía nada solo)"
          >
            <MessageCircle className="size-3.5" aria-hidden />
            {r.whatsapp}
          </a>
        ) : (
          <span className="text-muted-foreground">{r.whatsapp ? `${r.whatsapp} (sin link)` : '—'}</span>
        )}
      </td>
      <td className="px-3 py-2">
        {r.notice ? (
          <div>
            <span className="rounded-md bg-status-green-bg px-2 py-0.5 text-xs font-medium text-status-green">
              Avisado
            </span>
            <div className="mt-1 text-xs text-muted-foreground">
              {formatDateTimeBuenosAires(r.notice.notifiedAt)} · {r.notice.notifiedByLabel ?? 'usuario borrado'} ·{' '}
              {freePlanNoticeChannelLabel(r.notice.channel)}
            </div>
            {r.notice.note ? <div className="mt-0.5 max-w-xs text-xs">«{r.notice.note}»</div> : null}
          </div>
        ) : (
          <span className="rounded-md bg-status-yellow-bg px-2 py-0.5 text-xs font-medium text-status-yellow">
            Sin avisar
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        {mode === 'idle' ? (
          r.notice ? (
            <Button size="xs" variant="ghost" onClick={() => setMode('unmarking')}>
              <Undo2 aria-hidden /> Destildar
            </Button>
          ) : (
            <Button size="xs" variant="outline" onClick={() => setMode('marking')}>
              <Check aria-hidden /> Marcar avisado
            </Button>
          )
        ) : (
          <div className="w-64 space-y-2">
            {mode === 'marking' ? (
              <div className="flex flex-wrap gap-1" role="group" aria-label="Canal del aviso">
                {FREE_PLAN_NOTICE_CHANNELS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={channel === c}
                    onClick={() => setChannel(c)}
                    className={cn(
                      'rounded-md border px-2 py-1 text-xs',
                      channel === c
                        ? 'border-brand bg-brand-soft text-brand'
                        : 'border-border bg-card text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {FREE_PLAN_NOTICE_CHANNEL_LABELS[c]}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs">¿Destildar? Queda «sin avisar»; el aviso anterior sigue en el historial.</p>
            )}
            <Textarea
              value={note}
              maxLength={FREE_PLAN_NOTICE_NOTE_MAX}
              onChange={(e) => setNote(e.target.value)}
              placeholder={mode === 'marking' ? 'Nota (opcional)' : 'Motivo (opcional)'}
              className="min-h-14 text-xs"
            />
            <div className="flex gap-2">
              <Button size="xs" disabled={saving || (mode === 'marking' && !channel)} onClick={() => void submit(mode === 'marking')}>
                {mode === 'marking' ? 'Guardar' : 'Sí, destildar'}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setMode('idle')
                  setError(null)
                }}
              >
                Cancelar
              </Button>
            </div>
          </div>
        )}
        {error ? (
          <p role="alert" className="mt-1 text-xs text-status-red">
            {error}
          </p>
        ) : null}
      </td>
    </tr>
  )
}
