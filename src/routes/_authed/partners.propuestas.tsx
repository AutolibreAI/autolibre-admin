import { Fragment, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Download, X } from 'lucide-react'
import { listMarketplacePartners } from '~/fn/partners'
import { listQuoteRequestsFn } from '~/fn/quote-requests'
import { getProvidersFactsFn } from '~/fn/partner-fees'
import { Chip, FilterGroup } from '~/components/Filters'
import { MultiSelect } from '~/components/MultiSelect'
import { SortHeader } from '~/components/SortHeader'
import { SearchInput } from '~/components/SearchInput'
import { useProposalFacts } from '~/components/useProposalFacts'
import { ProposalLoadStatus as LoadStatus } from '~/components/ProposalLoadStatus'
import { PackageComposer } from '~/components/PartnerPackages'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { normalizeForMatch } from '~/lib/catalog'
import { toCsv } from '~/lib/csv'
import { formatArs, formatInt } from '~/lib/format'
import {
  PROPOSAL_COUNT_START,
  aggregatePartnerUsage,
  baDay,
  countableMonths,
  isFounding,
  monthLabel,
  shortDay,
} from '~/lib/partner-plans'
import type { ExternalUsageRow, PartnerRef } from '~/lib/partner-plans'
import { feeDay } from '~/lib/partner-fees'
import { PARTNER_FEE_CONFIG } from '~/lib/partner-fees-config'
import {
  PROVIDERS_CSV_HEADER,
  PROVIDER_STATUSES,
  PROVIDER_STATUS_LABELS,
  PROVIDER_TEXT_SORT_KEYS,
  providersSearchSchema,
  type ProviderFacts,
  type ProviderSortKey,
} from '~/lib/partner-providers'
import { cn } from '~/lib/utils'

/**
 * Partners › Proveedores (`/partners/propuestas`; la URL quedó de cuando era
 * «Propuestas», para no romper links). → `.claude/rules/partner-fees.md`.
 *
 * Desde el 2026-11-26 no hay planes ni tope de respuestas: esta pantalla dejó
 * de comparar propuestas contra el tope del plan y pasó a ser la vista por
 * proveedor del cobro nuevo. Por fila: rubros, zona, estado, «Alta por», alta,
 * propuestas enviadas en el mes, trabajos confirmados (total y del mes), si ya
 * usó el primer trabajo gratis, el paquete vigente y lo que hay por cobrar.
 *
 * - Las PROPUESTAS se cuentan en el navegador, pedido por pedido
 *   (`useProposalFacts`), igual que antes: no hay un endpoint que las cuente.
 * - Trabajos, gratis, paquetes y por cobrar salen de `getProvidersFactsFn`,
 *   con la MISMA clasificación que Liquidaciones.
 * - Filtros y orden en el CLIENTE (decenas de filas), en la URL (`provider*`).
 *
 * `ssr: 'data-only'`: el loader corre en el servidor, la carga de propuestas
 * es del navegador. Está detrás de auth.
 */
export const Route = createFileRoute('/_authed/partners/propuestas')({
  validateSearch: providersSearchSchema,
  ssr: 'data-only',
  loader: async ({ abortController }) => {
    const signal = abortController.signal
    const [quotes, partners, facts] = await Promise.all([
      listQuoteRequestsFn({ data: { quoteStatus: 'all', quoteShowDuplicates: false }, signal }),
      listMarketplacePartners({ data: {}, signal }),
      getProvidersFactsFn({ signal }).catch(() => ({ available: false as const })),
    ])
    const requests =
      'rows' in quotes
        ? quotes.rows
            .filter((r) => r.status !== 'closed' || (r.closedAt ?? '') >= PROPOSAL_COUNT_START)
            .map((r) => ({ id: r.id, createdAt: r.createdAt, channel: r.channel }))
        : null
    const list = partners.map((p) => ({
      id: p.id,
      name: p.name,
      tier: p.tier,
      status: p.status,
      zone: p.coverageZone || null,
      categories: p.categories,
      createdAt: p.createdAt,
    }))
    return { requests, partners: list, facts }
  },
  head: () => ({ meta: [{ title: 'Partners · Proveedores — AutoLibre' }] }),
  component: Providers,
})

interface Row {
  id: string
  name: string
  tier: string
  status: string
  zone: string | null
  categories: Array<{ slug: string; name: string }>
  createdAt: string
  monthSent: number
  facts: ProviderFacts | null
}

function Providers() {
  const { requests, partners, facts } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })
  const [composerFor, setComposerFor] = useState<string | null>(null)

  const months = useMemo(() => countableMonths(new Date()), [])
  const month = search.providerMonth && months.includes(search.providerMonth) ? search.providerMonth : months[0]!

  const load = useProposalFacts(requests ?? [])
  const refs: Array<PartnerRef> = useMemo(
    () => partners.map((p) => ({ id: p.id, name: p.name, tier: p.tier, status: p.status })),
    [partners],
  )
  const usage = useMemo(
    () => aggregatePartnerUsage(load.facts, month, refs, new Map(), { includeIdle: true }),
    [load.facts, month, refs],
  )
  const sentBy = useMemo(() => new Map(usage.rows.map((r) => [r.partnerId, r.sent])), [usage])
  const factsBy = facts.available ? facts.byPartner : null

  const all: Array<Row> = partners.map((p) => ({
    ...p,
    monthSent: sentBy.get(p.id) ?? 0,
    facts: factsBy?.[p.id] ?? null,
  }))

  const needle = search.q ? normalizeForMatch(search.q) : ''
  const rows = all.filter((r) => {
    if (needle && !normalizeForMatch(r.name).includes(needle)) return false
    if (search.providerStatuses.length > 0 && !search.providerStatuses.includes(r.status as never)) return false
    if (search.providerRubros.length > 0 && !r.categories.some((c) => search.providerRubros.includes(c.slug))) return false
    if (search.providerZones.length > 0) {
      const zone = normalizeForMatch(r.zone ?? '')
      if (!search.providerZones.some((z) => zone.includes(normalizeForMatch(z)))) return false
    }
    if (search.providerSourcer) {
      const id = r.facts?.sourcer?.memberId ?? 'none'
      if (id !== search.providerSourcer) return false
    }
    if (search.providerWithPackage && !r.facts?.package) return false
    if (search.providerPackageExpiring && !r.facts?.package?.expiringSoon) return false
    if (search.providerOwes && !(r.facts && r.facts.owed > 0)) return false
    return true
  })

  const value = (r: Row, k: ProviderSortKey): string | number | null => {
    switch (k) {
      case 'name':
        return r.name
      case 'zone':
        return r.zone
      case 'status':
        return PROVIDER_STATUS_LABELS[r.status] ?? r.status
      case 'sourcer':
        return r.facts?.sourcer?.name ?? null
      case 'createdAt':
        return r.createdAt
      case 'monthSent':
        return r.monthSent
      case 'confirmedTotal':
        return r.facts?.confirmedTotal ?? null
      case 'confirmedMonth':
        return r.facts?.confirmedMonth ?? null
      case 'package':
        return r.facts?.package?.balance ?? null
      case 'owed':
        return r.facts?.owed ?? null
    }
  }
  const sign = search.providerDir === 'asc' ? 1 : -1
  const sorted = [...rows].sort((a, b) => {
    const va = value(a, search.providerSort)
    const vb = value(b, search.providerSort)
    if (va === null && vb !== null) return 1
    if (vb === null && va !== null) return -1
    if (va !== null && vb !== null && va !== vb) {
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'es')
      if (cmp !== 0) return cmp * sign
    }
    return a.name.localeCompare(b.name, 'es')
  })

  const zoneOptions = useMemo(() => {
    const s = new Set<string>()
    for (const p of partners) if (p.zone) s.add(p.zone.trim())
    return [...s].sort((a, b) => a.localeCompare(b, 'es')).map((z) => ({ value: z, label: z }))
  }, [partners])
  const rubroOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of partners) for (const c of p.categories) m.set(c.slug, c.name)
    return [...m].sort((a, b) => a[1].localeCompare(b[1], 'es')).map(([value, label]) => ({ value, label }))
  }, [partners])

  const activeFilters =
    !!search.q ||
    search.providerStatuses.length > 0 ||
    search.providerRubros.length > 0 ||
    search.providerZones.length > 0 ||
    !!search.providerSourcer ||
    search.providerWithPackage ||
    search.providerPackageExpiring ||
    search.providerOwes

  const downloadCsv = () => {
    const csv = toCsv(
      PROVIDERS_CSV_HEADER,
      sorted.map((r) => [
        r.name,
        r.categories.map((c) => c.name).join(', '),
        r.zone ?? '',
        PROVIDER_STATUS_LABELS[r.status] ?? r.status,
        r.facts?.sourcer?.name ?? '',
        shortDay(baDay(r.createdAt)),
        r.monthSent,
        r.facts?.confirmedTotal ?? '',
        r.facts?.confirmedMonth ?? '',
        r.facts ? (r.facts.firstJobUsed ? 'usado' : 'disponible') : '',
        r.facts?.package?.balance ?? '',
        r.facts?.package ? feeDay(r.facts.package.expiresOn) : '',
        r.facts?.owed ?? '',
      ]),
    )
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `proveedores-${month}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const totals = {
    owed: rows.reduce((s, r) => s + (r.facts?.owed ?? 0), 0),
    withPackage: rows.filter((r) => r.facts?.package).length,
    expiring: rows.filter((r) => r.facts?.package?.expiringSoon).length,
    sent: rows.reduce((s, r) => s + r.monthSent, 0),
  }

  return (
    <>
      <PageHeader
        title="Proveedores"
        subtitle={`${formatInt(rows.length)} proveedores · ${monthLabel(month)} · sin planes ni tope de respuestas`}
        actions={<SsrTag>ssr: data-only</SsrTag>}
      />

      {!facts.available ? (
        <p className="mb-4 rounded-lg border border-status-yellow/30 bg-status-yellow-bg px-4 py-2 text-xs text-status-yellow">
          Falta la migración 038 (liquidaciones): trabajos confirmados, paquetes y por cobrar salen «—».
        </p>
      ) : !facts.packagesAvailable ? (
        <p className="mb-4 rounded-lg border border-status-yellow/30 bg-status-yellow-bg px-4 py-2 text-xs text-status-yellow">
          Falta la migración 044 (paquetes de trabajos): no se pueden cargar paquetes.
        </p>
      ) : null}

      <div className="mb-3 flex flex-wrap items-end gap-5">
        <FilterGroup label="Mes de las propuestas">
          {months.map((m) => (
            <Chip key={m} active={m === month} onClick={() => setSearch({ providerMonth: m })}>
              {monthLabel(m)}
            </Chip>
          ))}
        </FilterGroup>
        <FilterGroup
          label="Estado"
          onClear={search.providerStatuses.length > 0 ? () => setSearch({ providerStatuses: [] }) : undefined}
        >
          {PROVIDER_STATUSES.map((s) => (
            <Chip
              key={s}
              active={search.providerStatuses.includes(s)}
              onClick={() =>
                setSearch({
                  providerStatuses: search.providerStatuses.includes(s)
                    ? search.providerStatuses.filter((x) => x !== s)
                    : [...search.providerStatuses, s],
                })
              }
            >
              {PROVIDER_STATUS_LABELS[s]}
            </Chip>
          ))}
        </FilterGroup>
        <SearchInput
          label="Buscar"
          placeholder="Nombre del proveedor"
          value={search.q}
          onSearch={(q) => setSearch({ q })}
          className="w-full sm:w-56"
        />
        <Button variant="outline" size="sm" onClick={downloadCsv}>
          <Download className="size-3.5" aria-hidden />
          Descargar CSV
        </Button>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-5">
        <div className="space-y-1.5">
          <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">Rubro</span>
          <MultiSelect
            label="Rubro"
            options={rubroOptions}
            selected={search.providerRubros}
            onChange={(next) => setSearch({ providerRubros: next })}
            placeholder="Todos"
            searchPlaceholder="Buscar rubro…"
            className="w-52"
          />
        </div>
        <div className="space-y-1.5">
          <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">Zona</span>
          <MultiSelect
            label="Zona"
            options={zoneOptions}
            selected={search.providerZones}
            onChange={(next) => setSearch({ providerZones: next })}
            placeholder="Todas"
            searchPlaceholder="Buscar zona…"
            className="w-52"
          />
        </div>
        {facts.available ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Comercial (Alta por)</span>
            <select
              value={search.providerSourcer ?? ''}
              onChange={(e) => setSearch({ providerSourcer: e.target.value || undefined })}
              className="h-9 rounded-md border border-input bg-surface px-2 text-sm"
            >
              <option value="">Todos</option>
              {facts.sourcers.map((s) => (
                <option key={s.memberId} value={s.memberId}>
                  {s.name}
                </option>
              ))}
              <option value="none">Sin asignar</option>
            </select>
          </label>
        ) : null}
        <FilterGroup label="Cobro">
          <Chip active={search.providerWithPackage} onClick={() => setSearch({ providerWithPackage: !search.providerWithPackage })}>
            Con paquete vigente ({totals.withPackage})
          </Chip>
          <Chip
            tone="warn"
            active={search.providerPackageExpiring}
            onClick={() => setSearch({ providerPackageExpiring: !search.providerPackageExpiring })}
          >
            Paquete por vencer (≤ {PARTNER_FEE_CONFIG.PAQUETE_POR_VENCER_DIAS} días) ({totals.expiring})
          </Chip>
          <Chip active={search.providerOwes} onClick={() => setSearch({ providerOwes: !search.providerOwes })}>
            Con saldo por cobrar
          </Chip>
        </FilterGroup>
        {activeFilters ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setSearch({
                q: undefined,
                providerStatuses: [],
                providerRubros: [],
                providerZones: [],
                providerSourcer: undefined,
                providerWithPackage: false,
                providerPackageExpiring: false,
                providerOwes: false,
              })
            }
          >
            <X className="size-3.5" aria-hidden /> Limpiar filtros
          </Button>
        ) : null}
      </div>

      <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={`Propuestas enviadas · ${monthLabel(month)}`} value={formatInt(totals.sent)} />
        <Stat label="Con paquete vigente" value={formatInt(totals.withPackage)} />
        <Stat label="Paquetes por vencer" value={formatInt(totals.expiring)} />
        <Stat label="Por cobrar" value={formatArs(totals.owed)} />
      </dl>

      <LoadStatus load={load} />

      {requests === null ? (
        <Empty>Esta base no tiene la tabla de pedidos (`quote_requests`): las propuestas salen en 0.</Empty>
      ) : null}

      {sorted.length === 0 ? (
        <Empty>Ningún proveedor coincide con los filtros.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table className="min-w-[1500px]">
            <TableHeader>
              <TableRow>
                <Th label="Taller" k="name" />
                <TableHead>Rubros</TableHead>
                <Th label="Zona" k="zone" />
                <Th label="Estado" k="status" />
                <Th label="Alta por" k="sourcer" />
                <Th label="Alta" k="createdAt" />
                <Th label="Propuestas del mes" k="monthSent" align="right" title="Enviadas (no retiradas) en el mes elegido." />
                <Th label="Trabajos (total)" k="confirmedTotal" align="right" title="Confirmados por AutoLibre, sin disputas ni anulados." />
                <Th label="Trabajos (mes)" k="confirmedMonth" align="right" title="Del mes en curso." />
                <TableHead>Primer trabajo gratis</TableHead>
                <Th label="Paquete vigente" k="package" />
                <Th label="Por cobrar" k="owed" align="right" title="Pendiente + avisado en Partners › Liquidaciones." />
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r) => (
                <Fragment key={r.id}>
                  <ProviderRow
                    row={r}
                    canAddPackage={facts.available && facts.packagesAvailable}
                    onAddPackage={() => setComposerFor(composerFor === r.id ? null : r.id)}
                  />
                  {composerFor === r.id && facts.available ? (
                    <TableRow>
                      <TableCell colSpan={13} className="whitespace-normal bg-canvas">
                        <PackageComposer
                          partnerId={r.id}
                          partnerName={r.name}
                          today={facts.today}
                          onDone={() => setComposerFor(null)}
                        />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ExternalSection rows={usage.externals} />

      <p className="mt-4 text-xs text-muted-foreground">
        Sin planes ni tope desde el 26/11/26: el primer trabajo confirmado de cada proveedor es gratis, después{' '}
        {formatArs(PARTNER_FEE_CONFIG.FEE_POR_TRABAJO)} por trabajo, salvo que lo cubra un paquete vigente. Las propuestas
        se cuentan desde el 27/10/2026, por mes de envío en hora de Buenos Aires.
      </p>
    </>
  )
}

function ProviderRow({ row: r, canAddPackage, onAddPackage }: { row: Row; canAddPackage: boolean; onAddPackage: () => void }) {
  const f = r.facts
  const dash = <span className="text-muted-foreground">—</span>
  return (
    <TableRow className={cn(r.status === 'archived' && 'opacity-60')}>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link to="/partners/$partnerId" params={{ partnerId: r.id }} className="font-medium hover:underline">
            {r.name}
          </Link>
          {isFounding(r.tier) ? (
            <Badge variant="outline" className="text-muted-foreground">
              Aliado
            </Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="max-w-56 text-xs" title={r.categories.map((c) => c.name).join(', ')}>
        {r.categories.length ? (
          <span className="line-clamp-2">{r.categories.map((c) => c.name).join(', ')}</span>
        ) : (
          <span className="text-muted-foreground">sin rubros</span>
        )}
      </TableCell>
      <TableCell className="max-w-48 truncate text-sm" title={r.zone ?? undefined}>
        {r.zone ?? dash}
      </TableCell>
      <TableCell className="text-sm">{PROVIDER_STATUS_LABELS[r.status] ?? r.status}</TableCell>
      <TableCell className="text-sm">{f?.sourcer?.name ?? dash}</TableCell>
      <TableCell className="text-sm tabular-nums">{shortDay(baDay(r.createdAt))}</TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(r.monthSent)}</TableCell>
      <TableCell className="text-right tabular-nums">{f ? formatInt(f.confirmedTotal) : dash}</TableCell>
      <TableCell className="text-right tabular-nums">{f ? formatInt(f.confirmedMonth) : dash}</TableCell>
      <TableCell className="text-sm">
        {!f ? dash : f.firstJobUsed ? <span className="text-muted-foreground">usado</span> : 'disponible'}
      </TableCell>
      <TableCell className="text-sm tabular-nums">
        {!f?.package ? (
          dash
        ) : (
          <span className={cn(f.package.expiringSoon && 'font-medium text-status-yellow')}>
            saldo {f.package.balance} · vence {feeDay(f.package.expiresOn)}
            {f.package.expiringSoon ? ` (${f.package.daysLeft} d)` : ''}
          </span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {!f ? (
          dash
        ) : f.owed > 0 ? (
          <Link to="/partners/liquidaciones" search={{ feePartner: r.id }} className="hover:underline">
            {formatArs(f.owed)}
          </Link>
        ) : (
          <span className="text-muted-foreground">$ 0</span>
        )}
      </TableCell>
      <TableCell>
        {canAddPackage ? (
          <Button size="sm" variant="ghost" className="h-7 whitespace-nowrap" onClick={onAddPackage}>
            Cargar paquete
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  )
}

const SORT_SEARCH_KEYS = { sort: 'providerSort', dir: 'providerDir' }

function Th({ label, k, align, title }: { label: string; k: ProviderSortKey; align?: 'right'; title?: string }) {
  const search = Route.useSearch()
  return (
    <SortHeader
      label={label}
      sortKey={k}
      active={search.providerSort === k}
      dir={search.providerDir}
      to="/partners/propuestas"
      align={align}
      firstClick={PROVIDER_TEXT_SORT_KEYS.has(k) ? 'asc' : 'desc'}
      searchKeys={SORT_SEARCH_KEYS}
      title={title}
    />
  )
}

/** Talleres de afuera del directorio: no tienen ficha ni se les cobra. */
function ExternalSection({ rows }: { rows: ReadonlyArray<ExternalUsageRow> }) {
  if (rows.length === 0) return null
  return (
    <section className="mt-6">
      <h2 className="mb-1 font-heading text-sm font-semibold">Propuestas a talleres de afuera (excepción)</h2>
      <p className="mb-2 text-xs text-muted-foreground">
        No están en el directorio. Si uno sigue recibiendo propuestas, conviene registrarlo como proveedor.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table className="min-w-[480px]">
          <TableHeader>
            <TableRow>
              <TableHead>Taller</TableHead>
              <TableHead className="text-right">Enviadas</TableHead>
              <TableHead className="text-right">Retiradas</TableHead>
              <TableHead className="text-right">Elegidas</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.name}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="text-right tabular-nums">{formatInt(r.sent)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatInt(r.withdrawn)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatInt(r.selected)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-heading text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 rounded-lg border border-border bg-card py-12 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
