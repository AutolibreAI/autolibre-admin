import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { getPartnerCoverageBoard, getServiceCatalog, listPartnerCandidatesFn } from '~/fn/partners'
import { getQuoteRequestFn, listQuoteRequestsFn } from '~/fn/quote-requests'
import { CoverageMap } from '~/components/CoverageMap'
import type { MapPedido, MapProveedor } from '~/components/CoverageMap'
import { Chip, FilterGroup } from '~/components/Filters'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { SearchInput } from '~/components/SearchInput'
import { SortHeader } from '~/components/SortHeader'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import {
  COVERAGE_PRIORITY_LABELS,
  COVERAGE_RADII,
  COVERAGE_RUBROS,
  COVERAGE_RUBRO_LABELS,
  COVERAGE_RUBRO_SHORT,
  COVERED_MIN_PROVIDERS,
  areaStats,
  compareByPriority,
  coverageHeadline,
  coverageMapSearchSchema,
  hasSignal,
  nearbyCounts,
  parseZones,
  placeAll,
  toCoveragePedido,
  toCoverageProveedor,
  unmappedServiceNames,
  zoneStats,
} from '~/lib/coverage-map'
import type {
  CoveragePriority,
  CoverageRubro,
  CoverageSortKey,
  CoverageMapSearch,
  CoverageZone,
  PartnerSource,
  RubroFilter,
  ZoneStats,
} from '~/lib/coverage-map'
import { formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

const TO = '/partners/cobertura'

/** El geojson es estático (`public/geo`), no pasa por ningún servidor nuestro. */
const ZONES_URL = '/geo/zonas_amba.geojson'

/** Lo que la pantalla necesita de un pedido del listado. Nada de contacto. */
interface QuoteRowLite {
  id: string
  publicNumber: number
  createdAt: string
  channel: string
  description: string
  locationLocality: string | null
  locationAddress: string | null
}

/**
 * Cobertura AMBA: demanda (pedidos) contra oferta (partners), por partido y
 * comuna. Reemplazó a la matriz zona-de-texto × categoría el 2026-10-22.
 * → `.claude/rules/coverage-map.md`
 *
 * **v1 sin endpoint propio** (decidido: no tocar el servidor). Lee de tres
 * server functions que ya existían:
 *
 *  - `listPartnerCandidatesFn` con TODAS las categorías: los partners activos
 *    con sus servicios, modalidad y coordenadas;
 *  - `listQuoteRequestsFn`: los pedidos reales (sin duplicados), con su
 *    descripción y localidad;
 *  - `getQuoteRequestFn`, UNO POR PEDIDO y desde el navegador: es la única que
 *    trae el GPS. Por eso los pedidos aparecen de a poco. El endpoint de la
 *    sección 3 del spec lo resolvería en una consulta (`docs/pedido-backend-cobertura.md`).
 *
 * `ssr: 'data-only'`: el loader corre en el servidor, pero el mapa (Leaflet),
 * el geojson y la carga del GPS son del navegador — renderizar el componente en
 * el servidor sólo emitiría un esqueleto. Está detrás de auth, ningún crawler
 * lo ve.
 */
export const Route = createFileRoute('/_authed/partners/cobertura')({
  validateSearch: coverageMapSearchSchema,
  ssr: 'data-only',
  loader: async ({ abortController }) => {
    const signal = abortController.signal
    const [catalog, quotes, board] = await Promise.all([
      getServiceCatalog({ signal }),
      listQuoteRequestsFn({ data: { quoteStatus: 'all', quoteShowDuplicates: false }, signal }),
      getPartnerCoverageBoard({ signal }),
    ])

    // El validador de candidatos acepta hasta 16 categorías por llamada: si el
    // catálogo crece, se pide por tandas y se junta por id.
    const slugs = catalog.map((f) => f.slug)
    const chunks: Array<Array<string>> = []
    for (let i = 0; i < slugs.length; i += 16) chunks.push(slugs.slice(i, i + 16))
    const batches = await Promise.all(
      chunks.map((categorySlugs) =>
        listPartnerCandidatesFn({ data: { categorySlugs, lat: null, lng: null }, signal }),
      ),
    )
    const partners = new Map<string, PartnerSource>()
    for (const c of batches.flat()) {
      const prev = partners.get(c.id)
      const services = [...(prev?.services ?? []), ...c.matchedServices.map((s) => ({ name: s.name }))]
      partners.set(c.id, {
        id: c.id,
        name: c.name,
        modality: c.modality,
        tier: c.tier,
        coverageZone: c.coverageZone,
        location: c.location,
        services,
      })
    }

    const quoteRows: Array<QuoteRowLite> | null =
      'rows' in quotes
        ? quotes.rows
            // Pedidos reales: sin duplicados (ya filtrado) ni cancelados por la persona.
            .filter((r) => r.closeReasonCode !== 'cancelled_by_user')
            .map((r) => ({
              id: r.id,
              publicNumber: r.publicNumber,
              createdAt: r.createdAt,
              channel: r.channel,
              description: r.description,
              locationLocality: r.locationLocality,
              locationAddress: r.locationAddress,
            }))
        : null

    return {
      partners: [...partners.values()],
      quoteRows,
      totalActivePartners: board.totalActivePartners,
      serviceNames: catalog.flatMap((f) => f.services.map((s) => s.name)),
    }
  },
  head: () => ({ meta: [{ title: 'Partners · Cobertura — AutoLibre' }] }),
  component: CoberturaMapa,
})

// ── Datos del navegador ──────────────────────────────────────────────────────

function useZones() {
  const [zones, setZones] = useState<Array<CoverageZone> | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(ZONES_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((json: unknown) => {
        if (!cancelled) setZones(parseZones(json))
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])
  return { zones, failed }
}

/**
 * GPS por pedido, del detalle. Cache del módulo: volver a la pantalla, o
 * cambiar rubro y radio, no vuelve a pedir nada. Cuatro a la vez (el pool del
 * servidor es de cinco).
 */
const gpsCache = new Map<string, { lat: number | null; lng: number | null } | 'error'>()
const GPS_CONCURRENCY = 4

function usePedidoGps(rows: Array<QuoteRowLite>) {
  // Sin ningún texto de ubicación no hay GPS ni localidad: no vale la llamada.
  const ids = useMemo(
    () => rows.filter((r) => r.locationLocality || r.locationAddress).map((r) => r.id),
    [rows],
  )
  const key = ids.join(',')
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    const pending = ids.filter((id) => !gpsCache.has(id))
    let next = 0
    let sinceRender = 0
    const worker = async () => {
      while (!cancelled && next < pending.length) {
        const id = pending[next++]!
        try {
          const res = await getQuoteRequestFn({ data: { quoteRequestId: id } })
          const d = 'detail' in res ? res.detail : null
          gpsCache.set(id, { lat: d?.locationLatitude ?? null, lng: d?.locationLongitude ?? null })
        } catch {
          gpsCache.set(id, 'error')
        }
        // De a tandas: redibujar el mapa por cada pedido sería parpadeo puro.
        if (!cancelled && ++sinceRender >= 6) {
          sinceRender = 0
          setVersion((v) => v + 1)
        }
      }
    }
    void Promise.all(Array.from({ length: GPS_CONCURRENCY }, worker)).then(() => {
      if (!cancelled) setVersion((v) => v + 1)
    })
    return () => {
      cancelled = true
    }
    // `ids` cambia sólo si cambia `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const done = ids.filter((id) => gpsCache.has(id)).length
  const failed = ids.filter((id) => gpsCache.get(id) === 'error').length
  const gps = useMemo(() => {
    const m = new Map<string, { lat: number | null; lng: number | null }>()
    for (const id of ids) {
      const v = gpsCache.get(id)
      if (v && v !== 'error') m.set(id, v)
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version])
  return { gps, total: ids.length, done, failed, loading: done < ids.length }
}

// ── Pantalla ─────────────────────────────────────────────────────────────────

function CoberturaMapa() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  const { zones, failed: zonesFailed } = useZones()
  const quoteRows = data.quoteRows ?? []
  const gps = usePedidoGps(quoteRows)
  const [flyNonce, setFlyNonce] = useState(0)

  const rubro: RubroFilter = search.coverageRubro
  const radius = search.coverageRadius

  const proveedores = useMemo(() => data.partners.map(toCoverageProveedor), [data.partners])
  const pedidos = useMemo(
    () =>
      quoteRows.map((r) => {
        const g = gps.gps.get(r.id)
        return toCoveragePedido({
          ...r,
          locationLatitude: g?.lat ?? null,
          locationLongitude: g?.lng ?? null,
        })
      }),
    [quoteRows, gps.gps],
  )
  const placed = useMemo(
    () => (zones ? placeAll(zones, pedidos, proveedores) : null),
    [zones, pedidos, proveedores],
  )
  const near = useMemo(() => (placed ? nearbyCounts(placed, radius) : new Map<string, number>()), [placed, radius])
  const stats = useMemo(() => (placed ? zoneStats(placed, near, rubro) : null), [placed, near, rubro])

  if (zonesFailed) {
    return (
      <>
        <Header />
        <p className="text-sm text-status-red">
          No se pudo cargar <code className="font-mono">{ZONES_URL}</code>. Sin las zonas no hay mapa ni cálculo por zona.
        </p>
      </>
    )
  }
  if (!placed || !stats) {
    return (
      <>
        <Header />
        <p className="text-sm text-muted-foreground">Cargando las zonas del AMBA…</p>
      </>
    )
  }

  const statList = [...stats.values()]
  const pedidosAmba = placed.pedidos.filter((p) => p.zoneId && (rubro === 'todos' || p.rubro === rubro))
  const cubiertos = pedidosAmba.filter((p) => (near.get(p.id) ?? 0) >= COVERED_MIN_PROVIDERS).length
  const proveedoresZona = statList.reduce((n, s) => n + s.proveedores, 0)
  const salirYa = statList.filter((s) => s.priority === 'salir').length

  const focusZone = (id: string, fly: boolean) => {
    setSearch({ coverageZona: id })
    if (fly) setFlyNonce((n) => n + 1)
  }

  return (
    <>
      <Header />

      {data.quoteRows === null ? (
        <p className="mb-4 rounded-md border border-status-yellow/40 bg-status-yellow-bg px-3 py-2 text-sm text-status-yellow">
          Esta base no tiene <code className="font-mono">quote_requests</code>: el mapa muestra sólo la oferta.
        </p>
      ) : null}

      <Headline stats={statList} loading={gps.loading} progress={gps} />

      <div className="mb-5 flex flex-wrap items-start gap-x-6 gap-y-3">
        <FilterGroup label="Vista">
          <Chip active={search.coverageView === 'mapa'} onClick={() => setSearch({ coverageView: 'mapa' })}>
            Mapa
          </Chip>
          <Chip active={search.coverageView === 'tabla'} onClick={() => setSearch({ coverageView: 'tabla' })}>
            Tabla por rubro
          </Chip>
        </FilterGroup>
        <FilterGroup label="Radio">
          {COVERAGE_RADII.map((r) => (
            <Chip key={r} active={radius === r} onClick={() => setSearch({ coverageRadius: r })}>
              {r} km
            </Chip>
          ))}
        </FilterGroup>
        <FilterGroup label="Rubro">
          <Chip active={rubro === 'todos'} onClick={() => setSearch({ coverageRubro: 'todos' })}>
            Todos
          </Chip>
          {COVERAGE_RUBROS.map((r) => (
            <Chip key={r} active={rubro === r} onClick={() => setSearch({ coverageRubro: r })}>
              {COVERAGE_RUBRO_LABELS[r]}
            </Chip>
          ))}
        </FilterGroup>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Pedidos en el AMBA" value={formatInt(pedidosAmba.length)} hint={gps.loading ? 'todavía ubicando pedidos' : undefined} />
        <Kpi
          label={`Con ${COVERED_MIN_PROVIDERS}+ partners a ≤ ${radius} km`}
          value={pedidosAmba.length ? `${Math.round((cubiertos / pedidosAmba.length) * 100)} %` : '—'}
          hint={`${formatInt(cubiertos)} de ${formatInt(pedidosAmba.length)}`}
        />
        <Kpi
          label="Partners con local"
          value={formatInt(proveedoresZona)}
          hint={rubro === 'todos' ? 'en zonas del AMBA' : COVERAGE_RUBRO_LABELS[rubro]}
        />
        <Kpi label="Zonas «Salir ya»" value={formatInt(salirYa)} tone={salirYa > 0 ? 'red' : undefined} />
      </div>

      {search.coverageView === 'mapa' ? (
        <>
          <div className="mb-6">
            <CoverageMap
              zones={placed.zones}
              stats={stats}
              pedidos={placed.pedidos
                .filter((p) => p.lat !== null && p.lng !== null && (rubro === 'todos' || p.rubro === rubro))
                .map(
                  (p): MapPedido => ({
                    id: p.id,
                    numero: p.numero,
                    rubro: p.rubro,
                    localidad: p.localidad,
                    createdAt: p.createdAt,
                    aprox: p.aprox,
                    lat: p.lat!,
                    lng: p.lng!,
                    near: near.get(p.id) ?? 0,
                  }),
                )}
              proveedores={placed.proveedores
                .filter((p) => !p.remoto && p.lat !== null && p.lng !== null)
                .map(
                  (p): MapProveedor => ({
                    id: p.id,
                    nombre: p.nombre,
                    zona: p.zoneId ? (placed.zoneById.get(p.zoneId)?.nombre ?? p.coverageZone) : `Fuera del AMBA · ${p.coverageZone}`,
                    rubros: p.rubros,
                    lat: p.lat!,
                    lng: p.lng!,
                    highlighted: rubro === 'todos' || p.rubros.includes(rubro),
                  }),
                )}
              radiusKm={radius}
              focusZoneId={search.coverageZona}
              flyNonce={flyNonce}
              onZoneClick={(id) => {
                focusZone(id, false)
                requestAnimationFrame(() =>
                  document.getElementById(`zona-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
                )
              }}
            />
          </div>

          <div className="mb-6 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Ranking
              stats={statList}
              search={search}
              onSearch={(q) => setSearch({ q })}
              onPick={(id) => focusZone(id, true)}
            />
            <AreaSummary stats={statList} />
          </div>
        </>
      ) : (
        <RubroMatrix
          placed={placed}
          near={near}
          onPick={(id, r) => {
            setSearch({ coverageView: 'mapa', coverageRubro: r, coverageZona: id })
            setFlyNonce((n) => n + 1)
          }}
        />
      )}

      <Notes
        placed={placed}
        gps={gps}
        totalActivePartners={data.totalActivePartners}
        serviceNames={data.serviceNames}
      />
      <HowItWorks radius={radius} />
    </>
  )
}

function Header() {
  return (
    <PageHeader
      title="Cobertura"
      subtitle="Dónde hay pedidos y no hay partners cerca — por partido del AMBA y comuna de CABA"
      actions={<SsrTag>ssr: data-only</SsrTag>}
    />
  )
}

// ── Encabezado ───────────────────────────────────────────────────────────────

function Headline({
  stats,
  loading,
  progress,
}: {
  stats: Array<ZoneStats>
  loading: boolean
  progress: { done: number; total: number }
}) {
  const lines = coverageHeadline(stats)
  return (
    <div className="mb-5 rounded-lg border border-border bg-card px-4 py-3">
      {loading ? (
        <p className="mb-1 text-xs text-muted-foreground">
          Ubicando pedidos: {formatInt(progress.done)} de {formatInt(progress.total)}. La conclusión se termina de
          armar cuando estén todos.
        </p>
      ) : null}
      {lines.length === 0 ? (
        <p className="text-sm">Ninguna zona necesita salir a buscar partners con este rubro y este radio.</p>
      ) : (
        <div className="space-y-0.5">
          {lines.map((l) => (
            <p
              key={l.priority}
              className={cn('text-sm', l.priority === 'salir' ? 'font-heading text-base font-semibold' : 'text-gray-700')}
            >
              {l.text}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'red' }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('font-heading text-2xl font-semibold tabular-nums', tone === 'red' && 'text-status-red')}>
        {value}
      </div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

// ── Prioridad ────────────────────────────────────────────────────────────────

const PRIORITY_CLASS: Record<CoveragePriority, string> = {
  salir: 'border-status-red/30 bg-status-red-bg text-status-red',
  reforzar: 'border-status-yellow/30 bg-status-yellow-bg text-status-yellow',
  latente: 'border-dashed border-status-yellow/50 bg-status-yellow-bg/40 text-status-yellow',
  cubierta: 'border-status-green/30 bg-status-green-bg text-status-green',
  sin_demanda: 'border-border bg-card text-muted-foreground',
}

function PriorityBadge({ priority }: { priority: CoveragePriority }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs whitespace-nowrap',
        PRIORITY_CLASS[priority],
      )}
    >
      {COVERAGE_PRIORITY_LABELS[priority]}
    </span>
  )
}

// ── Ranking de zonas ─────────────────────────────────────────────────────────

const SORT_KEYS = { sort: 'coverageSort', dir: 'coverageDir' }

const SORTERS: Record<CoverageSortKey, (a: ZoneStats, b: ZoneStats) => number> = {
  priority: compareByPriority,
  zone: (a, b) => a.zone.nombre.localeCompare(b.zone.nombre, 'es'),
  area: (a, b) => a.zone.area.localeCompare(b.zone.area, 'es') || compareByPriority(a, b),
  pedidos: (a, b) => a.pedidos - b.pedidos || compareByPriority(b, a),
  sinCobertura: (a, b) => a.sinCobertura - b.sinCobertura || compareByPriority(b, a),
  proveedores: (a, b) => a.proveedores - b.proveedores || compareByPriority(b, a),
}

function Ranking({
  stats,
  search,
  onSearch,
  onPick,
}: {
  stats: Array<ZoneStats>
  search: CoverageMapSearch
  onSearch: (q: string | undefined) => void
  onPick: (zoneId: string) => void
}) {
  const q = search.q?.toLowerCase() ?? ''
  const factor = search.coverageDir === 'asc' ? 1 : -1
  const rows = stats
    .filter(hasSignal)
    .filter((s) => !q || s.zone.nombre.toLowerCase().includes(q) || s.zone.area.toLowerCase().includes(q))
    .sort((a, b) => SORTERS[search.coverageSort](a, b) * factor)

  const header = (label: string, key: CoverageSortKey, align?: 'right') => (
    <SortHeader
      label={label}
      sortKey={key}
      active={search.coverageSort === key}
      dir={search.coverageDir}
      to={TO}
      align={align}
      firstClick={align === 'right' ? 'desc' : 'asc'}
      searchKeys={SORT_KEYS}
    />
  )

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-3">
        <CardTitle className="text-base">Ranking de zonas</CardTitle>
        <SearchInput
          id="coverage-q"
          placeholder="Buscar zona o área…"
          value={search.q}
          onSearch={onSearch}
          className="w-full sm:w-56"
        />
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {rows.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">Ninguna zona tiene pedidos ni partners con este filtro.</p>
        ) : (
          <div className="max-h-[32rem] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {header('Zona', 'zone')}
                  {header('Área', 'area')}
                  {header('Prioridad', 'priority')}
                  {header('Pedidos', 'pedidos', 'right')}
                  {header(`Sin ${COVERED_MIN_PROVIDERS} opciones`, 'sinCobertura', 'right')}
                  {header('Partners', 'proveedores', 'right')}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow
                    key={s.zone.id}
                    id={`zona-${s.zone.id}`}
                    onClick={() => onPick(s.zone.id)}
                    className={cn('cursor-pointer', search.coverageZona === s.zone.id && 'bg-brand-soft')}
                  >
                    <TableCell className="font-medium">
                      <button
                        type="button"
                        className="rounded text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={(e) => {
                          e.stopPropagation()
                          onPick(s.zone.id)
                        }}
                      >
                        {s.zone.nombre}
                      </button>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{s.zone.area}</TableCell>
                    <TableCell>
                      <PriorityBadge priority={s.priority} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatInt(s.pedidos)}</TableCell>
                    <TableCell className={cn('text-right tabular-nums', s.sinCobertura > 0 && 'text-status-red')}>
                      {formatInt(s.sinCobertura)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatInt(s.proveedores)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Por área ─────────────────────────────────────────────────────────────────

function AreaSummary({ stats }: { stats: Array<ZoneStats> }) {
  const areas = areaStats(stats)
  const maxPed = Math.max(1, ...areas.map((a) => a.pedidos))
  const maxProv = Math.max(1, ...areas.map((a) => a.proveedores))
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Por área</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Área</TableHead>
              <TableHead>Pedidos · sin {COVERED_MIN_PROVIDERS} opciones</TableHead>
              <TableHead>Partners</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {areas.map((a) => (
              <TableRow key={a.area}>
                <TableCell className="text-sm font-medium whitespace-nowrap">{a.area}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="w-14 text-right text-sm tabular-nums">
                      {formatInt(a.pedidos)}
                      <span className={cn('text-muted-foreground', a.sinCobertura > 0 && 'text-status-red')}>
                        {' · '}
                        {formatInt(a.sinCobertura)}
                      </span>
                    </span>
                    <div className="relative h-2 min-w-16 flex-1 rounded-full bg-surface-2">
                      <div
                        className="absolute inset-y-0 left-0 rounded-full bg-muted-foreground/40"
                        style={{ width: `${(a.pedidos / maxPed) * 100}%` }}
                      />
                      <div
                        className="absolute inset-y-0 left-0 rounded-full bg-status-red/70"
                        style={{ width: `${(a.sinCobertura / maxPed) * 100}%` }}
                      />
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="w-8 text-right text-sm tabular-nums">{formatInt(a.proveedores)}</span>
                    <div className="relative h-2 min-w-12 flex-1 rounded-full bg-surface-2">
                      <div
                        className="absolute inset-y-0 left-0 rounded-full bg-action/60"
                        style={{ width: `${(a.proveedores / maxProv) * 100}%` }}
                      />
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="px-6 py-3 text-xs text-muted-foreground">
          Gris = pedidos; rojo = los que no tienen {COVERED_MIN_PROVIDERS} partners cerca. Suma de las zonas del área.
        </p>
      </CardContent>
    </Card>
  )
}

// ── Tabla por rubro ──────────────────────────────────────────────────────────

function RubroMatrix({
  placed,
  near,
  onPick,
}: {
  placed: ReturnType<typeof placeAll>
  near: Map<string, number>
  onPick: (zoneId: string, rubro: CoverageRubro) => void
}) {
  const all = zoneStats(placed, near, 'todos')
  const byRubro = new Map(COVERAGE_RUBROS.map((r) => [r, zoneStats(placed, near, r)] as const))
  const rows = [...all.values()].filter(hasSignal).sort(compareByPriority)

  return (
    <div className="mb-6">
      <p className="mb-2 text-sm text-muted-foreground">
        Cada celda: <strong className="text-foreground">partners / pedidos</strong> de esa zona y ese rubro, coloreada
        con la prioridad de esa combinación. Clic en una celda: abre el mapa con ese rubro y esa zona.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table className="min-w-[1100px]">
          <TableHeader>
            <TableRow>
              <TableHead>Zona</TableHead>
              <TableHead>Todos</TableHead>
              {COVERAGE_RUBROS.map((r) => (
                <TableHead key={r} className="text-center text-xs whitespace-nowrap" title={COVERAGE_RUBRO_LABELS[r]}>
                  {COVERAGE_RUBRO_SHORT[r]}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => (
              <TableRow key={s.zone.id}>
                <TableCell className="whitespace-nowrap">
                  <div className="font-medium">{s.zone.nombre}</div>
                  <div className="text-xs text-muted-foreground">{s.zone.area}</div>
                </TableCell>
                <TableCell>
                  <PriorityBadge priority={s.priority} />
                  <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                    {formatInt(s.proveedores)} / {formatInt(s.pedidos)}
                  </div>
                </TableCell>
                {COVERAGE_RUBROS.map((r) => {
                  const c = byRubro.get(r)?.get(s.zone.id)
                  if (!c) return <TableCell key={r} />
                  const empty = c.pedidos === 0 && c.proveedores === 0
                  return (
                    <TableCell key={r} className="p-1 text-center">
                      <button
                        type="button"
                        onClick={() => onPick(s.zone.id, r)}
                        title={`${s.zone.nombre} · ${COVERAGE_RUBRO_LABELS[r]}: ${COVERAGE_PRIORITY_LABELS[c.priority]}`}
                        className={cn(
                          'h-8 w-full rounded-md border text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          empty ? 'border-transparent text-muted-foreground/50 hover:border-border' : PRIORITY_CLASS[c.priority],
                        )}
                      >
                        {empty ? '—' : `${formatInt(c.proveedores)} / ${formatInt(c.pedidos)}`}
                      </button>
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

// ── Notas ────────────────────────────────────────────────────────────────────

function Notes({
  placed,
  gps,
  totalActivePartners,
  serviceNames,
}: {
  placed: ReturnType<typeof placeAll>
  gps: { total: number; done: number; failed: number; loading: boolean }
  totalActivePartners: number
  serviceNames: Array<string>
}) {
  const pedidos = placed.pedidos
  const sinUbicacion = pedidos.filter((p) => p.lat === null)
  const fueraAmba = pedidos.filter((p) => p.lat !== null && !p.zoneId)
  const aprox = pedidos.filter((p) => p.aprox && p.zoneId).length

  const provs = placed.proveedores
  const remotosSinZona = provs.filter((p) => p.remoto && !p.zoneId)
  const sinCoordsSinZona = provs.filter((p) => !p.remoto && p.lat === null && !p.zoneId)
  const coordsFuera = provs.filter((p) => !p.remoto && p.lat !== null && !p.zoneId)
  const sinServicios = Math.max(0, totalActivePartners - provs.length)
  const unmapped = unmappedServiceNames(serviceNames)

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">Lo que queda fuera del mapa</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <p className="font-medium">Pedidos ({formatInt(pedidos.length)} reales, sin duplicados ni cancelados)</p>
          <ul className="ml-4 list-disc text-muted-foreground">
            <li>
              {formatInt(sinUbicacion.length)} sin ubicación utilizable (ni GPS ni una localidad conocida)
              {sinUbicacion.length ? `: ${sinUbicacion.map((p) => `AL-${p.numero}`).join(', ')}` : ''}.
              {gps.loading ? ' Todavía se están cargando: el número baja a medida que llega el GPS.' : ''}
            </li>
            <li>
              {formatInt(fueraAmba.length)} ubicados fuera del AMBA
              {fueraAmba.length ? `: ${fueraAmba.map((p) => `AL-${p.numero}${p.localidad ? ` (${p.localidad})` : ''}`).join(', ')}` : ''}.
            </li>
            <li>{formatInt(aprox)} ubicados por el centro de su localidad (se tipeó la dirección, no hay GPS).</li>
            {gps.failed ? (
              <li className="text-status-yellow">
                {formatInt(gps.failed)} no se pudieron leer; recargá la página para reintentar.
              </li>
            ) : null}
          </ul>
        </div>
        <div>
          <p className="font-medium">Partners ({formatInt(totalActivePartners)} activos)</p>
          <ul className="ml-4 list-disc text-muted-foreground">
            <li>
              {formatInt(remotosSinZona.length)} remotos (a distancia, o mixto / a domicilio sin coordenadas): no tienen
              zona, sólo cuentan para Trámites
              {remotosSinZona.length ? `: ${remotosSinZona.map((p) => p.nombre).join(', ')}` : ''}.
            </li>
            <li>
              {formatInt(sinCoordsSinZona.length)} con local pero sin coordenadas
              {sinCoordsSinZona.length
                ? `: ${sinCoordsSinZona.map((p) => `${p.nombre} («${p.coverageZone}»)`).join(', ')}`
                : ''}
              . Se ubican cargándoles la coordenada desde su ficha.
            </li>
            <li>{formatInt(coordsFuera.length)} con local fuera del AMBA.</li>
            {sinServicios ? (
              <li>{formatInt(sinServicios)} sin ningún servicio cargado: no tienen rubro y no se pueden ubicar acá.</li>
            ) : null}
          </ul>
        </div>
        <div>
          <p className="font-medium">Usuarios</p>
          <p className="text-muted-foreground">
            Todavía no hay usuarios por zona (domicilio de la cédula, ciudad del primer login): no hay de dónde leerlos
            sin el endpoint nuevo. Por eso ninguna zona sale como «Demanda latente».
          </p>
        </div>
        {unmapped.length ? (
          <div>
            <p className="font-medium">Servicios que no entran en ninguno de los 10 rubros</p>
            <p className="text-muted-foreground">{unmapped.join(' · ')}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function HowItWorks({ radius }: { radius: number }) {
  return (
    <details className="mb-6 rounded-lg border border-border bg-card px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium">Cómo se calcula</summary>
      <ul className="mt-2 ml-4 list-disc space-y-1 text-muted-foreground">
        <li>
          <strong className="text-foreground">Zonas</strong>: los 39 partidos del AMBA y las 15 comunas de CABA. Cada
          pedido y cada partner cae en la zona cuyo polígono lo contiene.
        </li>
        <li>
          <strong className="text-foreground">Pedidos</strong>: los reales (sin duplicados ni cancelados por la persona).
          La ubicación es el GPS del teléfono o, si se tipeó, el centro de su localidad. El rubro se adivina por palabras
          de la descripción («freno» → Tren delantero; sin pista, Mecánica).
        </li>
        <li>
          <strong className="text-foreground">Partners</strong>: los activos, agrupando sus servicios en los 10 rubros.
          Los remotos (a distancia, o mixto / a domicilio sin coordenadas) no tienen zona.
        </li>
        <li>
          <strong className="text-foreground">Cubierto</strong>: el pedido tiene al menos {COVERED_MIN_PROVIDERS} partners
          con local y con su rubro a {radius} km o menos (línea recta). {COVERED_MIN_PROVIDERS} porque es el máximo de
          propuestas por pedido. Para Trámites se suman los remotos.
        </li>
        <li>
          <strong className="text-foreground">Salir ya</strong>: 2 o más pedidos sin cubrir, o 1 sin cubrir y ningún
          partner en la zona. <strong className="text-foreground">Reforzar</strong>: 1 sin cubrir, o 3 o más pedidos con
          menos de 5 partners cerca en promedio. <strong className="text-foreground">Demanda latente</strong>: sin pedidos,
          con 1 partner o ninguno, y usuarios en la zona (todavía sin datos).{' '}
          <strong className="text-foreground">Cubierta</strong>: hay pedidos y están todos cubiertos. El resto, sin demanda.
        </li>
      </ul>
    </details>
  )
}
