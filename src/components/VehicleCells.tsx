import { formatArs, formatDate, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * Celdas compartidas de las vistas por vehículo: el toggle de `/usuarios`, el
 * listado de `/vehiculos/listado` y la pestaña de multas de `/leads`.
 *
 * Vivían en `usuarios.index.tsx`. Se sacaron acá cuando el listado global las
 * necesitó idénticas: si "VTV vence en 3 días" se ve distinto en dos pantallas,
 * una está mal y no hay forma de saber cuál. Mismo criterio que `Filters.tsx` y
 * `SortHeader.tsx`.
 *
 * Todas asumen render SÓLO del lado del cliente (nacen de un click o de una
 * pantalla que no se manda por SSR), así que `new Date()` no tiene el riesgo de
 * mismatch de hidratación que tendría en una pantalla server-rendered.
 */

/**
 * Días hasta una fecha, por día calendario UTC — no por instante. `date` sin
 * hora: un vencimiento "hoy" no puede leerse como "vencido hace unas horas"
 * sólo porque ya pasó el mediodía en Argentina.
 */
export function daysUntilUtc(iso: string): number {
  const now = new Date()
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const target = new Date(iso)
  const targetUtc = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate())
  return Math.round((targetUtc - todayUtc) / 86_400_000)
}

/**
 * "Tiempo hasta vencimiento" de un documento cargado (VTV, seguro). `null` =
 * no cargado, que es distinto de vencido.
 */
export function ExpiryCell({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-muted-foreground/50">no cargado</span>

  const days = daysUntilUtc(iso)

  if (days < 0) {
    return (
      <span className="text-status-yellow" title={formatDate(iso)}>
        vencida hace {formatInt(Math.abs(days))} día{Math.abs(days) === 1 ? '' : 's'}
      </span>
    )
  }
  if (days === 0) {
    return (
      <span className="text-status-yellow" title={formatDate(iso)}>
        vence hoy
      </span>
    )
  }
  return (
    <span title={formatDate(iso)}>
      vence en {formatInt(days)} día{days === 1 ? '' : 's'}
    </span>
  )
}

/**
 * DTCs y anomalías: "lo encontrado en el evento más reciente", no un estado
 * resuelto por el dominio. Los tres valores se distinguen: `null` (gris, nunca
 * pasó) ≠ `0` (texto plano, pasó sin encontrar nada) ≠ encontró algo (ámbar).
 */
export function CountOrNeverCell({ value, title }: { value: number | null; title: string }) {
  if (value === null) {
    return (
      <span className="text-muted-foreground/50" title={`Nunca — ${title}`}>
        —
      </span>
    )
  }
  if (value === 0) return <span title={title}>0</span>
  return (
    <span className="font-medium text-status-yellow" title={title}>
      {formatInt(value)}
    </span>
  )
}

/**
 * Monto adeudado en multas. Tres estados: `null` (multas nunca consultadas) ≠
 * `$0` (consultadas, sin deuda) ≠ deuda real (ámbar, plata que el usuario
 * debe). El `$0` NO va en verde: "sin deuda hoy" es un dato, no un logro.
 */
export function FineDebtCell({ amount }: { amount: number | null }) {
  if (amount === null) {
    return (
      <span className="text-muted-foreground/50" title="Multas nunca consultadas">
        —
      </span>
    )
  }
  if (amount === 0) {
    return <span title="Consultado — sin multas pendientes">{formatArs(0)}</span>
  }
  return (
    <span className="font-medium text-status-yellow" title="Suma de multas con estado pendiente">
      {formatArs(amount)}
    </span>
  )
}

/** Un monto de pesos que puede no tener dato (deuda de patente hoy, tabla vacía). */
export function AmountOrNoneCell({ amount, title }: { amount: number | null; title: string }) {
  if (amount === null) return <span className="text-muted-foreground/50" title={title}>—</span>
  if (amount === 0) return <span title={title}>{formatArs(0)}</span>
  return (
    <span className={cn('font-medium text-status-yellow')} title={title}>
      {formatArs(amount)}
    </span>
  )
}
