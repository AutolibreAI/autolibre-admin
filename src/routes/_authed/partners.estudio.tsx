import { Link, createFileRoute } from '@tanstack/react-router'
import { Copy, FileText } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { getServiceCatalog, listMarketplacePartners, listPartnerZonesFn } from '~/fn/partners'
import { listQuoteRequestsFn } from '~/fn/quote-requests'
import { Chip, FilterGroup } from '~/components/Filters'
import { MockBanner } from '~/components/MockBanner'
import { MultiSelect } from '~/components/MultiSelect'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { ProposalLoadStatus } from '~/components/ProposalLoadStatus'
import { useProposalFacts } from '~/components/useProposalFacts'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '~/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { Textarea } from '~/components/ui/textarea'
import { fetchPartnerPlansMock } from '~/mocks/partner-plans'
import { partnerStudyExtrasMock } from '~/mocks/partner-study'
import { formatDate, formatInt } from '~/lib/format'
import {
  PARTNER_PLANS,
  PARTNER_PLAN_LABELS,
  PROPOSAL_COUNT_START,
  countableMonths,
  monthLabel,
} from '~/lib/partner-plans'
import {
  NORTH_STAR_MINUTES,
  NORTH_STAR_PROPOSALS,
  STUDY_PERIODS,
  formatMinutes,
  lastDaysRange,
  monthRange,
  northStar,
  partnerMonthlyReport,
  partnerStudySearchSchema,
  studyRows,
} from '~/lib/partner-study'
import { quoteChannelLabel } from '~/lib/quote-requests'
import { cn } from '~/lib/utils'
import type { PartnerPlan } from '~/lib/partner-plans'
import type { PartnerStudyRow, StudyPartnerRef } from '~/lib/partner-study'

/**
 * Estudio de proveedores: ranking, dormidos, y un reporte mensual por
 * proveedor listo para pegar en WhatsApp.
 *
 * Las propuestas son reales (las mismas que Partners › Propuestas, mismo hook y
 * misma cache). Matcheados, tasa de respuesta, vencidos, confirmaciones,
 * disputas, motivos y vistas/clics son de ejemplo (`~/mocks/partner-study`), en
 * cursiva. El plan también (`~/mocks/partner-plans`).
 *
 * `ssr: 'data-only'`: el período se mide contra el reloj del navegador y las
 * propuestas se cargan ahí.
 */
export const Route = createFileRoute('/_authed/partners/estudio')({
  validateSearch: partnerStudySearchSchema,
  ssr: 'data-only',
  loader: async ({ abortController }) => {
    const signal = abortController.signal
    const [quotes, partners, zones, catalog] = await Promise.all([
      listQuoteRequestsFn({ data: { quoteStatus: 'all', quoteShowDuplicates: false }, signal }),
      listMarketplacePartners({ data: {}, signal }),
      listPartnerZonesFn({ signal }),
      getServiceCatalog({ signal }),
    ])
    const requests =
      'rows' in quotes
        ? quotes.rows
            .filter((r) => r.status !== 'closed' || (r.closedAt ?? '') >= PROPOSAL_COUNT_START)
            .map((r) => ({ id: r.id, createdAt: r.createdAt, channel: r.channel }))
        : null
    const refs: Array<StudyPartnerRef> = partners.map((p) => ({
      id: p.id,
      name: p.name,
      tier: p.tier,
      status: p.status,
      coverageZone: p.coverageZone,
      categorySlugs: p.categories.map((c) => c.slug),
    }))
    return {
      requests,
      partners: refs,
      zones,
      rubros: catalog.map((f) => ({ slug: f.slug, name: f.name })),
    }
  },
  head: () => ({ meta: [{ title: 'Partners · Estudio — AutoLibre' }] }),
  component: PartnerStudy,
})

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v)} %`)

function PartnerStudy() {
  const { requests, partners, zones, rubros } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  const load = useProposalFacts(requests ?? [])
  const [plans, setPlans] = useState<Map<string, PartnerPlan>>(new Map())
  useEffect(() => {
    void fetchPartnerPlansMock(partners.map((p) => p.id)).then(setPlans)
  }, [partners])

  const now = useMemo(() => new Date(), [])
  const range = lastDaysRange(search.studyPeriod, now)
  const allRows = useMemo(() => studyRows(load.facts, partners, plans, range), [load.facts, partners, plans, range.from])
  const star = useMemo(() => northStar(load.facts, range), [load.facts, range.from])

  const rows = allRows.filter(
    (r) =>
      (search.studyZones.length === 0 ||
        search.studyZones.some((z) => r.coverageZone.toLowerCase().includes(z.toLowerCase()))) &&
      (search.studyRubros.length === 0 || search.studyRubros.some((s) => r.categorySlugs.includes(s))) &&
      (search.studyPlans.length === 0 || (r.plan !== null && search.studyPlans.includes(r.plan))),
  )
  const active = rows.filter((r) => !r.dormant)
  const dormant = rows.filter((r) => r.dormant && r.status === 'active')
  const [reportFor, setReportFor] = useState<PartnerStudyRow | null>(null)

  if (requests === null) {
    return (
      <>
        <PageHeader title="Estudio de proveedores" actions={<SsrTag>ssr: data-only</SsrTag>} />
        <p className="text-sm text-muted-foreground">Esta base no tiene la tabla de pedidos.</p>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Estudio de proveedores"
        subtitle={`Últimos ${search.studyPeriod} días · desde el 27/10/2026 como máximo`}
        actions={<SsrTag>ssr: data-only</SsrTag>}
      />

      <MockBanner
        items={[
          'Propuestas, elegidas, sin decisión, tiempo de respuesta, canal, dormidos y el «3 en menos de 1 h» son reales.',
          'Matcheados, tasa de respuesta, vencidos sin respuesta, confirmaciones, disputas, motivos de «no contraté», vistas y clics son de ejemplo (en cursiva). El plan también.',
          'Propuestas por rubro y por urgencia no se muestran: el pedido no guarda urgencia, y el rubro del pedido no viene en el listado.',
        ]}
      />

      <div className="mb-4 flex flex-wrap items-end gap-5">
        <FilterGroup label="Período">
          {STUDY_PERIODS.map((p) => (
            <Chip key={p} active={search.studyPeriod === p} onClick={() => setSearch({ studyPeriod: p })}>
              {p} días
            </Chip>
          ))}
        </FilterGroup>
        <div className="w-56 space-y-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Zona</span>
          <MultiSelect
            label="Zona"
            options={zones.map((z) => ({ value: z, label: z }))}
            selected={search.studyZones}
            onChange={(v) => setSearch({ studyZones: v })}
            placeholder="Todas"
          />
        </div>
        <div className="w-56 space-y-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Rubro</span>
          <MultiSelect
            label="Rubro"
            options={rubros.map((r) => ({ value: r.slug, label: r.name }))}
            selected={search.studyRubros}
            onChange={(v) => setSearch({ studyRubros: v })}
            placeholder="Todos"
          />
        </div>
        <FilterGroup
          label="Plan (de ejemplo)"
          onClear={search.studyPlans.length > 0 ? () => setSearch({ studyPlans: [] }) : undefined}
        >
          {PARTNER_PLANS.map((p) => (
            <Chip
              key={p}
              active={search.studyPlans.includes(p)}
              onClick={() =>
                setSearch({
                  studyPlans: search.studyPlans.includes(p)
                    ? search.studyPlans.filter((x) => x !== p)
                    : [...search.studyPlans, p],
                })
              }
            >
              {PARTNER_PLAN_LABELS[p]}
            </Chip>
          ))}
        </FilterGroup>
      </div>

      <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile
          label={`Pedidos con ${NORTH_STAR_PROPOSALS} propuestas en menos de ${NORTH_STAR_MINUTES} min`}
          value={`${formatInt(star.withThreeUnderHour)} de ${formatInt(star.requests)}`}
          hint={`${formatInt(star.withThree)} llegaron a ${NORTH_STAR_PROPOSALS} propuestas en algún momento`}
        />
        <Tile label="Propuestas en el período" value={formatInt(active.reduce((a, r) => a + r.sent + r.withdrawn, 0))} />
        <Tile label="Proveedores con propuestas" value={formatInt(active.length)} />
        <Tile label="Proveedores dormidos" value={formatInt(dormant.length)} hint="activos, sin propuestas en el período" />
      </dl>

      <ProposalLoadStatus load={load} />

      <div className="mb-8 overflow-x-auto rounded-lg border border-border bg-card">
        <Table className="min-w-[1240px]">
          <TableHeader>
            <TableRow>
              <TableHead>Proveedor</TableHead>
              <TableHead className="text-right">Enviadas</TableHead>
              <TableHead className="text-right">Elegida / otra / sin decisión</TableHead>
              <TableHead className="text-right">Mediana de respuesta</TableHead>
              <TableHead>Por canal</TableHead>
              <TableHead className="text-right italic">Matcheados · tasa</TableHead>
              <TableHead className="text-right italic">Vencidos sin respuesta</TableHead>
              <TableHead className="text-right italic">Confirmados · disputas</TableHead>
              <TableHead className="text-right italic">Vistas · clics</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {active.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
                  {load.loading ? 'Cargando propuestas…' : 'Ningún proveedor con propuestas en este período y filtro.'}
                </TableCell>
              </TableRow>
            ) : (
              active.map((r) => <StudyRow key={r.partnerId} row={r} onReport={() => setReportFor(r)} />)
            )}
          </TableBody>
        </Table>
      </div>

      <section>
        <h2 className="mb-2 font-heading text-base font-semibold">Proveedores dormidos ({formatInt(dormant.length)})</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Activos, que no recibieron ninguna propuesta en los últimos {search.studyPeriod} días.
        </p>
        <details className="rounded-lg border border-border bg-card px-4 py-3">
          <summary className="cursor-pointer text-sm">Ver la lista</summary>
          <ul className="mt-2 columns-1 gap-6 text-sm sm:columns-2 lg:columns-3">
            {dormant.map((r) => (
              <li key={r.partnerId} className="py-0.5">
                <Link to="/partners/$partnerId" params={{ partnerId: r.partnerId }} className="hover:underline">
                  {r.name}
                </Link>
                <span className="text-xs text-muted-foreground"> · {r.coverageZone}</span>
              </li>
            ))}
          </ul>
        </details>
      </section>

      <ReportSheet row={reportFor} facts={load.facts} partners={partners} onClose={() => setReportFor(null)} />
    </>
  )
}

function StudyRow({ row: r, onReport }: { row: PartnerStudyRow; onReport: () => void }) {
  const total = r.sent + r.withdrawn
  const x = partnerStudyExtrasMock(r.partnerId, total)
  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link to="/partners/$partnerId" params={{ partnerId: r.partnerId }} className="font-medium hover:underline">
            {r.name}
          </Link>
          {r.tier === 'founding' ? <Badge variant="outline">Aliado</Badge> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {r.coverageZone}
          {r.plan ? ` · ${PARTNER_PLAN_LABELS[r.plan]}` : ''}
          {r.lastProposalAt ? ` · última ${formatDate(r.lastProposalAt)}` : ''}
        </p>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatInt(total)}
        {r.withdrawn > 0 ? <span className="block text-xs text-muted-foreground">{r.withdrawn} retirada(s)</span> : null}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {r.selected} / {r.notSelected} / {r.undecided}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatMinutes(r.medianResponseMinutes)}</TableCell>
      <TableCell className="text-xs">
        {Object.entries(r.byChannel)
          .map(([c, n]) => `${quoteChannelLabel(c)} ${n}`)
          .join(' · ')}
      </TableCell>
      <TableCell className="text-right tabular-nums italic">
        {x.matched} · {pct(x.matched > 0 ? (total / x.matched) * 100 : null)}
      </TableCell>
      <TableCell className={cn('text-right tabular-nums italic', x.expiredUnanswered > 0 && 'text-status-yellow')}>
        {x.expiredUnanswered}
      </TableCell>
      <TableCell className="text-right tabular-nums italic">
        {x.confirmed} · {x.disputed}
      </TableCell>
      <TableCell className="text-right tabular-nums italic">
        {x.profileViews} · {x.contactClicks}
      </TableCell>
      <TableCell>
        <Button size="xs" variant="outline" className="gap-1" onClick={onReport}>
          <FileText aria-hidden /> Reporte
        </Button>
      </TableCell>
    </TableRow>
  )
}

function ReportSheet({
  row,
  facts,
  partners,
  onClose,
}: {
  row: PartnerStudyRow | null
  facts: ReturnType<typeof useProposalFacts>['facts']
  partners: Array<StudyPartnerRef>
  onClose: () => void
}) {
  const months = useMemo(() => countableMonths(new Date()), [])
  const [month, setMonth] = useState(months[0]!)
  const [copied, setCopied] = useState(false)

  // El reporte es por mes calendario, no por el período del ranking: las filas
  // se recalculan para ese mes, con los mismos datos.
  const monthRows = useMemo(() => studyRows(facts, partners, new Map(), monthRange(month)), [facts, partners, month])
  const mine = row ? monthRows.find((r) => r.partnerId === row.partnerId) : undefined
  const text = row && mine ? partnerMonthlyReport({ ...mine, plan: row.plan }, month, monthRows) : ''

  return (
    <Sheet open={row !== null} onOpenChange={(o) => (o ? null : onClose())}>
      <SheetContent side="right" className="w-full max-w-full overflow-y-auto bg-card sm:w-[32rem]">
        <div className="border-b border-border px-5 py-4 pr-10">
          <SheetTitle>Reporte para {row?.name}</SheetTitle>
          <SheetDescription className="mt-0.5 leading-relaxed">
            Texto para pegar en WhatsApp. No nombra clientes ni a otros proveedores: la zona va como mediana
            anónima, y sólo si hay 3 o más proveedores más en la misma zona.
          </SheetDescription>
        </div>
        <div className="space-y-3 px-5 py-5">
          <Select value={month} onValueChange={(v) => setMonth(v)}>
            <SelectTrigger className="w-full" aria-label="Mes">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m} value={m}>
                  {monthLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea readOnly rows={14} value={text} className="font-mono text-xs" />
          <Button
            size="sm"
            className="gap-1.5"
            disabled={!text}
            onClick={() =>
              void navigator.clipboard.writeText(text).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              })
            }
          >
            <Copy className="size-3.5" aria-hidden /> {copied ? 'Copiado' : 'Copiar'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-heading text-lg font-semibold tabular-nums">{value}</dd>
      {hint ? <dd className="text-xs text-muted-foreground">{hint}</dd> : null}
    </div>
  )
}
