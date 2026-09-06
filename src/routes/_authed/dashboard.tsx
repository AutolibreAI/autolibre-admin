import { Await, Link, createFileRoute } from '@tanstack/react-router'
import {
  AlertTriangle,
  Car,
  Handshake,
  Inbox,
  MapPinOff,
  Store,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { getOpsPulse } from '~/fn/ops'
import { getPipelineHealth } from '~/fn/partners'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { PanelSkeleton } from '~/components/Fallbacks'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { AdoptionPulse, LeadFunnel, MarketplaceHealth, OpsPulse } from '~/lib/ops'
import type { PipelineHealth } from '~/lib/partners'

export const Route = createFileRoute('/_authed/dashboard')({
  head: () => ({ meta: [{ title: 'Inicio — AutoLibre' }] }),

  /**
   * STREAMING SSR.
   *
   * El loader espera SOLO el pulso — los tres números que contestan "¿cómo va
   * el negocio?". La salud del pipeline se devuelve como promesa sin esperar:
   * Start la serializa en el documento y llega en un chunk posterior.
   *
   * Por qué ese reparto y no el inverso: el pulso son tres agregaciones sobre
   * tablas chicas; `pipelineHealth` cruza `partner_applications` con `partners`
   * y con `partner_services` tres veces. Se parte por COSTO medido, no por
   * importancia — lo caro se transmite, lo barato se espera.
   *
   * Las dos consultas arrancan en el servidor, en paralelo. No hay waterfall ni
   * un segundo viaje desde el cliente.
   */
  loader: async ({ abortController }) => {
    const signal = abortController.signal

    // La lenta primero, para que se superponga con la que sí se espera.
    const pipelinePromise = getPipelineHealth({ signal })
    const pulse = await getOpsPulse({ signal })

    return { pulse, pipelinePromise }
  },

  component: Dashboard,
})

function Dashboard() {
  const { pulse, pipelinePromise } = Route.useLoaderData()

  return (
    <>
      <PageHeader
        title="Inicio"
        subtitle="El estado del sistema en números que se pueden accionar."
        actions={<SsrTag>ssr: full + streaming</SsrTag>}
      />

      <PulseRow pulse={pulse} />

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Qué hay que arreglar</CardTitle>
            <SsrTag>streamed</SsrTag>
          </CardHeader>
          <CardContent>
            {/*
              Todo lo de arriba va en el primer flush. `Await` suspende sólo
              este subárbol: el fallback se renderiza en el servidor y se
              reemplaza cuando llega el chunk.
            */}
            <Await
              promise={pipelinePromise}
              fallback={<PanelSkeleton rows={3} label="Revisando el pipeline" />}
            >
              {(pipeline) => <ActionList pipeline={pipeline} marketplace={pulse.marketplace} />}
            </Await>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Marketplace</CardTitle>
          </CardHeader>
          <CardContent>
            <MarketplaceBreakdown marketplace={pulse.marketplace} leads={pulse.leads} />
          </CardContent>
        </Card>
      </div>
    </>
  )
}

// ── Pulso ────────────────────────────────────────────────────────────────────

function PulseRow({ pulse }: { pulse: OpsPulse }) {
  const { adoption, marketplace, leads } = pulse

  /**
   * `to` es opcional a propósito.
   *
   * Tres de las cuatro tarjetas tienen una pantalla detrás; **Vehículos no**.
   * Los autos se ven adentro de la ficha de su dueño, y no existe un listado
   * propio — así que esa tarjeta no lleva a ningún lado y no finge que sí: sin
   * `to` no recibe ni el cursor de mano ni el hover.
   *
   * La alternativa era mandarla igual a `/usuarios`, y es peor: prometería un
   * listado de vehículos que no hay. Una tarjeta que no se puede clickear es
   * una molestia; una que te lleva al lugar equivocado te hace dudar de si
   * entendiste el número.
   */
  const tiles: ReadonlyArray<PulseTile> = [
    {
      key: 'users',
      icon: Users,
      to: '/usuarios',
      value: formatInt(adoption.usersTotal),
      label: 'Usuarios reales',
      // Las cuentas internas se muestran, no se restan en silencio: la
      // diferencia entre "3 usuarios" y "3 + 2.986 internas" es la diferencia
      // entre un producto que arranca y uno que parece tener tracción.
      hint:
        adoption.usersInternal > 0
          ? `+${formatInt(adoption.usersInternal)} internas excluidas · ${formatInt(adoption.usersLast30d)} nuevos en 30 d`
          : `${formatInt(adoption.usersLast30d)} nuevos en 30 días`,
      alert: false,
    },
    {
      key: 'vehicles',
      icon: Car,
      value: formatInt(adoption.vehiclesActive),
      label: 'Vehículos activos',
      hint:
        adoption.vehiclesPerUser === null
          ? 'Sin usuarios reales todavía'
          : `${adoption.vehiclesPerUser.toFixed(1)} por usuario · ${formatInt(adoption.vehiclesLast30d)} en 30 d`,
      alert: false,
    },
    {
      key: 'partners',
      icon: Store,
      to: '/partners',
      value: formatInt(marketplace.active),
      label: 'Partners publicados',
      hint: `${formatInt(marketplace.founding)} founding · ${formatInt(marketplace.total)} en total`,
      alert: false,
    },
    {
      key: 'leads',
      icon: Handshake,
      // Directo a la pestaña con datos: `/leads` es sólo el layout y redirige acá.
      to: '/leads/talleres',
      value: formatInt(leads.won),
      label: 'Leads ganados',
      hint:
        leads.total === 0
          ? 'Todavía no hay leads'
          : `${formatInt(leads.total)} en total · ${formatInt(leads.fresh)} sin contactar`,
      // Un lead sin contactar más de 48 h es plata que se está yendo.
      alert: leads.staleUncontacted > 0,
    },
  ]

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((tile) => (
        <PulseCard key={tile.key} tile={tile} />
      ))}
    </div>
  )
}

interface PulseTile {
  key: string
  icon: LucideIcon
  /** Ausente cuando el número no tiene una pantalla detrás. Ver `tiles`. */
  to?: string
  value: string
  label: string
  hint: string
  alert: boolean
}

/**
 * Una tarjeta del pulso, clickeable sólo si tiene a dónde ir.
 *
 * El contenido es idéntico en los dos casos y vive una sola vez: duplicarlo en
 * una rama con `<Link>` y otra con `<div>` es cómo terminan divergiendo dos
 * tarjetas que deberían verse iguales.
 *
 * La versión con link agrega el borde de hover y el anillo de foco. **Ese
 * anillo no es opcional**: la tarjeta pasa a ser un destino de tabulación, y un
 * foco invisible deja a quien navega con teclado sin saber dónde está. Se pinta
 * desde el token, con `focus-visible` para que no aparezca al clickear.
 */
function PulseCard({ tile }: { tile: PulseTile }) {
  const { icon: Icon, to, value, label, hint, alert } = tile

  const base = cn(
    'block rounded-lg border p-4',
    alert ? 'border-status-yellow/30 bg-status-yellow-bg' : 'border-border bg-card',
  )

  const body = (
    <>
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
      </div>
      <div className="mt-2 font-heading text-2xl font-bold tracking-tight">{value}</div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>
    </>
  )

  if (!to) return <div className={base}>{body}</div>

  return (
    <Link
      to={to}
      className={cn(
        base,
        'transition-colors hover:border-foreground/20',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      )}
    >
      {body}
    </Link>
  )
}

// ── Lo accionable ────────────────────────────────────────────────────────────

interface ActionRow {
  key: string
  count: number
  icon: LucideIcon
  title: string
  detail: string
  to: string
}

/**
 * La lista central del panel: sólo lo que está roto y a dónde ir a arreglarlo.
 *
 * Regla de esta tarjeta: **una fila sólo aparece si su número es distinto de
 * cero.** Una lista de seis renglones que dicen "0" entrena a no leerla, y el
 * día que uno diga "3" nadie lo va a notar. Cuando no queda ninguna, la tarjeta
 * lo dice explícitamente — el vacío también es información.
 */
function ActionList({
  pipeline,
  marketplace,
}: {
  pipeline: PipelineHealth
  marketplace: MarketplaceHealth
}) {
  const rows: Array<ActionRow> = [
    {
      key: 'stuck',
      count: pipeline.stuckApplications,
      icon: AlertTriangle,
      title: 'Solicitudes trabadas',
      detail: 'Con acuerdo verbal y sin partner publicado. La invariante está rota.',
      to: '/solicitudes',
    },
    {
      key: 'invisible',
      count: pipeline.invisiblePartners,
      icon: Store,
      title: 'Partners invisibles',
      detail: 'Activos y sin un solo rubro: se listan sin filtros y desaparecen bajo cualquier chip.',
      to: '/partners',
    },
    {
      key: 'would-be-invisible',
      count: pipeline.wouldBeInvisible,
      icon: Inbox,
      title: 'Solicitudes que publicarían un partner invisible',
      detail: 'Lo declarado no resuelve a ningún rubro. Aprobarlas así repite el problema de arriba.',
      to: '/solicitudes',
    },
    {
      key: 'no-geo',
      count: marketplace.activeWithoutGeo,
      icon: MapPinOff,
      title: 'Partners sin coordenadas',
      detail: 'No se pueden ordenar por cercanía: el usuario ve uno a 400 km arriba de uno a seis cuadras.',
      to: '/partners',
    },
    {
      key: 'no-contact',
      count: marketplace.activeWithoutContact,
      icon: AlertTriangle,
      title: 'Partners sin forma de contacto',
      detail: 'Publicados sin WhatsApp, sin email y sin link. El usuario llega y no tiene cómo escribir.',
      to: '/partners',
    },
  ].filter((row) => row.count > 0)

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nada pendiente. Ni solicitudes trabadas, ni partners invisibles, ni fichas incompletas.
      </p>
    )
  }

  return (
    <ul className="space-y-2.5">
      {rows.map(({ key, count, icon: Icon, title, detail, to }) => (
        <li key={key}>
          <Link
            to={to}
            className="flex items-start gap-3 rounded-md border border-status-yellow/30 bg-status-yellow-bg p-3 transition-colors hover:border-status-yellow/60"
          >
            <Icon className="mt-0.5 size-4 shrink-0 text-status-yellow" aria-hidden />
            <div className="min-w-0">
              <div className="text-sm font-medium">
                {formatInt(count)} · {title}
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}

// ── Marketplace ──────────────────────────────────────────────────────────────

function MarketplaceBreakdown({
  marketplace,
  leads,
}: {
  marketplace: MarketplaceHealth
  leads: LeadFunnel
}) {
  return (
    <div className="space-y-5">
      <Distribution
        label="Directorio"
        rows={[
          { name: 'Publicados', value: marketplace.active },
          { name: 'Pausados', value: marketplace.paused },
          { name: 'Archivados', value: marketplace.archived },
        ]}
      />

      <Distribution
        label="Embudo de leads"
        rows={[
          { name: 'Sin contactar', value: leads.fresh },
          { name: 'Contactados', value: leads.contacted },
          { name: 'Ganados', value: leads.won },
          { name: 'Perdidos', value: leads.lost },
        ]}
        empty="Todavía ningún usuario pidió turno a un taller."
      />

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-4 text-sm">
        <Fact
          label="Origen del directorio"
          value={`${formatInt(marketplace.fromSheet)} del sheet · ${formatInt(marketplace.fromApplication)} por solicitud`}
        />
        <Fact
          label="Mediana hasta el contacto"
          value={
            leads.medianHoursToContact === null
              ? '—'
              : `${leads.medianHoursToContact.toFixed(1)} h`
          }
        />
      </dl>
    </div>
  )
}

/**
 * Barras en CSS puro, misma decisión que en Costos de IA: una librería de
 * charts para una distribución de cuatro filas trae su propia paleta y sus
 * propias sombras, que es exactamente lo que el design system prohíbe.
 */
function Distribution({
  label,
  rows,
  empty = 'Sin datos.',
}: {
  label: string
  rows: Array<{ name: string; value: number }>
  empty?: string
}) {
  const total = rows.reduce((acc, r) => acc + r.value, 0)

  return (
    <div>
      <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.name} className="grid grid-cols-[8rem_1fr_3rem] items-center gap-3">
              <span className="truncate text-sm">{row.name}</span>
              <span className="h-2.5 overflow-hidden rounded-full bg-secondary">
                <span
                  className="block h-full rounded-full bg-brand"
                  style={{ width: `${(row.value / total) * 100}%` }}
                />
              </span>
              <span className="text-right text-sm tabular-nums">{formatInt(row.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  )
}
