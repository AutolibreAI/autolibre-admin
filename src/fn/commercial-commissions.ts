import { createServerFn } from '@tanstack/react-start'
import {
  COMMISSIONS_UNAVAILABLE,
  commissionRow,
  setCommissionPaymentSchema,
  type CommissionPartnerFacts,
} from '~/lib/commercial-commissions'
import { sqlOne } from '~/server/db'
import { listCommissionFacts, setCommissionPayment } from '~/server/commercial-commissions.repo'
import { adminMiddleware } from './middleware'

/**
 * Comisiones de los comerciales — el borde RPC. `adminMiddleware`: es plata.
 * El monto y el comercial los pone el SERVIDOR re-calculando la regla, nunca
 * el payload.
 */

export type CommissionsData =
  | { available: false }
  | { available: true; facts: Array<CommissionPartnerFacts>; today: string }

export const getCommissionsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<CommissionsData> => {
    const [facts, today] = await Promise.all([
      listCommissionFacts(),
      sqlOne<{ d: string }>(`select to_char(now() at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD') as d`),
    ])
    if (!facts) return { available: false }
    return { available: true, facts, today: today?.d ?? '' }
  })

export const setCommissionPaymentFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(setCommissionPaymentSchema)
  .handler(async ({ data, context }) => {
    const facts = await listCommissionFacts()
    if (!facts) throw new Error(COMMISSIONS_UNAVAILABLE)
    const f = facts.find((x) => x.partnerId === data.partnerId)
    if (!f) throw new Error(`COMMISSION_NOT_DUE: ${data.partnerId}`)
    if (!data.paid) {
      await setCommissionPayment(
        { partnerId: f.partnerId, paid: false, memberId: null, kind: null, amount: null, reference: null, paidOn: null, note: data.note ?? null },
        context.user.id,
      )
      return { ok: true as const }
    }
    const row = commissionRow({ ...f, payment: null })
    if (!row.kind || row.amount <= 0) throw new Error(`COMMISSION_NOT_DUE: ${data.partnerId}`)
    await setCommissionPayment(
      {
        partnerId: f.partnerId,
        paid: true,
        memberId: f.member.id,
        kind: row.kind,
        amount: row.amount,
        reference: row.reference,
        paidOn: data.paidOn,
        note: data.note || null,
      },
      context.user.id,
    )
    return { ok: true as const }
  })
