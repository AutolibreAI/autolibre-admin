import { z } from 'zod'

/**
 * Liquidaciones por comercial (`/comercial/liquidaciones`) — lo que AutoLibre
 * le debe a cada comercial por los proveedores que trajo («Alta por», 035).
 * → `.claude/rules/partner-fees.md`, sección «Comisiones de los comerciales».
 *
 * Regla vigente (Nicolás, 2026-11-25), una comisión por proveedor:
 *
 * - **Primera cuota**: el proveedor se dio de alta con suscripción paga → la
 *   primera cuota completa (el precio del plan de su PRIMERA suscripción
 *   autorizada), de inmediato.
 * - **Fee del primer trabajo**: se dio de alta en el plan gratis (pago por
 *   auto) → el fee completo de su primer trabajo confirmado
 *   (`commercialFee` de `~/lib/partner-fees`), sin vencimiento.
 *
 * Si el primer trabajo es anterior a la suscripción paga, el alta fue en el
 * plan gratis: manda el fee. Si se suscribió antes de su primer trabajo,
 * manda la cuota.
 *
 * Sin imports de `~/`: lo prueba `node --test`.
 */

export const COMMISSION_KINDS = ['primera_cuota', 'fee_primer_trabajo'] as const
export type CommissionKind = (typeof COMMISSION_KINDS)[number]

export const COMMISSION_KIND_LABELS: Record<CommissionKind, string> = {
  primera_cuota: 'Primera cuota',
  fee_primer_trabajo: 'Fee del primer trabajo',
}

export const COMMISSIONS_UNAVAILABLE = 'COMMISSIONS_UNAVAILABLE'

/** Lo que trae el repo por proveedor con «Alta por». */
export interface CommissionPartnerFacts {
  partnerId: string
  partnerName: string
  member: { id: string; name: string; active: boolean }
  /** Primera suscripción autorizada (plan pago). */
  firstPaid: { planName: string; planCode: string; price: number; day: string } | null
  /** El primer trabajo confirmado si le corresponde el fee al comercial (`commercialFee` de la 038). */
  firstJob: { publicNumber: number; day: string; amount: number; feeStatus: string } | null
  /** Si ya se le pagó al comercial. */
  payment: {
    memberId: string
    memberName: string
    kind: string
    amount: number
    reference: string | null
    paidOn: string
    note: string | null
    paidByName: string | null
  } | null
}

export interface CommissionRow extends CommissionPartnerFacts {
  /** `null` = todavía no le corresponde nada (sin plan pago ni trabajo confirmado). */
  kind: CommissionKind | null
  amount: number
  reference: string | null
  /** Desde cuándo se le debe. */
  dueDay: string | null
  status: 'pagado' | 'pendiente' | 'sin_devengar'
}

export function commissionRow(f: CommissionPartnerFacts): CommissionRow {
  let kind: CommissionKind | null = null
  if (f.firstJob && (!f.firstPaid || f.firstJob.day <= f.firstPaid.day)) kind = 'fee_primer_trabajo'
  else if (f.firstPaid && f.firstPaid.price > 0) kind = 'primera_cuota'

  const computed =
    kind === 'fee_primer_trabajo'
      ? { amount: f.firstJob!.amount, reference: `AL-${f.firstJob!.publicNumber}`, dueDay: f.firstJob!.day }
      : kind === 'primera_cuota'
        ? { amount: f.firstPaid!.price, reference: f.firstPaid!.planName, dueDay: f.firstPaid!.day }
        : { amount: 0, reference: null, dueDay: null }

  // Lo pagado manda: monto y referencia congelados.
  if (f.payment) {
    return {
      ...f,
      kind: (COMMISSION_KINDS as ReadonlyArray<string>).includes(f.payment.kind) ? (f.payment.kind as CommissionKind) : kind,
      amount: f.payment.amount,
      reference: f.payment.reference,
      dueDay: computed.dueDay,
      status: 'pagado',
    }
  }
  return { ...f, kind, ...computed, status: kind ? 'pendiente' : 'sin_devengar' }
}

export interface CommissionGroup {
  member: { id: string; name: string; active: boolean }
  rows: Array<CommissionRow>
  pendingTotal: number
  pendingCount: number
  paidTotal: number
  paidCount: number
}

/** Por comercial; pendiente más grande primero. Agrupa por quién COBRÓ si ya se pagó. */
export function groupCommissions(rows: ReadonlyArray<CommissionRow>): Array<CommissionGroup> {
  const groups = new Map<string, CommissionGroup>()
  for (const r of rows) {
    const member =
      r.payment && r.payment.memberId !== r.member.id
        ? { id: r.payment.memberId, name: r.payment.memberName, active: true }
        : r.member
    const g = groups.get(member.id) ?? { member, rows: [], pendingTotal: 0, pendingCount: 0, paidTotal: 0, paidCount: 0 }
    g.rows.push(r)
    if (r.status === 'pendiente') {
      g.pendingTotal += r.amount
      g.pendingCount += 1
    } else if (r.status === 'pagado') {
      g.paidTotal += r.amount
      g.paidCount += 1
    }
    groups.set(member.id, g)
  }
  const order = { pendiente: 0, pagado: 1, sin_devengar: 2 } as const
  for (const g of groups.values())
    g.rows.sort((a, b) => order[a.status] - order[b.status] || a.partnerName.localeCompare(b.partnerName))
  return [...groups.values()].sort((a, b) => b.pendingTotal - a.pendingTotal || a.member.name.localeCompare(b.member.name))
}

export const setCommissionPaymentSchema = z.discriminatedUnion('paid', [
  z.object({
    paid: z.literal(true),
    partnerId: z.string().uuid(),
    paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida.'),
    note: z.string().trim().max(1000).optional(),
  }),
  z.object({
    paid: z.literal(false),
    partnerId: z.string().uuid(),
    note: z.string().trim().max(1000).optional(),
  }),
])
export type SetCommissionPaymentInput = z.infer<typeof setCommissionPaymentSchema>

export function readableCommissionError(raw: string): string {
  const code = raw.match(/[A-Z_]{6,}/)?.[0]
  switch (code) {
    case COMMISSIONS_UNAVAILABLE:
      return 'Falta aplicar la migración 039 (comisiones) o la 035 («Alta por») en esta base.'
    case 'COMMISSION_NOT_DUE':
      return 'A ese proveedor todavía no le corresponde comisión (o cambió el «Alta por»). Recargá.'
    case 'COMMISSION_PAID_ON_IN_FUTURE':
      return 'La fecha del pago no puede ser futura.'
    default:
      return `No se pudo guardar: ${raw}`
  }
}
