import { normalizeForMatch } from '~/lib/catalog'
import { normalizeArPhone } from '~/lib/partner-prospects'

/**
 * Sellos y validaciones de proveedores (Aliado, redes, aseguradoras).
 *
 * Tarjeta "Sellos y validaciones de proveedores (Aliado, redes, aseguradoras) +
 * filtro en catálogo". Lo único REAL hoy es Aliado = `partners.tier =
 * 'founding'`, que se edita en la tarjeta Perfil de la ficha. El catálogo de
 * sellos y los sellos asignados no existen en la base: viven en
 * `~/mocks/partner-seals` hasta que existan `seals` + `partner_seals`.
 *
 * Todo lo de este archivo es determinístico: el estado de un sello y el cruce
 * de un CSV de red contra los proveedores salen de reglas fijas, nunca de un
 * "parecido".
 */

export const SEAL_KINDS = ['alliance', 'network', 'insurer'] as const
export type SealKind = (typeof SEAL_KINDS)[number]

export const SEAL_KIND_LABELS: Record<SealKind, string> = {
  alliance: 'Alianza',
  network: 'Red',
  insurer: 'Aseguradora',
}

/** Un sello del catálogo (`seals`). */
export interface Seal {
  id: string
  slug: string
  name: string
  kind: SealKind
  /** Si la validación vence (una red que se renueva por año, una aseguradora). */
  requiresExpiry: boolean
}

/** Lo que se GUARDA. `expired` no se guarda: se deduce del reloj. */
export const STORED_SEAL_STATUSES = ['pending', 'verified', 'revoked'] as const
export type StoredSealStatus = (typeof STORED_SEAL_STATUSES)[number]

/** Lo que se MUESTRA. */
export type SealState = 'pending' | 'verified' | 'expired' | 'revoked'

export const SEAL_STATE_LABELS: Record<SealState, string> = {
  pending: 'Pendiente',
  verified: 'Verificado',
  expired: 'Vencido',
  revoked: 'Revocado',
}

/** Verde sólo para lo verificado; vencido en rojo, pendiente en ámbar. */
export const SEAL_STATE_CLASSES: Record<SealState, string> = {
  pending: 'border-status-yellow/40 bg-status-yellow-bg text-status-yellow',
  verified: 'border-status-green/30 bg-status-green-bg text-status-green',
  expired: 'border-status-red/30 bg-status-red-bg text-status-red',
  revoked: 'border-border bg-secondary text-muted-foreground',
}

/** Un sello asignado a un proveedor (`partner_seals`). */
export interface PartnerSeal {
  id: string
  partnerId: string
  sealId: string
  status: StoredSealStatus
  /** De dónde salió: "CSV red-x 2026-10", "Póliza vista", "Llamada". Texto libre. */
  source: string
  verifiedAt: string | null
  /** `YYYY-MM-DD`. Obligatorio si el sello `requiresExpiry`. */
  expiresAt: string | null
  grantedAt: string
  grantedBy: string
  revokedAt: string | null
}

/** `YYYY-MM-DD` de hoy en Buenos Aires, para comparar con `expiresAt`. */
export function todayBuenosAires(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/**
 * El estado que se muestra. Revocado gana; un verificado con vencimiento
 * anterior a hoy es vencido; un pendiente sigue pendiente aunque tenga fecha
 * (todavía no se validó nada que pueda vencer).
 */
export function sealState(seal: Pick<PartnerSeal, 'status' | 'expiresAt'>, today: string): SealState {
  if (seal.status === 'revoked') return 'revoked'
  if (seal.status === 'pending') return 'pending'
  if (seal.expiresAt && seal.expiresAt < today) return 'expired'
  return 'verified'
}

/** Días hasta que vence (negativo = vencido hace N). `null` sin vencimiento. */
export function daysToExpiry(expiresAt: string | null, today: string): number | null {
  if (!expiresAt) return null
  const ms = Date.parse(`${expiresAt}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)
  return Math.round(ms / 86_400_000)
}

/** Avisa en la ficha cuando un verificado vence dentro de este plazo. */
export const SEAL_EXPIRY_WARN_DAYS = 30

/** Lo que el formulario de asignar valida, igual que lo validaría el backend. */
export function validateSealGrant(
  seal: Seal | undefined,
  input: { status: StoredSealStatus; source: string; expiresAt: string },
  today: string,
): string | null {
  if (!seal) return 'Elegí un sello.'
  if (input.status === 'revoked') return 'Un sello se asigna pendiente o verificado.'
  if (input.source.trim() === '') return 'Decí de dónde sale (CSV de la red, póliza vista, llamada…).'
  if (input.expiresAt !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(input.expiresAt)) return 'La fecha de vencimiento no es válida.'
  if (seal.requiresExpiry && input.expiresAt === '') return `«${seal.name}» vence: cargá hasta cuándo vale.`
  if (input.status === 'verified' && input.expiresAt !== '' && input.expiresAt < today)
    return 'No se puede verificar un sello que ya venció.'
  return null
}

// ── Importar el CSV de una red ──────────────────────────────────────────────

/** Por qué clave se cruzó una fila con un proveedor, en orden de confianza. */
export const MATCH_KEYS = ['phone', 'cuit', 'address', 'name'] as const
export type MatchKey = (typeof MATCH_KEYS)[number]

export const MATCH_KEY_LABELS: Record<MatchKey, string> = {
  phone: 'Teléfono',
  cuit: 'CUIT',
  address: 'Dirección',
  name: 'Nombre exacto',
}

export const SEAL_CSV_COLUMNS = ['name', 'phone', 'cuit', 'address', 'expiresAt'] as const
export type SealCsvColumn = (typeof SEAL_CSV_COLUMNS)[number]

export const SEAL_CSV_COLUMN_LABELS: Record<SealCsvColumn, string> = {
  name: 'Nombre',
  phone: 'Teléfono',
  cuit: 'CUIT',
  address: 'Dirección',
  expiresAt: 'Vence',
}

const SEAL_HEADER_ALIASES: Record<SealCsvColumn, ReadonlyArray<string>> = {
  // Ya normalizados con `normalizeForMatch`.
  name: ['nombre', 'name', 'razon-social', 'prestador', 'proveedor', 'taller', 'comercio', 'fantasia', 'nombre-de-fantasia'],
  phone: ['telefono', 'tel', 'phone', 'whatsapp', 'celular', 'cel', 'movil'],
  cuit: ['cuit', 'cuil', 'cuit-cuil', 'nro-cuit'],
  address: ['direccion', 'domicilio', 'address', 'calle', 'ubicacion'],
  expiresAt: ['vence', 'vencimiento', 'vigencia', 'vigente-hasta', 'hasta', 'expira'],
}

export function detectSealCsvColumns(header: ReadonlyArray<string>): Record<SealCsvColumn, number | null> {
  const norm = header.map((h) => normalizeForMatch(h))
  const out = {} as Record<SealCsvColumn, number | null>
  for (const col of SEAL_CSV_COLUMNS) {
    const aliases = SEAL_HEADER_ALIASES[col]
    const exact = norm.findIndex((h) => aliases.includes(h))
    const partial = exact >= 0 ? exact : norm.findIndex((h) => aliases.some((a) => h.startsWith(a)))
    out[col] = partial >= 0 ? partial : null
  }
  return out
}

/** CUIT: 11 dígitos, sin guiones. Otra cosa no se cruza. */
export function normalizeCuit(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/[^0-9]/g, '')
  return /^[0-9]{11}$/.test(d) ? d : null
}

/**
 * Dirección comparable: `normalizeForMatch` + abreviaturas fijas. Sólo
 * IGUALDAD de este texto cuenta como cruce: "Av. Rivadavia 1234" y "Avenida
 * Rivadavia 1234" se cruzan; "Rivadavia 1234, CABA" y "Rivadavia 1234" NO.
 * Exige altura (algún dígito): una calle sola no identifica a nadie.
 */
export function normalizeAddress(raw: string | null | undefined): string | null {
  let v = normalizeForMatch(raw ?? '')
  if (v === '' || !/[0-9]/.test(v)) return null
  const swaps: ReadonlyArray<[RegExp, string]> = [
    [/(^|-)avenida(-|$)/g, '$1av$2'],
    [/(^|-)avda(-|$)/g, '$1av$2'],
    [/(^|-)general(-|$)/g, '$1gral$2'],
    [/(^|-)doctor(-|$)/g, '$1dr$2'],
    [/(^|-)numero(-|$)/g, '$1$2'],
    [/(^|-)nro(-|$)/g, '$1$2'],
    [/(^|-)n(-|$)/g, '$1$2'],
  ]
  for (const [re, to] of swaps) {
    // Dos pasadas: un reemplazo consume el guion que necesita el siguiente.
    v = v.replace(re, to).replace(re, to)
  }
  return v.replace(/-+/g, '-').replace(/^-|-$/g, '')
}

/** Nombre comparable: `normalizeForMatch`, nada más. Sin parecidos. */
export function normalizeName(raw: string | null | undefined): string | null {
  const v = normalizeForMatch(raw ?? '')
  return v === '' ? null : v
}

/** Lo mínimo de un proveedor para cruzar. Cada campo `null` = no hay dato. */
export interface SealMatchPartner {
  id: string
  name: string
  status: string
  phoneDigits: string | null
  /** `partners.cuit` no existe: hoy es siempre `null`. */
  cuit: string | null
  /** `null` si no se pidió la ficha de cada proveedor (cruce por dirección apagado). */
  address: string | null
}

export interface SealCsvRow {
  index: number
  name: string
  phone: string
  cuit: string
  address: string
  expiresAt: string
}

export type SealRowVerdict =
  /** Un solo proveedor, por una o más claves. */
  | 'match'
  /** Claves distintas apuntan a proveedores distintos: decide una persona. */
  | 'conflict'
  /** Una clave apunta a varios proveedores (dos sucursales con el mismo número). */
  | 'ambiguous'
  | 'none'

export const SEAL_ROW_VERDICT_LABELS: Record<SealRowVerdict, string> = {
  match: 'Cruza con un proveedor',
  conflict: 'Las claves no coinciden',
  ambiguous: 'Varios proveedores',
  none: 'Sin cruce',
}

export interface SealRowMatch {
  row: SealCsvRow
  verdict: SealRowVerdict
  /** Cada proveedor candidato con las claves por las que cruzó. */
  candidates: Array<{ partnerId: string; keys: Array<MatchKey> }>
  /** Qué claves traía la fila (normalizadas y válidas). */
  usableKeys: Array<MatchKey>
  /** `YYYY-MM-DD` si la columna "vence" traía una fecha legible. */
  expiresAt: string | null
}

/** `31/12/2026`, `2026-12-31` → `2026-12-31`. Otra cosa → `null`. */
export function parseCsvDate(raw: string): string | null {
  const v = raw.trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(v)
  if (m) {
    const [, d, mo, y] = m
    const iso = `${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}`
    return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso
  }
  return null
}

/**
 * El cruce de una fila contra el directorio. Reglas fijas:
 *
 * - teléfono: `normalizeArPhone` de los dos lados (el mismo de Comercial);
 * - CUIT: 11 dígitos iguales (los proveedores no tienen CUIT todavía);
 * - dirección: `normalizeAddress` igual (sólo si se cargaron las direcciones);
 * - nombre: `normalizeForMatch` igual.
 *
 * Nunca se cruza por "parecido". Si dos claves llevan a proveedores distintos,
 * la fila queda en `conflict` y no se preselecciona nada.
 */
export function matchSealRow(row: SealCsvRow, index: SealMatchIndex): SealRowMatch {
  const keys: Array<[MatchKey, string | null, Map<string, Array<string>>]> = [
    ['phone', normalizeArPhone(row.phone), index.byPhone],
    ['cuit', normalizeCuit(row.cuit), index.byCuit],
    ['address', normalizeAddress(row.address), index.byAddress],
    ['name', normalizeName(row.name), index.byName],
  ]
  const usableKeys: Array<MatchKey> = []
  const byPartner = new Map<string, Array<MatchKey>>()
  let ambiguous = false
  for (const [key, value, map] of keys) {
    if (value === null) continue
    usableKeys.push(key)
    const ids = map.get(value) ?? []
    if (ids.length > 1) ambiguous = true
    for (const id of ids) byPartner.set(id, [...(byPartner.get(id) ?? []), key])
  }
  const candidates = [...byPartner.entries()]
    .map(([partnerId, ks]) => ({ partnerId, keys: ks }))
    .sort((a, b) => MATCH_KEYS.indexOf(a.keys[0]!) - MATCH_KEYS.indexOf(b.keys[0]!))
  const verdict: SealRowVerdict =
    candidates.length === 0 ? 'none' : candidates.length === 1 ? 'match' : ambiguous ? 'ambiguous' : 'conflict'
  return { row, verdict, candidates, usableKeys, expiresAt: row.expiresAt ? parseCsvDate(row.expiresAt) : null }
}

export interface SealMatchIndex {
  byPhone: Map<string, Array<string>>
  byCuit: Map<string, Array<string>>
  byAddress: Map<string, Array<string>>
  byName: Map<string, Array<string>>
}

/** Los índices por clave normalizada → ids de proveedor. */
export function buildSealMatchIndex(partners: ReadonlyArray<SealMatchPartner>): SealMatchIndex {
  const add = (map: Map<string, Array<string>>, key: string | null, id: string) => {
    if (key === null) return
    const prev = map.get(key) ?? []
    if (!prev.includes(id)) map.set(key, [...prev, id])
  }
  const byPhone = new Map<string, Array<string>>()
  const byCuit = new Map<string, Array<string>>()
  const byAddress = new Map<string, Array<string>>()
  const byName = new Map<string, Array<string>>()
  for (const p of partners) {
    add(byPhone, p.phoneDigits, p.id)
    add(byCuit, normalizeCuit(p.cuit), p.id)
    add(byAddress, normalizeAddress(p.address), p.id)
    add(byName, normalizeName(p.name), p.id)
  }
  return { byPhone, byCuit, byAddress, byName }
}

export const SEAL_IMPORT_MAX = 2000
