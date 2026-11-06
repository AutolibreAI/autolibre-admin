import { z } from 'zod'
import { multiSelectParam, normalizeForMatch } from '~/lib/catalog'
import { baDay, isFounding, partnerProposalsSearchSchema, shortDay } from '~/lib/partner-plans'
import type { PlanInfo } from '~/lib/partner-plans'

/**
 * Orden y filtros de Partners › Propuestas (pedido de Tobías, 06/11/26).
 *
 * Tobías usa la pantalla para elegir a qué proveedor llamar primero y venderle
 * el plan pago. Todo vive en la URL (search params calificados `proposal*`,
 * regla de `notifications.md`) para que pueda guardar o compartir una vista.
 *
 * Es filtrado y orden de CLIENTE sobre filas que ya están en memoria (decenas):
 * las propuestas se cuentan en el navegador (`useProposalFacts`), así que no
 * hay ninguna consulta que acotar. El conteo sigue siendo el de
 * `bucketProposals`; acá sólo se poda y se ordena lo que ya salió de ahí.
 *
 * Decisiones:
 * - **Plan**: opciones del catálogo `subscription_plans` + «sin plan». Al
 *   06/11/26 el catálogo trae Gratis, Plus y Plus Max: «Estándar» no existe
 *   todavía como plan, así que no se ofrece (aparece solo el día que exista).
 * - **Zona**: por CONTENCIÓN sobre `coverage_zone`, igual que el listado
 *   (`partners-coverage.md`): un proveedor puede declarar dos zonas en el campo.
 * - **Propuestas del mes**: siempre el mes elegido en «Mes»; en el histórico,
 *   el mes en curso. **Propuestas históricas**: usadas desde el 27/10/26.
 * - **Último contacto**: el máximo `last_contact_on` de los contactos de
 *   Comercial vinculados al proveedor (`ops.partner_prospect`). Sin vínculo,
 *   no hay fecha; el chip «Sin contacto» los muestra.
 * - **Un rango vacío es "sin tope", nunca 0** (mismo criterio que `RangeFilter`).
 * - **Los nulos van siempre al final**, en las dos direcciones: ordenar por
 *   último contacto no tiene que mezclar "nunca" con "hace mucho".
 * - Sin `proposalSort` se respeta el orden de siempre (sobre el tope arriba).
 */

export const PROPOSAL_SORT_KEYS = [
  'name',
  'plan',
  'zone',
  'createdAt',
  'lastContact',
  'sent',
  'withdrawn',
  'selected',
  'used',
  'monthUsed',
  'historyUsed',
  'allTime',
  'allTimeFirst',
  'pctSelected',
  'firstAt',
  'lastAt',
  'activeMonths',
  'peak',
] as const
export type ProposalSortKey = (typeof PROPOSAL_SORT_KEYS)[number]

/** Columnas de texto: el primer click ordena A→Z; el resto, de mayor a menor. */
export const TEXT_SORT_KEYS: ReadonlySet<ProposalSortKey> = new Set(['name', 'plan', 'zone'])

/** «sin plan» en el filtro de plan. No choca con un `code` real del catálogo. */
export const NO_PLAN = 'none'

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .catch(undefined)
const count = z.coerce.number().int().min(0).max(100000).optional().catch(undefined)

/** Se mergea en `partnerProposalsSearchSchema` (`~/lib/partner-plans`). */
export const proposalFilterSearchShape = {
  proposalSort: z.enum(PROPOSAL_SORT_KEYS).optional().catch(undefined),
  proposalDir: z.enum(['asc', 'desc']).catch('desc').default('desc'),
  /** `code` de `subscription_plans`, o `none`. */
  proposalPlans: multiSelectParam(z.string().trim().min(1).max(40)),
  proposalZones: multiSelectParam(z.string().trim().min(1).max(120)),
  /** Slugs de `service_categories` (los «rubros» de la UI). */
  proposalRubros: multiSelectParam(z.string().trim().min(1).max(80)),
  proposalAliado: z.enum(['all', 'yes', 'no']).catch('all').default('all'),
  proposalMonthMin: count,
  proposalMonthMax: count,
  proposalHistMin: count,
  proposalHistMax: count,
  /** Fecha de alta del proveedor (`partners.created_at`, día de Buenos Aires). */
  proposalJoinedFrom: day,
  proposalJoinedTo: day,
  proposalContactFrom: day,
  proposalContactTo: day,
  /** Sólo los que no tienen ningún contacto comercial con fecha. */
  proposalNoContact: z.coerce.boolean().catch(false).default(false),
}

/**
 * El schema de la pantalla: el de siempre (mes, tope, buscar) más el orden y
 * los filtros. Se arma acá y no en `~/lib/partner-plans` para no crear un ciclo
 * de imports (este archivo ya depende de aquél).
 */
export const partnerProposalsPageSearchSchema = partnerProposalsSearchSchema.extend(proposalFilterSearchShape)

export interface ProposalFilterSearch {
  proposalSort?: ProposalSortKey
  proposalDir: 'asc' | 'desc'
  proposalPlans: Array<string>
  proposalZones: Array<string>
  proposalRubros: Array<string>
  proposalAliado: 'all' | 'yes' | 'no'
  proposalMonthMin?: number
  proposalMonthMax?: number
  proposalHistMin?: number
  proposalHistMax?: number
  proposalJoinedFrom?: string
  proposalJoinedTo?: string
  proposalContactFrom?: string
  proposalContactTo?: string
  proposalNoContact: boolean
}

/** Todo vacío: lo que deja «Limpiar filtros» (el orden y el mes no se tocan). */
export const CLEARED_PROPOSAL_FILTERS = {
  proposalPlans: [],
  proposalZones: [],
  proposalRubros: [],
  proposalAliado: 'all',
  proposalMonthMin: undefined,
  proposalMonthMax: undefined,
  proposalHistMin: undefined,
  proposalHistMax: undefined,
  proposalJoinedFrom: undefined,
  proposalJoinedTo: undefined,
  proposalContactFrom: undefined,
  proposalContactTo: undefined,
  proposalNoContact: false,
  proposalOverCap: false,
  q: undefined,
} as const

/** Lo que la pantalla sabe de cada proveedor, además de sus conteos. */
export interface PartnerFacts {
  zone: string | null
  categories: ReadonlyArray<{ slug: string; name: string }>
  /** ISO de `partners.created_at`. */
  createdAt: string | null
  /** `YYYY-MM-DD`. `null` = sin contacto comercial vinculado con fecha. */
  lastContactOn: string | null
  /** Usadas en el mes elegido (en el histórico, el mes en curso). */
  monthUsed: number
  /** Usadas desde el 27/10/26. */
  historyUsed: number
}

/** La forma mínima de una fila de las dos tablas. */
export interface FilterableRow {
  partnerId: string
  name: string
  tier: string | null
  plan: PlanInfo | null
}

const inRange = (n: number, min: number | undefined, max: number | undefined) =>
  (min === undefined || n >= min) && (max === undefined || n <= max)
const dayInRange = (d: string, from: string | undefined, to: string | undefined) =>
  (from === undefined || d >= from) && (to === undefined || d <= to)

export function matchesProposalFilters(row: FilterableRow, f: PartnerFacts, s: ProposalFilterSearch): boolean {
  if (s.proposalPlans.length > 0 && !s.proposalPlans.includes(row.plan?.code ?? NO_PLAN)) return false
  if (s.proposalAliado === 'yes' && !isFounding(row.tier)) return false
  if (s.proposalAliado === 'no' && isFounding(row.tier)) return false
  if (s.proposalZones.length > 0) {
    const zone = normalizeForMatch(f.zone ?? '')
    if (!s.proposalZones.some((z) => zone.includes(normalizeForMatch(z)))) return false
  }
  if (s.proposalRubros.length > 0 && !f.categories.some((c) => s.proposalRubros.includes(c.slug))) return false
  if (!inRange(f.monthUsed, s.proposalMonthMin, s.proposalMonthMax)) return false
  if (!inRange(f.historyUsed, s.proposalHistMin, s.proposalHistMax)) return false
  if (s.proposalJoinedFrom !== undefined || s.proposalJoinedTo !== undefined) {
    if (!f.createdAt || !dayInRange(baDay(f.createdAt), s.proposalJoinedFrom, s.proposalJoinedTo)) return false
  }
  if (s.proposalNoContact && f.lastContactOn !== null) return false
  if (s.proposalContactFrom !== undefined || s.proposalContactTo !== undefined) {
    if (!f.lastContactOn || !dayInRange(f.lastContactOn, s.proposalContactFrom, s.proposalContactTo)) return false
  }
  return true
}

type SortValue = number | string | null

/**
 * Ordena una copia. `value` devuelve el valor de la columna para esa fila; las
 * columnas que una vista no tiene devuelven `null` y no mueven nada. Desempate
 * siempre por nombre, para que el orden sea estable.
 */
export function sortProposalRows<R extends FilterableRow>(
  rows: ReadonlyArray<R>,
  key: ProposalSortKey | undefined,
  dir: 'asc' | 'desc',
  value: (row: R, key: ProposalSortKey) => SortValue,
): Array<R> {
  if (!key) return [...rows]
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const va = value(a, key)
    const vb = value(b, key)
    if (va === null && vb !== null) return 1
    if (vb === null && va !== null) return -1
    if (va !== null && vb !== null && va !== vb) {
      const cmp =
        typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'es')
      if (cmp !== 0) return cmp * sign
    }
    return a.name.localeCompare(b.name, 'es')
  })
}

/** Un filtro activo, como chip que se puede quitar. */
export interface ActiveFilterChip {
  key: string
  label: string
  /** El parche de search params que lo saca. */
  clear: Partial<Record<string, unknown>>
}

const rangeLabel = (name: string, min: number | undefined, max: number | undefined) =>
  min !== undefined && max !== undefined
    ? `${name}: ${min} a ${max}`
    : min !== undefined
      ? `${name}: ${min} o más`
      : `${name}: hasta ${max}`
const dayRangeLabel = (name: string, from: string | undefined, to: string | undefined) =>
  from !== undefined && to !== undefined
    ? `${name}: ${shortDay(from)} a ${shortDay(to)}`
    : from !== undefined
      ? `${name}: desde ${shortDay(from)}`
      : `${name}: hasta ${shortDay(to ?? '')}`

export function activeProposalFilterChips(
  s: ProposalFilterSearch & { q?: string; proposalOverCap: boolean },
  labels: { plan: (code: string) => string; rubro: (slug: string) => string; monthName: string },
): Array<ActiveFilterChip> {
  const out: Array<ActiveFilterChip> = []
  if (s.q) out.push({ key: 'q', label: `Busca: ${s.q}`, clear: { q: undefined } })
  for (const code of s.proposalPlans) {
    out.push({
      key: `plan:${code}`,
      label: `Plan: ${labels.plan(code)}`,
      clear: { proposalPlans: s.proposalPlans.filter((c) => c !== code) },
    })
  }
  for (const z of s.proposalZones) {
    out.push({ key: `zone:${z}`, label: `Zona: ${z}`, clear: { proposalZones: s.proposalZones.filter((x) => x !== z) } })
  }
  for (const r of s.proposalRubros) {
    out.push({
      key: `rubro:${r}`,
      label: `Rubro: ${labels.rubro(r)}`,
      clear: { proposalRubros: s.proposalRubros.filter((x) => x !== r) },
    })
  }
  if (s.proposalAliado !== 'all') {
    out.push({
      key: 'aliado',
      label: s.proposalAliado === 'yes' ? 'Sólo Aliados' : 'Sin Aliados',
      clear: { proposalAliado: 'all' },
    })
  }
  if (s.proposalMonthMin !== undefined || s.proposalMonthMax !== undefined) {
    out.push({
      key: 'month',
      label: rangeLabel(`Propuestas ${labels.monthName}`, s.proposalMonthMin, s.proposalMonthMax),
      clear: { proposalMonthMin: undefined, proposalMonthMax: undefined },
    })
  }
  if (s.proposalHistMin !== undefined || s.proposalHistMax !== undefined) {
    out.push({
      key: 'hist',
      label: rangeLabel('Propuestas desde 27/10', s.proposalHistMin, s.proposalHistMax),
      clear: { proposalHistMin: undefined, proposalHistMax: undefined },
    })
  }
  if (s.proposalJoinedFrom !== undefined || s.proposalJoinedTo !== undefined) {
    out.push({
      key: 'joined',
      label: dayRangeLabel('Alta', s.proposalJoinedFrom, s.proposalJoinedTo),
      clear: { proposalJoinedFrom: undefined, proposalJoinedTo: undefined },
    })
  }
  if (s.proposalNoContact) out.push({ key: 'nocontact', label: 'Sin contacto comercial', clear: { proposalNoContact: false } })
  if (s.proposalContactFrom !== undefined || s.proposalContactTo !== undefined) {
    out.push({
      key: 'contact',
      label: dayRangeLabel('Último contacto', s.proposalContactFrom, s.proposalContactTo),
      clear: { proposalContactFrom: undefined, proposalContactTo: undefined },
    })
  }
  if (s.proposalOverCap) out.push({ key: 'overcap', label: 'Sobre el tope', clear: { proposalOverCap: false } })
  return out
}
