import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { listMarketplacePartners } from '~/fn/partners'
import { listPartnerProposalUsageFn } from '~/fn/partner-quote-volume'
import { Chip, FilterGroup } from '~/components/Filters'
import { MockBanner } from '~/components/MockBanner'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Badge } from '~/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { fetchPartnerPlansMock } from '~/mocks/partner-plans'
import { formatInt } from '~/lib/format'
import {
  PARTNER_PLANS,
  PARTNER_PLAN_CAPS,
  PARTNER_PLAN_LABELS,
  aggregatePartnerUsage,
  countableMonths,
  monthLabel,
  partnerProposalsSearchSchema,
} from '~/lib/partner-plans'
import { cn } from '~/lib/utils'
import type { PartnerPlan, PartnerRef, PartnerUsageRow } from '~/lib/partner-plans'

/**
 * Propuestas por proveedor y por mes, contra el tope de su plan.
 *
 * Reemplaza lo que hoy no se puede contestar sin abrir pedido por pedido:
 * "¿cuántas propuestas le mandamos a cada proveedor este mes, y quién pasó el
 * tope de su plan?". El cobro a proveedores arranca en noviembre.
 *
 * ── De dónde salen los datos ───────────────────────────────────────────────
 *
 * Las propuestas son REALES y se cuentan en la base, en UNA consulta:
 * `ops.partner_proposal_usage_monthly()` (migración 025), la misma que leen los
 * ejecutivos por el conector MCP. Sólo `quote_request_proposals`, desde el
 * 27/10, sin pedidos de prueba (`duplicate`). Hasta la 025 se leían pedido por
 * pedido desde el navegador; `Partners › Estudio` todavía lo hace.
 *
 * El PLAN es de ejemplo (`~/mocks/partner-plans`): `partners.plan` no existe.
 * El tope y el rojo de "pasó el tope" se calculan contra ese plan inventado a
 * propósito — decidido el 2026-11-02, para tener la visual de la pantalla
 * mientras no exista el dato. El cartel de arriba lo dice.
 *
 * `ssr: 'data-only'`: el loader corre en el servidor; el mes en curso es del
 * navegador. Está detrás de auth.
 */
export const Route = createFileRoute('/_authed/partners/propuestas')({
  validateSearch: partnerProposalsSearchSchema,
  ssr: 'data-only',
  loader: async ({ abortController }) => {
    const signal = abortController.signal
    const [usage, partners] = await Promise.all([
      listPartnerProposalUsageFn({ signal }),
      listMarketplacePartners({ data: {}, signal }),
    ])
    const partnerRefs: Array<PartnerRef> = partners.map((p) => ({
      id: p.id,
      name: p.name,
      tier: p.tier,
      status: p.status,
    }))
    return { usage, partners: partnerRefs }
  },
  head: () => ({ meta: [{ title: 'Partners · Propuestas — AutoLibre' }] }),
  component: PartnerProposals,
})

function usePlans(partnerIds: ReadonlyArray<string>) {
  const [plans, setPlans] = useState<Map<string, PartnerPlan>>(new Map())
  const key = partnerIds.join(',')
  useEffect(() => {
    let cancelled = false
    void fetchPartnerPlansMock(partnerIds).then((m) => {
      if (!cancelled) setPlans(m)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return plans
}

// ── Pantalla ─────────────────────────────────────────────────────────────────

function PartnerProposals() {
  const { usage, partners } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  const months = useMemo(() => countableMonths(new Date()), [])
  const month = search.proposalMonth && months.includes(search.proposalMonth) ? search.proposalMonth : months[0]!

  const plans = usePlans(useMemo(() => partners.map((p) => p.id), [partners]))

  const allRows = useMemo(
    () =>
      aggregatePartnerUsage(usage.available ? usage.rows : [], month, partners, plans, {
        includeIdle: search.proposalShowIdle,
      }),
    [usage, month, partners, plans, search.proposalShowIdle],
  )
  const rows = search.proposalOverCap ? allRows.filter((r) => r.overCap) : allRows

  const totals = allRows.reduce(
    (acc, r) => ({
      sent: acc.sent + r.sent,
      withdrawn: acc.withdrawn + r.withdrawn,
      selected: acc.selected + r.selected,
      overCap: acc.overCap + Number(r.overCap),
      withProposals: acc.withProposals + Number(r.used > 0),
    }),
    { sent: 0, withdrawn: 0, selected: 0, overCap: 0, withProposals: 0 },
  )

  if (!usage.available) {
    return (
      <>
        <PageHeader title="Propuestas por proveedor" actions={<SsrTag>ssr: data-only</SsrTag>} />
        <Empty>
          {usage.reason === 'no_function'
            ? 'Falta aplicar la migración 025 de ops (`ops.partner_proposal_usage_monthly`) en esta base.'
            : `Esta base no tiene las propuestas en la app (migraciones 0120–0122 del backend). Falta: ${usage.detail ?? '—'}.`}
        </Empty>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Propuestas por proveedor"
        subtitle={`${monthLabel(month)} · hora de Buenos Aires · se cuenta desde el 27/10/2026`}
        actions={<SsrTag>ssr: data-only</SsrTag>}
      />

      <MockBanner
        items={[
          'El plan de cada proveedor es de ejemplo: todavía no existe la columna de plan en la base. Las propuestas, retiradas y elegidas son reales.',
          'Aliado sale del sello real (tier). «Taller de cabecera» no existe todavía en ningún lado.',
        ]}
      />

      <div className="mb-4 flex flex-wrap items-end gap-5">
        <FilterGroup label="Mes">
          {months.map((m) => (
            <Chip key={m} active={m === month} onClick={() => setSearch({ proposalMonth: m })}>
              {monthLabel(m)}
            </Chip>
          ))}
        </FilterGroup>
        <FilterGroup label="Tope">
          <Chip
            tone="warn"
            active={search.proposalOverCap}
            onClick={() => setSearch({ proposalOverCap: !search.proposalOverCap })}
          >
            Solo sobre el tope{totals.overCap > 0 && !search.proposalOverCap ? ` (${totals.overCap})` : ''}
          </Chip>
        </FilterGroup>
        <FilterGroup label="Proveedores">
          <Chip
            active={search.proposalShowIdle}
            onClick={() => setSearch({ proposalShowIdle: !search.proposalShowIdle })}
          >
            Incluir activos sin propuestas
          </Chip>
        </FilterGroup>
      </div>

      <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Enviadas" value={totals.sent} />
        <Stat label="Retiradas" value={totals.withdrawn} />
        <Stat label="Elegidas" value={totals.selected} />
        <Stat label="Proveedores con propuestas" value={totals.withProposals} />
        <Stat label="Pasaron el tope" value={totals.overCap} tone={totals.overCap > 0 ? 'red' : undefined} />
      </dl>

      {rows.length === 0 ? (
        <Empty>
          {search.proposalOverCap
            ? 'Nadie pasó el tope este mes.'
            : 'No hay propuestas enviadas en este mes.'}
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead>Proveedor</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead className="text-right">Enviadas</TableHead>
                <TableHead className="text-right">Retiradas</TableHead>
                <TableHead className="text-right">Elegidas</TableHead>
                <TableHead className="text-right">Usadas / tope</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <UsageRow key={r.partnerId ?? `ext:${r.name}`} row={r} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="mt-4 space-y-1 text-xs text-muted-foreground">
        <p>
          Topes por mes:{' '}
          {PARTNER_PLANS.map((p) => {
            const cap = PARTNER_PLAN_CAPS[p]
            return `${PARTNER_PLAN_LABELS[p]} ${cap === null ? 'sin límite' : formatInt(cap)}`
          }).join(' · ')}
          .
        </p>
        <p>
          Usadas = enviadas + retiradas: una propuesta retirada no devuelve el lugar. Elegidas es parte de
          las enviadas (la que la persona eligió en la app). El mes es el de envío, en hora de Buenos Aires.
        </p>
        <p>
          Aliado se marca como excepción: todavía no está decidido si cuenta contra el tope.
        </p>
      </div>
    </>
  )
}

function UsageRow({ row }: { row: PartnerUsageRow }) {
  const founding = row.tier === 'founding'
  return (
    <TableRow className={cn(row.overCap && 'bg-status-red-bg hover:bg-status-red-bg')}>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          {row.partnerId ? (
            <Link
              to="/partners/$partnerId"
              params={{ partnerId: row.partnerId }}
              className="font-medium text-foreground hover:underline"
            >
              {row.name}
            </Link>
          ) : (
            <span className="font-medium">{row.name}</span>
          )}
          {founding ? (
            <Badge variant="outline" className="border-status-violet/40 text-status-violet">
              Aliado · excepción
            </Badge>
          ) : null}
          {row.status && row.status !== 'active' ? (
            <Badge variant="outline" className="text-muted-foreground">
              {row.status === 'paused' ? 'pausado' : 'archivado'}
            </Badge>
          ) : null}
        </div>
        {row.partnerId === null ? (
          <p className="text-xs text-muted-foreground">Fuera del directorio: sin plan, no se cobra.</p>
        ) : null}
      </TableCell>
      <TableCell className="text-sm">
        {row.plan ? PARTNER_PLAN_LABELS[row.plan] : <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(row.sent)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {row.withdrawn > 0 ? formatInt(row.withdrawn) : <span className="text-muted-foreground">0</span>}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(row.selected)}</TableCell>
      <TableCell className={cn('text-right tabular-nums', row.overCap && 'font-semibold text-status-red')}>
        {formatInt(row.used)} /{' '}
        {row.plan === null ? '—' : row.cap === null ? 'sin límite' : formatInt(row.cap)}
        {row.overCap && row.cap !== null ? (
          <span className="ml-1 text-xs font-normal">(+{formatInt(row.used - row.cap)})</span>
        ) : null}
      </TableCell>
    </TableRow>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'red' }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('font-heading text-lg font-semibold tabular-nums', tone === 'red' && 'text-status-red')}>
        {formatInt(value)}
      </dd>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card py-16 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

