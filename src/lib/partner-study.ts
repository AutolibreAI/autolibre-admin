import { z } from 'zod'
import { multiSelectParam } from './catalog'
import { PARTNER_PLANS, PARTNER_PLAN_LABELS, PROPOSAL_COUNT_START, monthLabel } from './partner-plans'
import type { PartnerPlan, ProposalFact } from './partner-plans'

/**
 * Estudio de proveedores (`/partners/estudio`) — tarjeta "Panel admin: estudio
 * de proveedores (presupuestos enviados, tipo, confirmados y reporte para
 * ellos)".
 *
 * Todo lo de este archivo es cálculo determinístico sobre propuestas reales
 * (`useProposalFacts`): enviadas, retiradas, elegidas / no elegidas / sin
 * decisión, mediana de tiempo de respuesta, canal, dormidos y el norte "3
 * propuestas en menos de 1 h". Lo que no tiene de dónde leerse (pedidos
 * matcheados, vencidos sin respuesta, confirmaciones, disputas, motivos de "no
 * contraté", vistas y clics) viene de `~/mocks/partner-study`.
 *
 * El reporte para el proveedor nunca nombra personas ni a otros proveedores: la
 * comparación es con la mediana ANÓNIMA de su zona, y sólo si hay al menos
 * `ZONE_PEERS_MIN` proveedores más con propuestas en esa zona (con menos, el
 * promedio de "los otros" identificaría a alguien).
 */

export const STUDY_PERIODS = [7, 30, 90] as const
export type StudyPeriod = (typeof STUDY_PERIODS)[number]

export const ZONE_PEERS_MIN = 3

/** El norte del producto: 3 propuestas en menos de una hora. */
export const NORTH_STAR_PROPOSALS = 3
export const NORTH_STAR_MINUTES = 60

export const partnerStudySearchSchema = z.object({
  studyPeriod: z.coerce
    .number()
    .refine((n): n is StudyPeriod => (STUDY_PERIODS as ReadonlyArray<number>).includes(n))
    .catch(30)
    .default(30),
  studyZones: multiSelectParam(z.string().trim().max(120)),
  studyRubros: multiSelectParam(z.string().trim().max(60)),
  studyPlans: multiSelectParam(z.enum(PARTNER_PLANS)),
})
export type PartnerStudySearch = z.infer<typeof partnerStudySearchSchema>

export interface StudyPartnerRef {
  id: string
  name: string
  tier: string
  status: string
  coverageZone: string
  categorySlugs: Array<string>
}

export interface StudyRange {
  /** ISO inclusive. */
  from: string
  /** ISO exclusivo. `null` = hasta ahora. */
  to: string | null
}

export function lastDaysRange(days: number, now: Date): StudyRange {
  const from = new Date(now.getTime() - days * 86_400_000).toISOString()
  return { from: from < PROPOSAL_COUNT_START ? PROPOSAL_COUNT_START : from, to: null }
}

/** Mes calendario en Buenos Aires (UTC−3): del día 1 a las 00:00 al día 1 siguiente. */
export function monthRange(key: string): StudyRange {
  const [y, m] = key.split('-').map(Number) as [number, number]
  const from = `${y}-${String(m).padStart(2, '0')}-01T03:00:00.000Z`
  const ny = m === 12 ? y + 1 : y
  const nm = m === 12 ? 1 : m + 1
  const to = `${ny}-${String(nm).padStart(2, '0')}-01T03:00:00.000Z`
  return { from: from < PROPOSAL_COUNT_START ? PROPOSAL_COUNT_START : from, to }
}

const inRange = (iso: string, r: StudyRange) => iso >= r.from && (r.to === null || iso < r.to)

export function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const minutesBetween = (fromIso: string, toIso: string) =>
  Math.max(0, (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000)

export interface PartnerStudyRow {
  partnerId: string
  name: string
  tier: string
  status: string
  coverageZone: string
  categorySlugs: Array<string>
  plan: PartnerPlan | null
  /** Activas. */
  sent: number
  withdrawn: number
  /** La persona eligió ésta. */
  selected: number
  /** La persona eligió otra del mismo pedido. */
  notSelected: number
  /** El pedido todavía no tiene elegida. */
  undecided: number
  /** Desde que entró el pedido hasta esta propuesta. */
  medianResponseMinutes: number | null
  byChannel: Record<string, number>
  lastProposalAt: string | null
  /** Proveedor activo sin una sola propuesta en el período. */
  dormant: boolean
}

export function studyRows(
  facts: ReadonlyArray<ProposalFact>,
  partners: ReadonlyArray<StudyPartnerRef>,
  plans: ReadonlyMap<string, PartnerPlan>,
  range: StudyRange,
): Array<PartnerStudyRow> {
  const byPartner = new Map<string, Array<ProposalFact>>()
  for (const f of facts) {
    if (!f.partnerId || !inRange(f.createdAt, range)) continue
    const list = byPartner.get(f.partnerId) ?? []
    list.push(f)
    byPartner.set(f.partnerId, list)
  }

  const rows: Array<PartnerStudyRow> = []
  for (const p of partners) {
    const list = byPartner.get(p.id) ?? []
    if (list.length === 0 && p.status !== 'active') continue
    const byChannel: Record<string, number> = {}
    for (const f of list) byChannel[f.requestChannel] = (byChannel[f.requestChannel] ?? 0) + 1
    rows.push({
      partnerId: p.id,
      name: p.name,
      tier: p.tier,
      status: p.status,
      coverageZone: p.coverageZone,
      categorySlugs: p.categorySlugs,
      plan: plans.get(p.id) ?? null,
      sent: list.filter((f) => !f.withdrawnAt).length,
      withdrawn: list.filter((f) => f.withdrawnAt).length,
      selected: list.filter((f) => f.selected).length,
      notSelected: list.filter((f) => !f.selected && f.requestHasSelection).length,
      undecided: list.filter((f) => !f.requestHasSelection).length,
      medianResponseMinutes: median(list.map((f) => minutesBetween(f.requestCreatedAt, f.createdAt))),
      byChannel,
      lastProposalAt: list.reduce<string | null>((max, f) => (max === null || f.createdAt > max ? f.createdAt : max), null),
      dormant: list.length === 0,
    })
  }
  return rows.sort(
    (a, b) => b.sent + b.withdrawn - (a.sent + a.withdrawn) || a.name.localeCompare(b.name, 'es'),
  )
}

export interface NorthStar {
  /** Pedidos del período con al menos una propuesta. */
  requests: number
  withThree: number
  withThreeUnderHour: number
}

/** De los pedidos que entraron en el período, cuántos llegaron a 3 propuestas, y cuántos en menos de 1 h. */
export function northStar(facts: ReadonlyArray<ProposalFact>, range: StudyRange): NorthStar {
  const byRequest = new Map<string, Array<ProposalFact>>()
  for (const f of facts) {
    if (!inRange(f.requestCreatedAt, range)) continue
    const list = byRequest.get(f.quoteRequestId) ?? []
    list.push(f)
    byRequest.set(f.quoteRequestId, list)
  }
  let withThree = 0
  let withThreeUnderHour = 0
  for (const list of byRequest.values()) {
    if (list.length < NORTH_STAR_PROPOSALS) continue
    withThree += 1
    const third = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[NORTH_STAR_PROPOSALS - 1]!
    if (minutesBetween(third.requestCreatedAt, third.createdAt) < NORTH_STAR_MINUTES) withThreeUnderHour += 1
  }
  return { requests: byRequest.size, withThree, withThreeUnderHour }
}

export function formatMinutes(min: number | null): string {
  if (min === null) return '—'
  if (min < 60) return `${Math.round(min)} min`
  const h = min / 60
  return h < 48 ? `${h.toFixed(1).replace('.', ',')} h` : `${Math.round(h / 24)} días`
}

/**
 * El resumen mensual para mandarle al proveedor por WhatsApp. Determinístico:
 * los mismos datos dan el mismo texto. Sin nombres de personas ni de otros
 * proveedores; la zona va como mediana anónima y sólo con `ZONE_PEERS_MIN`
 * pares o más.
 */
export function partnerMonthlyReport(row: PartnerStudyRow, month: string, peers: ReadonlyArray<PartnerStudyRow>): string {
  const zone = row.coverageZone.trim().toLowerCase()
  const zonePeers = peers.filter(
    (p) => p.partnerId !== row.partnerId && p.coverageZone.trim().toLowerCase() === zone && !p.dormant,
  )
  const total = row.sent + row.withdrawn
  const lines = [
    `Hola, ${row.name}. Este es tu resumen de ${monthLabel(month)} en AutoLibre:`,
    '',
    `• Propuestas enviadas a clientes: ${total}`,
    `• Elegidas por el cliente: ${row.selected}`,
    `• Todavía sin decisión del cliente: ${row.undecided}`,
    `• Tiempo típico desde que entra el pedido hasta tu propuesta: ${formatMinutes(row.medianResponseMinutes)}`,
  ]
  if (row.plan) lines.push(`• Tu plan: ${PARTNER_PLAN_LABELS[row.plan]}`)
  lines.push('')
  if (zonePeers.length >= ZONE_PEERS_MIN) {
    const peerSent = median(zonePeers.map((p) => p.sent + p.withdrawn))
    const peerTime = median(
      zonePeers.map((p) => p.medianResponseMinutes).filter((v): v is number => v !== null),
    )
    lines.push(
      `En tu zona, un proveedor típico envió ${peerSent === null ? '—' : Math.round(peerSent)} propuestas y respondió en ${formatMinutes(peerTime)}.`,
    )
  } else {
    lines.push('Todavía no hay suficientes proveedores en tu zona para compararte.')
  }
  lines.push('', 'Cuanto más rápido respondés, más chances de que te elijan. ¡Gracias por estar en AutoLibre!')
  return lines.join('\n')
}
