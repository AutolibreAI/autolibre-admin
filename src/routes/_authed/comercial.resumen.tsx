import { Link, createFileRoute } from '@tanstack/react-router'
import {
  OBJECTION_LABELS,
  PROSPECT_FRONTS,
  PROSPECT_FRONT_LABELS,
  PROSPECT_STATUSES,
  PROSPECT_STATUS_LABELS,
  monthLabel,
  prospectSummarySearchSchema,
  type ProspectSummarySearch,
} from '~/lib/partner-prospects'
import { getComercialSummaryFn } from '~/fn/partner-prospects'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { MultiSelect } from '~/components/MultiSelect'
import { FollowUpTag } from '~/components/ProspectCards'
import { FrontBadge, ProspectStatusBadge, VerifiedBadge } from '~/components/ProspectFields'
import { InteractionComposer } from '~/components/ProspectInteractions'
import { ProspectsUnavailable } from '~/components/ProspectsUnavailable'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { cn } from '~/lib/utils'
import { formatDate, formatInt } from '~/lib/format'
import type { ComercialSummary, PartnerProspect, ProspectFacets } from '~/lib/partner-prospects'

const ALL = '__all__'
const LABEL = 'text-xs font-medium uppercase tracking-wider text-muted-foreground'

/**
 * Resumen (`/comercial/resumen`) — cómo viene el trabajo comercial, en una
 * pantalla: contactos por estado, verificados, altas, las objeciones que más se
 * repiten, cuántos trabajos por mes piden para que les cierre, y a quién hay
 * que llamar hoy. Reemplaza contar a mano las filas y las notas de la planilla.
 *
 * El rango de fechas acota las CHARLAS y las altas; los conteos por estado son
 * el estado actual (la pantalla lo dice). → `.claude/rules/partner-prospects.md`
 *
 * SSR completo: los números y "vencido hace N días" los calcula Postgres en
 * hora de Buenos Aires, así que el servidor y el navegador pintan lo mismo.
 */
export const Route = createFileRoute('/_authed/comercial/resumen')({
  validateSearch: prospectSummarySearchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getComercialSummaryFn({ data: deps }),
  head: () => ({ meta: [{ title: 'Resumen · Seguimiento comercial — AutoLibre' }] }),
  component: SummaryView,
})

function SummaryView() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<ProspectSummarySearch>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  if (!data.available) return <ProspectsUnavailable missing={data.missing} />

  const s = data.summary
  const hasRange = Boolean(search.prospectFrom || search.prospectTo)
  const filtered =
    hasRange ||
    Boolean(search.prospectFront) ||
    search.prospectZones.length > 0 ||
    Boolean(search.prospectRubro) ||
    Boolean(search.prospectOwner)

  return (
    <>
      <PageHeader
        title="Resumen"
        subtitle={`${formatInt(s.total)} ${filtered ? 'contactos con este filtro' : 'contactos en total'}`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <Filters
        search={search}
        facets={data.facets}
        filtered={filtered}
        setSearch={setSearch}
      />

      <SummaryBlocks summary={s} hasRange={hasRange} />

      <section aria-labelledby="rs-due" className="mt-8">
        <h2 id="rs-due" className="mb-2 font-heading text-sm font-semibold">
          Vencidos y para hoy ({formatInt(data.due.length)})
        </h2>
        {data.due.length === 0 ? (
          <p className="rounded-lg border border-border bg-card px-4 py-5 text-sm text-muted-foreground">
            Nada vencido ni para hoy con este filtro.
          </p>
        ) : (
          <ul className="space-y-2">
            {data.due.map((p) => (
              <DueRow key={p.id} prospect={p} />
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

function Filters({
  search,
  facets,
  filtered,
  setSearch,
}: {
  search: ProspectSummarySearch
  facets: ProspectFacets
  filtered: boolean
  setSearch: (next: Partial<ProspectSummarySearch>) => void
}) {
  return (
    <div className="mb-6 space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <label htmlFor="rs-from" className={LABEL}>Desde</label>
          <Input
            id="rs-from"
            type="date"
            className="h-9 w-40 shadow-none"
            value={search.prospectFrom ?? ''}
            onChange={(e) => setSearch({ prospectFrom: e.target.value || undefined })}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="rs-to" className={LABEL}>Hasta</label>
          <Input
            id="rs-to"
            type="date"
            className="h-9 w-40 shadow-none"
            value={search.prospectTo ?? ''}
            onChange={(e) => setSearch({ prospectTo: e.target.value || undefined })}
          />
        </div>
        <div className="space-y-1.5">
          <span className={LABEL}>Zona</span>
          <MultiSelect
            label="Zona"
            options={facets.localities.map((l) => ({ value: l, label: l }))}
            selected={search.prospectZones}
            onChange={(next) => setSearch({ prospectZones: next })}
            placeholder="Todas"
            className="w-52"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="rs-rubro" className={LABEL}>Rubro</label>
          <Select
            value={search.prospectRubro ?? ALL}
            onValueChange={(v) => setSearch({ prospectRubro: v === ALL ? undefined : v })}
          >
            <SelectTrigger id="rs-rubro" className="h-9 w-52 shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos</SelectItem>
              {facets.categories.map((c) => (
                <SelectItem key={c.slug} value={c.slug}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {filtered ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-9"
            onClick={() =>
              setSearch({
                prospectFrom: undefined,
                prospectTo: undefined,
                prospectFront: undefined,
                prospectZones: [],
                prospectRubro: undefined,
                prospectOwner: undefined,
              })
            }
          >
            Limpiar todo
          </Button>
        ) : null}
      </div>

      <FilterGroup
        label="Frente"
        onClear={search.prospectFront ? () => setSearch({ prospectFront: undefined }) : undefined}
      >
        {PROSPECT_FRONTS.map((f) => (
          <Chip
            key={f}
            active={search.prospectFront === f}
            onClick={() => setSearch({ prospectFront: search.prospectFront === f ? undefined : f })}
          >
            {PROSPECT_FRONT_LABELS[f]}
          </Chip>
        ))}
        <Chip
          active={search.prospectFront === 'none'}
          onClick={() => setSearch({ prospectFront: search.prospectFront === 'none' ? undefined : 'none' })}
        >
          Sin frente
        </Chip>
      </FilterGroup>

      <FilterGroup
        label="Conseguido por"
        onClear={search.prospectOwner ? () => setSearch({ prospectOwner: undefined }) : undefined}
      >
        {facets.owners.map((o) => (
          <Chip
            key={o.id}
            active={search.prospectOwner === o.id}
            onClick={() => setSearch({ prospectOwner: search.prospectOwner === o.id ? undefined : o.id })}
          >
            {o.name}
          </Chip>
        ))}
        <Chip
          active={search.prospectOwner === 'none'}
          onClick={() => setSearch({ prospectOwner: search.prospectOwner === 'none' ? undefined : 'none' })}
        >
          Sin asignar
        </Chip>
      </FilterGroup>
    </div>
  )
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <p className={LABEL}>{label}</p>
      <p className={cn('mt-1 font-heading text-2xl font-semibold tabular-nums', tone)}>{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function SummaryBlocks({ summary: s, hasRange }: { summary: ComercialSummary; hasRange: boolean }) {
  const maxObjection = Math.max(1, ...s.objections.map((o) => o.prospects))
  const periodLabel = hasRange ? 'en el período' : 'desde siempre'
  return (
    <div className="space-y-8">
      <section aria-labelledby="rs-state">
        <h2 id="rs-state" className="mb-1 font-heading text-sm font-semibold">
          Contactos por estado
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Estado de hoy de los contactos que pasan el filtro. El rango de fechas no lo cambia.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {PROSPECT_STATUSES.map((st) => (
            <div key={st} className="rounded-lg border border-border bg-card px-4 py-3">
              <ProspectStatusBadge status={st} />
              <p className="mt-2 font-heading text-2xl font-semibold tabular-nums">{formatInt(s.byStatus[st])}</p>
            </div>
          ))}
          <Tile label="Verificados" value={formatInt(s.verified)} hint="los 4 checks" tone="text-status-green" />
        </div>
      </section>

      <section aria-labelledby="rs-altas">
        <h2 id="rs-altas" className="mb-3 font-heading text-sm font-semibold">
          Altas en el marketplace
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Tile
            label="Altas del mes"
            value={formatInt(s.altasMonth)}
            hint={s.month ? monthLabel(s.month) : undefined}
            tone="text-status-green"
          />
          {s.altasPeriod !== null ? (
            <Tile label="Altas en el período" value={formatInt(s.altasPeriod)} tone="text-status-green" />
          ) : null}
          <div className="col-span-2 flex items-center rounded-lg border border-border bg-card px-4 py-3 text-sm sm:col-span-1">
            <Link
              to="/comercial/altas"
              search={{ prospectMonth: s.month || undefined }}
              className="underline underline-offset-2"
            >
              Ver altas por responsable
            </Link>
          </div>
        </div>
      </section>

      <section aria-labelledby="rs-objections">
        <h2 id="rs-objections" className="mb-1 font-heading text-sm font-semibold">
          Objeciones más repetidas
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          {formatInt(s.interactions)} {s.interactions === 1 ? 'charla' : 'charlas'} {periodLabel}. El número grande
          cuenta proveedores distintos: el que la repitió en tres llamados cuenta una vez.
        </p>
        {s.objections.length === 0 ? (
          <p className="rounded-lg border border-border bg-card px-4 py-5 text-sm text-muted-foreground">
            Ninguna charla con objeción cargada {periodLabel}.
          </p>
        ) : (
          <ul className="space-y-2 rounded-lg border border-border bg-card p-4">
            {s.objections.map((o) => (
              <li key={o.objection} className="space-y-1">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span>{OBJECTION_LABELS[o.objection] ?? o.objection}</span>
                  <span className="shrink-0 tabular-nums">
                    <strong className="font-semibold">{formatInt(o.prospects)}</strong>
                    <span className="text-muted-foreground">
                      {' '}
                      {o.prospects === 1 ? 'proveedor' : 'proveedores'} · {formatInt(o.interactions)}{' '}
                      {o.interactions === 1 ? 'charla' : 'charlas'}
                    </span>
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-surface-2" aria-hidden>
                  <div
                    className="h-1.5 rounded-full bg-action"
                    style={{ width: `${(o.prospects / maxObjection) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
        {s.otherObjections.length > 0 ? (
          <div className="mt-3 rounded-lg border border-border bg-card p-4">
            <p className={LABEL}>"Otra", con sus palabras</p>
            <ul className="mt-2 space-y-1 text-sm">
              {s.otherObjections.map((o) => (
                <li key={o.text} className="flex justify-between gap-3">
                  <span>{o.text}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">×{formatInt(o.count)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="rs-jobs">
        <h2 id="rs-jobs" className="mb-1 font-heading text-sm font-semibold">
          Trabajos por mes que piden para pagar
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          El último número que dijo cada proveedor {periodLabel}; cada uno cuenta una vez.
        </p>
        <div className="grid grid-cols-3 gap-3">
          <Tile label="Promedio" value={s.jobs.avg === null ? '—' : formatOneDecimal(s.jobs.avg)} />
          <Tile label="Mediana" value={s.jobs.median === null ? '—' : formatOneDecimal(s.jobs.median)} />
          <Tile label="Proveedores" value={formatInt(s.jobs.n)} hint="con el dato cargado" />
        </div>
      </section>
    </div>
  )
}

/** `4.5` → `4,5`; `4` → `4`. Sin `Intl` ad hoc: el mismo string en servidor y cliente. */
function formatOneDecimal(n: number): string {
  return Number.isInteger(n) ? formatInt(n) : n.toFixed(1).replace('.', ',')
}

function DueRow({ prospect: p }: { prospect: PartnerProspect }) {
  return (
    <li className="rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <Link
            to="/comercial/contactos/$prospectId"
            params={{ prospectId: p.id }}
            className="font-heading text-sm font-semibold underline-offset-2 hover:underline"
          >
            {p.name}
          </Link>
          <div className="flex flex-wrap items-center gap-1.5">
            <ProspectStatusBadge status={p.status} />
            {p.front ? <FrontBadge front={p.front} quoteCode={p.frontQuoteCode} /> : null}
            {p.verified ? <VerifiedBadge /> : null}
            <FollowUpTag days={p.followUpInDays} date={p.nextFollowUpOn} />
          </div>
          <p className="text-sm">
            <span className="text-muted-foreground">Próximo paso: </span>
            {p.nextStep ?? 'sin definir'}
            {p.lastContactOn ? (
              <span className="text-muted-foreground">
                {' '}
                · último contacto {formatDate(`${p.lastContactOn}T12:00:00Z`)}
              </span>
            ) : null}
          </p>
        </div>
        <InteractionComposer prospect={p} />
      </div>
    </li>
  )
}
