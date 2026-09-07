import { z } from 'zod'

/**
 * Multas — los vehículos con deuda de multas, mirados como cola de captación.
 *
 * ── Vocabulario ─────────────────────────────────────────────────────────────
 *
 * El aggregate del backend es `Fine` (`fines`). Esto NO es un `Lead`. Vive bajo
 * `/leads` como una línea de captación del panel: un auto que arrastra multas es
 * un candidato para un servicio de gestión/pago de multas.
 * → `.claude/rules/leads.md`
 *
 * ── Qué consulta reemplaza ──────────────────────────────────────────────────
 *
 * La que nadie corre porque cruza tres tablas: "de todos los autos a los que se
 * les consultaron las multas, ¿quiénes deben más, desde cuándo, y de quién son?"
 * En `/usuarios` esto ya está PERO por vehículo dentro de la ficha de UN
 * usuario. Acá es la vista transversal, ordenada por deuda.
 */

// ── Espejo del enum del backend ─────────────────────────────────────────────
//
// `fine_jurisdiction` en el schema del backend. Repetido acá para las labels y
// para rechazar un valor desconocido en el search param — mismo criterio que
// `LEAD_STATUSES` y `INSURANCE_STATUSES`.
export const FINE_JURISDICTIONS = [
  'caba',
  'pba',
  'ezeiza',
  'lanus',
  'santa_fe',
  'lomas_zamora',
  'corrientes',
  'entre_rios',
  'misiones',
] as const
export type FineJurisdiction = (typeof FINE_JURISDICTIONS)[number]

export const FINE_JURISDICTION_LABELS: Record<FineJurisdiction, string> = {
  caba: 'CABA',
  pba: 'PBA',
  ezeiza: 'Ezeiza',
  lanus: 'Lanús',
  santa_fe: 'Santa Fe',
  lomas_zamora: 'Lomas de Zamora',
  corrientes: 'Corrientes',
  entre_rios: 'Entre Ríos',
  misiones: 'Misiones',
}

/** Tolerante a un valor que el enum del backend agregue y este espejo no tenga. */
export function fineJurisdictionLabel(value: string): string {
  return (FINE_JURISDICTION_LABELS as Record<string, string>)[value] ?? value
}

// ── Orden ──────────────────────────────────────────────────────────────────
//
// El pedido fue "ordenar por todas las columnas". Cada clave mapea a una
// expresión SQL en `SORT_COLUMNS` de `fines.repo.ts` — nunca se interpola texto
// suelto en el `ORDER BY`, mismo patrón que `listUsers`.
export const FINE_SORT_KEYS = [
  'debt',
  'fineCount',
  'consultedAt',
  'oldestInfraction',
  'plate',
  'user',
  'jurisdictions',
] as const
export type FineSortKey = (typeof FINE_SORT_KEYS)[number]

export const FINE_DEBT_FILTERS = ['all', 'with', 'without'] as const
export type FineDebtFilter = (typeof FINE_DEBT_FILTERS)[number]

export const FINE_FRESHNESS_FILTERS = ['all', 'fresh', 'stale'] as const
export type FineFreshnessFilter = (typeof FINE_FRESHNESS_FILTERS)[number]

/**
 * Umbral para marcar una consulta como DESACTUALIZADA. Las multas se acumulan
 * con el tiempo (una infracción nueva no aparece hasta la próxima consulta),
 * así que un sync de hace más de un mes puede estar informando de menos.
 *
 * Es una lectura NUESTRA del reloj —igual que `stuck` en `/operacion`— y la UI
 * lo dice: no es un estado que el dominio escriba.
 */
export const FINE_STALE_AFTER_DAYS = 30

export const fineSearchSchema = z.object({
  /** Busca en patente, email y nombre del usuario. */
  q: z.string().trim().max(80).optional(),
  jurisdiction: z.enum(FINE_JURISDICTIONS).optional(),
  debt: z.enum(FINE_DEBT_FILTERS).catch('all').default('all'),
  freshness: z.enum(FINE_FRESHNESS_FILTERS).catch('all').default('all'),
  /**
   * `.catch()` en los dos: un `?sort=banana` de un favorito viejo cae al
   * default, no a una pantalla de error. Mismo criterio por campo que el resto
   * del repo.
   */
  sort: z.enum(FINE_SORT_KEYS).catch('debt').default('debt'),
  dir: z.enum(['asc', 'desc']).catch('desc').default('desc'),
})
export type FineSearch = z.infer<typeof fineSearchSchema>

// ── Tipo de salida ─────────────────────────────────────────────────────────

export interface FineDebtorRow {
  vehicleId: string
  plate: string
  archived: boolean
  brand: string
  model: string
  year: number
  userId: string
  userName: string | null
  userEmail: string
  /** `vehicle_fine_syncs.last_synced_at` — la consulta de multas más reciente de este auto. */
  consultedAt: string
  /** Días enteros desde `consultedAt` hasta hoy. Derivado en Postgres, contra un solo reloj. */
  daysSinceConsult: number
  /** Multas con `status = 'pending'`. */
  fineCount: number
  /** Suma de `amount` de las pendientes, en pesos enteros. `0` = consultado sin deuda. */
  debtAmount: number
  /** `min(infraction_date)` de las pendientes. `null` si `fineCount = 0`. */
  oldestInfraction: string | null
  /** Jurisdicciones distintas de las multas pendientes, ordenadas. Vacío si `fineCount = 0`. */
  jurisdictions: Array<string>
}
