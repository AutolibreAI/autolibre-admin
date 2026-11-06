import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { activeUserIdsSince } from './activity-feed.repo'
import { REFERRAL_ACTIVE_WINDOW_DAYS } from '~/lib/partner-referrals'
import type { PartnerReferralsResult, ReferralUnit } from '~/lib/partner-referrals'

/**
 * Taller de cabecera (Partners › Taller de cabecera). Lee las dos funciones de
 * la migración 027; acá sólo se arma el conjunto de usuarios activos (la
 * definición de Métricas vive en TS, `activeUserIdsSince`) y se mapea.
 *
 * Guard antes de llamar, con `to_regclass`/`to_regprocedure` y no un
 * try/catch: un catch que se traga errores de SQL termina tragándose los
 * reales. Sin la 027 o sin las tablas del backend, la pantalla dice qué falta.
 */
async function availability(): Promise<string | null> {
  const row = await sqlOne<{ missing: Array<string> | null }>(
    `select array_remove(array[
       case when to_regprocedure('ops.partner_referral_summary(uuid[])') is null
            then 'la migración 027 de ops (ops.partner_referral_summary)' end,
       case when to_regclass('public.partner_referral_codes') is null
            then 'partner_referral_codes (backend 0126)' end,
       case when to_regclass('public.preferred_partners') is null
            then 'preferred_partners (backend 0126)' end,
       case when to_regclass('public.partner_claim_codes') is null
            then 'partner_claim_codes (backend 0144)' end
     ], null) as missing`,
  )
  const missing = row?.missing ?? []
  return missing.length > 0 ? missing.join(', ') : null
}

interface SummaryRow {
  referral_code_id: string
  code: string
  code_label: string | null
  code_status: string
  code_created_on: string
  partner_id: string
  partner_name: string
  partner_status: string
  partner_tier: string
  partner_claimed: boolean
  links_total: number
  links_removed: number
  users_current: number
  vehicles_current: number
  active_current: number | null
  first_link_on: string | null
  last_link_on: string | null
}

const PG_UNIT: Record<ReferralUnit, 'week' | 'month'> = { semana: 'week', mes: 'month' }

export async function partnerReferrals(unit: ReferralUnit): Promise<PartnerReferralsResult> {
  const missing = await availability()
  if (missing) return { available: false, missing }

  const since = new Date(Date.now() - REFERRAL_ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const activeIds = await activeUserIdsSince(since)

  // Las fechas salen como texto: un `date` de pg llega a medianoche LOCAL y
  // `toISOString()` lo correría un día (`ai-costs.md`).
  const codes = await sql<SummaryRow>(
    `select s.referral_code_id, s.code, s.code_label, s.code_status,
            to_char(s.code_created_on, 'YYYY-MM-DD') as code_created_on,
            s.partner_id, s.partner_name, s.partner_status, s.partner_tier, s.partner_claimed,
            s.links_total, s.links_removed, s.users_current, s.vehicles_current, s.active_current,
            to_char(s.first_link_on, 'YYYY-MM-DD') as first_link_on,
            to_char(s.last_link_on, 'YYYY-MM-DD') as last_link_on
       from ops.partner_referral_summary($1::uuid[]) s`,
    [activeIds],
  )
  const series = await sql<{ bucket: string; partner_id: string; links: number; removals: number }>(
    `select bucket, partner_id, links, removals from ops.partner_referral_links_series($1)`,
    [PG_UNIT[unit]],
  )

  return {
    available: true,
    unit,
    activeWindowDays: REFERRAL_ACTIVE_WINDOW_DAYS,
    codes: codes.map((r) => ({
      codeId: r.referral_code_id,
      code: r.code,
      label: r.code_label,
      codeStatus: r.code_status,
      codeCreatedOn: r.code_created_on,
      partnerId: r.partner_id,
      partnerName: r.partner_name,
      partnerStatus: r.partner_status,
      partnerTier: r.partner_tier,
      partnerClaimed: r.partner_claimed,
      linksTotal: Number(r.links_total),
      linksRemoved: Number(r.links_removed),
      usersCurrent: Number(r.users_current),
      vehiclesCurrent: Number(r.vehicles_current),
      activeCurrent: r.active_current === null ? null : Number(r.active_current),
      firstLinkOn: r.first_link_on,
      lastLinkOn: r.last_link_on,
    })),
    series: series.map((r) => ({
      bucket: r.bucket,
      partnerId: r.partner_id,
      links: Number(r.links),
      removals: Number(r.removals),
    })),
  }
}
