import { useRef, useState } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { createPartnerPackageFn, voidPartnerPackageFn } from '~/fn/partner-fees'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { formatArs } from '~/lib/format'
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, feeDay, paymentMethodLabel, type PaymentMethod } from '~/lib/partner-fees'
import { PARTNER_FEE_CONFIG } from '~/lib/partner-fees-config'
import {
  addDays,
  createPackageSchema,
  packageStatusText,
  readablePackageError,
  type PackageRow,
  type PackageStatus,
} from '~/lib/partner-packages'
import { cn } from '~/lib/utils'

/**
 * Paquetes de trabajos (044): cargar a mano, listar y anular. Lo usan la ficha
 * del proveedor, Partners › Proveedores y Partners › Paquetes.
 * → `.claude/rules/partner-fees.md`, «Paquetes».
 */

export function PackageStatusBadge({ status, text }: { status: PackageStatus; text: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        status === 'vigente' && 'border-status-green bg-status-green-bg text-status-green',
        status === 'vencido' && 'border-status-yellow bg-status-yellow-bg text-status-yellow',
        (status === 'agotado' || status === 'anulado') && 'text-muted-foreground',
        status === 'anulado' && 'line-through',
      )}
    >
      {text}
    </Badge>
  )
}

/** Formulario de carga. Defaults de `partner-fees-config`; el precio de referencia, si está definido. */
export function PackageComposer({
  partnerId,
  partnerName,
  today,
  onDone,
}: {
  partnerId: string
  partnerName?: string
  today: string
  onDone?: () => void
}) {
  const router = useRouter()
  const inFlight = useRef(false)
  const c = PARTNER_FEE_CONFIG
  const [jobs, setJobs] = useState(String(c.PAQUETE_TRABAJOS))
  const [validity, setValidity] = useState(String(c.PAQUETE_VIGENCIA_DIAS))
  const [purchasedOn, setPurchasedOn] = useState(today)
  const [price, setPrice] = useState(c.PAQUETE_PRECIO_REFERENCIA === null ? '' : String(c.PAQUETE_PRECIO_REFERENCIA))
  const [method, setMethod] = useState<PaymentMethod>('transferencia')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = createPackageSchema.safeParse({
    partnerId,
    jobs,
    validityDays: validity,
    purchasedOn,
    pricePaid: price.replace(/\./g, '').replace(',', '.'),
    paymentMethod: method,
    note: note || undefined,
  })
  const expires = /^\d{4}-\d{2}-\d{2}$/.test(purchasedOn) && Number(validity) > 0 ? addDays(purchasedOn, Number(validity)) : null

  const save = async () => {
    if (!parsed.success || price.trim() === '' || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await createPartnerPackageFn({ data: parsed.data })
      await router.invalidate()
      onDone?.()
    } catch (e) {
      setError(readablePackageError(e instanceof Error ? e.message : String(e)))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const input = 'h-9 rounded-md border border-input bg-surface px-2 text-sm'
  return (
    <div className="space-y-2 rounded-md border border-border bg-canvas p-3 text-sm">
      <p className="font-medium">Cargar paquete{partnerName ? ` · ${partnerName}` : ''}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Trabajos</span>
          <input type="number" min={1} max={100} value={jobs} onChange={(e) => setJobs(e.target.value)} className={cn(input, 'w-20')} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Vigencia (días)</span>
          <input type="number" min={1} max={3650} value={validity} onChange={(e) => setValidity(e.target.value)} className={cn(input, 'w-24')} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Fecha de compra</span>
          <input type="date" max={today} value={purchasedOn} onChange={(e) => setPurchasedOn(e.target.value)} className={input} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Precio pagado (ARS)</span>
          <input
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder={c.PAQUETE_PRECIO_REFERENCIA === null ? 'a definir' : undefined}
            className={cn(input, 'w-32')}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Medio de pago</span>
          <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} className={input}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Nota (opcional)</span>
          <input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} className={input} />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        {expires ? `Vence el ${feeDay(expires)} (compra + vigencia, inclusive). ` : ''}
        {c.PAQUETE_PRECIO_REFERENCIA === null ? 'Precio de referencia: a definir. ' : ''}
        Cubre los trabajos confirmados de este proveedor entre la compra y el vencimiento, después del primero (gratis).
      </p>
      {!parsed.success && price.trim() !== '' ? (
        <p className="text-xs text-destructive">{parsed.error.issues[0]?.message}</p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !parsed.success || price.trim() === ''} onClick={() => void save()}>
          Guardar paquete
        </Button>
        {onDone ? (
          <Button size="sm" variant="ghost" onClick={onDone}>
            Cancelar
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  )
}

/** Una fila de paquete, con «Anular» (motivo obligatorio). */
export function PackageLine({ row, showPartner }: { row: PackageRow; showPartner?: boolean }) {
  const router = useRouter()
  const inFlight = useRef(false)
  const [voiding, setVoiding] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const doVoid = async () => {
    if (inFlight.current || !reason.trim()) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await voidPartnerPackageFn({ data: { packageId: row.id, reason } })
      setVoiding(false)
      await router.invalidate()
    } catch (e) {
      setError(readablePackageError(e instanceof Error ? e.message : String(e)))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <li className="space-y-1 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {showPartner ? (
          <Link to="/partners/$partnerId" params={{ partnerId: row.partnerId }} className="font-medium hover:underline">
            {row.partnerName}
          </Link>
        ) : null}
        <span className="tabular-nums">
          {row.jobs} trabajos · comprado el {feeDay(row.purchasedOn)} · vence el {feeDay(row.expiresOn)}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {formatArs(row.pricePaid)} · {paymentMethodLabel(row.paymentMethod)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <PackageStatusBadge status={row.status} text={packageStatusText(row)} />
          {row.status !== 'anulado' ? (
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setVoiding((v) => !v)}>
              Anular
            </Button>
          ) : null}
        </span>
      </div>
      <div className="text-xs text-muted-foreground">
        Usados {row.used} ({row.usedPersisted} guardados) · saldo {row.balance}
        {row.expiringSoon ? ` · vence en ${row.daysLeft} día${row.daysLeft === 1 ? '' : 's'}: ofrecer renovación` : ''}
        {row.createdByName ? ` · cargado por ${row.createdByName}` : ''}
        {row.note ? ` · «${row.note}»` : ''}
        {row.status === 'anulado' ? ` · anulado${row.voidedByName ? ` por ${row.voidedByName}` : ''}: «${row.voidReason}»` : ''}
      </div>
      {voiding ? (
        <div className="flex flex-wrap items-end gap-2">
          <input
            value={reason}
            maxLength={1000}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Motivo (obligatorio)"
            className="h-8 min-w-72 rounded-md border border-input bg-surface px-2 text-sm"
          />
          <Button size="sm" className="h-8" disabled={busy || !reason.trim()} onClick={() => void doVoid()}>
            Confirmar anulación
          </Button>
        </div>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </li>
  )
}

/** La tarjeta de la ficha del proveedor. */
export function PartnerPackagesCard({
  partnerId,
  view,
}: {
  partnerId: string
  view: { available: false } | { available: true; rows: Array<PackageRow>; today: string }
}) {
  const [adding, setAdding] = useState(false)
  return (
    <Card className="mb-4 shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm">
          <span>Paquetes de trabajos</span>
          {view.available && !adding ? (
            <Button size="sm" variant="outline" className="h-7 shadow-none" onClick={() => setAdding(true)}>
              Cargar paquete
            </Button>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!view.available ? (
          <p className="text-sm text-muted-foreground">Falta aplicar la migración 044 (paquetes de trabajos) en esta base.</p>
        ) : (
          <>
            {adding ? <PackageComposer partnerId={partnerId} today={view.today} onDone={() => setAdding(false)} /> : null}
            {view.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Sin paquetes. Cada trabajo confirmado se cobra suelto ({formatArs(PARTNER_FEE_CONFIG.FEE_POR_TRABAJO)}), salvo
                el primero, que es gratis.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {view.rows.map((r) => (
                  <PackageLine key={r.id} row={r} />
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
