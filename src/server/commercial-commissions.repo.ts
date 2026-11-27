import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { listFeeJobFacts, listFeePartnerFacts, listPackagesData } from './partner-fees.repo'
import { partnerPlansAvailability } from './partner-plans.repo'
import { teamAvailable } from './team.repo'
import { PARTNER_FEE_CONFIG } from '~/lib/partner-fees-config'
import { classifyFeeJobs } from '~/lib/partner-fees'
import { COMMISSIONS_UNAVAILABLE, type AwardPartnerFacts } from '~/lib/commercial-commissions'

/**
 * Liquidaciones a comerciales — migración 045 (+ 035 «Alta por» y 038 para el
 * primer trabajo). Lee `public` y `ops`; escribe sólo `ops.commercial_award`
 * por su SP. → `~/lib/commercial-commissions`.
 */

const BA = 'America/Argentina/Buenos_Aires'
const USER_LABEL = (a: string) => `coalesce(nullif(btrim(${a}.name), ''), ${a}.email)`

/** Se cachea sólo el `true`. */
let seen = false
export async function commissionsAvailable(): Promise<boolean> {
  if (seen) return true
  if (!(await teamAvailable())) return false
  const row = await sqlOne<{ ok: boolean }>(
    `select to_regclass('ops.commercial_award') is not null
        and to_regclass('ops.partner_fee_charge') is not null
        and exists (select 1 from information_schema.columns
                     where table_schema = 'ops' and table_name = 'team_member' and column_name = 'earns_award') as ok`,
  )
  seen = row?.ok === true
  return seen
}

/** Todos los proveedores con «Alta por», con lo que hace falta para su premio. */
export async function listAwardFacts(): Promise<Array<AwardPartnerFacts> | null> {
  if (!(await commissionsAvailable())) return null

  const [partners, billing, feeFacts, packages, awards] = await Promise.all([
    sql<{
      id: string
      name: string
      created_on: string
      member_id: string
      member_name: string
      member_active: boolean
      earns_award: boolean
    }>(
      `select p.id, p.name, to_char(p.created_at at time zone '${BA}', 'YYYY-MM-DD') as created_on,
              m.id as member_id, m.name as member_name, m.active as member_active, m.earns_award
         from partners p
         join ops.partner_application_sourcer s on s.application_id = p.application_id
         join ops.team_member m on m.id = s.member_id`,
    ),
    partnerPlansAvailability(),
    listFeeJobFacts(),
    listPackagesData(),
    sql<{
      partner_id: string
      member_id: string
      member_name: string
      status: 'pagado' | 'anulado'
      amount: string | null
      reference: string | null
      paid_on: string | null
      note: string | null
      void_reason: string | null
      updated_by: string | null
    }>(
      `select a.partner_id, a.member_id, m.name as member_name, a.status, a.amount::text as amount, a.reference,
              to_char(a.paid_on, 'YYYY-MM-DD') as paid_on, a.note, a.void_reason, ${USER_LABEL('u')} as updated_by
         from ops.commercial_award a
         join ops.team_member m on m.id = a.member_id
         left join users u on u.id = a.updated_by`,
    ),
  ])

  const ids = partners.map((p) => p.id)
  const subs = billing
    ? await sql<{ partner_id: string; name: string; day: string }>(
        `select distinct on (s.partner_id) s.partner_id, sp.name,
                to_char(s.authorized_at at time zone '${BA}', 'YYYY-MM-DD') as day
           from partner_subscriptions s
           join subscription_plans sp on sp.id = s.plan_id
          where s.authorized_at is not null and sp.price_amount > 0 and s.partner_id = any($1::uuid[])
          order by s.partner_id, s.authorized_at`,
        [ids],
      )
    : []

  // El primer trabajo sale de la MISMA regla que Liquidaciones a proveedores.
  const firstJobs = new Map<string, { publicNumber: number; day: string }>()
  if (feeFacts) {
    const ids2 = new Set<string>()
    for (const j of feeFacts) {
      if (j.selectedPartnerId) ids2.add(j.selectedPartnerId)
      if (j.attribution) ids2.add(j.attribution.partnerId)
    }
    const fp = await listFeePartnerFacts([...ids2])
    for (const j of classifyFeeJobs(feeFacts, new Map(fp.map((p) => [p.id, p])), PARTNER_FEE_CONFIG, packages)) {
      if (j.isFirstOfPartner && j.partnerId) firstJobs.set(j.partnerId, { publicNumber: j.publicNumber, day: j.jobDay })
    }
  }

  const subBy = new Map(subs.map((s) => [s.partner_id, s]))
  const awardBy = new Map(awards.map((a) => [a.partner_id, a]))
  return partners.map((p) => {
    const s = subBy.get(p.id)
    const a = awardBy.get(p.id)
    return {
      partnerId: p.id,
      partnerName: p.name,
      partnerCreatedOn: p.created_on,
      member: { id: p.member_id, name: p.member_name, active: p.member_active, earnsAward: p.earns_award },
      firstJob: firstJobs.get(p.id) ?? null,
      subscription: s ? { planName: s.name, day: s.day } : null,
      award: a
        ? {
            memberId: a.member_id,
            memberName: a.member_name,
            status: a.status,
            amount: a.amount === null ? null : Number(a.amount),
            reference: a.reference,
            paidOn: a.paid_on,
            note: a.note,
            voidReason: a.void_reason,
            updatedByName: a.updated_by,
          }
        : null,
    }
  })
}

export async function setCommercialAward(
  input: {
    partnerId: string
    status: 'pendiente' | 'pagado' | 'anulado'
    memberId: string | null
    amount: number | null
    reference: string | null
    paidOn: string | null
    note: string | null
    voidReason: string | null
  },
  actorId: string,
): Promise<void> {
  if (!(await commissionsAvailable())) throw new Error(COMMISSIONS_UNAVAILABLE)
  await sql(
    `select ops.set_commercial_award(
       p_partner_id => $1, p_status => $2, p_member_id => $3, p_amount => $4, p_reference => $5,
       p_paid_on => $6::date, p_note => $7, p_void_reason => $8, p_actor_id => $9)`,
    [
      input.partnerId,
      input.status,
      input.memberId,
      input.amount,
      input.reference,
      input.paidOn,
      input.note,
      input.voidReason,
      actorId,
    ],
  )
}

/** «Cobra premio» de una persona del equipo (045). */
export async function setTeamMemberEarnsAward(memberId: string, value: boolean, actorId: string): Promise<void> {
  if (!(await commissionsAvailable())) throw new Error(COMMISSIONS_UNAVAILABLE)
  await sql(`select ops.set_team_member_earns_award(p_id => $1, p_value => $2, p_actor_id => $3)`, [
    memberId,
    value,
    actorId,
  ])
}
