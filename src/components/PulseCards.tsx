import { Link } from '@tanstack/react-router'
import { Car, Handshake, Store, Users, type LucideIcon } from 'lucide-react'
import { formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { OpsPulse } from '~/lib/ops'

/**
 * Las cuatro tarjetas del pulso del negocio: usuarios reales, vehículos activos,
 * partners publicados, leads ganados.
 *
 * Vivían inline en `dashboard.tsx`. Cuando `/metricas` necesitó las mismas
 * cuatro, la tentación fue copiarlas — y una tarjeta copiada no se ve mal el día
 * uno, se ve mal el día que una de las dos cambia y nadie nota que la otra quedó
 * atrás. Mismo criterio que `Filters.tsx` y `VehicleCells.tsx`: una sola
 * definición, acá.
 */

interface PulseTile {
  key: string
  icon: LucideIcon
  /** Ausente cuando el número no tiene una pantalla detrás. Ver `tiles`. */
  to?: string
  value: string
  /** Un segundo número, más chico, debajo del principal. Hoy sólo lo usa Vehículos. */
  secondary?: string
  label: string
  hint: string
  alert: boolean
}

export function PulseRow({ pulse }: { pulse: OpsPulse }) {
  const { adoption, marketplace, leads } = pulse

  /**
   * `to` sigue siendo opcional en `PulseTile` —una tarjeta sin pantalla detrás
   * no debe fingir que la tiene— pero hoy las cuatro linkean: Vehículos pasó a
   * tener listado propio (`/vehiculos/listado`), así que ya no hace falta la
   * tarjeta muerta que esta nota describía.
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
      to: '/vehiculos/listado',
      value: formatInt(adoption.vehiclesActive),
      // El crudo cuenta dos veces un auto que cargaron dos usuarios. El número
      // chico es la flota real, deduplicada por patente.
      secondary: `${formatInt(adoption.vehiclesUnique)} únicos por patente`,
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
      // Directo a la pestaña con la tabla; `/partners` es sólo el layout y redirige.
      to: '/partners/listado',
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
  const { icon: Icon, to, value, secondary, label, hint, alert } = tile

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
      {secondary ? (
        <div className="mt-0.5 text-sm text-muted-foreground tabular-nums">{secondary}</div>
      ) : null}
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
