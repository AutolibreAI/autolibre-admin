import { Link, createFileRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { getPartnerReferralsFn } from '~/fn/partner-referrals'
import { Chip, FilterGroup } from '~/components/Filters'
import { GrowthChart } from '~/components/GrowthChart'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Badge } from '~/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { formatInt } from '~/lib/format'
import { shortDay } from '~/lib/partner-plans'
import {
  fillReferralBuckets,
  groupByPartner,
  partnerReferralsSearchSchema,
} from '~/lib/partner-referrals'
import type { ReferralCodeRow, ReferralPartnerRow } from '~/lib/partner-referrals'

/**
 * Partners › Taller de cabecera: cuánto aporta cada proveedor que reparte un
 * código de referido (Ser May y los que vengan).
 *
 * Reemplaza la consulta que nadie corría: `partner_referral_codes` →
 * `preferred_partners` → `users`/`vehicles`, más el cruce con la actividad
 * para saber si esa gente sigue usando la app. Todo sale de la migración 027
 * (`ops.partner_referral_summary` / `ops.partner_referral_links_series`).
 *
 * Sólo conteos: ninguna persona, email ni patente. "Activo" es la MISMA señal
 * que el gráfico de activos de Métricas (ramas del feed de `/actividad` +
 * refresh del token push) en los últimos 30 días, y no son aperturas de la app
 * (no existe ese registro).
 *
 * `ssr: 'data-only'`: está detrás de auth y el gráfico es markup pesado; el
 * loader corre en el servidor igual (mismo criterio que `/metricas`).
 */
export const Route = createFileRoute('/_authed/partners/cabecera')({
  validateSearch: partnerReferralsSearchSchema,
  loaderDeps: ({ search }) => ({ referralUnit: search.referralUnit }),
  ssr: 'data-only',
  loader: ({ deps, abortController }) =>
    getPartnerReferralsFn({ data: deps, signal: abortController.signal }),
  head: () => ({ meta: [{ title: 'Partners · Taller de cabecera — AutoLibre' }] }),
  component: PartnerReferralsPage,
})

function PartnerReferralsPage() {
  const result = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  if (!result.available) {
    return (
      <>
        <PageHeader title="Taller de cabecera" actions={<SsrTag>ssr: data-only</SsrTag>} />
        <Empty>Esta base todavía no tiene lo necesario: falta {result.missing}.</Empty>
      </>
    )
  }

  const partners = groupByPartner(result.codes)
  const filled = fillReferralBuckets(result.series, result.unit)
  const totals = partners.reduce(
    (acc, p) => ({
      users: acc.users + p.usersCurrent,
      vehicles: acc.vehicles + p.vehiclesCurrent,
      active: acc.active === null || p.activeCurrent === null ? null : acc.active + p.activeCurrent,
      links: acc.links + p.linksTotal,
      removed: acc.removed + p.linksRemoved,
    }),
    { users: 0, vehicles: 0, active: 0 as number | null, links: 0, removed: 0 },
  )
  const inactive = totals.active === null ? null : totals.users - totals.active

  return (
    <>
      <PageHeader
        title="Taller de cabecera"
        subtitle="Personas y autos que trae cada proveedor con su código · hora de Buenos Aires · sin cuentas internas"
        actions={<SsrTag>ssr: data-only</SsrTag>}
      />

      <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Personas vinculadas hoy" value={totals.users} />
        <Stat label="Autos de esas personas" value={totals.vehicles} />
        <Stat label={`Activas (${result.activeWindowDays} días)`} value={totals.active} />
        <Stat label="Inactivas" value={inactive} />
        <Stat label="Se desvincularon" value={totals.removed} />
      </dl>

      <section className="mb-6">
        <h2 className="mb-2 font-heading text-sm font-semibold">Ranking de proveedores</h2>
        {partners.length === 0 ? (
          <Empty>Todavía no hay códigos de taller de cabecera.</Empty>
        ) : (
          <PartnerTable rows={partners} windowDays={result.activeWindowDays} />
        )}
      </section>

      <section className="mb-6">
        <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
          <h2 className="font-heading text-sm font-semibold">Altas por {result.unit}</h2>
          <FilterGroup label="Agrupar por">
            {(['semana', 'mes'] as const).map((u) => (
              <Chip
                key={u}
                active={search.referralUnit === u}
                onClick={() => navigate({ search: { referralUnit: u }, replace: true, resetScroll: false })}
              >
                {u === 'semana' ? 'Semana' : 'Mes'}
              </Chip>
            ))}
          </FilterGroup>
        </div>
        <GrowthChart
          buckets={filled.map((p) => p.bucket)}
          unit={result.unit}
          label="Personas que cargaron un código"
          bars={[{ values: filled.map((p) => p.links), color: 'var(--color-brand)', label: `altas por ${result.unit}` }]}
          emptyMessage="Nadie cargó un código todavía."
        />
        {totals.removed > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Bajas (se desvincularon) por {result.unit}:{' '}
            {filled
              .filter((p) => p.removals > 0)
              .map((p) => `${shortDay(p.bucket)}: ${formatInt(p.removals)}`)
              .join(' · ')}
          </p>
        ) : null}
      </section>

      <section className="mb-6">
        <h2 className="mb-2 font-heading text-sm font-semibold">Por código</h2>
        <CodeTable rows={result.codes} />
      </section>

      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          Vinculadas = personas que hoy tienen al proveedor como taller de cabecera (cargaron su código y no lo
          desvincularon). Autos = los autos no archivados de esas personas, no autos atendidos en el taller.
        </p>
        <p>
          Activa = hizo algo en la app o renovó su token push en los últimos {result.activeWindowDays} días: la
          misma señal que «Usuarios activos» de Métricas. No son aperturas de la app (no hay registro de eso).
        </p>
        <p>
          «Reclamado» = el dueño ya reclamó el taller con su código de reclamo. Es otro código, distinto del de
          taller de cabecera.
        </p>
      </div>
    </>
  )
}

function PartnerTable({ rows, windowDays }: { rows: ReadonlyArray<ReferralPartnerRow>; windowDays: number }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <Table className="min-w-[900px]">
        <TableHeader>
          <TableRow>
            <TableHead>Proveedor</TableHead>
            <TableHead className="text-right">Códigos</TableHead>
            <TableHead className="text-right">Personas hoy</TableHead>
            <TableHead className="text-right">Autos</TableHead>
            <TableHead className="text-right" title={`Con actividad en los últimos ${windowDays} días`}>
              Activas
            </TableHead>
            <TableHead className="text-right">Inactivas</TableHead>
            <TableHead className="text-right">Canjes totales</TableHead>
            <TableHead className="text-right">Se desvincularon</TableHead>
            <TableHead>Primer canje</TableHead>
            <TableHead>Último canje</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.partnerId}>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Link
                    to="/partners/$partnerId"
                    params={{ partnerId: r.partnerId }}
                    className="font-medium text-foreground hover:underline"
                  >
                    {r.partnerName}
                  </Link>
                  {r.partnerTier === 'founding' ? (
                    <Badge variant="outline" className="text-muted-foreground">
                      Aliado
                    </Badge>
                  ) : null}
                  {r.partnerStatus !== 'active' ? (
                    <Badge variant="outline" className="text-muted-foreground">
                      {r.partnerStatus === 'paused' ? 'pausado' : 'archivado'}
                    </Badge>
                  ) : null}
                  {r.partnerClaimed ? (
                    <Badge variant="outline" className="text-muted-foreground">
                      Reclamado
                    </Badge>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatInt(r.codes)}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{formatInt(r.usersCurrent)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatInt(r.vehiclesCurrent)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmt(r.activeCurrent)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {fmt(r.activeCurrent === null ? null : r.usersCurrent - r.activeCurrent)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatInt(r.linksTotal)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatInt(r.linksRemoved)}</TableCell>
              <TableCell className="text-sm tabular-nums">{day(r.firstLinkOn)}</TableCell>
              <TableCell className="text-sm tabular-nums">{day(r.lastLinkOn)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function CodeTable({ rows }: { rows: ReadonlyArray<ReferralCodeRow> }) {
  if (rows.length === 0) return <Empty>Sin códigos.</Empty>
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <Table className="min-w-[760px]">
        <TableHeader>
          <TableRow>
            <TableHead>Código</TableHead>
            <TableHead>Etiqueta</TableHead>
            <TableHead>Proveedor</TableHead>
            <TableHead>Estado</TableHead>
            <TableHead>Creado</TableHead>
            <TableHead className="text-right">Canjes</TableHead>
            <TableHead className="text-right">Vigentes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.codeId}>
              <TableCell className="font-mono text-sm">{r.code}</TableCell>
              <TableCell className="text-sm">{r.label ?? <span className="text-muted-foreground">—</span>}</TableCell>
              <TableCell className="text-sm">{r.partnerName}</TableCell>
              <TableCell className="text-sm">
                {r.codeStatus === 'active' ? 'activo' : r.codeStatus === 'disabled' ? 'deshabilitado' : r.codeStatus}
              </TableCell>
              <TableCell className="text-sm tabular-nums">{shortDay(r.codeCreatedOn)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatInt(r.linksTotal)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatInt(r.usersCurrent)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

const fmt = (n: number | null) => (n === null ? '—' : formatInt(n))
const day = (d: string | null) => (d ? shortDay(d) : '—')

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-heading text-lg font-semibold tabular-nums">{value === null ? '—' : formatInt(value)}</dd>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card py-12 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
