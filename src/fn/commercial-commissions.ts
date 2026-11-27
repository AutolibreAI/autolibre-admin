import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import {
  COMMISSIONS_UNAVAILABLE,
  awardRow,
  setAwardSchema,
  type AwardPartnerFacts,
} from '~/lib/commercial-commissions'
import { PARTNER_FEE_CONFIG } from '~/lib/partner-fees-config'
import { sqlOne } from '~/server/db'
import { listAwardFacts, setCommercialAward, setTeamMemberEarnsAward } from '~/server/commercial-commissions.repo'
import { adminMiddleware } from './middleware'

/**
 * Liquidaciones a comerciales — el borde RPC. `adminMiddleware`: es plata.
 * El monto, el comercial y la referencia los pone el SERVIDOR re-calculando la
 * regla, nunca el payload.
 */

export type CommissionsData =
  | { available: false }
  | { available: true; facts: Array<AwardPartnerFacts>; today: string; premioPorAlta: number | null }

export const getCommissionsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<CommissionsData> => {
    const [facts, today] = await Promise.all([
      listAwardFacts(),
      sqlOne<{ d: string }>(`select to_char(now() at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD') as d`),
    ])
    if (!facts) return { available: false }
    return { available: true, facts, today: today?.d ?? '', premioPorAlta: PARTNER_FEE_CONFIG.PREMIO_POR_ALTA }
  })

export const setCommercialAwardFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(setAwardSchema)
  .handler(async ({ data, context }) => {
    const facts = await listAwardFacts()
    if (!facts) throw new Error(COMMISSIONS_UNAVAILABLE)
    const f = facts.find((x) => x.partnerId === data.partnerId)
    if (!f) throw new Error(`AWARD_NOT_DUE: ${data.partnerId}`)
    const row = awardRow({ ...f, award: null }, PARTNER_FEE_CONFIG.PREMIO_POR_ALTA)

    if (data.status === 'pendiente') {
      await setCommercialAward(
        { partnerId: f.partnerId, status: 'pendiente', memberId: null, amount: null, reference: null, paidOn: null, note: data.note ?? null, voidReason: null },
        context.user.id,
      )
      return { ok: true as const }
    }
    if (data.status === 'pagado') {
      if (row.status !== 'pendiente' || !f.member.earnsAward) throw new Error(`AWARD_NOT_DUE: ${data.partnerId}`)
      if (row.amount === null) throw new Error('AWARD_AMOUNT_UNDEFINED')
      await setCommercialAward(
        {
          partnerId: f.partnerId,
          status: 'pagado',
          memberId: f.member.id,
          amount: row.amount,
          reference: row.reference,
          paidOn: data.paidOn,
          note: data.note || null,
          voidReason: null,
        },
        context.user.id,
      )
      return { ok: true as const }
    }
    // Anular se puede esperando o pendiente (p. ej. el alta no fue del comercial).
    await setCommercialAward(
      {
        partnerId: f.partnerId,
        status: 'anulado',
        memberId: f.member.id,
        amount: row.amount,
        reference: row.reference,
        paidOn: null,
        note: null,
        voidReason: data.voidReason,
      },
      context.user.id,
    )
    return { ok: true as const }
  })

export const setTeamMemberEarnsAwardFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ memberId: z.uuid(), value: z.boolean() }))
  .handler(async ({ data, context }) => {
    await setTeamMemberEarnsAward(data.memberId, data.value, context.user.id)
    return { ok: true as const }
  })
