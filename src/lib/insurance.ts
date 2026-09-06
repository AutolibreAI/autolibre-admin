import { z } from 'zod'

/**
 * Seguros — las pólizas que los usuarios cargaron en la app, miradas desde la
 * pregunta "¿a quién se le está por vencer?".
 *
 * ── Ojo con el vocabulario ──────────────────────────────────────────────────
 *
 * `Insurance` es un aggregate de `vehicle-management` en el backend, NO un
 * `Lead`. Esta pantalla vive bajo `/leads` porque ofrecer alternativas de
 * seguro es una de las líneas de captación del panel, y la lista de pólizas por
 * vencer ES la cola de oportunidades de esa línea. La pestaña se llama
 * "Seguros"; el código dice `Insurance`, que es como se llama del otro lado.
 * → `.claude/rules/leads.md`
 *
 * ── Qué consulta reemplaza ──────────────────────────────────────────────────
 *
 * El `select … from insurances where expiration_date < now() + interval '30
 * days'` que hoy nadie corre sistemáticamente. Sin esto, "avisale al usuario
 * que se le vence el seguro" depende de que alguien se acuerde de mirar.
 */

// ── Espejo del enum del backend ─────────────────────────────────────────────
//
// `document_status` en el schema del backend. Repetido acá para las labels y
// para poder rechazar un valor desconocido antes de renderizar una fila en
// blanco — mismo criterio que `LEAD_STATUSES` en `~/lib/leads`.
export const INSURANCE_STATUSES = ['active', 'pending_renewal', 'expired'] as const
export type InsuranceStatus = (typeof INSURANCE_STATUSES)[number]

export const INSURANCE_STATUS_LABELS: Record<InsuranceStatus, string> = {
  active: 'Vigente',
  pending_renewal: 'En renovación',
  expired: 'Vencido',
}

/**
 * La label, tolerante a un valor que el enum del backend agregue y este espejo
 * todavía no tenga: lo muestra crudo en vez de romper. Mismo patrón defensivo
 * que `mapCensus` en `~/lib/users`.
 */
export function insuranceStatusLabel(status: string): string {
  return (INSURANCE_STATUS_LABELS as Record<string, string>)[status] ?? status
}

// ── Ventana ────────────────────────────────────────────────────────────────

export const INSURANCE_WINDOWS = ['30d', '60d', '90d', 'all'] as const
export type InsuranceWindow = (typeof INSURANCE_WINDOWS)[number]

export const INSURANCE_WINDOW_LABELS: Record<InsuranceWindow, string> = {
  '30d': 'Vencen en 30 días',
  '60d': '60 días',
  '90d': '90 días',
  all: 'Todas',
}

/**
 * Días de la ventana, o `null` para "sin tope". El repo lo pasa como parámetro
 * a `make_interval` — nunca interpolado, mismo criterio que los umbrales de
 * `ops-metrics.md`.
 */
export const INSURANCE_WINDOW_DAYS: Record<InsuranceWindow, number | null> = {
  '30d': 30,
  '60d': 60,
  '90d': 90,
  all: null,
}

export const insuranceSearchSchema = z.object({
  /**
   * `.catch('30d')`: un `?within=banana` guardado en un favorito abre la
   * ventana por default, no una pantalla de error. Mismo criterio por campo que
   * `opsSearchSchema.window`.
   */
  within: z.enum(INSURANCE_WINDOWS).catch('30d').default('30d'),
})
export type InsuranceSearch = z.infer<typeof insuranceSearchSchema>

// ── Tipos de salida ────────────────────────────────────────────────────────

export interface ExpiringInsurance {
  id: string
  /** Texto libre y sucio: "SANCOR SEGUROS" / "Sancor" / "Sancor Seguros" conviven. Se muestra crudo. */
  insurer: string
  policyNumber: string
  /** Texto libre del backend, y a veces vacío. La UI lo muestra crudo o "—". */
  coverageType: string | null
  issueDate: string | null
  expirationDate: string
  /**
   * Días hasta el vencimiento, con signo: negativo = ya venció. Se calcula de
   * `expiration_date`, NUNCA de `status` — ver el repo.
   */
  daysToExpiry: number
  status: InsuranceStatus
  insuredName: string | null
  /** La patente de la póliza; si viene vacía, la del vehículo asociado. */
  plate: string | null
  vin: string | null
  engineNumber: string | null
  /** Si tiene un PDF cargado. No se ofrece descarga: `GET /files/:id/url` está acotado al dueño. */
  hasPdf: boolean
  createdAt: string
  userId: string
  userName: string | null
  userEmail: string | null
  vehicleId: string
  vehicleAlias: string | null
}

export interface InsuranceSummary {
  /** Ya vencidas y sin archivar. */
  expired: number
  /** Vencen en los próximos 30 días (sin contar las ya vencidas). */
  next30: number
  /** Vencen entre 31 y 90 días. */
  next90: number
  /** Total de pólizas vivas (no archivadas). */
  live: number
}
