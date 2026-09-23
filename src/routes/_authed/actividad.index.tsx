import { Link, createFileRoute } from '@tanstack/react-router'
import {
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  Car,
  ChevronRight,
  ClipboardCheck,
  FileText,
  IdCard,
  LogIn,
  MessageCircle,
  MessageSquare,
  ReceiptText,
  Repeat,
  ScanLine,
  Search,
  ShieldCheck,
  Smartphone,
  UserPlus,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_LABELS,
  ACTIVITY_KIND_SHORT,
  ACTIVITY_LIMIT,
  ACTIVITY_WINDOWS,
  ACTIVITY_TARGET_LABELS,
  ACTIVITY_WINDOW_LABELS,
  activitySearchSchema,
  formatAge,
  type ActivityEvent,
  type ActivityKind,
  type ActivitySearch,
} from '~/lib/activity-feed'
import { listAppActivity } from '~/fn/activity-feed'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { ActivityLink, OutcomeBadge } from '~/components/ActivityCells'
import { SearchInput } from '~/components/SearchInput'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatDateTime, formatInt } from '~/lib/format'

export const Route = createFileRoute('/_authed/actividad/')({
  /**
   * SSR completo (el default de `start.ts`), igual que `/usuarios` y
   * `/documentos`: es una pantalla de ENTRADA — se abre para ver qué pasó recién,
   * muchas veces como primer pintado de la sesión, y `data-only` dejaría mirando
   * el shell vacío mientras baja el bundle.
   */
  validateSearch: activitySearchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ deps, abortController }) =>
    listAppActivity({ data: deps, signal: abortController.signal }),
  head: () => ({ meta: [{ title: 'Actividad — AutoLibre' }] }),
  component: ActivityFeed,
})

/**
 * El icono es lo que hace escaneable un feed mezclado: con dieciséis tipos de
 * evento en la misma columna, la etiqueta sola obliga a leer fila por fila.
 *
 * Vive acá y no en `~/lib/activity-feed` para no meter `lucide-react` —que es
 * del cliente— en un módulo que también importa el repo del servidor.
 */
const KIND_ICONS: Record<ActivityKind, LucideIcon> = {
  alta_usuario: UserPlus,
  vehiculo: Car,
  chat: MessageSquare,
  escaneo: ScanLine,
  seguro: ShieldCheck,
  cedula: FileText,
  registro: IdCard,
  vtv: ClipboardCheck,
  mantenimiento: Wrench,
  plan_mantenimiento: Repeat,
  pedido: ReceiptText,
  consulta_multas: ReceiptText,
  consulta_datos: Search,
  dispositivo: Smartphone,
  login: LogIn,
  feedback: MessageCircle,
}

/**
 * El feed de actividad de la app.
 *
 * Reemplaza los quince `select … order by created_at desc limit 20` sueltos que
 * habría que correr —y después mergear a ojo— para contestar "¿qué está pasando
 * en la app?". En la práctica no los corre nadie, que es justamente por lo que
 * esta pantalla existe. El qué entra y qué no está en `~/lib/activity-feed`.
 */
function ActivityFeed() {
  const events = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<ActivitySearch>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  const filtered =
    Boolean(search.q) || search.activityKind !== 'all' || search.activityWindow !== 'all'

  const people = new Set(events.map((e) => e.userId).filter(Boolean)).size

  return (
    <>
      <PageHeader
        title="Actividad"
        subtitle={`${formatInt(events.length)} ${filtered ? 'con este filtro' : 'eventos'} · ${formatInt(people)} personas`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <div className="mb-4 flex flex-wrap items-end gap-5">
        <SearchInput
          label="Buscar"
          placeholder="Email, nombre, patente o detalle"
          value={search.q}
          onSearch={(q) => setSearch({ q })}
        />

        <FilterGroup label="Cuándo">
          {ACTIVITY_WINDOWS.map((w) => (
            <Chip
              key={w}
              active={search.activityWindow === w}
              onClick={() => setSearch({ activityWindow: w })}
            >
              {ACTIVITY_WINDOW_LABELS[w]}
            </Chip>
          ))}
        </FilterGroup>

        {/*
          Invertir el tiempo es lo ÚNICO que se puede reordenar, y por eso es un
          chip y no un `SortHeader`: el orden cronológico ES la pregunta de la
          pantalla. Agrupar por usuario o por tipo lo hacen los filtros, con un
          resultado más útil que un `order by`.
        */}
        <FilterGroup label="Orden">
          <Chip
            active={search.activityDir === 'desc'}
            onClick={() => setSearch({ activityDir: 'desc' })}
          >
            <ArrowDownWideNarrow className="size-3.5" aria-hidden />
            Más nuevo
          </Chip>
          <Chip
            active={search.activityDir === 'asc'}
            onClick={() => setSearch({ activityDir: 'asc' })}
          >
            <ArrowUpWideNarrow className="size-3.5" aria-hidden />
            Más viejo
          </Chip>
        </FilterGroup>
      </div>

      <div className="mb-5">
        <FilterGroup label="Tipo">
          <Chip active={search.activityKind === 'all'} onClick={() => setSearch({ activityKind: 'all' })}>
            Todo
          </Chip>
          {ACTIVITY_KINDS.map((k) => {
            const Icon = KIND_ICONS[k]
            return (
              <Chip
                key={k}
                active={search.activityKind === k}
                onClick={() => setSearch({ activityKind: k })}
              >
                <Icon className="size-3.5" aria-hidden />
                {ACTIVITY_KIND_SHORT[k]}
              </Chip>
            )
          })}
        </FilterGroup>
      </div>

      {events.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-6 py-16 text-center">
          <p className="text-sm font-medium">No pasó nada con este filtro</p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
            El feed sólo muestra lo que hizo una persona en la app. Lo que escribe
            el sistema solo —las notificaciones que mandamos, las multas que
            sincroniza el proveedor— vive en sus propias pantallas.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cuándo</TableHead>
                <TableHead>Qué hizo</TableHead>
                <TableHead>Detalle</TableHead>
                <TableHead>Resultado</TableHead>
                <TableHead>Quién</TableHead>
                <TableHead>Vehículo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e) => (
                <EventRow key={`${e.kind}-${e.id}`} event={e} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        La hora es UTC.{' '}
        {events.length === ACTIVITY_LIMIT
          ? `Cortado en ${formatInt(ACTIVITY_LIMIT)} eventos — acotá la ventana o el tipo; el feed no pagina a propósito.`
          : null}
      </p>
    </>
  )
}

function EventRow({ event: e }: { event: ActivityEvent }) {
  const Icon = KIND_ICONS[e.kind]
  const targetLabel = ACTIVITY_TARGET_LABELS[e.kind]

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap align-top">
        <div className="text-sm tabular-nums">{formatAge(e.ageMinutes)}</div>
        <div className="text-xs tabular-nums text-muted-foreground">
          {formatDateTime(e.occurredAt)}
        </div>
      </TableCell>

      {/*
        El link va en "qué hizo" y es UNO solo por fila: es el título del evento.
        Lleva a la pantalla dueña de esa entidad cuando existe (un chat abre el
        chat, un escaneo abre la sesión) y a la ficha de actividad cuando no —
        por eso el renglón de abajo DICE adónde va: con destinos que cambian
        según el tipo, adivinar no es una opción.
      */}
      <TableCell className="align-top">
        <ActivityLink
          kind={e.kind}
          id={e.id}
          userId={e.userId}
          className="group inline-flex items-start gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0">
            <span className="block text-sm font-medium group-hover:text-brand group-hover:underline">
              {ACTIVITY_KIND_LABELS[e.kind]}
            </span>
            <span className="mt-0.5 inline-flex items-center gap-0.5 text-xs text-muted-foreground">
              {targetLabel}
              <ChevronRight className="size-3" aria-hidden />
            </span>
          </span>
        </ActivityLink>
      </TableCell>

      <TableCell
        className="max-w-[320px] align-top text-sm text-muted-foreground"
        title={e.detail ?? undefined}
      >
        <span className="line-clamp-2">{e.detail ?? <span className="text-muted-foreground/50">—</span>}</span>
      </TableCell>

      <TableCell className="align-top">
        {e.outcome ? <OutcomeBadge code={e.outcome} /> : <span className="text-muted-foreground/50">—</span>}
      </TableCell>

      <TableCell className="align-top">
        {e.userId ? (
          <Link
            to="/usuarios/$userId"
            params={{ userId: e.userId }}
            className="rounded text-sm outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {e.userName ?? e.userEmail}
          </Link>
        ) : (
          /* Un pedido de web o WhatsApp no tiene cuenta. No es un dato faltante. */
          <span className="text-sm text-muted-foreground/70">anónimo</span>
        )}
        {e.userName && e.userEmail ? (
          <div className="text-xs text-muted-foreground">{e.userEmail}</div>
        ) : null}
      </TableCell>

      <TableCell className="align-top">
        {e.vehiclePlate ? (
          <>
            <div className="font-mono text-sm font-medium tracking-wide">{e.vehiclePlate}</div>
            {e.vehicleLabel ? (
              <div className="max-w-[180px] truncate text-xs text-muted-foreground" title={e.vehicleLabel}>
                {e.vehicleLabel}
              </div>
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </TableCell>
    </TableRow>
  )
}
