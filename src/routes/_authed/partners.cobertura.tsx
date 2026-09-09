import { Link, createFileRoute } from '@tanstack/react-router'
import { AlertTriangle, Check, MapPinOff } from 'lucide-react'
import {
  coverageSearchSchema,
  singlePartnerCells,
} from '~/lib/partners-coverage'
import { getPartnerCoverageBoard } from '~/fn/partners'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { SortHeader } from '~/components/SortHeader'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { CoverageZoneRow, PartnerCoverageBoard } from '~/lib/partners-coverage'

const TO = '/partners/cobertura'

/**
 * El tablero de control del marketplace: qué oferta está cubierta y cuál hay
 * que salir a capturar.
 *
 * Filas = zona de cobertura (texto CRUDO de `partners.coverage_zone`, ver
 * `~/lib/partners-coverage`). Columnas = los 16 rubros (`service_categories`).
 * Cada celda = partners activos DISTINTOS de esa zona que cubren ese rubro.
 *
 * Colores: `0` es un hueco (rojo), `1` es punto único de falla (ámbar), `≥2`
 * plano. Verde no se usa: "cubierto" no es un logro del panel — mismo criterio
 * que las filas en cero de `/operacion`.
 *
 * SSR completo (heredado): tablero de contenido, puede ser el primer pintado de
 * una sesión de trabajo, y no hay estado de cliente.
 */
export const Route = createFileRoute('/_authed/partners/cobertura')({
  validateSearch: coverageSearchSchema,
  loader: ({ abortController }) =>
    getPartnerCoverageBoard({ signal: abortController.signal }),
  head: () => ({ meta: [{ title: 'Partners · Cobertura — AutoLibre' }] }),
  component: CoberturaBoard,
})

function CoberturaBoard() {
  const board = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  /**
   * `resetScroll: false`: tildar un rubro en la card de Huecos cambia un search
   * param, y sin esto TanStack scrollea al tope en cada navegación — el botón
   * que apretaste se va de la vista. El tablero se filtra en el cliente, no hay
   * `loaderDeps`, así que quedarse donde estás es lo correcto.
   */
  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  // Foco multi: sólo los slugs que matchean un rubro real, en orden de catálogo.
  const focused = board.categories
    .filter((c) => search.coverageRubros.includes(c.slug))
    .map((c) => c.slug)
  const focusSet = new Set(focused)

  const toggleRubro = (slug: string) =>
    setSearch({
      coverageRubros: focusSet.has(slug)
        ? search.coverageRubros.filter((s) => s !== slug)
        : [...search.coverageRubros.filter((s) => s !== slug), slug],
    })

  // Rubros enfocados al frente; el resto en orden de catálogo.
  const categories = focused.length
    ? [
        ...board.categories.filter((c) => focusSet.has(c.slug)),
        ...board.categories.filter((c) => !focusSet.has(c.slug)),
      ]
    : board.categories

  const focusSum = (z: CoverageZoneRow) =>
    focused.reduce((n, s) => n + (z.byCategory[s] ?? 0), 0)

  const q = search.q?.toLowerCase() ?? ''
  const zones = (q ? board.zones.filter((z) => z.zone.toLowerCase().includes(q)) : board.zones)
    .slice()
    .sort((a, b) => {
      if (focused.length) {
        return focusSum(b) - focusSum(a) || b.partnersTotal - a.partnersTotal
      }
      const factor = search.dir === 'asc' ? 1 : -1
      if (search.sort === 'zone') return a.zone.localeCompare(b.zone, 'es') * factor
      return (a.partnersTotal - b.partnersTotal) * factor
    })

  // Totales del pie: se recalculan sobre las zonas VISIBLES, así que filtrar por
  // zona actualiza la suma total y la de cada rubro.
  const shownTotal = zones.reduce((n, z) => n + z.partnersTotal, 0)
  const shownByCategory: Record<string, number> = {}
  for (const c of board.categories) {
    shownByCategory[c.slug] = zones.reduce((n, z) => n + (z.byCategory[c.slug] ?? 0), 0)
  }

  const spofs = singlePartnerCells(board)

  return (
    <>
      <PageHeader
        title="Cobertura"
        subtitle={`${formatInt(board.totalActivePartners)} publicados · ${board.categories.length} rubros · ${
          q ? `${zones.length} de ${board.zones.length}` : board.zones.length
        } zonas`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      {/*
        Sin `items-start` los dos cards se estiran a la misma altura de la fila.
        Huecos tiene altura natural (15 rubros fijos, sin scroll) y es la
        referencia; el `<ul>` de Punto único es `flex-1 min-h-0 overflow-y-auto`,
        así que aporta ~0 al alto intrínseco y termina con EXACTAMENTE la altura
        de Huecos, scrolleando su excedente.
      */}
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <GapsCard board={board} focusSet={focusSet} onToggle={toggleRubro} />
        <SpofCard spofs={spofs} />
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="space-y-1.5">
          <label
            htmlFor="zone-q"
            className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            Filtrar zona
          </label>
          <Input
            id="zone-q"
            type="search"
            placeholder="Tigre, CABA, Zona Norte…"
            defaultValue={search.q ?? ''}
            className="w-56"
            onChange={(e) => {
              const v = e.currentTarget.value.trim()
              setSearch({ q: v === '' ? undefined : v })
            }}
          />
        </div>

        {focused.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              Rubros enfocados
            </span>
            {focused.map((slug) => (
              <button
                key={slug}
                type="button"
                onClick={() => toggleRubro(slug)}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-brand bg-brand-soft px-2.5 text-xs text-brand"
              >
                {board.categories.find((c) => c.slug === slug)?.name}
                <span aria-hidden>✕</span>
              </button>
            ))}
            {focused.length > 1 ? (
              <button
                type="button"
                onClick={() => setSearch({ coverageRubros: [] })}
                className="h-7 rounded-md border border-border px-2.5 text-xs text-muted-foreground hover:text-foreground"
              >
                Limpiar
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table className="min-w-[1100px]">
          <TableHeader>
            <TableRow>
              <SortHeader
                label="Zona"
                sortKey="zone"
                active={focused.length === 0 && search.sort === 'zone'}
                dir={search.dir}
                to={TO}
              />
              <SortHeader
                label="Total"
                sortKey="total"
                active={focused.length === 0 && search.sort === 'total'}
                dir={search.dir}
                to={TO}
                align="right"
                firstClick="desc"
              />
              {categories.map((c) => (
                <TableHead
                  key={c.slug}
                  className={cn(
                    'text-right align-bottom text-xs whitespace-nowrap',
                    focusSet.has(c.slug) && 'bg-brand-soft text-brand',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleRubro(c.slug)}
                    className="hover:underline"
                  >
                    {c.name}
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {zones.map((z) => (
              <ZoneRow key={z.zone} zone={z} categories={categories} focusSet={focusSet} />
            ))}
            {zones.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={categories.length + 2}
                  className="text-center text-sm text-muted-foreground"
                >
                  Ninguna zona con ese texto.
                </TableCell>
              </TableRow>
            ) : (
              <TableRow className="border-t-2 border-border bg-secondary/40 font-medium">
                <TableCell>{q ? 'Total (zonas filtradas)' : 'Total por rubro'}</TableCell>
                <TableCell className="text-right tabular-nums">{formatInt(shownTotal)}</TableCell>
                {categories.map((c) => (
                  <TableCell
                    key={c.slug}
                    className={cn(
                      'text-right tabular-nums',
                      (shownByCategory[c.slug] ?? 0) === 0 && 'text-status-red',
                      focusSet.has(c.slug) && 'bg-brand-soft',
                    )}
                  >
                    {shownByCategory[c.slug] ?? 0}
                  </TableCell>
                ))}
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        La zona es el texto libre de <code>partners.coverage_zone</code>, sin normalizar:
        “Pacheco” y “General Pacheco” son dos filas.
      </p>
    </>
  )
}

function ZoneRow({
  zone,
  categories,
  focusSet,
}: {
  zone: CoverageZoneRow
  categories: PartnerCoverageBoard['categories']
  focusSet: Set<string>
}) {
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap font-medium">
        {zone.zone}
        {zone.invisible > 0 ? (
          <span className="ml-1.5 text-[10px] uppercase tracking-wider text-status-red">
            {zone.invisible} sin rubros
          </span>
        ) : null}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {formatInt(zone.partnersTotal)}
      </TableCell>
      {categories.map((c) => {
        const n = zone.byCategory[c.slug] ?? 0
        return (
          <TableCell
            key={c.slug}
            className={cn(
              'text-right tabular-nums',
              n === 0 && 'bg-status-red-bg text-status-red',
              n === 1 && 'bg-status-yellow-bg text-status-yellow',
              focusSet.has(c.slug) && n >= 2 && 'bg-brand-soft',
            )}
          >
            {n}
          </TableCell>
        )
      })}
    </TableRow>
  )
}

// ── Indicadores ─────────────────────────────────────────────────────────────

function GapsCard({
  board,
  focusSet,
  onToggle,
}: {
  board: PartnerCoverageBoard
  focusSet: Set<string>
  onToggle: (slug: string) => void
}) {
  const rows = board.categories
    .map((c) => {
      const total = board.categoryTotals[c.slug] ?? 0
      const zonesWithIt = board.zones.filter((z) => (z.byCategory[c.slug] ?? 0) > 0).length
      return { ...c, total, zonesWithIt }
    })
    .sort((a, b) => a.total - b.total || a.position - b.position)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MapPinOff className="size-4 text-status-red" aria-hidden />
          Huecos de cobertura
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-xs text-muted-foreground">
          Rubros por menos oferta. Elegí uno o varios para enfocar sus columnas.
        </p>
        <ul className="space-y-1.5">
          {rows.map((r) => {
            const on = focusSet.has(r.slug)
            return (
              <li key={r.slug}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onToggle(r.slug)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-sm transition-colors',
                    'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                    on
                      ? 'border-brand bg-brand-soft'
                      : r.total === 0
                        ? 'border-status-red/30 bg-status-red-bg'
                        : 'border-border hover:border-foreground/20',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded border',
                      on ? 'border-brand bg-brand text-white' : 'border-muted-foreground/40',
                    )}
                  >
                    {on ? <Check className="size-3" aria-hidden /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  <span
                    className={cn(
                      'shrink-0 tabular-nums',
                      r.total === 0 ? 'text-status-red' : 'text-muted-foreground',
                    )}
                  >
                    {r.total === 0
                      ? 'sin oferta'
                      : `${formatInt(r.total)} · ${r.zonesWithIt} zona${r.zonesWithIt === 1 ? '' : 's'}`}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}

/**
 * Punto único de falla, AGRUPADO por rubro: "Motor depende de un solo taller en
 * Tigre, Pilar y Munro". Sin agrupar son 100+ filas de una celda cada una —
 * ilegible, y la lista se desbordaba de la card.
 */
function SpofCard({ spofs }: { spofs: ReturnType<typeof singlePartnerCells> }) {
  const byCategory = new Map<string, { name: string; zones: Array<string> }>()
  for (const s of spofs) {
    const entry = byCategory.get(s.categorySlug) ?? { name: s.categoryName, zones: [] }
    entry.zones.push(s.zone)
    byCategory.set(s.categorySlug, entry)
  }
  const groups = [...byCategory.entries()].sort(
    (a, b) => b[1].zones.length - a[1].zones.length || a[1].name.localeCompare(b[1].name, 'es'),
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="size-4 text-status-yellow" aria-hidden />
          Punto único de falla
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col">
        <p className="mb-3 text-xs text-muted-foreground">
          Rubro cubierto por un solo taller en su zona: si pausa, la zona queda sin ese servicio.
        </p>
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Ningún rubro depende de un solo taller en su zona.
          </p>
        ) : (
          <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
            {groups.map(([slug, g]) => (
              <li key={slug}>
                <Link
                  to="/partners/listado"
                  search={{ category: slug }}
                  className="block rounded-md border border-status-yellow/30 bg-status-yellow-bg px-3 py-2 text-sm transition-colors hover:border-status-yellow/60"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">{g.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {g.zones.length} zona{g.zones.length === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                    {g.zones.join(' · ')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
