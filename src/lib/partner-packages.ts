import { z } from 'zod'
import { PARTNER_FEE_CONFIG } from '~/lib/partner-fees-config'

/**
 * Paquetes de trabajos (migración 044) — el proveedor paga por adelantado N
 * trabajos con vigencia. → `.claude/rules/partner-fees.md`, «Paquetes».
 *
 * Regla de cada trabajo confirmado (la aplica `classifyFeeJobs`):
 *   1. primer trabajo del proveedor → gratis;
 *   2. paquete vigente a la fecha del trabajo, con saldo → el que vence primero;
 *   3. si no, fee por trabajo.
 *
 * - **Saldo** = trabajos − imputados (guardados + propuestos por la regla).
 * - **Vigente** el día D: no anulado y `compra ≤ D ≤ vence`.
 * - Un paquete vencido con saldo queda «Vencido con X sin usar»: el saldo NO
 *   se traslada.
 * - Una imputación GUARDADA manda. Una DESHECHA (y no reabierta) saca el
 *   trabajo de la regla automática: va a fee.
 *
 * Lo prueba `node --test` (`tests/partner-fees.test.ts`, con el hook de `~/`).
 */

export const PACKAGE_STATUSES = ['vigente', 'agotado', 'vencido', 'anulado'] as const
export type PackageStatus = (typeof PACKAGE_STATUSES)[number]

export const PACKAGE_STATUS_LABELS: Record<PackageStatus, string> = {
  vigente: 'Vigente',
  agotado: 'Agotado',
  vencido: 'Vencido',
  anulado: 'Anulado',
}

export const PARTNER_PACKAGES_UNAVAILABLE = 'PARTNER_PACKAGES_UNAVAILABLE'

export interface PartnerPackage {
  id: string
  partnerId: string
  jobs: number
  validityDays: number
  /** `YYYY-MM-DD`. */
  purchasedOn: string
  /** `YYYY-MM-DD` = compra + vigencia. Vigente hasta ese día inclusive. */
  expiresOn: string
  pricePaid: number
  paymentMethod: string
  note: string | null
  createdByName: string | null
  createdAt: string
  voidedAt: string | null
  voidReason: string | null
  voidedByName: string | null
}

export interface PackageAllocation {
  id: string
  quoteRequestId: string
  packageId: string
  createdAt: string
  createdByName: string | null
  undoneAt: string | null
  undoReason: string | null
  undoneByName: string | null
  reopenedAt: string | null
}

export interface PackagesData {
  packages: Array<PartnerPackage>
  allocations: Array<PackageAllocation>
}

/** Días entre dos `YYYY-MM-DD` (b − a). Aritmética UTC: igual en servidor y cliente. */
export function dayDiff(a: string, b: string): number {
  const ms = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)))
  return Math.round((ms(b) - ms(a)) / 86_400_000)
}

/** `YYYY-MM-DD` + n días. */
export function addDays(d: string, n: number): string {
  const t = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) + n * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

export const isPackageValidOn = (p: PartnerPackage, day: string) =>
  p.voidedAt === null && p.purchasedOn <= day && day <= p.expiresOn

export function packageStatus(p: PartnerPackage, used: number, today: string): PackageStatus {
  if (p.voidedAt !== null) return 'anulado'
  if (used >= p.jobs) return 'agotado'
  if (today > p.expiresOn) return 'vencido'
  return 'vigente'
}

/** Vigente, con saldo, y vence dentro de `days` días (inclusive). */
export function isExpiringSoon(
  p: PartnerPackage,
  used: number,
  today: string,
  days: number = PARTNER_FEE_CONFIG.PAQUETE_POR_VENCER_DIAS,
): boolean {
  return packageStatus(p, used, today) === 'vigente' && dayDiff(today, p.expiresOn) <= days
}

/** El orden de consumo: el que vence primero; empate, el más viejo. */
export const byExpiry = (a: PartnerPackage, b: PartnerPackage) =>
  a.expiresOn === b.expiresOn
    ? a.purchasedOn === b.purchasedOn
      ? a.id.localeCompare(b.id)
      : a.purchasedOn < b.purchasedOn
        ? -1
        : 1
    : a.expiresOn < b.expiresOn
      ? -1
      : 1

/** Lo que trae un trabajo para la regla de paquetes. */
export interface PackageJobInput {
  quoteRequestId: string
  partnerId: string
  jobDay: string
  /** `false` si ya tiene otra exclusión (gratis, antes de inicio) o ya se avisó/cobró. */
  eligible: boolean
}

export interface PackageDecision {
  packageId: string
  /** `true` = imputación guardada en `ops`; `false` = la propone la regla. */
  persisted: boolean
}

export interface PackageRuleResult {
  /** Por trabajo: a qué paquete va (si va). */
  byJob: Map<string, PackageDecision>
  /** Trabajos con una imputación deshecha y no reabierta: no van a paquete. */
  blocked: Map<string, PackageAllocation>
  /** Por paquete: guardados y propuestos. */
  usage: Map<string, { persisted: number; provisional: number }>
}

/**
 * Imputa trabajos a paquetes. `jobs` en orden cronológico (se respeta). Las
 * guardadas se cuentan primero; después cada trabajo elegible toma el paquete
 * vigente a su fecha, con saldo, que vence primero.
 */
export function allocatePackages(
  jobs: ReadonlyArray<PackageJobInput>,
  data: PackagesData,
): PackageRuleResult {
  const byJob = new Map<string, PackageDecision>()
  const blocked = new Map<string, PackageAllocation>()
  const usage = new Map<string, { persisted: number; provisional: number }>()
  for (const p of data.packages) usage.set(p.id, { persisted: 0, provisional: 0 })

  const active = new Map<string, PackageAllocation>()
  for (const a of data.allocations) {
    if (a.undoneAt === null) active.set(a.quoteRequestId, a)
  }
  for (const a of data.allocations) {
    if (a.undoneAt !== null && a.reopenedAt === null && !active.has(a.quoteRequestId)) {
      const prev = blocked.get(a.quoteRequestId)
      if (!prev || (prev.undoneAt ?? '') < a.undoneAt) blocked.set(a.quoteRequestId, a)
    }
  }
  for (const a of active.values()) {
    byJob.set(a.quoteRequestId, { packageId: a.packageId, persisted: true })
    const u = usage.get(a.packageId)
    if (u) u.persisted += 1
  }

  const byPartner = new Map<string, Array<PartnerPackage>>()
  for (const p of data.packages) {
    if (p.voidedAt !== null) continue
    const list = byPartner.get(p.partnerId) ?? []
    list.push(p)
    byPartner.set(p.partnerId, list)
  }
  for (const list of byPartner.values()) list.sort(byExpiry)

  for (const j of jobs) {
    if (!j.eligible || byJob.has(j.quoteRequestId) || blocked.has(j.quoteRequestId)) continue
    for (const p of byPartner.get(j.partnerId) ?? []) {
      if (!isPackageValidOn(p, j.jobDay)) continue
      const u = usage.get(p.id)!
      if (u.persisted + u.provisional >= p.jobs) continue
      u.provisional += 1
      byJob.set(j.quoteRequestId, { packageId: p.id, persisted: false })
      break
    }
  }
  return { byJob, blocked, usage }
}

export interface PackageRow extends PartnerPackage {
  partnerName: string
  used: number
  usedPersisted: number
  balance: number
  status: PackageStatus
  expiringSoon: boolean
  /** Días hasta el vencimiento (negativo = ya venció). */
  daysLeft: number
}

export function packageRows(
  data: PackagesData,
  usage: ReadonlyMap<string, { persisted: number; provisional: number }>,
  partnerName: (id: string) => string,
  today: string,
): Array<PackageRow> {
  return data.packages.map((p) => {
    const u = usage.get(p.id) ?? { persisted: 0, provisional: 0 }
    const used = u.persisted + u.provisional
    return {
      ...p,
      partnerName: partnerName(p.partnerId),
      used,
      usedPersisted: u.persisted,
      balance: Math.max(p.jobs - used, 0),
      status: packageStatus(p, used, today),
      expiringSoon: isExpiringSoon(p, used, today),
      daysLeft: dayDiff(today, p.expiresOn),
    }
  })
}

/** «Vencido con 2 sin usar» / «Vigente · 3 de 5» … */
export function packageStatusText(r: Pick<PackageRow, 'status' | 'balance' | 'jobs'>): string {
  switch (r.status) {
    case 'vencido':
      return r.balance > 0 ? `Vencido con ${r.balance} sin usar` : 'Vencido'
    case 'agotado':
      return 'Agotado'
    case 'anulado':
      return 'Anulado'
    default:
      return `Vigente · saldo ${r.balance} de ${r.jobs}`
  }
}

// ── CSV para la caja ─────────────────────────────────────────────────────────

export const PACKAGE_CSV_HEADER = [
  'Fecha de compra',
  'Proveedor',
  'Trabajos',
  'Usados',
  'Saldo',
  'Vence',
  'Estado',
  'Monto',
  'Medio',
  'Nota',
] as const

export function packageCsvRows(
  rows: ReadonlyArray<PackageRow>,
  methodLabel: (m: string) => string,
  dayLabel: (d: string) => string,
): Array<Array<string | number>> {
  return [...rows]
    .sort((a, b) => (a.purchasedOn === b.purchasedOn ? a.partnerName.localeCompare(b.partnerName) : a.purchasedOn < b.purchasedOn ? -1 : 1))
    .map((r) => [
      dayLabel(r.purchasedOn),
      r.partnerName,
      r.jobs,
      r.used,
      r.balance,
      dayLabel(r.expiresOn),
      packageStatusText(r),
      r.pricePaid,
      methodLabel(r.paymentMethod),
      r.status === 'anulado' ? `Anulado: ${r.voidReason ?? ''}` : (r.note ?? ''),
    ])
}

// ── Escrituras ───────────────────────────────────────────────────────────────

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida.')
const note = z.string().trim().max(1000, 'Hasta 1000 caracteres.').optional()

export const createPackageSchema = z.object({
  partnerId: z.uuid(),
  jobs: z.coerce.number().int().min(1, 'Al menos 1 trabajo.').max(100, 'Hasta 100.'),
  validityDays: z.coerce.number().int().min(1, 'Al menos 1 día.').max(3650, 'Hasta 3650 días.'),
  purchasedOn: ymd,
  pricePaid: z.coerce.number().min(0, 'No puede ser negativo.').max(9_999_999_999, 'Demasiado grande.'),
  paymentMethod: z.enum(['mercado_pago', 'transferencia', 'efectivo']),
  note,
})
export type CreatePackageInput = z.infer<typeof createPackageSchema>

export const setPackagePriceSchema = z.object({
  packageId: z.uuid(),
  pricePaid: z.coerce.number().min(0, 'No puede ser negativo.').max(9_999_999_999, 'Demasiado grande.'),
  reason: z.string().trim().max(1000, 'Hasta 1000 caracteres.').optional(),
})

export const voidPackageSchema = z.object({
  packageId: z.uuid(),
  reason: z.string().trim().min(1, 'El motivo es obligatorio.').max(1000, 'Hasta 1000 caracteres.'),
})

/** Guardar las imputaciones que propone la regla (de un proveedor, o una sola). */
export const persistAllocationsSchema = z.object({
  quoteRequestIds: z.array(z.uuid()).min(1).max(200),
})

export const undoAllocationSchema = z.object({
  quoteRequestId: z.uuid(),
  reason: z.string().trim().min(1, 'El motivo es obligatorio.').max(1000, 'Hasta 1000 caracteres.'),
})

export const reopenAllocationSchema = z.object({ quoteRequestId: z.uuid() })

export function readablePackageError(raw: string): string {
  const code = raw.match(/[A-Z_]{6,}/)?.[0]
  switch (code) {
    case PARTNER_PACKAGES_UNAVAILABLE:
      return 'Falta aplicar la migración 044 (paquetes de trabajos) en esta base.'
    case 'PARTNER_NOT_FOUND':
      return 'Ese proveedor ya no existe. Recargá.'
    case 'PACKAGE_NOT_FOUND':
      return 'Ese paquete ya no existe. Recargá.'
    case 'PACKAGE_VOIDED':
      return 'Ese paquete está anulado.'
    case 'PACKAGE_EXHAUSTED':
      return 'El paquete ya no tiene saldo. Recargá.'
    case 'PACKAGE_HAS_ALLOCATIONS':
      return 'El paquete tiene trabajos imputados: deshacé esas imputaciones antes de anularlo.'
    case 'PACKAGE_PURCHASED_ON_IN_FUTURE':
      return 'La fecha de compra no puede ser futura.'
    case 'PACKAGE_VOID_REASON_REQUIRED':
    case 'ALLOCATION_UNDO_REASON_REQUIRED':
      return 'El motivo es obligatorio.'
    case 'JOB_ALREADY_ALLOCATED':
      return 'Ese trabajo ya está imputado a otro paquete. Recargá.'
    case 'ALLOCATION_NOT_DUE':
      return 'La regla ya no imputa ese trabajo a un paquete (cambió el resultado, la fecha o el saldo). Recargá.'
    case 'INVALID_PAYMENT_METHOD':
      return 'Elegí el medio de pago.'
    case 'QUOTE_REQUEST_NOT_FOUND':
      return 'Ese pedido ya no existe. Recargá.'
    default:
      return `No se pudo guardar: ${raw}`
  }
}
