import { useRef, useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { z } from 'zod'
import { Download } from 'lucide-react'
import { getCommissionsFn, setCommercialAwardFn } from '~/fn/commercial-commissions'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import {
  AWARD_CSV_HEADER,
  AWARD_STATUS_LABELS,
  awardCsvRows,
  awardRow,
  awardsVisible,
  groupAwards,
  readableCommissionError,
  type AwardGroup,
  type AwardRow,
} from '~/lib/commercial-commissions'
import { toCsv } from '~/lib/csv'
import { formatArs, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * Liquidaciones a comerciales (`/comercial/liquidaciones`) — el premio por cada
 * proveedor que dio de alta un comercial («Alta por»), cuando ese taller tiene
 * su primer trabajo confirmado (misma regla que Partners › Liquidaciones; cuenta
 * aunque ese trabajo sea gratis para el taller). → `~/lib/commercial-commissions`.
 *
 * Sólo cobra quien tiene «Cobra premio» en Comercial › Equipo (los fundadores
 * no). Las altas que tuvieron suscripción (régimen anterior) van aparte, para
 * resolverlas a mano. Estados pendiente → pagado / anulado (045), CSV para la
 * caja.
 *
 * SSR completo: pocas filas y "hoy" lo calcula el servidor.
 */
const searchSchema = z.object({
  awardShowWaiting: z.coerce.boolean().catch(true).default(true),
})

export const Route = createFileRoute('/_authed/comercial/liquidaciones')({
  validateSearch: searchSchema,
  loader: () => getCommissionsFn(),
  head: () => ({ meta: [{ title: 'Liquidaciones a comerciales · Comercial — AutoLibre' }] }),
  component: AwardsView,
})

const day = (d: string | null) => {
  if (!d) return '—'
  const [y, m, dd] = d.split('-')
  return `${dd}/${m}/${y?.slice(2)}`
}
const money = (n: number | null) => (n === null ? 'a definir' : formatArs(n))

function AwardsView() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  if (!data.available) {
    return (
      <>
        <PageHeader title="Liquidaciones a comerciales" />
        <Card className="shadow-none">
          <CardContent className="py-6 text-sm">
            Falta aplicar la migración <code>045_ops_premios_comerciales.sql</code> (y la 038 liquidaciones y la 035
            «Alta por») en esta base. La aplica el deploy de producción; en DEV, <code>pnpm db:migrate</code>.
          </CardContent>
        </Card>
      </>
    )
  }

  const all = data.facts.map((f) => awardRow(f, data.premioPorAlta)).filter(awardsVisible)
  const legacy = all.filter((r) => r.legacySubscription)
  const current = all.filter((r) => !r.legacySubscription)
  const shown = search.awardShowWaiting ? current : current.filter((r) => r.status !== 'esperando')
  const groups = groupAwards(shown)
  const pending = current.filter((r) => r.status === 'pendiente')
  const pendingTotal = pending.reduce((s, r) => s + (r.amount ?? 0), 0)
  const paidTotal = all.filter((r) => r.status === 'pagado').reduce((s, r) => s + (r.amount ?? 0), 0)
  const hiddenFounders = data.facts.filter((f) => !f.member.earnsAward && !f.award).length

  const downloadCsv = () => {
    const csv = toCsv(AWARD_CSV_HEADER, awardCsvRows(all, day))
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `premios-comerciales-${data.today}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <PageHeader
        title="Liquidaciones a comerciales"
        subtitle={`${formatInt(pending.length)} premios pendientes (${money(data.premioPorAlta === null ? null : pendingTotal)}) · pagado ${formatArs(paidTotal)} · premio por alta ${money(data.premioPorAlta)}`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />
      <div className="mb-4 space-y-1 text-xs text-muted-foreground">
        <p>
          El comercial que dio de alta a un proveedor («Alta por» en Solicitudes) cobra un premio cuando ese taller tiene su
          primer trabajo confirmado (Partners › Liquidaciones), aunque ese trabajo sea gratis para el taller. Ya no hay
          «primera cuota»: no se venden suscripciones.
        </p>
        <p>
          Sólo aparecen las altas de quien tiene «Cobra premio» en{' '}
          <Link to="/comercial/equipo" className="underline underline-offset-2 hover:text-foreground">
            Comercial › Equipo
          </Link>
          {hiddenFounders > 0 ? ` (${hiddenFounders} altas del equipo fundador no se muestran)` : ''}.
          {data.premioPorAlta === null
            ? ' El monto por alta todavía no está definido (PREMIO_POR_ALTA): se ven los premios pero no se pueden marcar pagados.'
            : ''}
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="text-sm text-brand hover:underline"
          onClick={() => void navigate({ search: { awardShowWaiting: !search.awardShowWaiting } })}
        >
          {search.awardShowWaiting ? 'Ocultar' : 'Mostrar'} las altas que esperan el primer trabajo
        </button>
        <Button size="sm" variant="outline" className="ml-auto shadow-none" onClick={downloadCsv}>
          <Download className="size-3.5" aria-hidden /> CSV de pagados (caja)
        </Button>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Ningún comercial tiene altas con premio todavía.
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <GroupCard key={g.member.id} group={g} today={data.today} />
          ))}
        </div>
      )}

      {legacy.length > 0 ? (
        <section className="mt-8">
          <h2 className="mb-1 font-heading text-base font-semibold">Con suscripción (histórico)</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Altas de comerciales que tuvieron una suscripción paga en el régimen anterior (primera cuota para el comercial).
            Se resuelven a mano: pagá o anulá el premio con motivo.
          </p>
          <ul className="divide-y divide-border rounded-md border border-border bg-card">
            {legacy.map((r) => (
              <AwardLine key={r.partnerId} row={r} today={data.today} showMember />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}

function GroupCard({ group: g, today }: { group: AwardGroup; today: string }) {
  return (
    <Card className="shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-baseline justify-between gap-2 text-base">
          <span>
            {g.member.name}
            {!g.member.active && <span className="text-xs font-normal text-muted-foreground"> (inactivo)</span>}
          </span>
          <span className="text-sm font-normal">
            {g.altas} altas · {g.waiting} esperan el primer trabajo · pendiente{' '}
            <strong className="tabular-nums">{formatArs(g.pendingTotal)}</strong> ({g.pendingCount}) · pagado{' '}
            <span className="tabular-nums">{formatArs(g.paidTotal)}</span> ({g.paidCount})
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border rounded-md border border-border">
          {g.rows.map((r) => (
            <AwardLine key={r.partnerId} row={r} today={today} />
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function AwardLine({ row, today, showMember }: { row: AwardRow; today: string; showMember?: boolean }) {
  const router = useRouter()
  const inFlight = useRef(false)
  const [mode, setMode] = useState<null | 'pagar' | 'anular'>(null)
  const [paidOn, setPaidOn] = useState(today)
  const [note, setNote] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (data: Parameters<typeof setCommercialAwardFn>[0]['data']) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await setCommercialAwardFn({ data })
      setMode(null)
    } catch (e) {
      setError(readableCommissionError(e instanceof Error ? e.message : String(e)))
    } finally {
      inFlight.current = false
      setBusy(false)
      await router.invalidate()
    }
  }

  return (
    <li className="space-y-2 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link to="/partners/$partnerId" params={{ partnerId: row.partnerId }} className="font-medium hover:underline">
          {row.partnerName}
        </Link>
        <span className="text-muted-foreground">
          {showMember ? `${row.member.name} · ` : ''}alta {day(row.partnerCreatedOn)}
          {row.firstJob ? ` · primer trabajo ${row.reference} el ${day(row.firstJob.day)}` : ' · sin trabajo confirmado'}
          {row.subscription ? ` · suscripción ${row.subscription.planName} desde ${day(row.subscription.day)}` : ''}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {row.status !== 'esperando' ? <span className="tabular-nums">{money(row.amount)}</span> : null}
          <Badge
            variant="outline"
            className={cn(
              row.status === 'pagado' && 'border-status-green bg-status-green-bg text-status-green',
              row.status === 'pendiente' && 'border-status-yellow bg-status-yellow-bg text-status-yellow',
              (row.status === 'esperando' || row.status === 'anulado') && 'text-muted-foreground',
            )}
          >
            {row.status === 'pagado' ? `Pagado el ${day(row.award?.paidOn ?? null)}` : AWARD_STATUS_LABELS[row.status]}
          </Badge>
          {row.status === 'pendiente' && (
            <Button size="sm" variant="outline" className="h-7 shadow-none" onClick={() => setMode(mode === 'pagar' ? null : 'pagar')}>
              Marcar pagado
            </Button>
          )}
          {(row.status === 'pendiente' || row.status === 'esperando') && (
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setMode(mode === 'anular' ? null : 'anular')}>
              Anular
            </Button>
          )}
          {(row.status === 'pagado' || row.status === 'anulado') && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={busy}
              onClick={() => void save({ status: 'pendiente', partnerId: row.partnerId })}
            >
              Volver a pendiente
            </Button>
          )}
        </span>
      </div>
      {row.award?.status === 'anulado' && row.award.voidReason ? (
        <p className="text-xs text-muted-foreground">Anulado: «{row.award.voidReason}»{row.award.updatedByName ? ` — ${row.award.updatedByName}` : ''}</p>
      ) : null}
      {row.award?.status === 'pagado' && row.award.note ? (
        <p className="text-xs text-muted-foreground">«{row.award.note}»{row.award.updatedByName ? ` — ${row.award.updatedByName}` : ''}</p>
      ) : null}
      {mode === 'pagar' && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Fecha del pago</span>
            <input type="date" max={today} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className="h-9 rounded-md border border-input bg-surface px-2" />
          </label>
          <label className="flex min-w-64 flex-1 flex-col gap-1">
            <span className="text-xs text-muted-foreground">Nota (opcional)</span>
            <input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} className="h-9 rounded-md border border-input bg-surface px-2" />
          </label>
          <Button
            size="sm"
            className="h-9"
            disabled={busy || !paidOn || row.amount === null}
            onClick={() => void save({ status: 'pagado', partnerId: row.partnerId, paidOn, note: note || undefined })}
          >
            Confirmar pago de {money(row.amount)}
          </Button>
        </div>
      )}
      {mode === 'anular' && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-64 flex-1 flex-col gap-1">
            <span className="text-xs text-muted-foreground">Motivo (obligatorio)</span>
            <input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} className="h-9 rounded-md border border-input bg-surface px-2" />
          </label>
          <Button
            size="sm"
            className="h-9"
            disabled={busy || !reason.trim()}
            onClick={() => void save({ status: 'anulado', partnerId: row.partnerId, voidReason: reason })}
          >
            Confirmar anulación
          </Button>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </li>
  )
}
