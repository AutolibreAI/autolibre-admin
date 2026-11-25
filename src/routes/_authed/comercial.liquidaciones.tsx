import { useRef, useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { z } from 'zod'
import { getCommissionsFn, setCommissionPaymentFn } from '~/fn/commercial-commissions'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import {
  COMMISSION_KIND_LABELS,
  commissionRow,
  groupCommissions,
  readableCommissionError,
  type CommissionRow,
} from '~/lib/commercial-commissions'
import { formatArs } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * Liquidaciones por comercial (`/comercial/liquidaciones`) — lo que le debemos
 * a cada comercial por los proveedores que trajo («Alta por»): la primera
 * cuota si el alta fue con plan pago, o el fee del primer trabajo confirmado
 * si fue en el plan gratis. Marcar pagado guarda fecha y nota (039).
 * → `.claude/rules/partner-fees.md`
 *
 * SSR completo: pocas filas y "hoy" lo calcula el servidor.
 */
const searchSchema = z.object({
  commissionShowAll: z.boolean().optional().catch(undefined),
})

export const Route = createFileRoute('/_authed/comercial/liquidaciones')({
  validateSearch: searchSchema,
  loader: () => getCommissionsFn(),
  head: () => ({ meta: [{ title: 'Liquidaciones · Comercial — AutoLibre' }] }),
  component: CommissionsView,
})

const day = (d: string | null) => {
  if (!d) return '—'
  const [y, m, dd] = d.split('-')
  return `${dd}/${m}/${y?.slice(2)}`
}

function CommissionsView() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  if (!data.available) {
    return (
      <>
        <PageHeader title="Liquidaciones por comercial" />
        <Card className="shadow-none">
          <CardContent className="py-6 text-sm">
            Falta aplicar la migración <code>039_ops_comisiones_comerciales.sql</code> (y la 035, «Alta por») en esta base.
          </CardContent>
        </Card>
      </>
    )
  }

  const rows = data.facts.map(commissionRow)
  const groups = groupCommissions(search.commissionShowAll ? rows : rows.filter((r) => r.status !== 'sin_devengar'))
  const pending = rows.filter((r) => r.status === 'pendiente').reduce((s, r) => s + r.amount, 0)
  const paid = rows.filter((r) => r.status === 'pagado').reduce((s, r) => s + r.amount, 0)
  const hidden = rows.filter((r) => r.status === 'sin_devengar').length

  return (
    <>
      <PageHeader
        title="Liquidaciones por comercial"
        subtitle={`Pendiente ${formatArs(pending)} · pagado ${formatArs(paid)} · ${rows.length} proveedores con «Alta por»`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />
      <p className="mb-4 text-xs text-muted-foreground">
        Alta con plan pago: la primera cuota completa, de inmediato. Alta en el plan gratis: el fee completo del primer
        trabajo confirmado del taller (Partners › Liquidaciones), sin vencimiento. Quién trajo a cada proveedor sale de
        «Alta por» en Solicitudes.
      </p>
      {hidden > 0 && (
        <button
          type="button"
          className="mb-4 text-sm text-brand hover:underline"
          onClick={() => void navigate({ search: { commissionShowAll: search.commissionShowAll ? undefined : true } })}
        >
          {search.commissionShowAll ? 'Ocultar' : 'Mostrar'} los {hidden} proveedores que todavía no generaron comisión
        </button>
      )}
      {groups.length === 0 && (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Ningún comercial tiene comisiones todavía.
        </p>
      )}
      <div className="space-y-4">
        {groups.map((g) => (
          <Card key={g.member.id} className="shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-baseline justify-between gap-2 text-base">
                <span>
                  {g.member.name}
                  {!g.member.active && <span className="text-xs font-normal text-muted-foreground"> (inactivo)</span>}
                </span>
                <span className="text-sm font-normal">
                  Pendiente <strong className="tabular-nums">{formatArs(g.pendingTotal)}</strong> ({g.pendingCount}) · pagado{' '}
                  <span className="tabular-nums">{formatArs(g.paidTotal)}</span> ({g.paidCount})
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-border rounded-md border border-border">
                {g.rows.map((r) => (
                  <CommissionLine key={r.partnerId} row={r} today={data.today} />
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  )
}

function CommissionLine({ row, today }: { row: CommissionRow; today: string }) {
  const router = useRouter()
  const inFlight = useRef(false)
  const [open, setOpen] = useState(false)
  const [paidOn, setPaidOn] = useState(today)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (paid: boolean) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await setCommissionPaymentFn({
        data: paid ? { paid: true, partnerId: row.partnerId, paidOn, note: note || undefined } : { paid: false, partnerId: row.partnerId },
      })
      setOpen(false)
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
          {row.kind ? COMMISSION_KIND_LABELS[row.kind] : 'Sin comisión todavía (sin plan pago ni trabajo confirmado)'}
          {row.reference ? ` · ${row.reference}` : ''}
          {row.dueDay ? ` · desde el ${day(row.dueDay)}` : ''}
        </span>
        {row.kind === 'fee_primer_trabajo' && row.firstJob && row.status !== 'pagado' && (
          <span className="text-xs text-muted-foreground">(al proveedor: {row.firstJob.feeStatus})</span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {row.kind && <span className="tabular-nums">{formatArs(row.amount)}</span>}
          <Badge
            variant="outline"
            className={cn(
              row.status === 'pagado' && 'border-status-green bg-status-green-bg text-status-green',
              row.status === 'pendiente' && 'border-status-yellow bg-status-yellow-bg text-status-yellow',
              row.status === 'sin_devengar' && 'text-muted-foreground',
            )}
          >
            {row.status === 'pagado' ? `Pagado el ${day(row.payment?.paidOn ?? null)}` : row.status === 'pendiente' ? 'Pendiente' : '—'}
          </Badge>
          {row.status === 'pendiente' && (
            <Button size="sm" variant="outline" className="h-7 shadow-none" onClick={() => setOpen((v) => !v)}>
              Marcar pagado
            </Button>
          )}
          {row.status === 'pagado' && (
            <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => void save(false)}>
              Volver a pendiente
            </Button>
          )}
        </span>
      </div>
      {row.payment?.note && <p className="text-xs text-muted-foreground">«{row.payment.note}»{row.payment.paidByName ? ` — ${row.payment.paidByName}` : ''}</p>}
      {open && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Fecha del pago</span>
            <input type="date" max={today} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className="h-9 rounded-md border border-input bg-surface px-2" />
          </label>
          <label className="flex min-w-64 flex-1 flex-col gap-1">
            <span className="text-xs text-muted-foreground">Nota (opcional)</span>
            <input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} className="h-9 rounded-md border border-input bg-surface px-2" />
          </label>
          <Button size="sm" className="h-9" disabled={busy || !paidOn} onClick={() => void save(true)}>
            Confirmar pago de {formatArs(row.amount)}
          </Button>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </li>
  )
}
