import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { listFeeJobFacts, listFeePartnerFacts } from './partner-fees.repo'
import { partnerPlansAvailability } from './partner-plans.repo'
import { teamAvailable } from './team.repo'
import { PARTNER_FEE_CONFIG } from '~/lib/partner-fees-config'
import { classifyFeeJobs } from '~/lib/partner-fees'
import { COMMISSIONS_UNAVAILABLE, type CommissionPartnerFacts } from '~/lib/commercial-commissions'

/**
 * Comisiones de los comerciales — migración 039 (+ 035 «Alta por» y, para el
 * fee del primer trabajo, 038). Lee `public` y `ops`; escribe sólo
 * `ops.commercial_commission_payment` por su SP.
 */

const BA = 'America/Argentina/Buenos_Aires'

export async function commissionsAvailable(): Promise<boolean> {
  if (!(await teamAvailable())) return false
  const row = await sqlOne<{ ok: boolean }>(
    `select to_regclass('ops.commercial_commission_payment') is not null as ok`,
  )
  return row?.ok === true
}

/** Todos los proveedores con «Alta por», con lo que hace falta para calcular su comisión. */
export async function listCommissionFacts(): Promise<Array<CommissionPartnerFacts> | null> {
  if (!(await commissionsAvailable())) return null

  const [partners, billing, feeFacts] = await Promise.all([
    sql<{ id: string; name: string; member_id: string; member_name: string; member_active: boolean }>(
      `select p.id, p.name, m.id as member_id, m.name as member_name, m.active as member_active
         from partners p
         join ops.partner_application_sourcer s on s.application_id = p.application_id
         join ops.team_member m on m.id = s.member_id`,
    ),
    partnerPlansAvailability(),
    listFeeJobFacts(),
  ])

  const ids = partners.map((p) => p.id)
  const [subs, payments] = await Promise.all([
    billing
      ? sql<{ partner_id: string; code: string; name: string; price: string; day: string }>(
          `select distinct on (s.partner_id) s.partner_id, sp.code, sp.name, sp.price_amount::text as price,
                  to_char(s.authorized_at at time zone '${BA}', 'YYYY-MM-DD') as day
             from partner_subscriptions s
             join subscription_plans sp on sp.id = s.plan_id
            where s.authorized_at is not null and sp.price_amount > 0 and s.partner_id = any($1::uuid[])
            order by s.partner_id, s.authorized_at`,
          [ids],
        )
      : Promise.resolve([]),
    sql<{ partner_id: string; member_id: string; member_name: string; kind: string; amount: string; reference: string | null; paid_on: string; note: string | null; paid_by: string | null }>(
      `select c.partner_id, c.member_id, m.name as member_name, c.kind, c.amount::text as amount, c.reference,
              to_char(c.paid_on, 'YYYY-MM-DD') as paid_on, c.note,
              coalesce(nullif(btrim(u.name), ''), u.email) as paid_by
         from ops.commercial_commission_payment c
         join ops.team_member m on m.id = c.member_id
         left join users u on u.id = c.paid_by`,
    ),
  ])

  // El fee del primer trabajo sale de la MISMA regla que Liquidaciones a proveedores.
  const firstJobs = new Map<string, NonNullable<CommissionPartnerFacts['firstJob']>>()
  if (feeFacts) {
    const ids2 = new Set<string>()
    for (const j of feeFacts) {
      if (j.selectedPartnerId) ids2.add(j.selectedPartnerId)
      if (j.attribution) ids2.add(j.attribution.partnerId)
    }
    const fp = await listFeePartnerFacts([...ids2])
    for (const j of classifyFeeJobs(feeFacts, new Map(fp.map((p) => [p.id, p])))) {
      if (!j.commercialFee || !j.partnerId) continue
      firstJobs.set(j.partnerId, {
        publicNumber: j.publicNumber,
        day: j.jobDay,
        amount: j.amount > 0 ? j.amount : PARTNER_FEE_CONFIG.FEE_POR_TRABAJO,
        feeStatus: j.status,
      })
    }
  }

  const subBy = new Map(subs.map((s) => [s.partner_id, s]))
  const payBy = new Map(payments.map((p) => [p.partner_id, p]))
  return partners.map((p) => {
    const s = subBy.get(p.id)
    const pay = payBy.get(p.id)
    return {
      partnerId: p.id,
      partnerName: p.name,
      member: { id: p.member_id, name: p.member_name, active: p.member_active },
      firstPaid: s ? { planName: s.name, planCode: s.code, price: Number(s.price), day: s.day } : null,
      firstJob: firstJobs.get(p.id) ?? null,
      payment: pay
        ? {
            memberId: pay.member_id,
            memberName: pay.member_name,
            kind: pay.kind,
            amount: Number(pay.amount),
            reference: pay.reference,
            paidOn: pay.paid_on,
            note: pay.note,
            paidByName: pay.paid_by,
          }
        : null,
    }
  })
}

export async function setCommissionPayment(
  input: {
    partnerId: string
    paid: boolean
    memberId: string | null
    kind: string | null
    amount: number | null
    reference: string | null
    paidOn: string | null
    note: string | null
  },
  actorId: string,
): Promise<void> {
  if (!(await commissionsAvailable())) throw new Error(COMMISSIONS_UNAVAILABLE)
  await sql(
    `select ops.set_commercial_commission_payment(
       p_partner_id => $1, p_paid => $2, p_member_id => $3, p_kind => $4, p_amount => $5,
       p_reference => $6, p_paid_on => $7, p_note => $8, p_actor_id => $9)`,
    [input.partnerId, input.paid, input.memberId, input.kind, input.amount, input.reference, input.paidOn, input.note, actorId],
  )
}
