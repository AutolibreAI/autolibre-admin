import { z } from 'zod'

/**
 * Liquidaciones a comerciales (`/comercial/liquidaciones`) — el premio que
 * AutoLibre le paga a cada comercial por los proveedores que dio de alta
 * («Alta por», 035). → `.claude/rules/partner-fees.md`, «Premios».
 *
 * Regla vigente (Nicolás, 2026-11-26):
 *
 * - Cobra premio sólo quien tiene «Cobra premio» encendido en Comercial ›
 *   Equipo (`ops.team_member.earns_award`, 045). El equipo fundador no.
 *   Las altas de quien no cobra no aparecen.
 * - El premio corresponde cuando el taller tiene su PRIMER trabajo confirmado
 *   (`commercialFee` de `~/lib/partner-fees`, misma definición que
 *   Liquidaciones; cuenta aunque ese trabajo sea gratis para el taller).
 * - Monto por alta: `PREMIO_POR_ALTA` en `partner-fees-config.ts` (vacío = a
 *   definir: se ve, no se puede marcar pagado).
 * - Ya no se venden suscripciones: no hay más «primera cuota». Las altas que
 *   tuvieron suscripción van a una sección aparte, «Con suscripción
 *   (histórico)», para resolverlas a mano.
 *
 * Estados: esperando (sin primer trabajo) → pendiente → pagado / anulado
 * (con motivo). Lo guardado vive en `ops.commercial_award` (045).
 *
 * Sin imports de `~/`: lo prueba `node --test`.
 */

export const AWARD_STATUSES = ['esperando', 'pendiente', 'pagado', 'anulado'] as const
export type AwardStatus = (typeof AWARD_STATUSES)[number]

export const AWARD_STATUS_LABELS: Record<AwardStatus, string> = {
  esperando: 'Espera el primer trabajo',
  pendiente: 'Pendiente',
  pagado: 'Pagado',
  anulado: 'Anulado',
}

export const COMMISSIONS_UNAVAILABLE = 'COMMISSIONS_UNAVAILABLE'

/** Lo que trae el repo por proveedor con «Alta por». */
export interface AwardPartnerFacts {
  partnerId: string
  partnerName: string
  /** `YYYY-MM-DD` del alta del partner (Buenos Aires). */
  partnerCreatedOn: string
  member: { id: string; name: string; active: boolean; earnsAward: boolean }
  /** El primer trabajo confirmado del taller (la regla de Liquidaciones). */
  firstJob: { publicNumber: number; day: string } | null
  /** Tuvo alguna suscripción paga autorizada (régimen anterior). */
  subscription: { planName: string; day: string } | null
  /** Lo guardado en `ops.commercial_award`. */
  award: {
    memberId: string
    memberName: string
    status: 'pagado' | 'anulado'
    amount: number | null
    reference: string | null
    paidOn: string | null
    note: string | null
    voidReason: string | null
    updatedByName: string | null
  } | null
}

export interface AwardRow extends AwardPartnerFacts {
  status: AwardStatus
  /** El congelado si se pagó; si no, el de la config (`null` = a definir). */
  amount: number | null
  reference: string | null
  /** Va a la sección «Con suscripción (histórico)». */
  legacySubscription: boolean
}

export function awardRow(f: AwardPartnerFacts, premioPorAlta: number | null): AwardRow {
  const reference = f.firstJob ? `AL-${f.firstJob.publicNumber}` : null
  const base = { ...f, legacySubscription: f.subscription !== null }
  if (f.award) {
    return {
      ...base,
      status: f.award.status,
      amount: f.award.status === 'pagado' ? f.award.amount : (f.award.amount ?? premioPorAlta),
      reference: f.award.reference ?? reference,
    }
  }
  return { ...base, status: f.firstJob ? 'pendiente' : 'esperando', amount: premioPorAlta, reference }
}

/** Sólo las altas de quien cobra premio (o que ya tienen un premio guardado). */
export const awardsVisible = (r: AwardRow) => r.member.earnsAward || r.award !== null

export interface AwardGroup {
  member: { id: string; name: string; active: boolean }
  rows: Array<AwardRow>
  altas: number
  waiting: number
  pendingCount: number
  /** Suma de los pendientes con monto definido. */
  pendingTotal: number
  paidCount: number
  paidTotal: number
}

/** Por comercial; pendiente más grande primero. Agrupa por quién COBRÓ si ya se pagó. */
export function groupAwards(rows: ReadonlyArray<AwardRow>): Array<AwardGroup> {
  const groups = new Map<string, AwardGroup>()
  for (const r of rows) {
    const member =
      r.award && r.award.memberId !== r.member.id
        ? { id: r.award.memberId, name: r.award.memberName, active: true }
        : { id: r.member.id, name: r.member.name, active: r.member.active }
    const g =
      groups.get(member.id) ??
      ({ member, rows: [], altas: 0, waiting: 0, pendingCount: 0, pendingTotal: 0, paidCount: 0, paidTotal: 0 } as AwardGroup)
    g.rows.push(r)
    g.altas += 1
    if (r.status === 'esperando') g.waiting += 1
    if (r.status === 'pendiente') {
      g.pendingCount += 1
      g.pendingTotal += r.amount ?? 0
    }
    if (r.status === 'pagado') {
      g.paidCount += 1
      g.paidTotal += r.amount ?? 0
    }
    groups.set(member.id, g)
  }
  const order: Record<AwardStatus, number> = { pendiente: 0, esperando: 1, pagado: 2, anulado: 3 }
  for (const g of groups.values())
    g.rows.sort((a, b) => order[a.status] - order[b.status] || a.partnerName.localeCompare(b.partnerName))
  return [...groups.values()].sort(
    (a, b) => b.pendingCount - a.pendingCount || b.pendingTotal - a.pendingTotal || a.member.name.localeCompare(b.member.name),
  )
}

// ── CSV para la caja ─────────────────────────────────────────────────────────

export const AWARD_CSV_HEADER = ['Fecha de pago', 'Comercial', 'Proveedor', 'Primer trabajo', 'Monto', 'Nota'] as const

/** Una fila por premio pagado. */
export function awardCsvRows(rows: ReadonlyArray<AwardRow>, dayLabel: (d: string) => string): Array<Array<string | number>> {
  return rows
    .filter((r) => r.status === 'pagado' && r.award?.paidOn)
    .sort((a, b) => (a.award!.paidOn! < b.award!.paidOn! ? -1 : a.award!.paidOn! > b.award!.paidOn! ? 1 : 0))
    .map((r) => [
      dayLabel(r.award!.paidOn!),
      r.award!.memberName,
      r.partnerName,
      r.reference ?? '',
      r.amount ?? '',
      r.award!.note ?? '',
    ])
}

// ── Escrituras ───────────────────────────────────────────────────────────────

const note = z.string().trim().max(1000, 'Hasta 1000 caracteres.').optional()

export const setAwardSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('pagado'),
    partnerId: z.uuid(),
    paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida.'),
    note,
  }),
  z.object({
    status: z.literal('anulado'),
    partnerId: z.uuid(),
    voidReason: z.string().trim().min(1, 'El motivo es obligatorio.').max(1000, 'Hasta 1000 caracteres.'),
  }),
  z.object({ status: z.literal('pendiente'), partnerId: z.uuid(), note }),
])
export type SetAwardInput = z.infer<typeof setAwardSchema>

export function readableCommissionError(raw: string): string {
  const code = raw.match(/[A-Z_]{6,}/)?.[0]
  switch (code) {
    case COMMISSIONS_UNAVAILABLE:
      return 'Falta aplicar la migración 045 (premios a comerciales), la 038 o la 035 («Alta por») en esta base.'
    case 'AWARD_NOT_DUE':
      return 'A esa alta todavía no le corresponde premio (sin primer trabajo, o cambió el «Alta por»). Recargá.'
    case 'AWARD_AMOUNT_UNDEFINED':
      return 'El monto del premio por alta todavía no está definido (PREMIO_POR_ALTA en partner-fees-config).'
    case 'AWARD_PAID_ON_IN_FUTURE':
      return 'La fecha del pago no puede ser futura.'
    case 'AWARD_VOID_REASON_REQUIRED':
      return 'El motivo es obligatorio para anular.'
    default:
      return `No se pudo guardar: ${raw}`
  }
}
