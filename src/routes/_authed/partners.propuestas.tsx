import { Link, createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { listMarketplacePartners } from '~/fn/partners'
import { listQuoteRequestsFn } from '~/fn/quote-requests'
import { Chip, FilterGroup } from '~/components/Filters'
import { MockBanner } from '~/components/MockBanner'
import { useProposalFacts } from '~/components/useProposalFacts'
import { usePartnerPlans } from '~/components/usePartnerPlans'
import { ProposalLoadStatus as LoadStatus } from '~/components/ProposalLoadStatus'
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
import { formatInt } from '~/lib/format'
import {
  PARTNER_PLANS,
  PARTNER_PLAN_CAPS,
  PARTNER_PLAN_LABELS,
  PROPOSAL_COUNT_START,
  aggregatePartnerUsage,
  countableMonths,
  isFounding,
  monthLabel,
  partnerProposalsSearchSchema,
} from '~/lib/partner-plans'
import { cn } from '~/lib/utils'
import type { CapTone, ExternalUsageRow, PartnerPlan, PartnerRef, PartnerUsageRow } from '~/lib/partner-plans'

/**
 * Propuestas por proveedor y por mes, contra el tope de su plan.
 *
 * Reemplaza lo que hoy no se puede contestar sin abrir pedido por pedido:
 * "¿cuántas propuestas le mandamos a cada proveedor este mes, y quién pasó el
 * tope de su plan?". El cobro a proveedores arranca en noviembre.
 *
 * ── De dónde salen los datos ───────────────────────────────────────────────
 *
 * Las propuestas son REALES: no hay un endpoint que las cuente por proveedor,
 * así que se leen pedido por pedido con `listQuoteProposalsFn` (el mismo que
 * usa la ficha), desde el navegador, como hace el mapa de cobertura con el GPS.
 * Sólo se piden los pedidos que pueden tener propuestas contables: abiertos, o
 * cerrados desde el 27/10. Sin duplicados (el equipo marca así sus pruebas).
 *
 * El PLAN es de ejemplo (`~/mocks/partner-plans`): `partners.plan` no existe.
 * El día que exista `GET /admin/partner-proposal-usage`, esta pantalla deja de
 * pedir propuestas una por una y consume esas filas.
 *
 * Los colores los decide `capTone` (`~/lib/partner-plans`), no esta pantalla:
 * rojo pasó el tope, amarillo llegó, Aliado siempre gris (sin límite por
 * ahora), sin plan gris. El tope no frena ningún envío: sólo se marca.
 *
 * `ssr: 'data-only'`: el loader corre en el servidor (lista de pedidos y de
 * proveedores), pero la carga de propuestas y el mes en curso son del
 * navegador. Está detrás de auth.
 */
export const Route = createFileRoute('/_authed/partners/propuestas')({
  validateSearch: partnerProposalsSearchSchema,
  ssr: 'data-only',
  loader: async ({ abortController }) => {
    const signal = abortController.signal
    const [quotes, partners] = await Promise.all([
      listQuoteRequestsFn({ data: { quoteStatus: 'all', quoteShowDuplicates: false }, signal }),
      listMarketplacePartners({ data: {}, signal }),
    ])
    const requests =
      'rows' in quotes
        ? quotes.rows
            .filter((r) => r.status !== 'closed' || (r.closedAt ?? '') >= PROPOSAL_COUNT_START)
            .map((r) => ({ id: r.id, createdAt: r.createdAt, channel: r.channel }))
        : null
    const partnerRefs: Array<PartnerRef> = partners.map((p) => ({
      id: p.id,
      name: p.name,
      tier: p.tier,
      status: p.status,
    }))
    return { requests, partners: partnerRefs }
  },
  head: () => ({ meta: [{ title: 'Partners · Propuestas — AutoLibre' }] }),
  component: PartnerProposals,
})

// ── Pantalla ─────────────────────────────────────────────────────────────────

function PartnerProposals() {
  const { requests, partners } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  const months = useMemo(() => countableMonths(new Date()), [])
  const month = search.proposalMonth && months.includes(search.proposalMonth) ? search.proposalMonth : months[0]!

  const load = useProposalFacts(requests ?? [])
  const { plans } = usePartnerPlans(useMemo(() => partners.map((p) => p.id), [partners]))

  const view = useMemo(
    () => aggregatePartnerUsage(load.facts, month, partners, plans, { includeIdle: search.proposalShowIdle }),
    [load.facts, month, partners, plans, search.proposalShowIdle],
  )
  const rows = search.proposalOverCap ? view.rows.filter((r) => r.tone === 'over') : view.rows

  const totals = view.rows.reduce(
    (acc, r) => ({
      sent: acc.sent + r.sent,
      withdrawn: acc.withdrawn + r.withdrawn,
      selected: acc.selected + r.selected,
      over: acc.over + Number(r.tone === 'over'),
      at: acc.at + Number(r.tone === 'at'),
      withProposals: acc.withProposals + Number(r.used > 0),
    }),
    { sent: 0, withdrawn: 0, selected: 0, over: 0, at: 0, withProposals: 0 },
  )

  if (requests === null) {
    return (
      <>
        <PageHeader title="Propuestas por proveedor" actions={<SsrTag>ssr: data-only</SsrTag>} />
        <Empty>Esta base no tiene la tabla de pedidos (`quote_requests`).</Empty>
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
            Solo sobre el tope{totals.over > 0 && !search.proposalOverCap ? ` (${totals.over})` : ''}
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

      <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-6">
        <Stat label="Enviadas" value={totals.sent} />
        <Stat label="Retiradas" value={totals.withdrawn} />
        <Stat label="Elegidas" value={totals.selected} />
        <Stat label="Proveedores con propuestas" value={totals.withProposals} />
        <Stat label="Llegaron al tope" value={totals.at} tone={totals.at > 0 ? 'yellow' : undefined} />
        <Stat label="Pasaron el tope" value={totals.over} tone={totals.over > 0 ? 'red' : undefined} />
      </dl>

      <LoadStatus load={load} />

      {load.unavailable ? (
        <Empty>
          Esta base no tiene las propuestas en la app (migraciones 0120–0122 del backend). No hay nada que
          contar.
        </Empty>
      ) : rows.length === 0 && !load.loading ? (
        <Empty>
          {search.proposalOverCap
            ? 'Nadie pasó el tope este mes.'
            : 'No hay propuestas a proveedores del directorio en este mes.'}
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
                <UsageRow key={r.partnerId} row={r} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ExternalSection rows={view.externals} />

      <Legend />
    </>
  )
}

function UsageRow({ row }: { row: PartnerUsageRow }) {
  return (
    <TableRow className={toneRowClass(row.tone)}>
      <TableCell>
        <ProviderName row={row} />
      </TableCell>
      <TableCell className="text-sm">
        <PlanLabel plan={row.plan} />
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(row.sent)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {row.withdrawn > 0 ? formatInt(row.withdrawn) : <span className="text-muted-foreground">0</span>}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(row.selected)}</TableCell>
      <TableCell className={cn('text-right tabular-nums', toneTextClass(row.tone))}>
        {formatInt(row.used)} / {row.plan === null ? '—' : row.cap === null ? 'sin límite' : formatInt(row.cap)}
        <ToneNote tone={row.tone} used={row.used} cap={row.cap} />
      </TableCell>
    </TableRow>
  )
}

// ── Piezas compartidas por las filas ─────────────────────────────────────────

function ProviderName({ row }: { row: { partnerId: string; name: string; tier: string | null; status: string | null } }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Link
        to="/partners/$partnerId"
        params={{ partnerId: row.partnerId }}
        className="font-medium text-foreground hover:underline"
      >
        {row.name}
      </Link>
      {isFounding(row.tier) ? (
        <Badge variant="outline" className="border-border text-muted-foreground">
          Aliado · sin límite por ahora
        </Badge>
      ) : null}
      {row.status && row.status !== 'active' ? (
        <Badge variant="outline" className="text-muted-foreground">
          {row.status === 'paused' ? 'pausado' : 'archivado'}
        </Badge>
      ) : null}
    </div>
  )
}

function PlanLabel({ plan }: { plan: PartnerPlan | null }) {
  return plan ? <>{PARTNER_PLAN_LABELS[plan]}</> : <span className="text-muted-foreground">sin plan</span>
}

function toneRowClass(tone: CapTone) {
  return cn(
    tone === 'over' && 'bg-status-red-bg hover:bg-status-red-bg',
    tone === 'at' && 'bg-status-yellow-bg hover:bg-status-yellow-bg',
  )
}

function toneTextClass(tone: CapTone) {
  return cn(
    tone === 'over' && 'font-semibold text-status-red',
    tone === 'at' && 'font-semibold text-status-yellow',
    (tone === 'founding' || tone === 'no_plan') && 'text-muted-foreground',
  )
}

function ToneNote({ tone, used, cap }: { tone: CapTone; used: number; cap: number | null }) {
  if (tone === 'over' && cap !== null) {
    return <span className="ml-1 text-xs font-normal">(+{formatInt(used - cap)})</span>
  }
  if (tone === 'at') return <span className="ml-1 text-xs font-normal">(llegó)</span>
  if (tone === 'founding' && cap !== null) return <span className="ml-1 text-xs font-normal">(referencia)</span>
  return null
}

// ── Talleres de afuera ───────────────────────────────────────────────────────

/**
 * Caso excepcional (decidido el 02/11/26): un taller que no está en el
 * directorio. No tiene plan, no suma a ningún tope y no se cobra. Va aparte
 * para que no se confunda con un proveedor, y para ver quién conviene dar de
 * alta.
 */
function ExternalSection({ rows }: { rows: ReadonlyArray<ExternalUsageRow> }) {
  return (
    <section className="mt-6">
      <h2 className="mb-1 font-heading text-sm font-semibold">Propuestas a talleres de afuera (excepción)</h2>
      <p className="mb-2 text-xs text-muted-foreground">
        No están en el directorio: no suman a ningún tope ni plan. Si uno sigue recibiendo propuestas,
        conviene registrarlo como proveedor.
      </p>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          Ninguna en este período.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table className="min-w-[560px]">
            <TableHeader>
              <TableRow>
                <TableHead>Taller</TableHead>
                <TableHead className="text-right">Enviadas</TableHead>
                <TableHead className="text-right">Retiradas</TableHead>
                <TableHead className="text-right">Elegidas</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.name}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(r.sent)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(r.withdrawn)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(r.selected)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(r.used)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}

function Legend() {
  return (
    <div className="mt-4 space-y-1 text-xs text-muted-foreground">
      <p>
        Topes por mes calendario:{' '}
        {PARTNER_PLANS.map((p) => {
          const cap = PARTNER_PLAN_CAPS[p]
          return `${PARTNER_PLAN_LABELS[p]} ${cap === null ? 'sin límite' : formatInt(cap)}`
        }).join(' · ')}
        .
      </p>
      <p>
        Usadas = enviadas + retiradas: una propuesta retirada no devuelve el lugar. Elegidas = la propuesta que
        la persona tiene elegida hoy en la app; si la eligió y después la des-eligió, no cuenta. El mes es el de
        envío, en hora de Buenos Aires.
      </p>
      <p>
        Rojo: pasó el tope. Amarillo: llegó al tope. Aliado: sin límite por ahora, su tope es sólo referencia y
        nunca se pinta. El tope no frena ningún envío: sólo se marca.
      </p>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'red' | 'yellow' }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'font-heading text-lg font-semibold tabular-nums',
          tone === 'red' && 'text-status-red',
          tone === 'yellow' && 'text-status-yellow',
        )}
      >
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
