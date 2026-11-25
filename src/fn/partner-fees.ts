import { createServerFn } from '@tanstack/react-start'
import {
  attributePartnerFeeSchema,
  classifyFeeJobs,
  setPartnerFeeStatusSchema,
  type FeeJobFacts,
  type FeePartnerFacts,
} from '~/lib/partner-fees'
import type { PartnerOption } from '~/lib/partners'
import { listPartnerOptions } from '~/server/partners.repo'
import {
  attributePartnerFee,
  listFeeJobFacts,
  listFeePartnerFacts,
  setPartnerFeeStatus,
} from '~/server/partner-fees.repo'
import { sqlOne } from '~/server/db'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'

/**
 * Liquidaciones a proveedores — el borde RPC. Lee por SQL y escribe sólo `ops`
 * (038). `adminMiddleware` en todo: es plata, y un server function es un
 * endpoint público. El actor sale de la sesión, nunca del payload.
 */

export type PartnerFeesData =
  | { available: false }
  | {
      available: true
      jobs: Array<FeeJobFacts>
      partners: Array<FeePartnerFacts>
      partnerOptions: Array<PartnerOption>
      /** Hoy en Buenos Aires, calculado en el servidor (la pantalla es SSR). */
      today: string
    }

async function loadFacts() {
  const jobs = await listFeeJobFacts()
  if (!jobs) return null
  const ids = new Set<string>()
  for (const j of jobs) {
    if (j.selectedPartnerId) ids.add(j.selectedPartnerId)
    if (j.attribution) ids.add(j.attribution.partnerId)
    if (j.charge) ids.add(j.charge.partnerId)
  }
  const partners = await listFeePartnerFacts([...ids])
  return { jobs, partners }
}

export const getPartnerFeesFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<PartnerFeesData> => {
    void requestSignal()
    const [facts, partnerOptions, today] = await Promise.all([
      loadFacts(),
      listPartnerOptions(),
      sqlOne<{ d: string }>(`select to_char(now() at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD') as d`),
    ])
    if (!facts) return { available: false }
    return { available: true, ...facts, partnerOptions, today: today?.d ?? '' }
  })

export const attributePartnerFeeFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(attributePartnerFeeSchema)
  .handler(async ({ data, context }) => {
    await attributePartnerFee(data, context.user.id)
    return { ok: true as const }
  })

/**
 * Mover el estado de cobro. Antes de escribir se RE-CALCULA la regla con los
 * datos de ahora: cada trabajo tiene que seguir siendo liquidable, de ESE
 * proveedor, y (para avisar o cobrar) no estar excluido. El monto lo pone el
 * servidor, nunca el cliente: el congelado si ya tenía, si no el de la config.
 */
export const setPartnerFeeStatusFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(setPartnerFeeStatusSchema)
  .handler(async ({ data, context }) => {
    const facts = await loadFacts()
    if (!facts) throw new Error('PARTNER_FEES_UNAVAILABLE')
    const jobs = classifyFeeJobs(facts.jobs, new Map(facts.partners.map((p) => [p.id, p])))
    const byId = new Map(jobs.map((j) => [j.quoteRequestId, j]))

    let amount: number | null = null
    for (const id of data.quoteRequestIds) {
      const j = byId.get(id)
      // Volver a pendiente sólo pide que haya un cobro de ese proveedor.
      if (data.status === 'pendiente') {
        if (!j?.charge || j.charge.partnerId !== data.partnerId) throw new Error(`FEE_NOT_LIQUIDABLE: ${id}`)
        continue
      }
      if (!j || j.kind !== 'liquidable' || j.partnerId !== data.partnerId) throw new Error(`FEE_NOT_LIQUIDABLE: ${id}`)
      if (data.status !== 'anulado') {
        if (j.amount <= 0) throw new Error(`FEE_NOT_LIQUIDABLE: ${id}`)
        // Un lote lleva UN monto: si hay montos congelados distintos, que se
        // muevan por separado.
        if (amount !== null && amount !== j.amount) throw new Error(`FEE_MIXED_AMOUNTS: ${id}`)
        amount = j.amount
      }
    }

    const changed = await setPartnerFeeStatus({ ...data, amount }, context.user.id)
    return { changed }
  })
