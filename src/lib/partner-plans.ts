import { z } from 'zod'

/**
 * Planes de proveedor y conteo mensual de propuestas
 * (`/partners/propuestas`, tarjeta "Admin: conteo mensual de propuestas por
 * proveedor + tope por plan").
 *
 * ── La unidad es la PROPUESTA ENVIADA ─────────────────────────────────────
 *
 * Una fila de `quote_request_proposals`, no un pedido recibido. Se cuenta en el
 * mes calendario de `created_at` en hora de Buenos Aires, y nada anterior a
 * `PROPOSAL_COUNT_START` (27/10/26 00:00 de Buenos Aires).
 *
 * - **Enviadas**: las que siguen activas.
 * - **Retiradas**: `withdrawn_at` cargado. Se muestran aparte pero SUMAN al tope:
 *   el proveedor ya recibió el pedido y el lugar se usó.
 * - **Usadas** = enviadas + retiradas. Es lo que se compara contra el tope.
 * - **Elegidas**: la propuesta es `quote_requests.selected_proposal_id`. Es un
 *   subconjunto de las enviadas, no suma aparte.
 *
 * ── El plan todavía no existe en la base ──────────────────────────────────
 *
 * `partners.tier` (`founding | standard`) es el sello Aliado, no un plan
 * comercial. Mientras no haya `partners.plan`, el plan sale de
 * `~/mocks/partner-plans` y la pantalla lo dice. Todo lo de este archivo es
 * cálculo determinístico: no lee nada.
 */

export const PARTNER_PLANS = ['gratis', 'estandar', 'plus', 'plus_max'] as const
export type PartnerPlan = (typeof PARTNER_PLANS)[number]

export const PARTNER_PLAN_LABELS: Record<PartnerPlan, string> = {
  gratis: 'Gratis',
  estandar: 'Estándar',
  plus: 'Plus',
  plus_max: 'Plus Max',
}

/** Propuestas por mes calendario. `null` = sin límite. */
export const PARTNER_PLAN_CAPS: Record<PartnerPlan, number | null> = {
  gratis: 1,
  estandar: null,
  plus: 10,
  plus_max: 15,
}

/** 2026-10-27 00:00 en Buenos Aires (UTC−3, sin horario de verano). */
export const PROPOSAL_COUNT_START = '2026-10-27T03:00:00.000Z'

export const PROPOSAL_COUNT_TZ = 'America/Argentina/Buenos_Aires'

const monthParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: PROPOSAL_COUNT_TZ,
  year: 'numeric',
  month: '2-digit',
})

/** `YYYY-MM` del instante, en hora de Buenos Aires. */
export function baMonthKey(iso: string | Date): string {
  const parts = monthParts.formatToParts(typeof iso === 'string' ? new Date(iso) : iso)
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000'
  const month = parts.find((p) => p.type === 'month')?.value ?? '00'
  return `${year}-${month}`
}

/** Meses desde el primero contado hasta el de `now`, el más nuevo primero. */
export function countableMonths(now: Date): Array<string> {
  const first = baMonthKey(PROPOSAL_COUNT_START)
  const last = baMonthKey(now)
  const out: Array<string> = []
  let [y, m] = first.split('-').map(Number) as [number, number]
  for (let guard = 0; guard < 240; guard++) {
    const key = `${y}-${String(m).padStart(2, '0')}`
    out.push(key)
    if (key >= last) break
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out.reverse()
}

const MONTH_NAMES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number]
  return `${MONTH_NAMES[m - 1] ?? key} ${y}`
}

export const partnerProposalsSearchSchema = z.object({
  /** `YYYY-MM`. Ausente = el mes en curso (lo resuelve la pantalla). */
  proposalMonth: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional()
    .catch(undefined),
  /** Sólo los que pasaron el tope. */
  proposalOverCap: z.coerce.boolean().catch(false).default(false),
  /** Incluir a los proveedores sin ninguna propuesta en el mes. */
  proposalShowIdle: z.coerce.boolean().catch(false).default(false),
})
export type PartnerProposalsSearch = z.infer<typeof partnerProposalsSearchSchema>

/** Una propuesta, reducida a lo que el conteo necesita. */
export interface ProposalFact {
  id: string
  quoteRequestId: string
  partnerId: string | null
  providerName: string
  createdAt: string
  withdrawnAt: string | null
  selected: boolean
}

export interface PartnerRef {
  id: string
  name: string
  tier: string
  status: string
}

export interface PartnerUsageRow {
  /** `null` = taller de afuera del directorio (sin plan, no se cobra). */
  partnerId: string | null
  name: string
  tier: string | null
  status: string | null
  plan: PartnerPlan | null
  /** `null` = sin límite, o sin plan. */
  cap: number | null
  sent: number
  withdrawn: number
  selected: number
  used: number
  overCap: boolean
}

export function aggregatePartnerUsage(
  facts: ReadonlyArray<ProposalFact>,
  month: string,
  partners: ReadonlyArray<PartnerRef>,
  plans: ReadonlyMap<string, PartnerPlan>,
  opts: { includeIdle: boolean },
): Array<PartnerUsageRow> {
  const rows = new Map<string, PartnerUsageRow>()
  const byId = new Map(partners.map((p) => [p.id, p]))

  const rowFor = (partnerId: string | null, fallbackName: string): PartnerUsageRow => {
    const key = partnerId ?? `externo:${fallbackName.trim().toLowerCase()}`
    let row = rows.get(key)
    if (!row) {
      const p = partnerId ? byId.get(partnerId) : undefined
      const plan = partnerId ? (plans.get(partnerId) ?? null) : null
      row = {
        partnerId,
        name: p?.name ?? fallbackName,
        tier: p?.tier ?? null,
        status: p?.status ?? null,
        plan,
        cap: plan ? PARTNER_PLAN_CAPS[plan] : null,
        sent: 0,
        withdrawn: 0,
        selected: 0,
        used: 0,
        overCap: false,
      }
      rows.set(key, row)
    }
    return row
  }

  if (opts.includeIdle) {
    for (const p of partners) if (p.status === 'active') rowFor(p.id, p.name)
  }

  for (const f of facts) {
    if (f.createdAt < PROPOSAL_COUNT_START) continue
    if (baMonthKey(f.createdAt) !== month) continue
    const row = rowFor(f.partnerId, f.providerName)
    if (f.withdrawnAt) row.withdrawn += 1
    else row.sent += 1
    if (f.selected) row.selected += 1
  }

  for (const row of rows.values()) {
    row.used = row.sent + row.withdrawn
    row.overCap = row.cap !== null && row.used > row.cap
  }

  return [...rows.values()].sort(
    (a, b) =>
      Number(b.overCap) - Number(a.overCap) ||
      b.used - a.used ||
      a.name.localeCompare(b.name, 'es'),
  )
}
