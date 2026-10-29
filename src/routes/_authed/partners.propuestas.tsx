import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { listMarketplacePartners } from '~/fn/partners'
import { listQuoteProposalsFn } from '~/fn/quote-proposals'
import { listQuoteRequestsFn } from '~/fn/quote-requests'
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
  PROPOSAL_COUNT_START,
  aggregatePartnerUsage,
  countableMonths,
  monthLabel,
  partnerProposalsSearchSchema,
} from '~/lib/partner-plans'
import { cn } from '~/lib/utils'
import type { PartnerPlan, PartnerRef, PartnerUsageRow, ProposalFact } from '~/lib/partner-plans'

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
    const requestIds =
      'rows' in quotes
        ? quotes.rows
            .filter((r) => r.status !== 'closed' || (r.closedAt ?? '') >= PROPOSAL_COUNT_START)
            .map((r) => r.id)
        : null
    const partnerRefs: Array<PartnerRef> = partners.map((p) => ({
      id: p.id,
      name: p.name,
      tier: p.tier,
      status: p.status,
    }))
    return { requestIds, partners: partnerRefs }
  },
  head: () => ({ meta: [{ title: 'Partners · Propuestas — AutoLibre' }] }),
  component: PartnerProposals,
})

// ── Propuestas, pedido por pedido ────────────────────────────────────────────

/** Cache del módulo: volver a la pantalla o cambiar de mes no vuelve a pedir. */
const factsCache = new Map<string, Array<ProposalFact> | 'error' | 'unavailable'>()
const CONCURRENCY = 4

function useProposalFacts(requestIds: ReadonlyArray<string>) {
  const key = requestIds.join(',')
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    const pending = requestIds.filter((id) => !factsCache.has(id))
    let next = 0
    let sinceRender = 0
    const worker = async () => {
      while (!cancelled && next < pending.length) {
        const id = pending[next++]!
        try {
          const res = await listQuoteProposalsFn({ data: { quoteRequestId: id } })
          if (!res.available) {
            factsCache.set(id, 'unavailable')
          } else {
            factsCache.set(
              id,
              [...res.active, ...res.withdrawn].map((p) => ({
                id: p.id,
                quoteRequestId: id,
                partnerId: p.partnerId,
                providerName: p.providerName,
                createdAt: p.createdAt,
                withdrawnAt: p.withdrawnAt,
                selected: p.id === res.selectedProposalId,
              })),
            )
          }
        } catch {
          factsCache.set(id, 'error')
        }
        if (!cancelled && ++sinceRender >= 8) {
          sinceRender = 0
          setVersion((v) => v + 1)
        }
      }
    }
    void Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(() => {
      if (!cancelled) setVersion((v) => v + 1)
    })
    return () => {
      cancelled = true
    }
    // `requestIds` cambia sólo si cambia `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return useMemo(() => {
    const facts: Array<ProposalFact> = []
    let done = 0
    let failed = 0
    let unavailable = false
    for (const id of requestIds) {
      const v = factsCache.get(id)
      if (v === undefined) continue
      done += 1
      if (v === 'error') failed += 1
      else if (v === 'unavailable') unavailable = true
      else facts.push(...v)
    }
    return { facts, done, failed, unavailable, total: requestIds.length, loading: done < requestIds.length }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version])
}

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
  const { requestIds, partners } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  const months = useMemo(() => countableMonths(new Date()), [])
  const month = search.proposalMonth && months.includes(search.proposalMonth) ? search.proposalMonth : months[0]!

  const load = useProposalFacts(requestIds ?? [])
  const plans = usePlans(useMemo(() => partners.map((p) => p.id), [partners]))

  const allRows = useMemo(
    () => aggregatePartnerUsage(load.facts, month, partners, plans, { includeIdle: search.proposalShowIdle }),
    [load.facts, month, partners, plans, search.proposalShowIdle],
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

  if (requestIds === null) {
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

function LoadStatus({ load }: { load: ReturnType<typeof useProposalFacts> }) {
  if (!load.loading && load.failed === 0) return null
  return (
    <p className={cn('mb-3 text-xs', load.failed > 0 ? 'text-status-yellow' : 'text-muted-foreground')}>
      {load.loading
        ? `Leyendo propuestas: ${formatInt(load.done)} de ${formatInt(load.total)} pedidos. Los números se completan solos.`
        : null}
      {load.failed > 0
        ? ` ${formatInt(load.failed)} pedidos no se pudieron leer: los totales pueden estar cortos. Recargá la página.`
        : null}
    </p>
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

