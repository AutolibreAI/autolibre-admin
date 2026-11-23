import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { listPartnerPlans } from './partner-plans.repo'
import { listPartnerProposalUsageMonthly } from './partner-quote-volume.repo'
import { PROPOSAL_COUNT_START, baMonthKey, capTone, effectivePlans } from '~/lib/partner-plans'
import type { DispatchPartnerFactsResult } from '~/lib/partner-dispatch'

/**
 * Despacho por WhatsApp — el ÚNICO SQL de la feature, y es un guard.
 *
 * Todo lo demás (borrador, aprobación, seguimiento) va por HTTP al backend.
 * Esto sólo evita pegarle a un backend cuya base todavía no tiene la 0142:
 * sin `partner_outreach` la tarjeta dice "falta desplegar" sin hacer fetch.
 * Ni una lectura ni una escritura sobre `partner_outreach` desde el panel.
 * → `.claude/rules/partner-dispatch.md`
 */
export async function partnerDispatchAvailability(opts: { signal?: AbortSignal } = {}): Promise<boolean> {
  void opts.signal
  const row = await sqlOne<{ has_table: boolean }>(
    `select to_regclass('public.partner_outreach') is not null as has_table`,
  )
  return row?.has_table === true
}

/**
 * Lo que el borrador del backend no trae de cada taller ACTIVO: zona, horario,
 * Aliado, WhatsApp, plan efectivo y propuestas usadas este mes (2026-11-20).
 * Sólo lectura, sobre `partners` + el billing + el conteo de
 * `/partners/propuestas` — no toca `partner_outreach`. Un taller del borrador
 * que no esté acá (se pausó entre medio) se muestra sin estos datos.
 */
export async function dispatchPartnerFacts(): Promise<DispatchPartnerFactsResult> {
  const month = baMonthKey(new Date())
  const [partners, plans, usage] = await Promise.all([
    sql<{ id: string; tier: string | null; coverage_zone: string; hours: string | null; modality: string | null; whatsapp: string | null }>(
      `select id, tier::text as tier, coverage_zone, nullif(btrim(hours), '') as hours,
              nullif(btrim(modality), '') as modality, nullif(btrim(whatsapp), '') as whatsapp
         from partners where status = 'active'`,
    ),
    listPartnerPlans(),
    listPartnerProposalUsageMonthly(PROPOSAL_COUNT_START),
  ])
  const effective = effectivePlans(plans, partners.map((p) => p.id))
  const used = new Map<string, number>()
  if (usage.available) {
    for (const r of usage.rows) {
      if (r.partnerId && r.month === month) used.set(r.partnerId, (used.get(r.partnerId) ?? 0) + r.sent + r.withdrawn)
    }
  }
  const byPartner: DispatchPartnerFactsResult['byPartner'] = {}
  for (const p of partners) {
    const plan = effective.get(p.id) ?? null
    const n = usage.available ? (used.get(p.id) ?? 0) : null
    byPartner[p.id] = {
      tier: p.tier,
      coverageZone: p.coverage_zone,
      hours: p.hours,
      modality: p.modality,
      whatsapp: p.whatsapp,
      plan: plan ? { code: plan.code, name: plan.name, cap: plan.cap } : null,
      usedThisMonth: n,
      capTone: capTone(n ?? 0, plan, p.tier),
    }
  }
  return { month, plansAvailable: plans.available, usageAvailable: usage.available, byPartner }
}
