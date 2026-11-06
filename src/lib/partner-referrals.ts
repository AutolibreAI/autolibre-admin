import { z } from 'zod'

/**
 * Taller de cabecera: cuántas personas y autos trae cada proveedor que
 * reparte un código de referido (Ser May y los que vengan).
 *
 * Datos: `ops.partner_referral_summary()` y `ops.partner_referral_links_series()`
 * (migración 027), sobre `partner_referral_codes` (la oferta) y
 * `preferred_partners` (el canje). `partner_claim_codes` NO es el canje de un
 * referido: es el código con el que el dueño reclama el taller; de ahí sólo
 * sale "reclamado por su dueño". Ver la cabecera de la 027.
 *
 * Sólo conteos: ningún id ni dato de persona llega al navegador.
 */

/** Ventana de "activo": la misma señal que Métricas, en los últimos N días. */
export const REFERRAL_ACTIVE_WINDOW_DAYS = 30

export const REFERRAL_UNITS = ['semana', 'mes'] as const
export type ReferralUnit = (typeof REFERRAL_UNITS)[number]

export const partnerReferralsSearchSchema = z.object({
  referralUnit: z.enum(REFERRAL_UNITS).catch('semana').default('semana'),
})

export interface ReferralCodeRow {
  codeId: string
  code: string
  label: string | null
  codeStatus: string
  codeCreatedOn: string
  partnerId: string
  partnerName: string
  partnerStatus: string
  partnerTier: string
  /** Su dueño ya canjeó un código de reclamo (`partner_claim_codes`). */
  partnerClaimed: boolean
  linksTotal: number
  linksRemoved: number
  usersCurrent: number
  vehiclesCurrent: number
  /** De `usersCurrent`, con actividad en la ventana. `null` = no se pudo medir. */
  activeCurrent: number | null
  firstLinkOn: string | null
  lastLinkOn: string | null
}

/** Una fila por proveedor: la suma de sus códigos. */
export interface ReferralPartnerRow {
  partnerId: string
  partnerName: string
  partnerStatus: string
  partnerTier: string
  partnerClaimed: boolean
  codes: number
  linksTotal: number
  linksRemoved: number
  usersCurrent: number
  vehiclesCurrent: number
  activeCurrent: number | null
  firstLinkOn: string | null
  lastLinkOn: string | null
}

export interface ReferralSeriesPoint {
  bucket: string
  partnerId: string
  links: number
  removals: number
}

export type PartnerReferralsResult =
  | { available: false; missing: string }
  | {
      available: true
      codes: Array<ReferralCodeRow>
      series: Array<ReferralSeriesPoint>
      unit: ReferralUnit
      activeWindowDays: number
    }

/**
 * Suma por proveedor. Las personas se suman código por código: una persona que
 * canjeó dos códigos del MISMO proveedor no puede tenerlo dos veces vigente
 * (índice único parcial de `preferred_partners` por usuario y partner), así
 * que la suma no duplica a nadie vigente.
 */
export function groupByPartner(codes: ReadonlyArray<ReferralCodeRow>): Array<ReferralPartnerRow> {
  const out = new Map<string, ReferralPartnerRow>()
  const minDay = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a < b ? a : b)
  const maxDay = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a > b ? a : b)
  for (const c of codes) {
    const prev = out.get(c.partnerId)
    if (!prev) {
      out.set(c.partnerId, {
        partnerId: c.partnerId,
        partnerName: c.partnerName,
        partnerStatus: c.partnerStatus,
        partnerTier: c.partnerTier,
        partnerClaimed: c.partnerClaimed,
        codes: 1,
        linksTotal: c.linksTotal,
        linksRemoved: c.linksRemoved,
        usersCurrent: c.usersCurrent,
        vehiclesCurrent: c.vehiclesCurrent,
        activeCurrent: c.activeCurrent,
        firstLinkOn: c.firstLinkOn,
        lastLinkOn: c.lastLinkOn,
      })
      continue
    }
    prev.codes += 1
    prev.linksTotal += c.linksTotal
    prev.linksRemoved += c.linksRemoved
    prev.usersCurrent += c.usersCurrent
    prev.vehiclesCurrent += c.vehiclesCurrent
    prev.activeCurrent = prev.activeCurrent === null || c.activeCurrent === null ? null : prev.activeCurrent + c.activeCurrent
    prev.firstLinkOn = minDay(prev.firstLinkOn, c.firstLinkOn)
    prev.lastLinkOn = maxDay(prev.lastLinkOn, c.lastLinkOn)
  }
  return [...out.values()].sort(
    (a, b) => b.usersCurrent - a.usersCurrent || b.linksTotal - a.linksTotal || a.partnerName.localeCompare(b.partnerName, 'es'),
  )
}

/** `YYYY-MM-DD` del lunes / día 1, para mostrar. */
export function referralBucketLabel(bucket: string, unit: ReferralUnit): string {
  const [y, m, d] = bucket.split('-')
  if (!y || !m || !d) return bucket
  return unit === 'mes' ? `${m}/${y}` : `sem. ${d}/${m}`
}

/**
 * Completa los períodos vacíos entre el primero y el último, para que el
 * gráfico no salte semanas. Fechas como texto `YYYY-MM-DD`, aritmética en UTC
 * sobre el día (no se corre por zona).
 */
export function fillReferralBuckets(points: ReadonlyArray<ReferralSeriesPoint>, unit: ReferralUnit): Array<{
  bucket: string
  links: number
  removals: number
}> {
  const byBucket = new Map<string, { links: number; removals: number }>()
  for (const p of points) {
    const prev = byBucket.get(p.bucket) ?? { links: 0, removals: 0 }
    byBucket.set(p.bucket, { links: prev.links + p.links, removals: prev.removals + p.removals })
  }
  const keys = [...byBucket.keys()].sort()
  if (keys.length === 0) return []
  const out: Array<{ bucket: string; links: number; removals: number }> = []
  const cur = new Date(`${keys[0]}T00:00:00Z`)
  const last = new Date(`${keys[keys.length - 1]}T00:00:00Z`)
  while (cur <= last) {
    const key = cur.toISOString().slice(0, 10)
    out.push({ bucket: key, ...(byBucket.get(key) ?? { links: 0, removals: 0 }) })
    if (unit === 'mes') cur.setUTCMonth(cur.getUTCMonth() + 1)
    else cur.setUTCDate(cur.getUTCDate() + 7)
  }
  return out
}
