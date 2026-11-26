import { z } from 'zod'
import { PARTNER_FEE_CONFIG, type PartnerFeeConfig } from '~/lib/partner-fees-config'
import { allocatePackages, type PackageAllocation, type PackagesData } from '~/lib/partner-packages'

/**
 * Liquidaciones a proveedores (`/partners/liquidaciones`) — el fee que el
 * proveedor le paga a AutoLibre por cada trabajo confirmado que le llegó por
 * nosotros. → `.claude/rules/partner-fees.md`
 *
 * Este archivo es la REGLA: qué trabajo es liquidable, cuánto paga, cuál es
 * el primer trabajo de cada taller (el fee del comercial), el mensaje de cobro
 * y el CSV. Todo determinístico y sin leer nada; el repo trae los hechos.
 *
 * ── Qué es un trabajo confirmado ──────────────────────────────────────────
 *
 * `outcome = 'hired'` (lo cargó el equipo) o `user_outcome = 'hired'` (lo
 * declaró la persona, o el equipo en su nombre). Sin duplicados/pruebas ni
 * pedidos de cuentas internas: eso lo filtra el SQL, con los mismos
 * predicados que el resto del panel.
 *
 * - **En disputa**: un lado dice `hired` y el otro `not_hired`. No se
 *   liquida: va a su pestaña y lo resuelve una persona (decidido el
 *   2026-11-25).
 * - **Sin atribuir**: confirmado y sin proveedor. El proveedor sale de la
 *   propuesta elegida (`selected_proposal_id`) y, si no hay, de la
 *   atribución parche de `ops.partner_fee_attribution` (038).
 * - **Liquidable**: el resto. Su estado de cobro es la fila de
 *   `ops.partner_fee_charge`, o `pendiente` si no hay fila.
 *
 * ── Cuánto se cobra (modelo del 2026-11-26, sin suscripciones) ────────────
 *
 * Para cada liquidable pendiente, en este orden:
 *   1. el PRIMER trabajo confirmado del proveedor → «Gratis (primer trabajo)»;
 *   2. un paquete vigente a la fecha del trabajo, con saldo → «Cubierto por
 *      paquete», el que vence primero (`~/lib/partner-packages`);
 *   3. si no, el fee por trabajo.
 * La opción de no cobrar a quien tenía plan pago se sacó: ya no se venden
 * suscripciones.
 */

export const FEE_STATUSES = ['pendiente', 'avisado', 'cobrado', 'anulado'] as const
export type FeeStatus = (typeof FEE_STATUSES)[number]

export const FEE_STATUS_LABELS: Record<FeeStatus, string> = {
  pendiente: 'Pendiente',
  avisado: 'Avisado',
  cobrado: 'Cobrado',
  anulado: 'Anulado',
}

export const PAYMENT_METHODS = ['mercado_pago', 'transferencia', 'efectivo'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  mercado_pago: 'Mercado Pago',
  transferencia: 'Transferencia',
  efectivo: 'Efectivo',
}

export const paymentMethodLabel = (m: string | null) =>
  m === null ? '—' : ((PAYMENT_METHOD_LABELS as Record<string, string>)[m] ?? m)

/** Sentinela de la pantalla cuando falta la 038. */
export const PARTNER_FEES_UNAVAILABLE = 'PARTNER_FEES_UNAVAILABLE'

// ── Los hechos que trae el repo ─────────────────────────────────────────────

export interface FeeProposal {
  partnerId: string | null
  name: string
  amountMin: number | null
  amountMax: number | null
  withdrawn: boolean
}

export interface FeeAttribution {
  partnerId: string
  partnerName: string | null
  note: string | null
  byName: string | null
  at: string
}

export interface FeeCharge {
  partnerId: string
  status: FeeStatus
  amount: number | null
  notifiedAt: string | null
  paidOn: string | null
  paymentMethod: string | null
  note: string | null
  voidReason: string | null
  updatedByName: string | null
  updatedAt: string
}

export interface FeeJobFacts {
  quoteRequestId: string
  publicNumber: number
  createdAt: string
  /** Día del trabajo, `YYYY-MM-DD` en Buenos Aires: el que declaró la persona; si no, el del cierre; si no, el del pedido. */
  jobDay: string
  jobDaySource: 'performed_on' | 'closed_at' | 'created_at'
  outcome: string | null
  userOutcome: string | null
  outcomeNote: string | null
  closedReason: string | null
  internalNotes: string | null
  vehicleLabel: string | null
  services: Array<string>
  selectedPartnerId: string | null
  selectedPartnerName: string | null
  attribution: FeeAttribution | null
  proposals: Array<FeeProposal>
  charge: FeeCharge | null
}

export interface FeePartnerFacts {
  id: string
  name: string
  whatsapp: string | null
  tier: string | null
  /** «Alta por» de su solicitud (035). */
  sourcer: { memberId: string; name: string; active: boolean } | null
}

// ── La clasificación ─────────────────────────────────────────────────────────

export type FeeJobKind = 'disputa' | 'sin_atribuir' | 'liquidable'

export type FeeExclusion = 'antes_de_inicio' | 'primer_trabajo' | 'paquete'

export const FEE_EXCLUSION_LABELS: Record<FeeExclusion, string> = {
  antes_de_inicio: 'Anterior a la fecha de inicio del cobro',
  primer_trabajo: 'Gratis (primer trabajo)',
  paquete: 'Cubierto por paquete',
}

export interface FeeJob extends FeeJobFacts {
  kind: FeeJobKind
  /** El proveedor que se cobra (`null` si no está atribuido). */
  partnerId: string | null
  partnerSource: 'selected' | 'attribution' | null
  /** La propuesta elegida y la atribución parche dicen proveedores distintos (manda la elegida). */
  attributionMismatch: boolean
  /** El cobro ya guardado es de OTRO proveedor que el atribuido hoy. */
  chargePartnerMismatch: boolean
  status: FeeStatus
  /** Por qué no se cobra según la config (sólo `pendiente`; lo ya avisado/cobrado no se recalcula). */
  exclusion: FeeExclusion | null
  /** El monto: el congelado si ya se avisó/cobró, si no el de la config. `0` si está excluido. */
  amount: number
  /** Monto de la propuesta del proveedor en este pedido, si la hubo. */
  proposalAmount: { min: number | null; max: number | null } | null
  /** Es el primer trabajo confirmado del taller y lo trajo un comercial («Alta por»): genera su premio. */
  commercialFee: { memberId: string; name: string } | null
  /** Es el primer trabajo confirmado (no anulado) de su proveedor. */
  isFirstOfPartner: boolean
  /** A qué paquete va (sólo con `exclusion = 'paquete'`). `persisted` = guardada en `ops`. */
  packageAllocation: { packageId: string; persisted: boolean } | null
  /** Imputación deshecha y no reabierta: no va a paquete aunque haya saldo. */
  allocationUndone: PackageAllocation | null
}

export function isDispute(outcome: string | null, userOutcome: string | null): boolean {
  return (
    (outcome === 'hired' && userOutcome === 'not_hired') ||
    (userOutcome === 'hired' && outcome === 'not_hired')
  )
}

const byJobOrder = (a: FeeJobFacts, b: FeeJobFacts) =>
  a.jobDay === b.jobDay ? a.publicNumber - b.publicNumber : a.jobDay < b.jobDay ? -1 : 1

/**
 * Clasifica TODOS los trabajos juntos (el primero de cada taller depende de
 * los demás). El orden de la salida es el de la entrada.
 */
export function classifyFeeJobs(
  facts: ReadonlyArray<FeeJobFacts>,
  partners: ReadonlyMap<string, FeePartnerFacts>,
  config: PartnerFeeConfig = PARTNER_FEE_CONFIG,
  packages: PackagesData | null = null,
): Array<FeeJob> {
  const base = facts.map((f) => {
    const partnerId = f.selectedPartnerId ?? f.attribution?.partnerId ?? null
    const partnerSource: FeeJob['partnerSource'] = f.selectedPartnerId
      ? 'selected'
      : f.attribution
        ? 'attribution'
        : null
    const kind: FeeJobKind = isDispute(f.outcome, f.userOutcome)
      ? 'disputa'
      : partnerId === null
        ? 'sin_atribuir'
        : 'liquidable'
    return { f, partnerId, partnerSource, kind }
  })

  // El primer trabajo de cada taller: entre los liquidables no anulados, por día.
  const firstByPartner = new Map<string, string>()
  for (const { f, partnerId } of [...base]
    .filter((b) => b.kind === 'liquidable' && b.f.charge?.status !== 'anulado')
    .sort((a, b) => byJobOrder(a.f, b.f))) {
    if (partnerId && !firstByPartner.has(partnerId)) firstByPartner.set(partnerId, f.quoteRequestId)
  }

  // Primero las exclusiones que no dependen de paquetes, para saber qué
  // trabajos quedan elegibles para la regla de paquetes.
  const pre = base.map(({ f, partnerId, partnerSource, kind }) => {
    const status: FeeStatus = f.charge?.status ?? 'pendiente'
    const isFirst = partnerId !== null && firstByPartner.get(partnerId) === f.quoteRequestId
    let exclusion: FeeExclusion | null = null
    if (kind === 'liquidable' && status === 'pendiente') {
      if (config.FECHA_INICIO && f.jobDay < config.FECHA_INICIO) exclusion = 'antes_de_inicio'
      else if (config.PRIMER_TRABAJO_GRATIS && isFirst) exclusion = 'primer_trabajo'
    }
    return { f, partnerId, partnerSource, kind, status, isFirst, exclusion }
  })

  // Paquetes: en orden cronológico, sólo liquidables pendientes sin otra exclusión.
  const rule = packages
    ? allocatePackages(
        [...pre]
          .filter((x) => x.kind === 'liquidable' && x.partnerId !== null)
          .sort((a, b) => byJobOrder(a.f, b.f))
          .map((x) => ({
            quoteRequestId: x.f.quoteRequestId,
            partnerId: x.partnerId!,
            jobDay: x.f.jobDay,
            eligible: x.status === 'pendiente' && x.exclusion === null,
          })),
        packages,
      )
    : null

  return pre.map(({ f, partnerId, partnerSource, kind, status, isFirst, exclusion: pre }) => {
    let exclusion: FeeExclusion | null = pre
    const decision = rule?.byJob.get(f.quoteRequestId) ?? null
    // Una imputación GUARDADA manda aunque el trabajo sea el primero; una
    // propuesta sólo se aplica a un pendiente sin otra exclusión.
    const packageAllocation =
      kind === 'liquidable' && status === 'pendiente' && decision && (decision.persisted || exclusion === null)
        ? decision
        : null
    if (packageAllocation) exclusion = 'paquete'

    const amount =
      f.charge?.amount ?? (exclusion !== null || kind !== 'liquidable' ? 0 : config.FEE_POR_TRABAJO)

    const proposal = partnerId
      ? (f.proposals.find((p) => p.partnerId === partnerId && !p.withdrawn) ??
        f.proposals.find((p) => p.partnerId === partnerId) ??
        null)
      : null

    // El premio del comercial: el primer trabajo confirmado del taller (aunque
    // sea gratis para el taller), si tiene «Alta por».
    const sourcer = partnerId ? (partners.get(partnerId)?.sourcer ?? null) : null
    const commercialFee =
      kind === 'liquidable' && isFirst && sourcer ? { memberId: sourcer.memberId, name: sourcer.name } : null

    return {
      ...f,
      kind,
      partnerId,
      partnerSource,
      attributionMismatch:
        f.selectedPartnerId !== null && f.attribution !== null && f.attribution.partnerId !== f.selectedPartnerId,
      chargePartnerMismatch: f.charge !== null && partnerId !== null && f.charge.partnerId !== partnerId,
      status,
      exclusion,
      amount,
      proposalAmount: proposal ? { min: proposal.amountMin, max: proposal.amountMax } : null,
      commercialFee,
      isFirstOfPartner: isFirst,
      packageAllocation,
      allocationUndone: rule?.blocked.get(f.quoteRequestId) ?? null,
    }
  })
}

// ── Agrupado por proveedor ──────────────────────────────────────────────────

export interface FeePartnerGroup {
  partner: FeePartnerFacts
  jobs: Array<FeeJob>
  /** Pendientes cobrables (sin exclusión). */
  pendingCount: number
  pendingTotal: number
  notifiedCount: number
  notifiedTotal: number
  /** Día del trabajo más viejo entre los pendientes y avisados. */
  oldestOpenDay: string | null
}

/** Sólo liquidables con algo abierto (pendiente cobrable o avisado). Más deuda primero. */
export function groupOpenByPartner(
  jobs: ReadonlyArray<FeeJob>,
  partners: ReadonlyMap<string, FeePartnerFacts>,
): Array<FeePartnerGroup> {
  const groups = new Map<string, FeePartnerGroup>()
  for (const j of jobs) {
    if (j.kind !== 'liquidable' || !j.partnerId) continue
    const open = (j.status === 'pendiente' && j.exclusion === null) || j.status === 'avisado'
    const excludedPending = j.status === 'pendiente' && j.exclusion !== null
    if (!open && !excludedPending) continue
    const partner = partners.get(j.partnerId) ?? {
      id: j.partnerId,
      name: 'Proveedor borrado',
      whatsapp: null,
      tier: null,
      sourcer: null,
    }
    const g =
      groups.get(j.partnerId) ??
      ({ partner, jobs: [], pendingCount: 0, pendingTotal: 0, notifiedCount: 0, notifiedTotal: 0, oldestOpenDay: null } as FeePartnerGroup)
    g.jobs.push(j)
    if (j.status === 'pendiente' && j.exclusion === null) {
      g.pendingCount += 1
      g.pendingTotal += j.amount
    }
    if (j.status === 'avisado') {
      g.notifiedCount += 1
      g.notifiedTotal += j.amount
    }
    if (open && (g.oldestOpenDay === null || j.jobDay < g.oldestOpenDay)) g.oldestOpenDay = j.jobDay
    groups.set(j.partnerId, g)
  }
  for (const g of groups.values()) g.jobs.sort(byJobOrder)
  return [...groups.values()]
    .filter((g) => g.pendingCount + g.notifiedCount > 0 || g.jobs.length > 0)
    .sort((a, b) => b.pendingTotal + b.notifiedTotal - (a.pendingTotal + a.notifiedTotal) || a.partner.name.localeCompare(b.partner.name))
}

// ── Resumen ─────────────────────────────────────────────────────────────────

export interface FeeSummary {
  pendingTotal: number
  pendingCount: number
  notifiedTotal: number
  notifiedCount: number
  paidThisMonthTotal: number
  paidThisMonthCount: number
  unattributed: number
  disputes: number
}

/** `monthKey` = `YYYY-MM` de hoy en Buenos Aires, calculado en el SERVIDOR (la pantalla es SSR). */
export function feeSummary(jobs: ReadonlyArray<FeeJob>, monthKey: string): FeeSummary {
  const s: FeeSummary = {
    pendingTotal: 0,
    pendingCount: 0,
    notifiedTotal: 0,
    notifiedCount: 0,
    paidThisMonthTotal: 0,
    paidThisMonthCount: 0,
    unattributed: 0,
    disputes: 0,
  }
  for (const j of jobs) {
    if (j.kind === 'sin_atribuir') s.unattributed += 1
    else if (j.kind === 'disputa') s.disputes += 1
    else if (j.status === 'pendiente' && j.exclusion === null) {
      s.pendingCount += 1
      s.pendingTotal += j.amount
    } else if (j.status === 'avisado') {
      s.notifiedCount += 1
      s.notifiedTotal += j.amount
    } else if (j.status === 'cobrado' && j.charge?.paidOn?.startsWith(monthKey)) {
      s.paidThisMonthCount += 1
      s.paidThisMonthTotal += j.amount
    }
  }
  return s
}

// ── Filtros ─────────────────────────────────────────────────────────────────

export const FEE_VIEWS = ['cobrar', 'sin_atribuir', 'disputa', 'registro'] as const
export type FeeView = (typeof FEE_VIEWS)[number]

export const FEE_VIEW_LABELS: Record<FeeView, string> = {
  cobrar: 'Por cobrar',
  sin_atribuir: 'Sin atribuir',
  disputa: 'En disputa',
  registro: 'Cobrados y anulados',
}

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .catch(undefined)

/**
 * Search params calificados `fee*` (`notifications.md`): `view`, `from`,
 * `partner`, `plan` pelados chocan con otras rutas. Filtran en el CLIENTE:
 * los trabajos son decenas y la regla del primer trabajo necesita verlos
 * todos.
 */
export const partnerFeesSearchSchema = z.object({
  feeView: z.enum(FEE_VIEWS).catch('cobrar').default('cobrar'),
  feeFrom: day,
  feeTo: day,
  /** uuid de partner. */
  feePartner: z.string().uuid().optional().catch(undefined),
  /** id de `ops.team_member`, o `none` (sin «Alta por»). */
  feeSourcer: z.string().max(40).optional().catch(undefined),
})
export type PartnerFeesSearch = z.infer<typeof partnerFeesSearchSchema>

export function matchesFeeFilters(
  j: FeeJob,
  partners: ReadonlyMap<string, FeePartnerFacts>,
  s: Pick<PartnerFeesSearch, 'feeFrom' | 'feeTo' | 'feePartner' | 'feeSourcer'>,
): boolean {
  if (s.feeFrom && j.jobDay < s.feeFrom) return false
  if (s.feeTo && j.jobDay > s.feeTo) return false
  const p = j.partnerId ? partners.get(j.partnerId) : undefined
  if (s.feePartner && j.partnerId !== s.feePartner) return false
  if (s.feeSourcer) {
    const id = p?.sourcer?.memberId ?? 'none'
    if (id !== s.feeSourcer) return false
  }
  return true
}

// ── Escrituras: schemas ─────────────────────────────────────────────────────

const note = z
  .string()
  .transform((v) => v.trim())
  .pipe(z.string().max(1000, 'Hasta 1000 caracteres.'))
  .optional()

export const attributePartnerFeeSchema = z.object({
  quoteRequestId: z.string().uuid(),
  /** `null` = quitar la atribución. */
  partnerId: z.string().uuid().nullable(),
  note,
})
export type AttributePartnerFeeInput = z.infer<typeof attributePartnerFeeSchema>

export const setPartnerFeeStatusSchema = z
  .object({
    quoteRequestIds: z.array(z.string().uuid()).min(1, 'Elegí al menos un trabajo.').max(200),
    partnerId: z.string().uuid(),
    status: z.enum(FEE_STATUSES),
    paidOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida.')
      .optional(),
    paymentMethod: z.enum(PAYMENT_METHODS).optional(),
    note,
    voidReason: note,
  })
  .superRefine((v, ctx) => {
    if (v.status === 'cobrado' && !v.paidOn)
      ctx.addIssue({ code: 'custom', path: ['paidOn'], message: 'Poné la fecha del cobro.' })
    if (v.status === 'cobrado' && !v.paymentMethod)
      ctx.addIssue({ code: 'custom', path: ['paymentMethod'], message: 'Elegí el medio de pago.' })
    if (v.status === 'anulado' && !v.voidReason)
      ctx.addIssue({ code: 'custom', path: ['voidReason'], message: 'El motivo es obligatorio para anular.' })
  })
export type SetPartnerFeeStatusInput = z.infer<typeof setPartnerFeeStatusSchema>

/** Traduce las sentinelas de los SP de la 038 (y la de disponibilidad). */
export function readablePartnerFeeError(raw: string): string {
  const m = raw.match(/[A-Z_]{6,}/)
  switch (m?.[0]) {
    case PARTNER_FEES_UNAVAILABLE:
      return 'Falta aplicar la migración 038 (liquidaciones) en esta base.'
    case 'FEE_ALREADY_CHARGED':
      return 'Ese trabajo ya se avisó o cobró a otro proveedor. Volvelo a pendiente antes de cambiarlo.'
    case 'FEE_NOT_LIQUIDABLE':
      return 'Ese trabajo ya no es liquidable (cambió el resultado o el proveedor). Recargá.'
    case 'FEE_MIXED_AMOUNTS':
      return 'Los trabajos elegidos tienen montos distintos ya congelados: movelos por separado.'
    case 'FEE_PAID_ON_IN_FUTURE':
      return 'La fecha del cobro no puede ser futura.'
    case 'FEE_PAID_ON_REQUIRED':
      return 'Poné la fecha del cobro.'
    case 'INVALID_PAYMENT_METHOD':
      return 'Elegí el medio de pago.'
    case 'FEE_VOID_REASON_REQUIRED':
      return 'El motivo es obligatorio para anular.'
    case 'PARTNER_NOT_FOUND':
      return 'Ese proveedor ya no existe. Recargá.'
    case 'QUOTE_REQUEST_NOT_FOUND':
      return 'Ese pedido ya no existe. Recargá.'
    case 'FEE_NOTE_TOO_LONG':
      return 'La nota pasa de 1000 caracteres.'
    default:
      return `No se pudo guardar: ${raw}`
  }
}

// ── Mensaje de cobro ─────────────────────────────────────────────────────────

const ars = (n: number) => `$ ${Math.round(n).toLocaleString('es-AR')}`

/** `YYYY-MM-DD` → `dd/mm/aa`, sin `Date`. */
export const feeDay = (d: string) => {
  const [y, m, dd] = d.split('-')
  return y && m && dd ? `${dd}/${m}/${y.slice(2)}` : d
}

/**
 * El mensaje de WhatsApp para un proveedor: saludo, trabajos (AL-n, fecha,
 * vehículo), total y forma de pago. Sin contacto, nombre ni patente del
 * cliente: el taller ya lo atendió, y el mensaje puede reenviarse.
 */
export function chargeMessage(
  partnerName: string,
  jobs: ReadonlyArray<Pick<FeeJob, 'publicNumber' | 'jobDay' | 'vehicleLabel' | 'amount'>>,
  config: PartnerFeeConfig = PARTNER_FEE_CONFIG,
): string {
  const total = jobs.reduce((s, j) => s + j.amount, 0)
  const lines = jobs.map(
    (j) => `• AL-${j.publicNumber} · ${feeDay(j.jobDay)}${j.vehicleLabel ? ` · ${j.vehicleLabel}` : ''} · ${ars(j.amount)}`,
  )
  const plural = jobs.length === 1
  return [
    `¡Hola, ${partnerName}! Te escribimos de AutoLibre.`,
    '',
    plural
      ? 'Te pasamos el detalle del trabajo que te llegó por AutoLibre y quedó confirmado:'
      : `Te pasamos el detalle de los ${jobs.length} trabajos que te llegaron por AutoLibre y quedaron confirmados:`,
    '',
    ...lines,
    '',
    `Total: ${ars(total)}`,
    '',
    `Forma de pago: ${config.FORMA_DE_PAGO}`,
    '',
    'Cualquier duda, respondé este mensaje. ¡Gracias!',
  ].join('\n')
}

// ── CSV del registro de caja ─────────────────────────────────────────────────

export const FEE_CSV_HEADER = ['Fecha de cobro', 'Proveedor', 'Trabajos', 'Cantidad', 'Monto', 'Medio'] as const

/** Una fila por cobro: proveedor + fecha + medio. Los trabajos, como `AL-n` separados por coma. */
export function feePaymentsCsvRows(
  jobs: ReadonlyArray<FeeJob>,
  partners: ReadonlyMap<string, FeePartnerFacts>,
): Array<Array<string | number>> {
  const groups = new Map<string, { paidOn: string; partner: string; method: string; jobs: Array<number>; total: number }>()
  for (const j of jobs) {
    if (j.status !== 'cobrado' || !j.charge?.paidOn) continue
    const pid = j.charge.partnerId
    const key = `${j.charge.paidOn}|${pid}|${j.charge.paymentMethod ?? ''}`
    const g = groups.get(key) ?? {
      paidOn: j.charge.paidOn,
      partner: partners.get(pid)?.name ?? pid,
      method: paymentMethodLabel(j.charge.paymentMethod),
      jobs: [],
      total: 0,
    }
    g.jobs.push(j.publicNumber)
    g.total += j.amount
    groups.set(key, g)
  }
  return [...groups.values()]
    .sort((a, b) => (a.paidOn === b.paidOn ? a.partner.localeCompare(b.partner) : a.paidOn < b.paidOn ? -1 : 1))
    .map((g) => [
      feeDay(g.paidOn),
      g.partner,
      g.jobs.sort((a, b) => a - b).map((n) => `AL-${n}`).join(', '),
      g.jobs.length,
      g.total,
      g.method,
    ])
}
