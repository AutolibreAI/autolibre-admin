import { Await, Link, createFileRoute } from '@tanstack/react-router'
import { AlertTriangle, EyeOff, Unlink } from 'lucide-react'
import {
  APPLICATION_STATUSES,
  STATUS_LABELS,
  applicationSearchSchema,
} from '~/lib/partners'
import { getPipelineHealth, listPartnerApplications } from '~/fn/partners'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { ApplicationStatusBadge } from '~/components/ApplicationStatusBadge'
import { ResolvedServicesSummary } from '~/components/ResolvedServicesSummary'
import { PanelSkeleton } from '~/components/Fallbacks'
import { Input } from '~/components/ui/input'
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
    const applications = await listPartnerApplications({ data: deps, signal })
    return { applications, healthPromise }
  },

  head: () => ({ meta: [{ title: 'Solicitudes de partners — AutoLibre' }] }),
  component: ApplicationsQueue,
})

function ApplicationsQueue() {
  const { applications, healthPromise } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setFilter = (patch: Partial<typeof search>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })

  return (
    <>
      <PageHeader
        title="Solicitudes de partners"
        subtitle={`${applications.length} en la cola`}
        actions={<SsrTag>ssr: full + streaming</SsrTag>}
      />

      <Await
        promise={healthPromise}
        fallback={<PanelSkeleton rows={1} label="Cargando chequeos de salud" />}
      >
        {(health) => <HealthBar health={health} />}
      </Await>

      <div className="mb-4 mt-5 flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <label
            htmlFor="q"
            className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            Buscar
          </label>
          <Input
            id="q"
            type="search"
            placeholder="Nombre o email"
            defaultValue={search.q ?? ''}
            className="w-56"
            onChange={(e) => {
              const value = e.currentTarget.value.trim()
              setFilter({ q: value === '' ? undefined : value })
            }}
          />
        </div>

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
                <TableHead>Al aprobar</TableHead>
                <TableHead>Seguimiento</TableHead>
                <TableHead>Recibida</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {applications.map((app) => (
                <Row key={app.id} app={app} />
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

function Row({ app }: { app: ApplicationListItem }) {
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
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <ApplicationStatusBadge status={app.status} />
          {app.alreadyPublished ? (
            <span className="text-xs text-muted-foreground">publicada</span>
          ) : null}
        </div>
      </TableCell>
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
