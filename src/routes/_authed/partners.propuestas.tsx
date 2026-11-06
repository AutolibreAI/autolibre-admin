import { Link, createFileRoute } from '@tanstack/react-router'
import { Download, X } from 'lucide-react'
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { listMarketplacePartners } from '~/fn/partners'
import { listPartnerQuoteVolumeFn } from '~/fn/partner-quote-volume'
import { listPartnerPlansFn } from '~/fn/partner-plans'
import { listQuoteRequestsFn } from '~/fn/quote-requests'
import { listPartnerLastContactsFn } from '~/fn/partner-prospects'
import { Chip, FilterGroup, RangeFilter } from '~/components/Filters'
import { MultiSelect } from '~/components/MultiSelect'
import { SortHeader } from '~/components/SortHeader'
import { SearchInput } from '~/components/SearchInput'
import { useProposalFacts } from '~/components/useProposalFacts'
import { ProposalLoadStatus as LoadStatus } from '~/components/ProposalLoadStatus'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { normalizeForMatch } from '~/lib/catalog'
import { formatInt } from '~/lib/format'
import {
  PROPOSAL_COUNT_START,
  PROPOSAL_HISTORY,
  aggregatePartnerHistory,
  aggregatePartnerUsage,
  baDay,
  capLabel,
  countableMonths,
  effectivePlans,
  isFounding,
  monthLabel,
  partnerHistoryCsv,
  shortDay,
} from '~/lib/partner-plans'
import {
  CLEARED_PROPOSAL_FILTERS,
  NO_PLAN,
  TEXT_SORT_KEYS,
  activeProposalFilterChips,
  matchesProposalFilters,
  partnerProposalsPageSearchSchema,
  sortProposalRows,
} from '~/lib/partner-proposal-filters'
import type { PartnerFacts, ProposalSortKey } from '~/lib/partner-proposal-filters'
import { cn } from '~/lib/utils'
import type {
  AllTimeVolume,
  CapTone,
  ExternalUsageRow,
  PartnerHistoryRow,
  PartnerRef,
  PartnerPlansResult,
  PartnerUsageRow,
  PlanInfo,
  UsageCounts,
} from '~/lib/partner-plans'

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
 * El PLAN es real desde el 05/11/26, y de sólo lectura: el plan EFECTIVO de
 * la suscripción de Mercado Pago (billing del backend, `listPartnerPlansFn`),
 * Gratis si no hay una que dé acceso. Topes y nombres salen del catálogo
 * `subscription_plans`. El día que exista `GET /admin/partner-proposal-usage`,
 * esta pantalla deja de pedir propuestas una por una y consume esas filas.
 *
 * La vista histórica (`proposalMonth=historico`) suma todo desde el 27/10 por
 * proveedor, con el pico mensual: el color va sobre ese pico, así se ve quién
 * pasaría el tope de su plan en algún mes. Sale del MISMO conteo que la vista
 * mensual (`bucketProposals`), y su CSV es para cruzar con quién pagó.
 *
 * El histórico suma además "desde siempre" (pedidos y desde cuándo cotiza),
 * de `ops.partner_quote_volume()` (migración 025): incluye lo cargado en
 * `ops.quote_request_response` antes del 27/10, que esta pantalla no cuenta.
 * Va en columnas aparte y no entra al pico ni al color: lo viejo no se publicó
 * en la app y no había tope. Es lo que usa Comercial para llamar a los talleres.
 *
 * Los colores los decide `capTone` (`~/lib/partner-plans`), no esta pantalla:
 * rojo pasó el tope, amarillo llegó, Aliado siempre gris (sin límite por
 * ahora), sin plan (base sin billing) gris. El tope no frena ningún envío.
 *
 * Orden y filtros (06/11/26, para Tobías): todo en la URL, sobre las filas ya
 * contadas — ver `~/lib/partner-proposal-filters`. Los encabezados ordenan
 * (`proposalSort`/`proposalDir`); sin orden elegido queda el de siempre.
 *
 * `ssr: 'data-only'`: el loader corre en el servidor (lista de pedidos y de
 * proveedores), pero la carga de propuestas y el mes en curso son del
 * navegador. Está detrás de auth.
 */
export const Route = createFileRoute('/_authed/partners/propuestas')({
  validateSearch: partnerProposalsPageSearchSchema,
  ssr: 'data-only',
  loader: async ({ abortController }) => {
    const signal = abortController.signal
    const [quotes, partners, volume, plans, contacts] = await Promise.all([
      listQuoteRequestsFn({ data: { quoteStatus: 'all', quoteShowDuplicates: false }, signal }),
      listMarketplacePartners({ data: {}, signal }),
      listPartnerQuoteVolumeFn({ signal }),
      listPartnerPlansFn({ signal }),
      listPartnerLastContactsFn({ signal }),
    ])
    // Sólo proveedores del directorio: un taller de afuera no tiene plan ni ficha.
    const allTime: Array<[string, AllTimeVolume]> | null = volume.available
      ? volume.rows.flatMap((r) =>
          r.partnerId ? [[r.partnerId, { requests: r.requests, firstOn: r.firstQuotedOn }] as [string, AllTimeVolume]] : [],
        )
      : null
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
    // Lo que los filtros necesitan y `PartnerRef` no trae. Sin datos de personas.
    const partnerInfo = partners.map(
      (p) => [p.id, { zone: p.coverageZone || null, categories: p.categories, createdAt: p.createdAt }] as const,
    )
    return {
      requests,
      partners: partnerRefs,
      allTime,
      plansResult: plans,
      partnerInfo,
      lastContacts: contacts.rows,
      contactsAvailable: contacts.available,
    }
  },
  head: () => ({ meta: [{ title: 'Partners · Propuestas — AutoLibre' }] }),
  component: PartnerProposals,
})

// ── Pantalla ─────────────────────────────────────────────────────────────────

function PartnerProposals() {
  const { requests, partners, allTime, plansResult, partnerInfo, lastContacts, contactsAvailable } =
    Route.useLoaderData()
  const allTimeMap = useMemo(() => (allTime ? new Map(allTime) : null), [allTime])
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  const months = useMemo(() => countableMonths(new Date()), [])
  const isHistory = search.proposalMonth === PROPOSAL_HISTORY
  const month = search.proposalMonth && months.includes(search.proposalMonth) ? search.proposalMonth : months[0]!

  const load = useProposalFacts(requests ?? [])
  const plans = useMemo(() => effectivePlans(plansResult, partners.map((p) => p.id)), [plansResult, partners])

  const monthView = useMemo(
    () => aggregatePartnerUsage(load.facts, month, partners, plans, { includeIdle: search.proposalShowIdle }),
    [load.facts, month, partners, plans, search.proposalShowIdle],
  )
  const historyView = useMemo(
    () =>
      aggregatePartnerHistory(load.facts, partners, plans, {
        includeIdle: search.proposalShowIdle,
        allTime: allTimeMap,
      }),
    [load.facts, partners, plans, search.proposalShowIdle, allTimeMap],
  )
  const view = isHistory ? historyView : monthView

  // ── Lo que cada fila necesita para filtrarse y ordenarse ──────────────────
  const infoMap = useMemo(() => new Map(partnerInfo), [partnerInfo])
  const contactMap = useMemo(() => new Map(lastContacts.map((c) => [c.partnerId, c.lastContactOn])), [lastContacts])
  const facts = useMemo(() => {
    const monthUsed = new Map(monthView.rows.map((r) => [r.partnerId, r.used]))
    const historyUsed = new Map(historyView.rows.map((r) => [r.partnerId, r.used]))
    const out = new Map<string, PartnerFacts>()
    for (const id of new Set([...monthUsed.keys(), ...historyUsed.keys()])) {
      const info = infoMap.get(id)
      out.set(id, {
        zone: info?.zone ?? null,
        categories: info?.categories ?? [],
        createdAt: info?.createdAt ?? null,
        lastContactOn: contactMap.get(id) ?? null,
        monthUsed: monthUsed.get(id) ?? 0,
        historyUsed: historyUsed.get(id) ?? 0,
      })
    }
    return out
  }, [monthView, historyView, infoMap, contactMap])
  const factsFor = (id: string): PartnerFacts =>
    facts.get(id) ?? { zone: null, categories: [], createdAt: null, lastContactOn: null, monthUsed: 0, historyUsed: 0 }

  const needle = search.q ? normalizeForMatch(search.q) : ''
  const matches = (name: string) => needle === '' || normalizeForMatch(name).includes(needle)
  const keep = (r: PartnerUsageRow | PartnerHistoryRow) =>
    matches(r.name) &&
    (!search.proposalOverCap || r.tone === 'over') &&
    matchesProposalFilters(r, factsFor(r.partnerId), search)
  const monthRows = sortProposalRows(monthView.rows.filter(keep), search.proposalSort, search.proposalDir, (r, k) =>
    monthSortValue(r, k, factsFor(r.partnerId)),
  )
  const historyRows = sortProposalRows(
    historyView.rows.filter(keep),
    search.proposalSort,
    search.proposalDir,
    (r, k) => historySortValue(r, k, factsFor(r.partnerId)),
  )

  // ── Opciones de los filtros (salen de los datos, nunca a mano) ────────────
  const planOptions = useMemo(() => {
    const catalog = plansResult.available ? plansResult.catalog : []
    return [...catalog.map((p) => ({ value: p.code, label: p.name })), { value: NO_PLAN, label: 'Sin plan' }]
  }, [plansResult])
  const zoneOptions = useMemo(() => {
    const zones = new Set<string>()
    for (const [, info] of partnerInfo) if (info.zone) zones.add(info.zone.trim())
    return [...zones].sort((a, b) => a.localeCompare(b, 'es')).map((z) => ({ value: z, label: z }))
  }, [partnerInfo])
  const rubroOptions = useMemo(() => {
    const bySlug = new Map<string, string>()
    for (const [, info] of partnerInfo) for (const c of info.categories) bySlug.set(c.slug, c.name)
    return [...bySlug].sort((a, b) => a[1].localeCompare(b[1], 'es')).map(([value, label]) => ({ value, label }))
  }, [partnerInfo])
  const monthName = isHistory ? 'del mes en curso' : `de ${monthLabel(month).toLowerCase()}`
  const chips = activeProposalFilterChips(search, {
    plan: (code) => planOptions.find((o) => o.value === code)?.label ?? code,
    rubro: (slug) => rubroOptions.find((o) => o.value === slug)?.label ?? slug,
    monthName,
  })
  const toggle = (list: ReadonlyArray<string>, v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
  const rows = isHistory ? historyRows : monthRows
  const externals = view.externals.filter((e) => matches(e.name))

  const downloadCsv = () => {
    // Se baja lo que se ve: el buscador y "solo sobre el tope" también filtran el CSV.
    const csv = partnerHistoryCsv({ rows: historyRows, externals })
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `propuestas-por-proveedor-historico-${baDay(new Date())}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Los totales no siguen al buscador: son el panorama del período.
  const counted: ReadonlyArray<UsageCounts & { tone: CapTone }> = view.rows
  const totals = counted.reduce(
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
        subtitle={`${isHistory ? 'Histórico' : monthLabel(month)} · hora de Buenos Aires · se cuenta desde el 27/10/2026`}
        actions={<SsrTag>ssr: data-only</SsrTag>}
      />

      {!plansResult.available ? (
        <p className="mb-4 rounded-lg border border-status-yellow/30 bg-status-yellow-bg px-4 py-2 text-xs text-status-yellow">
          Esta base no tiene el billing del backend (subscription_plans / partner_subscriptions): los proveedores
          salen «sin plan» y no se marca ningún tope.
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap items-end gap-5">
        <FilterGroup label="Mes">
          {months.map((m) => (
            <Chip key={m} active={!isHistory && m === month} onClick={() => setSearch({ proposalMonth: m })}>
              {monthLabel(m)}
            </Chip>
          ))}
          <Chip active={isHistory} onClick={() => setSearch({ proposalMonth: PROPOSAL_HISTORY })}>
            Histórico (desde 27/10/26)
          </Chip>
        </FilterGroup>
        <FilterGroup label="Tope">
          <Chip
            tone="warn"
            active={search.proposalOverCap}
            onClick={() => setSearch({ proposalOverCap: !search.proposalOverCap })}
          >
            {isHistory ? 'Solo con un mes sobre el tope' : 'Solo sobre el tope'}
            {totals.over > 0 && !search.proposalOverCap ? ` (${totals.over})` : ''}
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
        <SearchInput
          label="Buscar"
          placeholder="Nombre del proveedor"
          value={search.q}
          onSearch={(q) => setSearch({ q })}
          className="w-full sm:w-56"
        />
        {isHistory ? (
          <Button variant="outline" size="sm" onClick={downloadCsv} disabled={load.loading}>
            <Download className="size-3.5" aria-hidden />
            Descargar CSV
          </Button>
        ) : null}
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-5">
        <FilterGroup
          label="Plan"
          onClear={search.proposalPlans.length > 0 ? () => setSearch({ proposalPlans: [] }) : undefined}
        >
          {planOptions.map((o) => (
            <Chip
              key={o.value}
              active={search.proposalPlans.includes(o.value)}
              onClick={() => setSearch({ proposalPlans: toggle(search.proposalPlans, o.value) })}
            >
              {o.label}
            </Chip>
          ))}
        </FilterGroup>
        <FilterGroup label="Aliado">
          <Chip active={search.proposalAliado === 'all'} onClick={() => setSearch({ proposalAliado: 'all' })}>
            Todos
          </Chip>
          <Chip active={search.proposalAliado === 'yes'} onClick={() => setSearch({ proposalAliado: 'yes' })}>
            Sí
          </Chip>
          <Chip active={search.proposalAliado === 'no'} onClick={() => setSearch({ proposalAliado: 'no' })}>
            No
          </Chip>
        </FilterGroup>
        <div className="space-y-1.5">
          <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">Zona</span>
          <MultiSelect
            label="Zona"
            options={zoneOptions}
            selected={search.proposalZones}
            onChange={(next) => setSearch({ proposalZones: next })}
            placeholder="Todas"
            searchPlaceholder="Buscar zona…"
            className="w-52"
          />
        </div>
        <div className="space-y-1.5">
          <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">Rubro</span>
          <MultiSelect
            label="Rubro"
            options={rubroOptions}
            selected={search.proposalRubros}
            onChange={(next) => setSearch({ proposalRubros: next })}
            placeholder="Todos"
            searchPlaceholder="Buscar rubro…"
            className="w-52"
          />
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-5">
        <RangeFilter
          label={`Propuestas ${monthName}`}
          type="number"
          min={search.proposalMonthMin}
          max={search.proposalMonthMax}
          onCommit={({ min, max }) => setSearch({ proposalMonthMin: toCount(min), proposalMonthMax: toCount(max) })}
        />
        <RangeFilter
          label="Propuestas desde 27/10"
          type="number"
          min={search.proposalHistMin}
          max={search.proposalHistMax}
          onCommit={({ min, max }) => setSearch({ proposalHistMin: toCount(min), proposalHistMax: toCount(max) })}
        />
        <RangeFilter
          label="Fecha de alta"
          type="date"
          min={search.proposalJoinedFrom}
          max={search.proposalJoinedTo}
          onCommit={({ min, max }) => setSearch({ proposalJoinedFrom: min, proposalJoinedTo: max })}
        />
        {contactsAvailable ? (
          <>
            <RangeFilter
              label="Último contacto"
              type="date"
              min={search.proposalContactFrom}
              max={search.proposalContactTo}
              onCommit={({ min, max }) => setSearch({ proposalContactFrom: min, proposalContactTo: max })}
            />
            <FilterGroup label="Comercial">
              <Chip
                active={search.proposalNoContact}
                onClick={() => setSearch({ proposalNoContact: !search.proposalNoContact })}
              >
                Sin contacto
              </Chip>
            </FilterGroup>
          </>
        ) : null}
      </div>

      {chips.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-1.5" aria-label="Filtros activos">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setSearch(c.clear as Partial<typeof search>)}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-brand/40 bg-brand-soft px-2.5 text-xs text-brand outline-none hover:border-brand focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Quitar filtro ${c.label}`}
            >
              {c.label}
              <X className="size-3" aria-hidden />
            </button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setSearch({ ...CLEARED_PROPOSAL_FILTERS, proposalPlans: [], proposalZones: [], proposalRubros: [] })
            }
          >
            Limpiar filtros
          </Button>
        </div>
      ) : null}

      <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-6">
        <Stat label="Enviadas" value={totals.sent} />
        <Stat label="Retiradas" value={totals.withdrawn} />
        <Stat label="Elegidas" value={totals.selected} />
        <Stat label="Proveedores con propuestas" value={totals.withProposals} />
        <Stat
          label={isHistory ? 'Llegaron al tope en un mes' : 'Llegaron al tope'}
          value={totals.at}
          tone={totals.at > 0 ? 'yellow' : undefined}
        />
        <Stat
          label={isHistory ? 'Pasaron el tope en un mes' : 'Pasaron el tope'}
          value={totals.over}
          tone={totals.over > 0 ? 'red' : undefined}
        />
      </dl>

      <LoadStatus load={load} />

      {load.unavailable ? (
        <Empty>
          Esta base no tiene las propuestas en la app (migraciones 0120–0122 del backend). No hay nada que
          contar.
        </Empty>
      ) : rows.length === 0 && !load.loading ? (
        <Empty>
          {chips.length > 0
            ? 'Ningún proveedor coincide con los filtros.'
            : search.proposalOverCap
              ? isHistory
                ? 'Nadie pasó el tope en ningún mes.'
                : 'Nadie pasó el tope este mes.'
              : isHistory
                ? 'No hay propuestas a proveedores del directorio desde el 27/10.'
                : 'No hay propuestas a proveedores del directorio en este mes.'}
        </Empty>
      ) : isHistory ? (
        <>
          {allTimeMap === null ? (
            <p className="mb-2 rounded-lg border border-status-yellow/30 bg-status-yellow-bg px-4 py-2 text-xs text-status-yellow">
              «Desde siempre» no está disponible: falta aplicar la migración 025 de ops en esta base.
            </p>
          ) : null}
          <HistoryTable rows={historyRows} factsFor={factsFor} />
        </>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table className="min-w-[1180px]">
            <TableHeader>
              <TableRow>
                <Th label="Proveedor" k="name" />
                <Th label="Plan" k="plan" />
                <Th label="Zona" k="zone" />
                <Th label="Alta" k="createdAt" />
                <Th label="Último contacto" k="lastContact" title="Del seguimiento comercial (Comercial › Contactos)." />
                <Th label="Enviadas" k="sent" align="right" />
                <Th label="Retiradas" k="withdrawn" align="right" />
                <Th label="Elegidas" k="selected" align="right" />
                <Th label="Usadas / tope" k="used" align="right" />
                <Th label="Desde 27/10" k="historyUsed" align="right" title="Usadas desde el 27/10/26 (el histórico)." />
              </TableRow>
            </TableHeader>
            <TableBody>
              {monthRows.map((r) => (
                <UsageRow key={r.partnerId} row={r} facts={factsFor(r.partnerId)} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ExternalSection rows={externals} history={isHistory} />

      <Legend plansResult={plansResult} />
    </>
  )
}

function UsageRow({ row, facts }: { row: PartnerUsageRow; facts: PartnerFacts }) {
  return (
    <TableRow className={toneRowClass(row.tone)}>
      <TableCell>
        <ProviderName row={row} />
      </TableCell>
      <TableCell className="text-sm">
        <PlanCell plan={row.plan} />
      </TableCell>
      <FactCells facts={facts} />
      <TableCell className="text-right tabular-nums">{formatInt(row.sent)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {row.withdrawn > 0 ? formatInt(row.withdrawn) : <span className="text-muted-foreground">0</span>}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(row.selected)}</TableCell>
      <TableCell className={cn('text-right tabular-nums', toneTextClass(row.tone))}>
        {formatInt(row.used)} / {row.plan === null ? '—' : row.cap === null ? 'sin límite' : formatInt(row.cap)}
        <ToneNote tone={row.tone} used={row.used} cap={row.cap} />
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(facts.historyUsed)}</TableCell>
    </TableRow>
  )
}

// ── Vista histórica ──────────────────────────────────────────────────────────

/**
 * Sin columna de tope: el tope es mensual. El color va sobre el PICO mensual,
 * con las mismas reglas que el mes (`capTone`).
 */
function HistoryTable({
  rows,
  factsFor,
}: {
  rows: ReadonlyArray<PartnerHistoryRow>
  factsFor: (id: string) => PartnerFacts
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <Table className="min-w-[1600px]">
        <TableHeader>
          <TableRow>
            <Th label="Proveedor" k="name" />
            <Th label="Plan" k="plan" />
            <Th label="Zona" k="zone" />
            <Th label="Alta" k="createdAt" />
            <Th label="Último contacto" k="lastContact" title="Del seguimiento comercial (Comercial › Contactos)." />
            <Th
              label="Pedidos desde siempre"
              k="allTime"
              align="right"
              title="Pedidos distintos en los que cotizó, también antes del 27/10 (tabla vieja de ops). No entra al pico ni al color."
            />
            <Th label="Cotiza desde" k="allTimeFirst" title="La primera vez que cotizó, en cualquiera de las dos tablas." />
            <Th label="Enviadas" k="sent" align="right" />
            <Th label="Retiradas" k="withdrawn" align="right" />
            <Th label="Elegidas" k="selected" align="right" />
            <Th label="Total usadas" k="used" align="right" />
            <Th label="% elegidas" k="pctSelected" align="right" />
            <Th label="Primera" k="firstAt" />
            <Th label="Última" k="lastAt" />
            <Th label="Meses" k="activeMonths" align="right" />
            <Th label="Pico mensual" k="peak" align="right" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.partnerId} className={toneRowClass(r.tone)}>
              <TableCell>
                <ProviderName row={r} />
              </TableCell>
              <TableCell className="text-sm">
                <PlanCell plan={r.plan} />
              </TableCell>
              <FactCells facts={factsFor(r.partnerId)} />
              <TableCell className="text-right font-medium tabular-nums">
                {r.allTime === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  formatInt(r.allTime.requests)
                )}
              </TableCell>
              <TableCell className="text-sm tabular-nums">
                {r.allTime?.firstOn ? shortDay(r.allTime.firstOn) : <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatInt(r.sent)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {r.withdrawn > 0 ? formatInt(r.withdrawn) : <span className="text-muted-foreground">0</span>}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatInt(r.selected)}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{formatInt(r.used)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {r.pctSelected === null ? <span className="text-muted-foreground">—</span> : formatPct(r.pctSelected)}
              </TableCell>
              <TableCell className="text-sm tabular-nums">{r.firstAt ? shortDay(baDay(r.firstAt)) : '—'}</TableCell>
              <TableCell className="text-sm tabular-nums">{r.lastAt ? shortDay(baDay(r.lastAt)) : '—'}</TableCell>
              <TableCell className="text-right tabular-nums">{formatInt(r.activeMonths)}</TableCell>
              <TableCell className={cn('text-right tabular-nums', toneTextClass(r.tone))}>
                {r.peak ? (
                  <>
                    {formatInt(r.peak.used)}
                    <span className="ml-1 text-xs font-normal">en {monthLabel(r.peak.month)}</span>
                    <ToneNote tone={r.tone} used={r.peak.used} cap={r.plan ? r.plan.cap : null} />
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// ── Orden ────────────────────────────────────────────────────────────────────

const SORT_SEARCH_KEYS = { sort: 'proposalSort', dir: 'proposalDir' }

/** Encabezado ordenable: texto A→Z al primer click; números y fechas, de mayor a menor. */
function Th({ label, k, align, title }: { label: string; k: ProposalSortKey; align?: 'right'; title?: string }) {
  const search = Route.useSearch()
  return (
    <SortHeader
      label={label}
      sortKey={k}
      active={search.proposalSort === k}
      dir={search.proposalDir}
      to="/partners/propuestas"
      align={align}
      firstClick={TEXT_SORT_KEYS.has(k) ? 'asc' : 'desc'}
      searchKeys={SORT_SEARCH_KEYS}
      title={title}
    />
  )
}

type SortValue = number | string | null

/** `undefined` = esa columna no es común a las dos tablas. */
function commonSortValue(
  r: PartnerUsageRow | PartnerHistoryRow,
  k: ProposalSortKey,
  f: PartnerFacts,
): SortValue | undefined {
  switch (k) {
    case 'name':
      return r.name
    case 'plan':
      return r.plan?.name ?? null
    case 'zone':
      return f.zone
    case 'createdAt':
      return f.createdAt
    case 'lastContact':
      return f.lastContactOn
    case 'sent':
      return r.sent
    case 'withdrawn':
      return r.withdrawn
    case 'selected':
      return r.selected
    case 'used':
      return r.used
    case 'monthUsed':
      return f.monthUsed
    case 'historyUsed':
      return f.historyUsed
    default:
      return undefined
  }
}

function monthSortValue(r: PartnerUsageRow, k: ProposalSortKey, f: PartnerFacts): SortValue {
  return commonSortValue(r, k, f) ?? null
}

function historySortValue(r: PartnerHistoryRow, k: ProposalSortKey, f: PartnerFacts): SortValue {
  const common = commonSortValue(r, k, f)
  if (common !== undefined) return common
  switch (k) {
    case 'allTime':
      return r.allTime?.requests ?? null
    case 'allTimeFirst':
      return r.allTime?.firstOn || null
    case 'pctSelected':
      return r.pctSelected
    case 'firstAt':
      return r.firstAt
    case 'lastAt':
      return r.lastAt
    case 'activeMonths':
      return r.activeMonths
    case 'peak':
      return r.peak?.used ?? null
    default:
      return null
  }
}

/** `''` del rango es "sin tope", nunca 0. */
function toCount(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

/** Zona, alta y último contacto: lo que Tobías mira antes de llamar. */
function FactCells({ facts }: { facts: PartnerFacts }) {
  return (
    <>
      <TableCell className="max-w-48 truncate text-sm" title={facts.zone ?? undefined}>
        {facts.zone ?? <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="text-sm tabular-nums">
        {facts.createdAt ? shortDay(baDay(facts.createdAt)) : <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="text-sm tabular-nums">
        {facts.lastContactOn ? (
          shortDay(facts.lastContactOn)
        ) : (
          <span className="text-muted-foreground">sin contacto</span>
        )}
      </TableCell>
    </>
  )
}

const pct = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 })
const formatPct = (n: number) => `${pct.format(n)} %`

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

/** El plan efectivo, de sólo lectura: lo contrata el taller por Mercado Pago. */
function PlanCell({ plan }: { plan: PlanInfo | null }) {
  return plan ? <span>{plan.name}</span> : <span className="text-muted-foreground">sin plan</span>
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
function ExternalSection({ rows, history }: { rows: ReadonlyArray<ExternalUsageRow>; history: boolean }) {
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
                {history ? <TableHead>Primera</TableHead> : null}
                {history ? <TableHead>Última</TableHead> : null}
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
                  {history ? (
                    <TableCell className="text-sm tabular-nums">{r.firstAt ? shortDay(baDay(r.firstAt)) : '—'}</TableCell>
                  ) : null}
                  {history ? (
                    <TableCell className="text-sm tabular-nums">{r.lastAt ? shortDay(baDay(r.lastAt)) : '—'}</TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}

function Legend({ plansResult }: { plansResult: PartnerPlansResult }) {
  const catalog = plansResult.available ? plansResult.catalog.filter((p) => p.active) : []
  return (
    <div className="mt-4 space-y-1 text-xs text-muted-foreground">
      {catalog.length > 0 ? (
        <p>
          Topes por mes calendario: {catalog.map((p) => `${p.name} ${capLabel(p)}`).join(' · ')}. El plan es el
          efectivo de la suscripción de Mercado Pago (en prueba o activa); sin suscripción, pendiente o pausada
          es Gratis. Se ve, no se cambia desde el panel.
        </p>
      ) : null}
      <p>
        Usadas = enviadas + retiradas: una propuesta retirada no devuelve el lugar. Elegidas = la propuesta que
        la persona tiene elegida hoy en la app; si la eligió y después la des-eligió, no cuenta. El mes es el de
        envío, en hora de Buenos Aires. En el histórico, el pico mensual es el máximo de usadas en un mes
        calendario, y el color va sobre ese pico.
      </p>
      <p>
        «Pedidos desde siempre» (sólo en el histórico) cuenta pedidos distintos en los que el proveedor cotizó,
        también antes del 27/10, cuando lo que contestaba cada taller se cargaba en otra tabla. No entra al pico
        ni al color: eso no se publicó en la app y no había tope. Sin pedidos de prueba.
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
