import { Link, createFileRoute } from '@tanstack/react-router'
import { FileText } from 'lucide-react'
import {
  INSURANCE_WINDOWS,
  INSURANCE_WINDOW_LABELS,
  insuranceSearchSchema,
  insuranceStatusLabel,
  type ExpiringInsurance,
  type InsuranceSummary,
} from '~/lib/insurance'
import { insuranceSummaryFn, listExpiringInsurancesFn } from '~/fn/insurance'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { Badge } from '~/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatDate, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * Seguros — la cola de pólizas por vencer, para ofrecer alternativas.
 *
 * ── Qué reemplaza ───────────────────────────────────────────────────────────
 *
 * El `select … from insurances where expiration_date < now() + interval '30
 * days'` que hoy nadie corre. Es una lista de trabajo, no una métrica.
 *
 * ── Vocabulario ─────────────────────────────────────────────────────────────
 *
 * Esto NO es un `Lead` del backend: `Insurance` es un aggregate de
 * `vehicle-management`. Vive bajo `/leads` como línea de captación del panel.
 * → `.claude/rules/leads.md`
 */
export const Route = createFileRoute('/_authed/leads/seguros')({
  /**
   * SSR completo (heredado). Es una pantalla de CONTENIDO —tabla de pólizas con
   * titular y fechas— y puede ser el primer pintado de una sesión que entra a
   * trabajar renovaciones. Mismo criterio que `/leads/talleres`.
   */
  validateSearch: insuranceSearchSchema,
  loaderDeps: ({ search }) => search,

  /**
   * Dos consultas, un `Promise.all`. Ninguna es notoriamente más cara que la
   * otra (decenas de filas), así que no hay nada que transmitir — un `Await`
   * sería una frontera de Suspense sin nada del otro lado. Mismo criterio que
   * `/operacion`.
   */
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal
    const [rows, summary] = await Promise.all([
      listExpiringInsurancesFn({ data: deps, signal }),
      insuranceSummaryFn({ signal }),
    ])
    return { rows, summary }
  },

  head: () => ({ meta: [{ title: 'Leads · Seguros — AutoLibre' }] }),
  component: Seguros,
})

function Seguros() {
  const { rows, summary } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <>
      <PageHeader
        title="Seguros"
        subtitle="Pólizas por vencer — la cola para ofrecer alternativas."
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <SummaryTiles summary={summary} />

      <div className="mb-4 mt-5">
        <FilterGroup label="Ventana">
          {INSURANCE_WINDOWS.map((w) => (
            <Chip
              key={w}
              active={search.within === w}
              onClick={() => navigate({ search: { within: w }, replace: true })}
            >
              {INSURANCE_WINDOW_LABELS[w]}
            </Chip>
          ))}
        </FilterGroup>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          {search.within === 'all'
            ? 'Ninguna póliza cargada. Cuando un usuario cargue el seguro de su auto en la app, aparece acá.'
            : 'Ninguna póliza vence en esa ventana. Ampliá la ventana para ver el resto.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vence</TableHead>
                <TableHead>Aseguradora</TableHead>
                <TableHead>Cobertura</TableHead>
                <TableHead>Vehículo</TableHead>
                <TableHead>Titular</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">PDF</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <InsuranceRow key={r.id} row={r} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  )
}

/**
 * Las cuatro tarjetas están siempre, incluso en cero — es una superficie de
 * monitoreo, no una lista de pendientes. Mismo criterio que las tarjetas de
 * cola de `/operacion` y opuesto a "qué hay que arreglar" de Inicio.
 *
 * Los cortes son fijos (vencidas / ≤30 / 31–90) y no siguen la ventana elegida
 * arriba: son un panorama, no el resultado del filtro.
 */
function SummaryTiles({ summary }: { summary: InsuranceSummary }) {
  const tiles = [
    { label: 'Ya vencidas', value: summary.expired, tone: summary.expired > 0 ? 'red' : 'plain' },
    { label: 'Vencen en ≤30 días', value: summary.next30, tone: summary.next30 > 0 ? 'amber' : 'plain' },
    { label: 'Vencen en 31–90 días', value: summary.next90, tone: 'plain' },
    { label: 'Pólizas vigentes', value: summary.live, tone: 'plain' },
  ] as const

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map((t) => (
        <div
          key={t.label}
          className={cn(
            'rounded-lg border p-4',
            t.tone === 'red'
              ? 'border-destructive/30 bg-status-red-bg'
              : t.tone === 'amber'
                ? 'border-status-yellow/30 bg-status-yellow-bg'
                : 'border-border bg-card',
          )}
        >
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t.label}
          </div>
          <div className="mt-1 font-heading text-2xl font-bold tracking-tight tabular-nums">
            {formatInt(t.value)}
          </div>
        </div>
      ))}
    </div>
  )
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-status-green-bg text-status-green border-status-green/20',
  pending_renewal: 'bg-status-yellow-bg text-status-yellow border-status-yellow/20',
  expired: 'bg-status-red-bg text-status-red border-destructive/20',
}

function InsuranceRow({ row }: { row: ExpiringInsurance }) {
  const overdue = row.daysToExpiry < 0
  const soon = row.daysToExpiry >= 0 && row.daysToExpiry <= 30

  return (
    <TableRow className={cn(overdue && 'bg-status-red-bg/40', soon && 'bg-status-yellow-bg/40')}>
      <TableCell>
        <div className="font-medium tabular-nums">{formatDate(row.expirationDate)}</div>
        <div
          className={cn(
            'text-xs',
            overdue
              ? 'font-medium text-status-red'
              : soon
                ? 'font-medium text-status-yellow'
                : 'text-muted-foreground',
          )}
        >
          {overdue
            ? `venció hace ${Math.abs(row.daysToExpiry)} d`
            : row.daysToExpiry === 0
              ? 'vence hoy'
              : `en ${row.daysToExpiry} d`}
        </div>
      </TableCell>

      <TableCell>
        <div>{row.insurer}</div>
        <div className="text-xs text-muted-foreground">Póliza {row.policyNumber}</div>
      </TableCell>

      {/*
        Texto libre del backend, a veces largo. Se trunca con `title` para el
        detalle: una celda de 200 caracteres rompe la tabla.
      */}
      <TableCell className="max-w-[16rem] truncate" title={row.coverageType ?? undefined}>
        <span className="text-sm text-muted-foreground">{row.coverageType ?? '—'}</span>
      </TableCell>

      <TableCell>
        <div>{row.vehicleAlias ?? row.plate ?? '—'}</div>
        {row.plate && row.vehicleAlias ? (
          <div className="font-mono text-xs uppercase text-muted-foreground">{row.plate}</div>
        ) : null}
        {row.vin || row.engineNumber ? (
          <div className="text-xs text-muted-foreground">
            {row.vin ? `VIN ${row.vin}` : ''}
            {row.vin && row.engineNumber ? ' · ' : ''}
            {row.engineNumber ? `motor ${row.engineNumber}` : ''}
          </div>
        ) : null}
      </TableCell>

      <TableCell>
        {/*
          El titular de la póliza gana sobre el nombre de la cuenta: es a quién
          hay que nombrar al contactar. El link va a la ficha del usuario —los
          autos se ven ahí dentro, no hay listado propio de vehículos.
        */}
        <Link
          to="/usuarios/$userId"
          params={{ userId: row.userId }}
          className="text-brand hover:underline"
        >
          {row.insuredName ?? row.userName ?? row.userEmail ?? '—'}
        </Link>
        <div className="truncate text-xs text-muted-foreground">{row.userEmail ?? ''}</div>
      </TableCell>

      <TableCell>
        <Badge variant="outline" className={STATUS_STYLES[row.status] ?? 'border-border'}>
          {insuranceStatusLabel(row.status)}
        </Badge>
      </TableCell>

      {/*
        Sólo se informa si hay PDF, no se ofrece descarga: `GET /files/:id/url`
        del backend está acotado al DUEÑO del archivo, así que un admin que no
        subió la póliza recibe 404. Mismo límite que los manuales de catálogo.
      */}
      <TableCell className="text-right">
        {row.hasPdf ? (
          <FileText
            className="ml-auto size-4 text-muted-foreground"
            aria-label="Tiene PDF cargado (no descargable desde el panel)"
          />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  )
}
