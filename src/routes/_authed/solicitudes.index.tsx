import { Await, Link, createFileRoute } from '@tanstack/react-router'
import { AlertTriangle, EyeOff, Unlink } from 'lucide-react'
import {
  APPLICATION_STATUSES,
  STATUS_LABELS,
  applicationSearchSchema,
} from '~/lib/partners'
import { getPipelineHealth, listPartnerApplications } from '~/fn/partners'
import { getSourcingContextFn } from '~/fn/team'
import { SOURCER_FILTER_NONE, sourcerLabel, type SourcingContext } from '~/lib/team'
import { ClaimSourcerButton, SourcerSelect } from '~/components/SourcerSelect'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { ApplicationStatusBadge } from '~/components/ApplicationStatusBadge'
import { ResolvedServicesSummary } from '~/components/ResolvedServicesSummary'
import { PanelSkeleton } from '~/components/Fallbacks'
import { SearchInput } from '~/components/SearchInput'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatDate } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { ApplicationListItem, PipelineHealth } from '~/lib/partners'

export const Route = createFileRoute('/_authed/solicitudes/')({
  validateSearch: applicationSearchSchema,
  loaderDeps: ({ search }) => search,

  /**
   * STREAMING SSR.
   *
   * La cola se espera — es el contenido de la página. Los tres chequeos de
   * salud cruzan `partners` y `partner_services` enteras, así que se devuelven
   * como promesa sin await y llegan en un chunk posterior. El operador ve su
   * trabajo pendiente de entrada y el semáforo un instante después, en vez de
   * esperar a los dos.
   */
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal
    const healthPromise = getPipelineHealth({ signal })
    // "Alta por" (035): el selector, "Es mío" y el progreso necesitan el
    // catálogo del equipo. Arranca antes del await de la cola (en paralelo).
    const sourcingPromise = getSourcingContextFn({ signal })
    const [applications, sourcing] = await Promise.all([
      listPartnerApplications({ data: deps, signal }),
      sourcingPromise,
    ])
    return { applications, healthPromise, sourcing }
  },

  head: () => ({ meta: [{ title: 'Solicitudes de partners — AutoLibre' }] }),
  component: ApplicationsQueue,
})

function ApplicationsQueue() {
  const { applications, healthPromise, sourcing } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setFilter = (patch: Partial<typeof search>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })

  return (
    <>
      <PageHeader
        title="Solicitudes de partners"
        subtitle={`${applications.length} en la cola`}
        actions={
          <>
            <Link
              to="/solicitudes/otros"
              className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm text-muted-foreground hover:text-foreground"
            >
              Revisar rubros «Otro» y servicios declarados
            </Link>
            <SsrTag>ssr: full + streaming</SsrTag>
          </>
        }
      />

      <Await
        promise={healthPromise}
        fallback={<PanelSkeleton rows={1} label="Cargando chequeos de salud" />}
      >
        {(health) => <HealthBar health={health} />}
      </Await>

      <div className="mb-4 mt-5 flex flex-wrap items-end gap-3">
        <SearchInput
          label="Buscar"
          placeholder="Nombre o email"
          value={search.q}
          onSearch={(q) => setFilter({ q })}
          className="w-full sm:w-56"
        />

        <div className="space-y-1.5">
          <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Estado
          </span>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={!search.status} onClick={() => setFilter({ status: undefined })}>
              Todos
            </Chip>
            {APPLICATION_STATUSES.map((s) => (
              <Chip key={s} active={search.status === s} onClick={() => setFilter({ status: s })}>
                {STATUS_LABELS[s]}
              </Chip>
            ))}
          </div>
        </div>

        {sourcing.available ? (
          <div className="space-y-1.5">
            <label
              htmlFor="filter-sourcer"
              className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              Alta por
            </label>
            <select
              id="filter-sourcer"
              value={search.applicationSourcer ?? ''}
              onChange={(e) => setFilter({ applicationSourcer: (e.target.value || undefined) as typeof search.applicationSourcer })}
              className="h-8 rounded-md border border-border bg-card px-2 text-sm"
            >
              <option value="">Todas</option>
              <option value={SOURCER_FILTER_NONE}>Sin asignar</option>
              {sourcing.members
                .filter((m) => m.active || m.applicationCount > 0)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {sourcerLabel(m)}
                  </option>
                ))}
            </select>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Publicadas
          </span>
          <Chip
            active={search.published === 'show'}
            onClick={() =>
              setFilter({ published: search.published === 'show' ? 'hide' : 'show' })
            }
          >
            {search.published === 'show' ? 'Mostrando' : 'Ocultas'}
          </Chip>
        </div>
      </div>

      <SourcingProgress
        sourcing={sourcing}
        filteringUnassigned={search.applicationSourcer === SOURCER_FILTER_NONE}
        onShowUnassigned={() =>
          setFilter({ applicationSourcer: SOURCER_FILTER_NONE, published: 'show', status: undefined })
        }
      />

      {applications.length === 0 ? (
        <div className="rounded-lg border border-border bg-card py-16 text-center text-sm text-muted-foreground">
          No hay solicitudes con esos filtros.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Taller</TableHead>
                <TableHead>Estado</TableHead>
                {sourcing.available ? <TableHead>Alta por</TableHead> : null}
                <TableHead>Al aprobar</TableHead>
                <TableHead>Seguimiento</TableHead>
                <TableHead>Recibida</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {applications.map((app) => (
                <Row key={app.id} app={app} sourcing={sourcing} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  )
}

/**
 * El semáforo del runbook, como indicador permanente.
 *
 * Las consultas 4, 5 y 6 del archivo original terminan con "esto se mira
 * después de cada aprobación". Un panel existe justamente para que eso no
 * dependa de que alguien se acuerde.
 */
function HealthBar({ health }: { health: PipelineHealth }) {
  const items = [
    {
      key: 'invisible',
      icon: EyeOff,
      value: health.invisiblePartners,
      label: 'Partners invisibles',
      hint: 'Publicados con cero rubros: se listan sin filtro pero no salen bajo ningún chip.',
    },
    {
      key: 'stuck',
      icon: Unlink,
      value: health.stuckApplications,
      label: 'Solicitudes trabadas',
      hint: 'En acuerdo verbal sin partner. La función las rechaza para siempre hasta destrabarlas.',
    },
    {
      key: 'would',
      icon: AlertTriangle,
      value: health.wouldBeInvisible,
      label: 'Quedarían invisibles',
      hint: 'Pendientes cuyo declarado no matchea ninguna familia activa. Al aprobarlas no se carga ningún rubro.',
    },
  ] as const

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {items.map(({ key, icon: Icon, value, label, hint }) => {
        const bad = value > 0
        return (
          <div
            key={key}
            className={cn(
              'rounded-lg border p-3.5',
              bad ? 'border-status-red/25 bg-status-red-bg' : 'border-border bg-card',
            )}
          >
            <div className="flex items-center gap-2">
              <Icon
                className={cn('size-4 shrink-0', bad ? 'text-status-red' : 'text-status-green')}
                aria-hidden
              />
              <span
                className={cn(
                  'font-heading text-lg font-bold',
                  bad ? 'text-status-red' : 'text-foreground',
                )}
              >
                {value}
              </span>
              <span className="text-sm font-medium">{label}</span>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>
          </div>
        )
      })}
    </div>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'h-8 rounded-md border px-3 text-sm transition-colors',
        active
          ? 'border-brand bg-brand-soft text-brand'
          : 'border-border bg-card text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/**
 * El progreso de la carga de "Alta por": solicitudes no descartadas sin
 * asignar, de todas las fechas y estados (incluidas las publicadas). El link
 * arma el filtro para recorrerlas: sin asignar + publicadas a la vista.
 */
function SourcingProgress({
  sourcing,
  filteringUnassigned,
  onShowUnassigned,
}: {
  sourcing: SourcingContext
  filteringUnassigned: boolean
  onShowUnassigned: () => void
}) {
  if (!sourcing.available || !sourcing.progress) return null
  const { unassigned, total } = sourcing.progress
  const done = unassigned === 0
  return (
    <div
      className={cn(
        'mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3.5 py-2.5 text-sm',
        done ? 'border-border bg-card' : 'border-status-yellow/30 bg-status-yellow-bg',
      )}
    >
      <span className={cn('font-heading font-semibold', done ? 'text-status-green' : 'text-status-yellow')}>
        {done ? 'Todas asignadas' : `${unassigned} de ${total} solicitudes sin asignar`}
      </span>
      <span className="text-xs text-muted-foreground">
        «Alta por»: quién del equipo trajo al proveedor. Cuenta todas menos las descartadas, de cualquier fecha.
      </span>
      {!done && !filteringUnassigned ? (
        <button type="button" onClick={onShowUnassigned} className="ml-auto text-xs font-medium text-foreground underline underline-offset-2">
          Ver las sin asignar
        </button>
      ) : null}
      {!sourcing.meMemberId ? (
        <span className="w-full text-xs text-muted-foreground">
          Tu usuario no está vinculado a ninguna persona del equipo: vinculalo en Comercial › Equipo para tener «Es mío».
        </span>
      ) : null}
    </div>
  )
}

function Row({ app, sourcing }: { app: ApplicationListItem; sourcing: SourcingContext }) {
  return (
    <TableRow>
      <TableCell>
        <Link
          to="/solicitudes/$applicationId"
          params={{ applicationId: app.id }}
          className="font-medium hover:text-brand hover:underline"
        >
          {app.businessName}
        </Link>
        <div className="text-xs text-muted-foreground">{app.email}</div>
        {app.declaredOther ? (
          <span
            className="mt-0.5 inline-block text-xs text-brand"
            title="Cargó texto libre en 'otros' del formulario"
          >
            declaró otros
          </span>
        ) : null}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <ApplicationStatusBadge status={app.status} />
          {app.alreadyPublished ? (
            <span className="text-xs text-muted-foreground">publicada</span>
          ) : null}
        </div>
      </TableCell>
      {sourcing.available ? (
        <TableCell>
          <div className="flex items-start gap-2">
            <SourcerSelect applicationId={app.id} current={app.sourcer} members={sourcing.members} compact />
            {!app.sourcer && sourcing.meMemberId ? (
              <ClaimSourcerButton applicationId={app.id} meMemberId={sourcing.meMemberId} members={sourcing.members} />
            ) : null}
          </div>
        </TableCell>
      ) : null}
      <TableCell>
        <ResolvedServicesSummary
          resolved={app.resolved}
          declaredCount={app.declaredServices.length}
          compact
        />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {app.followUpDate ? formatDate(app.followUpDate) : '—'}
      </TableCell>
      <TableCell className="text-muted-foreground">{formatDate(app.createdAt)}</TableCell>
    </TableRow>
  )
}
