import { z } from 'zod'

/**
 * Planes de proveedor y conteo de propuestas por proveedor
 * (`/partners/propuestas`, tarjeta "Admin: conteo mensual de propuestas por
 * proveedor + tope por plan").
 *
 * ── La unidad es la PROPUESTA ENVIADA ─────────────────────────────────────
 *
 * Una fila de `quote_request_proposals`, no un pedido recibido. Se cuenta en el
 * mes calendario de `created_at` en hora de Buenos Aires, y nada anterior a
 * `PROPOSAL_COUNT_START` (27/10/26 00:00 de Buenos Aires). Las propuestas de
 * pedidos cerrados como duplicado no llegan acá: la pantalla no pide esos
 * pedidos (el equipo marca así sus pruebas).
 *
 * - **Enviadas**: las que siguen activas.
 * - **Retiradas**: `withdrawn_at` cargado. Se muestran aparte pero SUMAN al tope:
 *   el proveedor ya recibió el pedido y el lugar se usó.
 * - **Usadas** = enviadas + retiradas. Es lo que se compara contra el tope.
 * - **Elegidas**: la propuesta es HOY `quote_requests.selected_proposal_id`
 *   (decidido el 02/11/26). Una que la persona eligió y después des-eligió NO
 *   cuenta, ni en el mes ni en el histórico: no hay registro de elecciones
 *   pasadas, y contar "alguna vez elegida" necesitaría ese registro.
 *
 * ── Decisiones (02/11/26) ─────────────────────────────────────────────────
 *
 * 1. Aliado (`tier = founding`): se ve su conteo y el tope de su plan como
 *    referencia, pero no tiene límite. Nunca rojo ni amarillo.
 * 2. El tope no frena el envío: sólo se marca.
 * 3. Los talleres de afuera del directorio siguen permitidos como excepción.
 *    Van en una sección aparte y no suman a ningún tope ni plan.
 * 4. Elegidas = la elegida de hoy (arriba).
 * 5. El plan se carga a mano desde el admin (`PartnerPlanEditor`).
 *
 * Todo lo de este archivo es cálculo determinístico: no lee nada. Las dos
 * vistas (mes e histórico) salen del MISMO `bucketProposals`, así que no pueden
 * contar distinto.
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

/**
 * 2026-10-27 00:00 en Buenos Aires (UTC−3, sin horario de verano).
 * Se toca JUNTO con el default de `p_from` de `ops.partner_proposal_usage_monthly`
 * (migración 025), que es lo que lee el conector MCP de los ejecutivos.
 */
export const PROPOSAL_COUNT_START = '2026-10-27T03:00:00.000Z'

export const PROPOSAL_COUNT_TZ = 'America/Argentina/Buenos_Aires'

/** Valor de `proposalMonth` para la vista histórica. */
export const PROPOSAL_HISTORY = 'historico'

export const isFounding = (tier: string | null) => tier === 'founding'

const monthParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: PROPOSAL_COUNT_TZ,
  year: 'numeric',
  month: '2-digit',
})

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: PROPOSAL_COUNT_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** `YYYY-MM` del instante, en hora de Buenos Aires. */
export function baMonthKey(iso: string | Date): string {
  const parts = monthParts.formatToParts(typeof iso === 'string' ? new Date(iso) : iso)
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000'
  const month = parts.find((p) => p.type === 'month')?.value ?? '00'
  return `${year}-${month}`
}

/** `YYYY-MM-DD` del instante, en hora de Buenos Aires. */
export function baDay(iso: string | Date): string {
  return dayFormat.format(typeof iso === 'string' ? new Date(iso) : iso)
}

/** `YYYY-MM-DD` → `dd/mm/aa`, sin pasar por `Date` (no corre el día). */
export function shortDay(day: string): string {
  const [y, m, d] = day.split('-')
  return y && m && d ? `${d}/${m}/${y.slice(2)}` : day
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
  /** `YYYY-MM` o `historico`. Ausente = el mes en curso (lo resuelve la pantalla). */
  proposalMonth: z
    .string()
    .regex(/^(\d{4}-(0[1-9]|1[0-2])|historico)$/)
    .optional()
    .catch(undefined),
  /** Sólo los que pasaron el tope (en el histórico: en su pico mensual). */
  proposalOverCap: z.coerce.boolean().catch(false).default(false),
  /** Incluir a los proveedores activos sin ninguna propuesta. */
  proposalShowIdle: z.coerce.boolean().catch(false).default(false),
  /** Buscar por nombre de proveedor. */
  q: z.string().trim().max(80).optional(),
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
  /** Es HOY la `selected_proposal_id` del pedido. */
  selected: boolean
  /** Del pedido: para tiempo de respuesta, canal y "elegido / no elegido / sin decisión". */
  requestCreatedAt: string
  requestChannel: string
  requestHasSelection: boolean
}

export interface PartnerRef {
  id: string
  name: string
  tier: string
  status: string
}

// ── Color del tope ────────────────────────────────────────────────────────────

/**
 * Qué dice la celda de usadas contra el tope. Lo decide el código, nunca la
 * pantalla:
 *
 * | tono | cuándo | se pinta |
 * |---|---|---|
 * | `no_plan` | sin plan cargado | "sin plan", gris |
 * | `founding` | Aliado, pase o no el tope | gris neutro + badge |
 * | `unlimited` | plan sin límite (Estándar) | normal |
 * | `over` | usadas > tope | rojo |
 * | `at` | usadas = tope | amarillo |
 * | `under` | por debajo | normal |
 */
export type CapTone = 'no_plan' | 'founding' | 'unlimited' | 'over' | 'at' | 'under'

export function capTone(used: number, plan: PartnerPlan | null, tier: string | null): CapTone {
  if (plan === null) return 'no_plan'
  if (isFounding(tier)) return 'founding'
  const cap = PARTNER_PLAN_CAPS[plan]
  if (cap === null) return 'unlimited'
  if (used > cap) return 'over'
  if (used === cap) return 'at'
  return 'under'
}

// ── El conteo, una sola vez ───────────────────────────────────────────────────

export interface UsageCounts {
  sent: number
  withdrawn: number
  selected: number
  /** sent + withdrawn. */
  used: number
}

const zero = (): UsageCounts => ({ sent: 0, withdrawn: 0, selected: 0, used: 0 })

function add(into: UsageCounts, from: UsageCounts) {
  into.sent += from.sent
  into.withdrawn += from.withdrawn
  into.selected += from.selected
  into.used += from.used
}

interface ProviderBucket {
  /** `null` = taller de afuera del directorio. */
  partnerId: string | null
  name: string
  months: Map<string, UsageCounts>
  firstAt: string | null
  lastAt: string | null
}

/** La clave de un taller de afuera es su nombre normalizado: no tiene id. */
const externalKey = (name: string) => `externo:${name.trim().toLowerCase()}`

/**
 * Agrupa las propuestas contables por proveedor y por mes de Buenos Aires.
 * Es el único lugar que decide qué cuenta como enviada, retirada, elegida y
 * usada.
 */
function bucketProposals(facts: ReadonlyArray<ProposalFact>): Map<string, ProviderBucket> {
  const out = new Map<string, ProviderBucket>()
  for (const f of facts) {
    if (f.createdAt < PROPOSAL_COUNT_START) continue
    const key = f.partnerId ?? externalKey(f.providerName)
    let b = out.get(key)
    if (!b) {
      b = { partnerId: f.partnerId, name: f.providerName, months: new Map(), firstAt: null, lastAt: null }
      out.set(key, b)
    }
    const month = baMonthKey(f.createdAt)
    let c = b.months.get(month)
    if (!c) {
      c = zero()
      b.months.set(month, c)
    }
    if (f.withdrawnAt) c.withdrawn += 1
    else c.sent += 1
    if (f.selected) c.selected += 1
    c.used += 1
    if (b.firstAt === null || f.createdAt < b.firstAt) b.firstAt = f.createdAt
    if (b.lastAt === null || f.createdAt > b.lastAt) b.lastAt = f.createdAt
  }
  return out
}

function sumMonths(b: ProviderBucket): UsageCounts {
  const total = zero()
  for (const c of b.months.values()) add(total, c)
  return total
}

/** El mes con más usadas; empate → el más viejo. */
function peakMonth(b: ProviderBucket): { month: string; used: number } | null {
  let peak: { month: string; used: number } | null = null
  for (const [month, c] of [...b.months.entries()].sort(([a], [z]) => a.localeCompare(z))) {
    if (c.used > 0 && (peak === null || c.used > peak.used)) peak = { month, used: c.used }
  }
  return peak
}

// ── Taller de afuera: sección aparte ──────────────────────────────────────────

export interface ExternalUsageRow extends UsageCounts {
  name: string
  firstAt: string | null
  lastAt: string | null
}

function externalRows(buckets: Map<string, ProviderBucket>, month: string | null): Array<ExternalUsageRow> {
  const rows: Array<ExternalUsageRow> = []
  for (const b of buckets.values()) {
    if (b.partnerId !== null) continue
    const counts = month === null ? sumMonths(b) : (b.months.get(month) ?? zero())
    if (counts.used === 0) continue
    rows.push({ name: b.name, ...counts, firstAt: b.firstAt, lastAt: b.lastAt })
  }
  return rows.sort((a, b) => b.used - a.used || a.name.localeCompare(b.name, 'es'))
}

// ── Vista mensual ─────────────────────────────────────────────────────────────

export interface PartnerUsageRow extends UsageCounts {
  partnerId: string
  name: string
  tier: string | null
  status: string | null
  plan: PartnerPlan | null
  /** `null` = sin límite, o sin plan. */
  cap: number | null
  tone: CapTone
}

export interface PartnerUsageView<Row> {
  /** Proveedores del directorio. */
  rows: Array<Row>
  /** Talleres de afuera: no suman a ningún tope ni plan. */
  externals: Array<ExternalUsageRow>
}

export function aggregatePartnerUsage(
  facts: ReadonlyArray<ProposalFact>,
  month: string,
  partners: ReadonlyArray<PartnerRef>,
  plans: ReadonlyMap<string, PartnerPlan>,
  opts: { includeIdle: boolean },
): PartnerUsageView<PartnerUsageRow> {
  const buckets = bucketProposals(facts)
  const byId = new Map(partners.map((p) => [p.id, p]))
  const ids = new Set<string>()
  for (const b of buckets.values()) if (b.partnerId && (b.months.get(month)?.used ?? 0) > 0) ids.add(b.partnerId)
  if (opts.includeIdle) for (const p of partners) if (p.status === 'active') ids.add(p.id)

  const rows = [...ids].map((id): PartnerUsageRow => {
    const p = byId.get(id)
    const b = buckets.get(id)
    const counts = b?.months.get(month) ?? zero()
    const plan = plans.get(id) ?? null
    const tier = p?.tier ?? null
    return {
      partnerId: id,
      name: p?.name ?? b?.name ?? id,
      tier,
      status: p?.status ?? null,
      plan,
      cap: plan ? PARTNER_PLAN_CAPS[plan] : null,
      ...counts,
      tone: capTone(counts.used, plan, tier),
    }
  })

  const rank = (t: CapTone) => (t === 'over' ? 0 : t === 'at' ? 1 : 2)
  rows.sort((a, b) => rank(a.tone) - rank(b.tone) || b.used - a.used || a.name.localeCompare(b.name, 'es'))
  return { rows, externals: externalRows(buckets, month) }
}

// ── Vista histórica ───────────────────────────────────────────────────────────

export interface PartnerHistoryRow extends UsageCounts {
  partnerId: string
  name: string
  tier: string | null
  status: string | null
  plan: PartnerPlan | null
  /** elegidas / enviadas. `null` sin enviadas: no hay de qué sacar el porcentaje. */
  pctSelected: number | null
  firstAt: string | null
  lastAt: string | null
  /** Meses calendario con al menos una usada. */
  activeMonths: number
  /** El máximo de usadas en un mes calendario. */
  peak: { month: string; used: number } | null
  /** El color va sobre el pico: quién pasaría el tope de su plan en algún mes. */
  tone: CapTone
  /**
   * Desde siempre, de las DOS tablas (`ops.partner_quote_volume()`, migración
   * 025): también lo que se cargó en `ops.quote_request_response` antes del
   * 27/10. `null` = la función no está en esta base. Va APARTE de los conteos
   * de arriba y no entra al pico ni al color: lo viejo no se publicó en la app
   * y en septiembre no había tope.
   */
  allTime: AllTimeVolume | null
}

/** Lo que cotizó un proveedor desde siempre (`ops.partner_quote_volume()`). */
export interface AllTimeVolume {
  /** Pedidos distintos en los que cotizó, de las dos tablas. */
  requests: number
  /** `YYYY-MM-DD` en hora de Buenos Aires. */
  firstOn: string
}

export function aggregatePartnerHistory(
  facts: ReadonlyArray<ProposalFact>,
  partners: ReadonlyArray<PartnerRef>,
  plans: ReadonlyMap<string, PartnerPlan>,
  opts: {
    includeIdle: boolean
    /** Por `partner_id`. `null` = la 025 no está; sin la clave = sin historial. */
    allTime?: ReadonlyMap<string, AllTimeVolume> | null
  },
): PartnerUsageView<PartnerHistoryRow> {
  const buckets = bucketProposals(facts)
  const byId = new Map(partners.map((p) => [p.id, p]))
  const ids = new Set<string>()
  for (const b of buckets.values()) if (b.partnerId) ids.add(b.partnerId)
  if (opts.includeIdle) for (const p of partners) if (p.status === 'active') ids.add(p.id)
  // Un proveedor que sólo cotizó antes del 27/10 también va: es justo el que
  // Comercial quiere encontrar, y sin esto la columna lo escondería.
  if (opts.allTime) for (const id of opts.allTime.keys()) ids.add(id)
  const allTimeFor = (id: string): AllTimeVolume | null =>
    opts.allTime ? (opts.allTime.get(id) ?? { requests: 0, firstOn: '' }) : null

  const rows = [...ids].map((id): PartnerHistoryRow => {
    const p = byId.get(id)
    const b = buckets.get(id)
    const counts = b ? sumMonths(b) : zero()
    const peak = b ? peakMonth(b) : null
    const plan = plans.get(id) ?? null
    const tier = p?.tier ?? null
    return {
      partnerId: id,
      name: p?.name ?? b?.name ?? id,
      tier,
      status: p?.status ?? null,
      plan,
      ...counts,
      pctSelected: counts.sent > 0 ? (counts.selected / counts.sent) * 100 : null,
      firstAt: b?.firstAt ?? null,
      lastAt: b?.lastAt ?? null,
      activeMonths: b ? [...b.months.values()].filter((c) => c.used > 0).length : 0,
      peak,
      tone: capTone(peak?.used ?? 0, plan, tier),
      allTime: allTimeFor(id),
    }
  })

  rows.sort(
    (a, b) =>
      b.used - a.used ||
      (b.allTime?.requests ?? 0) - (a.allTime?.requests ?? 0) ||
      a.name.localeCompare(b.name, 'es'),
  )
  return { rows, externals: externalRows(buckets, null) }
}

// ── CSV del histórico ─────────────────────────────────────────────────────────

/**
 * Para cruzar con quién pagó. Separador `;` y coma decimal: se abre directo en
 * un Excel en español; Sheets lo detecta al importar. Con BOM para los acentos.
 * Los talleres de afuera van al final, marcados, sin plan.
 */
export function partnerHistoryCsv(view: PartnerUsageView<PartnerHistoryRow>): string {
  const head = [
    'tipo', 'proveedor', 'partner_id', 'aliado', 'plan', 'enviadas', 'retiradas', 'elegidas',
    'usadas', 'pct_elegidas', 'primera', 'ultima', 'meses_con_actividad', 'pico_mes', 'pico_usadas',
    'pico_sobre_tope', 'pedidos_desde_siempre', 'cotiza_desde',
  ]
  const cell = (v: string | number | null) => {
    if (v === null) return ''
    const s = typeof v === 'number' ? String(v).replace('.', ',') : v
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const day = (iso: string | null) => (iso ? baDay(iso) : null)
  const lines = [head.join(';')]
  for (const r of view.rows) {
    lines.push(
      [
        'directorio', r.name, r.partnerId, isFounding(r.tier) ? 'si' : 'no',
        r.plan ? PARTNER_PLAN_LABELS[r.plan] : 'sin plan', r.sent, r.withdrawn, r.selected, r.used,
        r.pctSelected === null ? null : Math.round(r.pctSelected * 10) / 10, day(r.firstAt), day(r.lastAt),
        r.activeMonths, r.peak?.month ?? null, r.peak?.used ?? null,
        r.tone === 'over' ? 'si' : r.tone === 'at' ? 'llego' : 'no',
        r.allTime ? r.allTime.requests : null, r.allTime?.firstOn || null,
      ]
        .map(cell)
        .join(';'),
    )
  }
  for (const e of view.externals) {
    lines.push(
      [
        'taller de afuera', e.name, null, null, null, e.sent, e.withdrawn, e.selected, e.used,
        e.sent > 0 ? Math.round((e.selected / e.sent) * 1000) / 10 : null, day(e.firstAt), day(e.lastAt),
        null, null, null, null, null, null,
      ]
        .map(cell)
        .join(';'),
    )
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n'
}
