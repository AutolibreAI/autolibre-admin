import { z } from 'zod'
import { formatArs } from '~/lib/format'
import { PARTNER_FEE_CONFIG } from '~/lib/partner-fees-config'
import { canonicalWhatsAppDigits } from '~/lib/partners'
import { toWhatsAppAR } from '~/lib/whatsapp-ar'

/**
 * Aviso del cambio del plan gratis (`/partners/plan-gratis`, migración 042) —
 * client-safe: tipos, schemas, etiquetas, filtros, el texto del aviso y la
 * traducción de errores. → `.claude/rules/partner-free-plan-notice.md`
 *
 * El plan gratis cambió (2026-11-26): el PRIMER trabajo que le llevamos a un
 * proveedor es gratis, y desde el SEGUNDO se cobra `FEE_POR_TRABAJO` fijo por
 * trabajo. Esta pantalla sólo registra QUIÉN YA ESTÁ AVISADO. No toca la regla
 * de Liquidaciones (`PRIMER_CLIENTE_GRATIS` sigue apagado ahí).
 */

export const FREE_PLAN_NOTICE_UNAVAILABLE = 'FREE_PLAN_NOTICE_UNAVAILABLE'

export const FREE_PLAN_NOTICE_CHANNELS = ['whatsapp', 'llamada', 'en_persona'] as const
export type FreePlanNoticeChannel = (typeof FREE_PLAN_NOTICE_CHANNELS)[number]

export const FREE_PLAN_NOTICE_CHANNEL_LABELS: Record<FreePlanNoticeChannel, string> = {
  whatsapp: 'WhatsApp',
  llamada: 'Llamada',
  en_persona: 'En persona',
}

export function freePlanNoticeChannelLabel(c: string): string {
  return (FREE_PLAN_NOTICE_CHANNEL_LABELS as Record<string, string>)[c] ?? c
}

export const FREE_PLAN_NOTICE_NOTE_MAX = 1000

/** El aviso vigente de un proveedor. */
export interface FreePlanNotice {
  channel: string
  note: string | null
  /** ISO. Se muestra con `formatDateTimeBuenosAires` (zona pineada: no rompe la hidratación). */
  notifiedAt: string
  /** Quién lo marcó (usuario del panel). `null` = usuario borrado. */
  notifiedByLabel: string | null
}

export interface FreePlanNoticeRow {
  partnerId: string
  name: string
  zone: string | null
  whatsapp: string | null
  status: string
  tier: string
  notice: FreePlanNotice | null
}

export type FreePlanNoticeList =
  | { available: false; reason: 'migration' | 'billing' }
  | { available: true; rows: Array<FreePlanNoticeRow> }

// ── Filtros (en el cliente: decenas de filas) ────────────────────────────────

export const FREE_PLAN_NOTICE_STATES = ['all', 'sin_avisar', 'avisados'] as const
export type FreePlanNoticeState = (typeof FREE_PLAN_NOTICE_STATES)[number]

export const FREE_PLAN_NOTICE_STATE_LABELS: Record<FreePlanNoticeState, string> = {
  all: 'Todos',
  sin_avisar: 'Sin avisar',
  avisados: 'Avisados',
}

/** Search params calificados `freePlanNotice*` (`notifications.md`); `q` se comparte. */
export const freePlanNoticeSearchSchema = z.object({
  q: z.string().trim().max(80).optional().catch(undefined),
  freePlanNoticeState: z.enum(FREE_PLAN_NOTICE_STATES).optional().catch(undefined),
  freePlanNoticeChannel: z.enum(FREE_PLAN_NOTICE_CHANNELS).optional().catch(undefined),
  /** Los pausados no reciben pedidos hoy; se ven sólo pidiéndolos. */
  freePlanNoticePaused: z.boolean().optional().catch(undefined),
})
export type FreePlanNoticeSearch = z.infer<typeof freePlanNoticeSearchSchema>

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** El universo del contador: activos, más pausados si se pidieron. */
export function inNoticeUniverse(r: FreePlanNoticeRow, s: Pick<FreePlanNoticeSearch, 'freePlanNoticePaused'>): boolean {
  return r.status === 'active' || (s.freePlanNoticePaused === true && r.status === 'paused')
}

export function matchesFreePlanNoticeFilters(r: FreePlanNoticeRow, s: FreePlanNoticeSearch): boolean {
  if (!inNoticeUniverse(r, s)) return false
  const state = s.freePlanNoticeState ?? 'all'
  if (state === 'avisados' && !r.notice) return false
  if (state === 'sin_avisar' && r.notice) return false
  if (s.freePlanNoticeChannel && r.notice?.channel !== s.freePlanNoticeChannel) return false
  if (s.q) {
    const q = fold(s.q)
    const hay = fold([r.name, r.zone ?? '', r.whatsapp ?? ''].join(' '))
    if (!hay.includes(q)) return false
  }
  return true
}

/** «X de Y avisados», sobre el universo (no sobre lo filtrado por estado o texto). */
export function freePlanNoticeProgress(
  rows: ReadonlyArray<FreePlanNoticeRow>,
  s: Pick<FreePlanNoticeSearch, 'freePlanNoticePaused'>,
): { notified: number; total: number } {
  const universe = rows.filter((r) => inNoticeUniverse(r, s))
  return { notified: universe.filter((r) => r.notice).length, total: universe.length }
}

// ── El aviso por WhatsApp ────────────────────────────────────────────────────

/** El texto del aviso. El monto sale de la config de fees, nunca escrito a mano. */
export function freePlanNoticeMessage(partnerName: string, fee: number = PARTNER_FEE_CONFIG.FEE_POR_TRABAJO): string {
  return (
    `Hola ${partnerName.trim()}! Te escribimos de AutoLibre para contarte un cambio en el plan gratis: ` +
    `el primer trabajo que te llevamos es gratis, y desde el segundo se cobra un fee fijo de ${formatArs(fee)} por trabajo. ` +
    `Si querés ver los planes pagos o tenés alguna duda, respondenos por acá.`
  )
}

/**
 * Los dígitos para `wa.me`: primero la forma canónica que ya usa todo el repo;
 * si no, `toWhatsAppAR` (que nunca inventa una característica). Sin ninguna
 * de las dos, no hay link.
 */
export function freePlanNoticeWhatsAppDigits(phone: string | null): string | null {
  if (!phone) return null
  const canonical = canonicalWhatsAppDigits(phone)
  if (canonical) return canonical
  const ar = toWhatsAppAR(phone)
  return ar.ok ? ar.digits : null
}

export function freePlanNoticeWhatsAppUrl(phone: string | null, partnerName: string): string | null {
  const digits = freePlanNoticeWhatsAppDigits(phone)
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(freePlanNoticeMessage(partnerName))}` : null
}

// ── Escritura ────────────────────────────────────────────────────────────────

export const setFreePlanNoticeSchema = z.discriminatedUnion('notified', [
  z.object({
    partnerId: z.string().uuid(),
    notified: z.literal(true),
    channel: z.enum(FREE_PLAN_NOTICE_CHANNELS, { message: 'Elegí por dónde lo avisaste.' }),
    note: z.string().trim().max(FREE_PLAN_NOTICE_NOTE_MAX, 'La nota es demasiado larga (máx. 1000).').optional(),
    /** Lo que vio el operador (control de pisada). */
    expectedNotified: z.boolean(),
  }),
  z.object({
    partnerId: z.string().uuid(),
    notified: z.literal(false),
    note: z.string().trim().max(FREE_PLAN_NOTICE_NOTE_MAX, 'La nota es demasiado larga (máx. 1000).').optional(),
    expectedNotified: z.boolean(),
  }),
])
export type SetFreePlanNoticeInput = z.infer<typeof setFreePlanNoticeSchema>

export function readableFreePlanNoticeError(raw: string): string {
  if (raw.startsWith(FREE_PLAN_NOTICE_UNAVAILABLE)) {
    return 'Falta aplicar la migración 042 (aviso del plan gratis) en esta base.'
  }
  if (raw.startsWith('FREE_PLAN_NOTICE_CHANGED')) {
    return 'Mientras tanto alguien cambió el aviso de este proveedor. Recargamos: revisá y volvé a intentar.'
  }
  if (raw.startsWith('CHANNEL_REQUIRED')) return 'Elegí por dónde lo avisaste.'
  if (raw.startsWith('INVALID_CHANNEL')) return 'Canal inválido.'
  if (raw.startsWith('NOTE_TOO_LONG')) return 'La nota es demasiado larga (máx. 1000).'
  if (raw.startsWith('PARTNER_NOT_FOUND')) return 'El proveedor ya no existe. Recargá.'
  if (raw === 'UNAUTHENTICATED') return 'Tu sesión venció. Volvé a entrar.'
  if (raw === 'FORBIDDEN') return 'Tu usuario no es admin.'
  return raw
}
