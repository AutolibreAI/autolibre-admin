import { useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { Copy, Download, MessageCircle } from 'lucide-react'
import {
  attributePartnerFeeFn,
  getPartnerFeesFn,
  persistPackageAllocationsFn,
  reopenPackageAllocationFn,
  setPartnerFeeStatusFn,
  undoPackageAllocationFn,
} from '~/fn/partner-fees'
import { readablePackageError } from '~/lib/partner-packages'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Textarea } from '~/components/ui/textarea'
import { toCsv } from '~/lib/csv'
import { formatArs, formatInt } from '~/lib/format'
import {
  FEE_CSV_HEADER,
  FEE_EXCLUSION_LABELS,
  FEE_STATUS_LABELS,
  FEE_VIEWS,
  FEE_VIEW_LABELS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  chargeMessage,
  classifyFeeJobs,
  feeDay,
  feePaymentsCsvRows,
  feeSummary,
  groupOpenByPartner,
  matchesFeeFilters,
  partnerFeesSearchSchema,
  paymentMethodLabel,
  readablePartnerFeeError,
  type FeeJob,
  type FeePartnerFacts,
  type FeePartnerGroup,
  type FeeStatus,
  type FeeView,
  type PartnerFeesSearch,
  type PaymentMethod,
} from '~/lib/partner-fees'
import { PARTNER_FEE_CONFIG } from '~/lib/partner-fees-config'
import type { PartnerOption } from '~/lib/partners'
import { cn } from '~/lib/utils'
import { toWhatsAppAR } from '~/lib/whatsapp-ar'

/**
 * Liquidaciones (`/partners/liquidaciones`) — lo que cada proveedor le debe a
 * AutoLibre por los trabajos confirmados que le llegaron por nosotros (ARS
 * 20.000 por trabajo, `~/lib/partner-fees-config`), y el registro del cobro.
 * → `.claude/rules/partner-fees.md`
 *
 * Cuatro vistas (`feeView`): Por cobrar (agrupado por proveedor, con el
 * mensaje de WhatsApp), Sin atribuir (la cola para decir qué proveedor hizo
 * el trabajo), En disputa (el cliente y el equipo no coinciden: se resuelve a
 * mano en la ficha) y Cobrados y anulados (con el CSV para la caja).
 *
 * Los filtros podan en el CLIENTE: son decenas de trabajos y la regla del
 * primer trabajo de cada taller necesita verlos todos.
 *
 * Desde el 2026-11-26 (sin suscripciones): el primer trabajo de cada
 * proveedor es gratis y un paquete vigente cubre los siguientes (044). Un
 * trabajo «Cubierto por paquete» que propone la regla se GUARDA con un click
 * (o se rechaza con motivo); el que ya está guardado se deshace con motivo.
 *
 * SSR completo: es una tabla y "hoy" lo calcula el servidor (Buenos Aires).
 */
export const Route = createFileRoute('/_authed/partners/liquidaciones')({
  validateSearch: partnerFeesSearchSchema,
  loader: () => getPartnerFeesFn(),
  head: () => ({ meta: [{ title: 'Liquidaciones · Partners — AutoLibre' }] }),
  component: PartnerFeesView,
})

const ars = (n: number) => formatArs(n)

function PartnerFeesView() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  if (!data.available) {
    return (
      <>
        <PageHeader title="Liquidaciones" subtitle="El fee por trabajo confirmado que cobramos a cada proveedor" />
        <Card className="shadow-none">
          <CardContent className="py-6 text-sm">
            Falta aplicar la migración <code>038_ops_liquidaciones_proveedores.sql</code> en esta base (la aplica el
            deploy de producción; en DEV, <code>pnpm db:migrate</code>). Sin ella no hay dónde guardar la atribución ni
            el estado del cobro.
          </CardContent>
        </Card>
      </>
    )
  }

  const setSearch = (patch: Partial<PartnerFeesSearch>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), resetScroll: false })

  return <Loaded data={data} search={search} setSearch={setSearch} />
}

type LoadedData = Extract<Awaited<ReturnType<typeof getPartnerFeesFn>>, { available: true }>

function Loaded({
  data,
  search,
  setSearch,
}: {
  data: LoadedData
  search: PartnerFeesSearch
  setSearch: (patch: Partial<PartnerFeesSearch>) => void
}) {
  const partners = useMemo(() => new Map(data.partners.map((p) => [p.id, p])), [data.partners])
  const allJobs = useMemo(
    () => classifyFeeJobs(data.jobs, partners, PARTNER_FEE_CONFIG, data.packages),
    [data.jobs, partners, data.packages],
  )
  const jobs = allJobs.filter((j) => matchesFeeFilters(j, partners, search))
  const summary = feeSummary(jobs, data.today.slice(0, 7))
  const counts: Record<FeeView, number> = {
    cobrar: groupOpenByPartner(jobs, partners).length,
    sin_atribuir: summary.unattributed,
    disputa: summary.disputes,
    registro: jobs.filter((j) => j.kind === 'liquidable' && (j.status === 'cobrado' || j.status === 'anulado')).length,
  }

  return (
    <>
      <PageHeader
        title="Liquidaciones"
        subtitle={`${formatInt(allJobs.length)} trabajos confirmados · ${ars(PARTNER_FEE_CONFIG.FEE_POR_TRABAJO)} por trabajo`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <section aria-label="Resumen" className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Pendiente" value={ars(summary.pendingTotal)} hint={`${summary.pendingCount} trabajos sin avisar`} />
        <Tile label="Avisado" value={ars(summary.notifiedTotal)} hint={`${summary.notifiedCount} trabajos esperando el pago`} />
        <Tile label="Cobrado este mes" value={ars(summary.paidThisMonthTotal)} hint={`${summary.paidThisMonthCount} trabajos`} />
        <Tile
          label="Sin atribuir"
          value={formatInt(summary.unattributed)}
          hint={summary.disputes ? `+ ${summary.disputes} en disputa` : 'trabajos sin proveedor'}
          warn={summary.unattributed > 0}
        />
      </section>

      <Filters data={data} partners={partners} search={search} setSearch={setSearch} />

      <ConfigNote jobs={allJobs} packagesAvailable={data.packages !== null} />

      <nav aria-label="Vistas" className="mb-4 flex flex-wrap gap-1 border-b border-border">
        {FEE_VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setSearch({ feeView: v })}
            aria-current={search.feeView === v ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              search.feeView === v ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {FEE_VIEW_LABELS[v]} <span className="text-xs text-muted-foreground">({counts[v]})</span>
          </button>
        ))}
      </nav>

      {search.feeView === 'cobrar' && <ChargeView jobs={jobs} partners={partners} options={data.partnerOptions} today={data.today} />}
      {search.feeView === 'sin_atribuir' && (
        <UnattributedView jobs={jobs.filter((j) => j.kind === 'sin_atribuir')} options={data.partnerOptions} />
      )}
      {search.feeView === 'disputa' && <DisputeView jobs={jobs.filter((j) => j.kind === 'disputa')} partners={partners} />}
      {search.feeView === 'registro' && <LedgerView jobs={jobs} partners={partners} />}
    </>
  )
}

function Tile({ label, value, hint, warn }: { label: string; value: string; hint: string; warn?: boolean }) {
  return (
    <Card className="shadow-none">
      <CardContent className="py-4">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className={cn('text-2xl font-bold tabular-nums', warn && 'text-status-yellow')}>{value}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  )
}

function ConfigNote({ jobs, packagesAvailable }: { jobs: ReadonlyArray<FeeJob>; packagesAvailable: boolean }) {
  const c = PARTNER_FEE_CONFIG
  const liq = jobs.filter((j) => j.kind === 'liquidable' && j.status === 'pendiente')
  const free = liq.filter((j) => j.exclusion === 'primer_trabajo').length
  const covered = liq.filter((j) => j.exclusion === 'paquete').length
  const fee = liq.filter((j) => j.exclusion === null).length
  return (
    <div className="mb-4 space-y-1 text-xs text-muted-foreground">
      <p>
        Regla vigente (sin suscripciones): por cada trabajo confirmado por AutoLibre (equipo o cliente dijo «fue»), sin
        duplicados, pruebas ni cuentas internas — 1) el primero de cada proveedor es gratis
        {c.PRIMER_TRABAJO_GRATIS ? '' : ' (APAGADO en la config)'}; 2) si tiene un paquete vigente a la fecha del
        trabajo con saldo, lo cubre el que vence primero; 3) si no, {ars(c.FEE_POR_TRABAJO)}.{' '}
        {c.FECHA_INICIO ? `Se cobra desde el ${feeDay(c.FECHA_INICIO)}.` : 'Fecha de inicio del cobro: a definir.'}
      </p>
      <p>
        Pendientes hoy: {formatInt(free)} gratis (primer trabajo) · {formatInt(covered)} cubiertos por paquete ·{' '}
        {formatInt(fee)} con fee.
        {!packagesAvailable ? ' Falta la migración 044: ningún trabajo se cubre con paquete.' : ''}
      </p>
    </div>
  )
}

// ── Filtros ───────────────────────────────────────────────────────────────

function Filters({
  data,
  partners,
  search,
  setSearch,
}: {
  data: LoadedData
  partners: ReadonlyMap<string, FeePartnerFacts>
  search: PartnerFeesSearch
  setSearch: (patch: Partial<PartnerFeesSearch>) => void
}) {
  const list = [...partners.values()].sort((a, b) => a.name.localeCompare(b.name))
  const sourcers = new Map<string, string>()
  for (const p of list) if (p.sourcer) sourcers.set(p.sourcer.memberId, p.sourcer.name)
  const active = search.feeFrom || search.feeTo || search.feePartner || search.feeSourcer
  void data

  return (
    <section aria-label="Filtros" className="mb-4 flex flex-wrap items-end gap-3 text-sm">
      <Field label="Trabajo desde">
        <input
          type="date"
          className="h-9 rounded-md border border-input bg-surface px-2"
          value={search.feeFrom ?? ''}
          onChange={(e) => setSearch({ feeFrom: e.target.value || undefined })}
        />
      </Field>
      <Field label="hasta">
        <input
          type="date"
          className="h-9 rounded-md border border-input bg-surface px-2"
          value={search.feeTo ?? ''}
          onChange={(e) => setSearch({ feeTo: e.target.value || undefined })}
        />
      </Field>
      <Field label="Proveedor">
        <NativeSelect value={search.feePartner ?? ''} onChange={(v) => setSearch({ feePartner: v || undefined })}>
          <option value="">Todos</option>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Alta por">
        <NativeSelect value={search.feeSourcer ?? ''} onChange={(v) => setSearch({ feeSourcer: v || undefined })}>
          <option value="">Todos</option>
          {[...sourcers].map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
          <option value="none">Sin asignar</option>
        </NativeSelect>
      </Field>
      {active && (
        <Button
          size="sm"
          variant="ghost"
          className="h-9"
          onClick={() => setSearch({ feeFrom: undefined, feeTo: undefined, feePartner: undefined, feeSourcer: undefined })}
        >
          Limpiar filtros
        </Button>
      )}
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

function NativeSelect({
  value,
  onChange,
  children,
  className,
}: {
  value: string
  onChange: (v: string) => void
  children: ReactNode
  className?: string
}) {
  return (
    <select
      className={cn('h-9 rounded-md border border-input bg-surface px-2 text-sm', className)}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {children}
    </select>
  )
}

// ── Piezas compartidas ────────────────────────────────────────────────────

function StatusBadge({ status }: { status: FeeStatus }) {
  const cls: Record<FeeStatus, string> = {
    pendiente: 'border-border text-foreground',
    avisado: 'border-status-yellow bg-status-yellow-bg text-status-yellow',
    cobrado: 'border-status-green bg-status-green-bg text-status-green',
    anulado: 'border-border text-muted-foreground line-through',
  }
  return (
    <Badge variant="outline" className={cls[status]}>
      {FEE_STATUS_LABELS[status]}
    </Badge>
  )
}

function JobLink({ job }: { job: FeeJob }) {
  return (
    <Link
      to="/leads/pedidos/$quoteRequestId"
      params={{ quoteRequestId: job.quoteRequestId }}
      className="font-medium text-brand hover:underline"
    >
      AL-{job.publicNumber}
    </Link>
  )
}

const JOB_DAY_SOURCE: Record<FeeJob['jobDaySource'], string> = {
  performed_on: 'fecha del trabajo',
  closed_at: 'cierre del pedido',
  created_at: 'alta del pedido',
}

function proposalAmountLabel(p: FeeJob['proposalAmount']): string | null {
  if (!p || p.min === null) return null
  return p.max !== null && p.max !== p.min ? `${ars(p.min)} a ${ars(p.max)}` : ars(p.min)
}

function useWrite() {
  const router = useRouter()
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await fn()
      await router.invalidate()
      return true
    } catch (e) {
      setError(readablePartnerFeeError(e instanceof Error ? e.message : String(e)))
      await router.invalidate()
      return false
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="text-sm text-destructive">{error}</p> : null
}

function NotesBlock({ job }: { job: FeeJob }) {
  const parts: Array<[string, string]> = []
  if (job.outcomeNote) parts.push(['Nota del resultado', job.outcomeNote])
  if (job.closedReason) parts.push(['Nota del cierre', job.closedReason])
  if (!parts.length && !job.internalNotes) return <p className="text-xs text-muted-foreground">Sin notas de cierre.</p>
  return (
    <div className="space-y-1 text-xs">
      {parts.map(([k, v]) => (
        <p key={k}>
          <span className="text-muted-foreground">{k}: </span>
          {v}
        </p>
      ))}
      {job.internalNotes && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Notas internas del pedido</summary>
          <p className="mt-1 whitespace-pre-wrap">{job.internalNotes}</p>
        </details>
      )}
    </div>
  )
}

// ── Atribuir un trabajo a un proveedor ────────────────────────────────────

function AttributeForm({
  job,
  options,
  onDone,
}: {
  job: FeeJob
  options: ReadonlyArray<PartnerOption>
  onDone?: () => void
}) {
  const fromProposals = job.proposals.filter((p) => p.partnerId !== null)
  const proposalIds = new Set(fromProposals.map((p) => p.partnerId))
  const [partnerId, setPartnerId] = useState(job.attribution?.partnerId ?? '')
  const [note, setNote] = useState(job.attribution?.note ?? '')
  const { busy, error, run } = useWrite()

  const save = (pid: string | null) =>
    run(() => attributePartnerFeeFn({ data: { quoteRequestId: job.quoteRequestId, partnerId: pid, note } })).then(
      (ok) => ok && onDone?.(),
    )

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Proveedor que hizo el trabajo">
          <NativeSelect value={partnerId} onChange={setPartnerId} className="min-w-64">
            <option value="">Elegí…</option>
            {fromProposals.length > 0 && (
              <optgroup label="Propuestas de este pedido">
                {fromProposals.map((p) => (
                  <option key={p.partnerId!} value={p.partnerId!}>
                    {p.name}
                    {p.withdrawn ? ' (retirada)' : ''}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Todo el directorio (activos)">
              {options
                .filter((o) => !proposalIds.has(o.id))
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
            </optgroup>
          </NativeSelect>
        </Field>
        <Button size="sm" className="h-9" disabled={busy || !partnerId} onClick={() => save(partnerId)}>
          {job.attribution ? 'Cambiar' : 'Asignar proveedor'}
        </Button>
        {job.attribution && (
          <Button size="sm" variant="ghost" className="h-9" disabled={busy} onClick={() => save(null)}>
            Quitar
          </Button>
        )}
      </div>
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={1000}
        rows={2}
        placeholder="De dónde sale (p. ej. «la nota del cierre dice que fue a …»). Opcional."
      />
      <p className="text-xs text-muted-foreground">
        Se guarda en el panel (`ops`), no en el pedido: el backend todavía no deja elegir la propuesta en un pedido cerrado.
      </p>
      <ErrorLine error={error} />
    </div>
  )
}

// ── Vista: sin atribuir ───────────────────────────────────────────────────

function UnattributedView({ jobs, options }: { jobs: ReadonlyArray<FeeJob>; options: ReadonlyArray<PartnerOption> }) {
  if (!jobs.length) return <Empty>Todos los trabajos confirmados tienen proveedor.</Empty>
  return (
    <div className="space-y-3">
      {jobs.map((j) => (
        <Card key={j.quoteRequestId} className="shadow-none">
          <CardContent className="grid gap-4 py-4 md:grid-cols-2">
            <div className="space-y-1 text-sm">
              <p>
                <JobLink job={j} /> · {feeDay(j.jobDay)}{' '}
                <span className="text-xs text-muted-foreground">({JOB_DAY_SOURCE[j.jobDaySource]})</span>
              </p>
              <p>{j.vehicleLabel ?? <span className="text-muted-foreground">sin vehículo</span>}</p>
              <p className="text-muted-foreground">{j.services.length ? j.services.join(', ') : 'sin rubro/servicio'}</p>
              <p className="text-xs text-muted-foreground">
                Equipo: {j.outcome ?? '—'} · Cliente: {j.userOutcome ?? 'no declaró'} ·{' '}
                {j.proposals.length ? `${j.proposals.length} propuestas: ${j.proposals.map((p) => p.name).join(', ')}` : 'sin propuestas'}
              </p>
              <NotesBlock job={j} />
            </div>
            <AttributeForm job={j} options={options} />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ── Vista: en disputa ─────────────────────────────────────────────────────

function DisputeView({ jobs, partners }: { jobs: ReadonlyArray<FeeJob>; partners: ReadonlyMap<string, FeePartnerFacts> }) {
  if (!jobs.length) return <Empty>No hay trabajos donde el cliente y el equipo digan cosas distintas.</Empty>
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        El equipo y el cliente no coinciden en si fue al taller. No se liquidan hasta resolverlo: corregí el resultado en la
        ficha del pedido y vuelve solo a «Por cobrar».
      </p>
      {jobs.map((j) => (
        <Card key={j.quoteRequestId} className="shadow-none">
          <CardContent className="space-y-1 py-4 text-sm">
            <p>
              <JobLink job={j} /> · {feeDay(j.jobDay)} · {j.vehicleLabel ?? 'sin vehículo'}
            </p>
            <p>
              Según el equipo: <strong>{j.outcome ?? '—'}</strong> · Según el cliente: <strong>{j.userOutcome ?? '—'}</strong>
            </p>
            <p className="text-muted-foreground">
              Proveedor: {j.partnerId ? (partners.get(j.partnerId)?.name ?? '—') : 'sin atribuir'}
            </p>
            <NotesBlock job={j} />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ── Paquetes: imputación de un trabajo ────────────────────────────────────

function usePackageWrite() {
  const router = useRouter()
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (e) {
      setError(readablePackageError(e instanceof Error ? e.message : String(e)))
      return false
    } finally {
      inFlight.current = false
      setBusy(false)
      await router.invalidate()
    }
  }
  return { busy, error, run }
}

function PersistAllocationsButton({ ids }: { ids: Array<string> }) {
  const { busy, error, run } = usePackageWrite()
  return (
    <span className="flex flex-col gap-1">
      <Button
        size="sm"
        variant="outline"
        className="shadow-none"
        disabled={busy}
        onClick={() => void run(() => persistPackageAllocationsFn({ data: { quoteRequestIds: ids } }))}
        title="Guarda en el panel las imputaciones que propone la regla, para que no cambien solas."
      >
        Guardar imputaciones a paquete ({ids.length})
      </Button>
      <ErrorLine error={error} />
    </span>
  )
}

/** Cubierto por paquete (guardado o propuesto) o imputación deshecha. */
function PackageAllocationLine({ job }: { job: FeeJob }) {
  const [undoing, setUndoing] = useState(false)
  const [reason, setReason] = useState('')
  const { busy, error, run } = usePackageWrite()
  const a = job.packageAllocation
  return (
    <span className="flex basis-full flex-col gap-1">
      {a ? (
        <span className="flex flex-wrap items-center gap-2">
          <span className={a.persisted ? 'text-status-green' : 'text-status-yellow'}>
            {a.persisted ? 'Imputado a un paquete (guardado)' : 'La regla lo imputa a un paquete (sin guardar)'}
          </span>
          <Link to="/partners/paquetes" search={{ packagePartner: job.partnerId ?? undefined }} className="text-brand hover:underline">
            ver paquete
          </Link>
          {!a.persisted && (
            <button
              type="button"
              disabled={busy}
              className="text-brand hover:underline"
              onClick={() => void run(() => persistPackageAllocationsFn({ data: { quoteRequestIds: [job.quoteRequestId] } }))}
            >
              Guardar
            </button>
          )}
          <button type="button" className="text-brand hover:underline" onClick={() => setUndoing((v) => !v)}>
            {a.persisted ? 'Deshacer imputación' : 'No imputar'}
          </button>
        </span>
      ) : job.allocationUndone ? (
        <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
          Imputación a paquete deshecha
          {job.allocationUndone.undoneByName ? ` por ${job.allocationUndone.undoneByName}` : ''}: «
          {job.allocationUndone.undoReason}»
          <button
            type="button"
            disabled={busy}
            className="text-brand hover:underline"
            onClick={() => void run(() => reopenPackageAllocationFn({ data: { quoteRequestId: job.quoteRequestId } }))}
          >
            Volver a imputar automático
          </button>
        </span>
      ) : null}
      {undoing && a && (
        <span className="flex flex-wrap items-end gap-2">
          <input
            value={reason}
            maxLength={1000}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Motivo (obligatorio): p. ej. «se atribuyó mal»"
            className="h-8 min-w-72 rounded-md border border-input bg-surface px-2 text-sm"
          />
          <Button
            size="sm"
            className="h-8"
            disabled={busy || !reason.trim()}
            onClick={() =>
              void run(() => undoPackageAllocationFn({ data: { quoteRequestId: job.quoteRequestId, reason } })).then(
                (ok) => ok && setUndoing(false),
              )
            }
          >
            Confirmar
          </Button>
        </span>
      )}
      <ErrorLine error={error} />
    </span>
  )
}

// ── Vista: por cobrar ─────────────────────────────────────────────────────

function ChargeView({
  jobs,
  partners,
  options,
  today,
}: {
  jobs: ReadonlyArray<FeeJob>
  partners: ReadonlyMap<string, FeePartnerFacts>
  options: ReadonlyArray<PartnerOption>
  today: string
}) {
  const groups = groupOpenByPartner(jobs, partners)
  if (!groups.length) return <Empty>No hay nada pendiente ni avisado con estos filtros.</Empty>
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <PartnerGroupCard key={g.partner.id} group={g} options={options} today={today} />
      ))}
    </div>
  )
}

type Action = null | 'cobrado' | 'anulado'

function PartnerGroupCard({
  group,
  options,
  today,
}: {
  group: FeePartnerGroup
  options: ReadonlyArray<PartnerOption>
  today: string
}) {
  const { partner } = group
  const chargeable = group.jobs.filter((j) => (j.status === 'pendiente' && j.exclusion === null) || j.status === 'avisado')
  const [selected, setSelected] = useState<Set<string>>(() => new Set(chargeable.map((j) => j.quoteRequestId)))
  const [action, setAction] = useState<Action>(null)
  const [showMessage, setShowMessage] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const { busy, error, run } = useWrite()

  const sel = chargeable.filter((j) => selected.has(j.quoteRequestId))
  const provisional = group.jobs.filter((j) => j.packageAllocation && !j.packageAllocation.persisted)
  const selPending = sel.filter((j) => j.status === 'pendiente')
  const selNotified = sel.filter((j) => j.status === 'avisado')

  const move = (ids: Array<string>, status: FeeStatus, extra: { paidOn?: string; paymentMethod?: PaymentMethod; note?: string; voidReason?: string } = {}) =>
    run(() => setPartnerFeeStatusFn({ data: { quoteRequestIds: ids, partnerId: partner.id, status, ...extra } })).then((ok) => {
      if (ok) setAction(null)
      return ok
    })

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <Card className="shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-baseline justify-between gap-2 text-base">
          <span>
            <Link to="/partners/$partnerId" params={{ partnerId: partner.id }} className="hover:underline">
              {partner.name}
            </Link>{' '}
            <span className="text-xs font-normal text-muted-foreground">
              {partner.tier === 'founding' ? '· Aliado ' : ''}· Alta por {partner.sourcer?.name ?? 'sin asignar'}
            </span>
          </span>
          <span className="tabular-nums">
            {ars(group.pendingTotal + group.notifiedTotal)}{' '}
            <span className="text-xs font-normal text-muted-foreground">
              ({group.pendingCount} pendientes · {group.notifiedCount} avisados
              {group.oldestOpenDay ? ` · el más viejo del ${feeDay(group.oldestOpenDay)}` : ''})
            </span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="divide-y divide-border rounded-md border border-border">
          {group.jobs.map((j) => {
            const canSelect = chargeable.includes(j)
            return (
              <li key={j.quoteRequestId} className="space-y-1 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <input
                    type="checkbox"
                    aria-label={`Elegir AL-${j.publicNumber}`}
                    disabled={!canSelect}
                    checked={canSelect && selected.has(j.quoteRequestId)}
                    onChange={() => toggle(j.quoteRequestId)}
                  />
                  <JobLink job={j} />
                  <span>{feeDay(j.jobDay)}</span>
                  <span>{j.vehicleLabel ?? <span className="text-muted-foreground">sin vehículo</span>}</span>
                  <span className="text-muted-foreground">{j.services.join(', ') || 'sin servicio'}</span>
                  {proposalAmountLabel(j.proposalAmount) && (
                    <span className="text-xs text-muted-foreground">propuesta {proposalAmountLabel(j.proposalAmount)}</span>
                  )}
                  <span className="ml-auto flex items-center gap-2">
                    <span className="tabular-nums">{j.exclusion ? '—' : ars(j.amount)}</span>
                    <StatusBadge status={j.status} />
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 pl-6 text-xs">
                  {j.commercialFee && (
                    <Badge variant="outline" className="border-status-violet bg-status-violet-bg text-status-violet">
                      Premio para {j.commercialFee.name}
                    </Badge>
                  )}
                  {j.exclusion && <span className="text-muted-foreground">No se cobra: {FEE_EXCLUSION_LABELS[j.exclusion]}</span>}
                  {(j.packageAllocation || j.allocationUndone) && <PackageAllocationLine job={j} />}
                  {j.partnerSource === 'attribution' && (
                    <span className="text-muted-foreground">
                      Atribuido a mano{j.attribution?.byName ? ` por ${j.attribution.byName}` : ''}
                      {j.attribution?.note ? ` — «${j.attribution.note}»` : ''}
                    </span>
                  )}
                  {j.partnerSource === 'selected' && <span className="text-muted-foreground">Propuesta elegida</span>}
                  {j.attributionMismatch && (
                    <span className="text-status-yellow">La atribución a mano dice otro proveedor; manda la propuesta elegida.</span>
                  )}
                  {j.status === 'avisado' && j.charge?.notifiedAt && (
                    <span className="text-muted-foreground">Avisado el {feeDay(j.charge.notifiedAt.slice(0, 10))}</span>
                  )}
                  {j.partnerSource === 'attribution' && j.status === 'pendiente' && (
                    <button type="button" className="text-brand hover:underline" onClick={() => setEditing(editing === j.quoteRequestId ? null : j.quoteRequestId)}>
                      Cambiar proveedor
                    </button>
                  )}
                </div>
                {editing === j.quoteRequestId && (
                  <div className="pl-6">
                    <AttributeForm job={j} options={options} onDone={() => setEditing(null)} />
                  </div>
                )}
              </li>
            )
          })}
        </ul>

        <div className="flex flex-wrap gap-2">
          {provisional.length > 0 && <PersistAllocationsButton ids={provisional.map((j) => j.quoteRequestId)} />}
          <Button size="sm" variant="outline" className="shadow-none" onClick={() => setShowMessage((v) => !v)}>
            <MessageCircle className="size-4" aria-hidden /> Mensaje de cobro
          </Button>
          <Button size="sm" disabled={busy || !selPending.length} onClick={() => move(selPending.map((j) => j.quoteRequestId), 'avisado')}>
            Marcar avisado ({selPending.length})
          </Button>
          <Button size="sm" variant="outline" className="shadow-none" disabled={busy || !sel.length} onClick={() => setAction('cobrado')}>
            Registrar cobro ({sel.length})
          </Button>
          <Button size="sm" variant="ghost" disabled={busy || !sel.length} onClick={() => setAction('anulado')}>
            Anular ({sel.length})
          </Button>
          {selNotified.length > 0 && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => move(selNotified.map((j) => j.quoteRequestId), 'pendiente')}>
              Volver a pendiente ({selNotified.length})
            </Button>
          )}
        </div>

        {action === 'cobrado' && (
          <PaidForm
            count={sel.length}
            total={sel.reduce((s, j) => s + j.amount, 0)}
            today={today}
            busy={busy}
            onCancel={() => setAction(null)}
            onSubmit={(v) => move(sel.map((j) => j.quoteRequestId), 'cobrado', v)}
          />
        )}
        {action === 'anulado' && (
          <VoidForm
            count={sel.length}
            busy={busy}
            onCancel={() => setAction(null)}
            onSubmit={(voidReason) => move(sel.map((j) => j.quoteRequestId), 'anulado', { voidReason })}
          />
        )}
        <ErrorLine error={error} />

        {showMessage && <ChargeMessage partner={partner} jobs={sel.length ? sel : chargeable} />}
      </CardContent>
    </Card>
  )
}

function PaidForm({
  count,
  total,
  today,
  busy,
  onCancel,
  onSubmit,
}: {
  count: number
  total: number
  today: string
  busy: boolean
  onCancel: () => void
  onSubmit: (v: { paidOn: string; paymentMethod: PaymentMethod; note?: string }) => void
}) {
  const [paidOn, setPaidOn] = useState(today)
  const [method, setMethod] = useState<PaymentMethod | ''>('')
  const [note, setNote] = useState('')
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-sm">
        Registrar el cobro de {count} {count === 1 ? 'trabajo' : 'trabajos'} por <strong>{ars(total)}</strong>.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Fecha del cobro">
          <input type="date" max={today} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className="h-9 rounded-md border border-input bg-surface px-2" />
        </Field>
        <Field label="Medio">
          <NativeSelect value={method} onChange={(v) => setMethod(v as PaymentMethod | '')}>
            <option value="">Elegí…</option>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Textarea rows={2} maxLength={1000} placeholder="Nota (opcional): número de operación, quién lo recibió…" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !paidOn || !method} onClick={() => method && onSubmit({ paidOn, paymentMethod: method, note: note || undefined })}>
          Confirmar cobro
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}

function VoidForm({ count, busy, onCancel, onSubmit }: { count: number; busy: boolean; onCancel: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-sm">
        Anular {count} {count === 1 ? 'trabajo' : 'trabajos'}: no se cobran. Queda registrado con el motivo.
      </p>
      <Textarea rows={2} maxLength={1000} placeholder="Motivo (obligatorio): disputa, «no reconozco», etc." value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" disabled={busy || !reason.trim()} onClick={() => onSubmit(reason.trim())}>
          Anular
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}

function ChargeMessage({ partner, jobs }: { partner: FeePartnerFacts; jobs: ReadonlyArray<FeeJob> }) {
  const initial = chargeMessage(partner.name, jobs)
  const [text, setText] = useState(initial)
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const wa = partner.whatsapp ? toWhatsAppAR(partner.whatsapp) : null
  const url = wa?.ok ? `https://wa.me/${wa.digits}?text=${encodeURIComponent(text)}` : null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied('ok')
    } catch {
      setCopied('fail')
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">
        Con los trabajos elegidos (o todos los abiertos si no hay ninguno elegido). Editable: lo que se copia y se manda es
        lo de este cuadro. Sin datos del cliente.
      </p>
      <Textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className="shadow-none" onClick={copy}>
          <Copy className="size-4" aria-hidden /> Copiar mensaje
        </Button>
        {url ? (
          <Button asChild size="sm" variant="outline" className="shadow-none">
            <a href={url} target="_blank" rel="noreferrer">
              <MessageCircle className="size-4" aria-hidden /> Abrir chat (+{wa?.ok ? wa.digits : ''})
            </a>
          </Button>
        ) : (
          <span className="text-xs text-status-yellow">
            {partner.whatsapp
              ? `No se puede armar el link de WhatsApp: el número ${wa && !wa.ok ? wa.reason : 'no es válido'}.`
              : 'El proveedor no tiene WhatsApp cargado en su ficha.'}
          </span>
        )}
        {text !== initial && (
          <Button size="sm" variant="ghost" onClick={() => setText(initial)}>
            Volver al original
          </Button>
        )}
        {copied === 'ok' && <span className="text-xs text-status-green">Copiado.</span>}
        {copied === 'fail' && <span className="text-xs text-destructive">No se pudo copiar: seleccioná el texto a mano.</span>}
      </div>
    </div>
  )
}

// ── Vista: cobrados y anulados ────────────────────────────────────────────

function LedgerView({ jobs, partners }: { jobs: ReadonlyArray<FeeJob>; partners: ReadonlyMap<string, FeePartnerFacts> }) {
  const rows = jobs
    .filter((j) => j.kind === 'liquidable' && (j.status === 'cobrado' || j.status === 'anulado') && j.charge)
    .sort((a, b) => ((b.charge?.paidOn ?? b.charge?.updatedAt ?? '') < (a.charge?.paidOn ?? a.charge?.updatedAt ?? '') ? -1 : 1))
  const { busy, error, run } = useWrite()

  const download = () => {
    const csv = toCsv(FEE_CSV_HEADER, feePaymentsCsvRows(jobs, partners))
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'cobros-proveedores.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  if (!rows.length) return <Empty>Todavía no hay cobros ni anulaciones registrados con estos filtros.</Empty>
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" className="shadow-none" onClick={download}>
          <Download className="size-4" aria-hidden /> Exportar cobros (CSV)
        </Button>
        <span className="text-xs text-muted-foreground">Una fila por cobro (proveedor, fecha y medio), con los filtros de arriba.</span>
      </div>
      <ErrorLine error={error} />
      <ul className="divide-y divide-border rounded-md border border-border bg-surface">
        {rows.map((j) => {
          const c = j.charge!
          return (
            <li key={j.quoteRequestId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <JobLink job={j} />
              <span>{partners.get(c.partnerId)?.name ?? '—'}</span>
              <span className="text-muted-foreground">trabajo {feeDay(j.jobDay)}</span>
              <StatusBadge status={j.status} />
              {j.status === 'cobrado' && (
                <span>
                  {ars(j.amount)} · {c.paidOn ? feeDay(c.paidOn) : '—'} · {paymentMethodLabel(c.paymentMethod)}
                </span>
              )}
              {j.status === 'anulado' && <span className="text-muted-foreground">Motivo: {c.voidReason}</span>}
              {c.note && <span className="text-xs text-muted-foreground">«{c.note}»</span>}
              <span className="text-xs text-muted-foreground">{c.updatedByName ? `por ${c.updatedByName}` : ''}</span>
              {j.commercialFee && (
                <Badge variant="outline" className="border-status-violet bg-status-violet-bg text-status-violet">
                  Fee para {j.commercialFee.name}
                </Badge>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-7"
                disabled={busy}
                onClick={() => run(() => setPartnerFeeStatusFn({ data: { quoteRequestIds: [j.quoteRequestId], partnerId: c.partnerId, status: 'pendiente' } }))}
              >
                Volver a pendiente
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{children}</p>
}
