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
  allocateJobToPackage,
  attributePartnerFee,
  createPartnerPackage,
  listFeeJobFacts,
  listFeePartnerFacts,
  listPackagesData,
  reopenJobPackageAllocation,
  setPartnerFeeStatus,
  setPartnerPackagePrice,
  undoJobPackageAllocation,
  voidPartnerPackage,
} from '~/server/partner-fees.repo'
import { PARTNER_FEE_CONFIG } from '~/lib/partner-fees-config'
import {
  PARTNER_PACKAGES_UNAVAILABLE,
  createPackageSchema,
  persistAllocationsSchema,
  reopenAllocationSchema,
  setPackagePriceSchema,
  undoAllocationSchema,
  voidPackageSchema,
  packageRows,
  type PackageRow,
  type PackagesData,
} from '~/lib/partner-packages'
import { z } from 'zod'
import { sql, sqlOne } from '~/server/db'
import { providerFacts, type ProviderFacts } from '~/lib/partner-providers'
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
      /** Paquetes e imputaciones (044). `null` sin la 044. */
      packages: PackagesData | null
      /** Hoy en Buenos Aires, calculado en el servidor (la pantalla es SSR). */
      today: string
    }

async function loadFacts() {
  const [jobs, packages] = await Promise.all([listFeeJobFacts(), listPackagesData()])
  if (!jobs) return null
  const ids = new Set<string>()
  for (const j of jobs) {
    if (j.selectedPartnerId) ids.add(j.selectedPartnerId)
    if (j.attribution) ids.add(j.attribution.partnerId)
    if (j.charge) ids.add(j.charge.partnerId)
  }
  for (const p of packages?.packages ?? []) ids.add(p.partnerId)
  const partners = await listFeePartnerFacts([...ids])
  return { jobs, partners, packages }
}

/** La regla aplicada con los datos de AHORA (antes de cualquier escritura). */
async function classifiedNow() {
  const facts = await loadFacts()
  if (!facts) throw new Error('PARTNER_FEES_UNAVAILABLE')
  return classifyFeeJobs(facts.jobs, new Map(facts.partners.map((p) => [p.id, p])), PARTNER_FEE_CONFIG, facts.packages)
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
    const jobs = await classifiedNow()
    const byId = new Map(jobs.map((j) => [j.quoteRequestId, j]))

    // Monto por trabajo: el que se puso a mano, si no el congelado o el de la
    // config. Se agrupa por monto: el SP lleva uno por llamada.
    const byAmount = new Map<number | null, Array<string>>()
    for (const id of data.quoteRequestIds) {
      const j = byId.get(id)
      // Volver a pendiente sólo pide que haya un cobro de ese proveedor.
      if (data.status === 'pendiente') {
        if (!j?.charge || j.charge.partnerId !== data.partnerId) throw new Error(`FEE_NOT_LIQUIDABLE: ${id}`)
        byAmount.set(null, [...(byAmount.get(null) ?? []), id])
        continue
      }
      if (!j || j.kind !== 'liquidable' || j.partnerId !== data.partnerId) throw new Error(`FEE_NOT_LIQUIDABLE: ${id}`)
      let amount: number | null = null
      if (data.status !== 'anulado') {
        const manual = data.amounts?.[id]
        // Un trabajo gratis o cubierto por paquete no se avisa ni se cobra
        // (amount 0), salvo que ya tuviera un cobro guardado.
        if (j.amount <= 0) throw new Error(`FEE_NOT_LIQUIDABLE: ${id}`)
        amount = manual ?? j.amount
      }
      byAmount.set(amount, [...(byAmount.get(amount) ?? []), id])
    }

    let changed = 0
    for (const [amount, ids] of byAmount) {
      changed += await setPartnerFeeStatus({ ...data, quoteRequestIds: ids, amount }, context.user.id)
    }
    return { changed }
  })

// ── Paquetes de trabajos (044) ──────────────────────────────────────────────

export const createPartnerPackageFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(createPackageSchema)
  .handler(async ({ data, context }) => {
    await createPartnerPackage(data, context.user.id)
    return { ok: true as const }
  })

export const voidPartnerPackageFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(voidPackageSchema)
  .handler(async ({ data, context }) => {
    await voidPartnerPackage(data.packageId, data.reason, context.user.id)
    return { ok: true as const }
  })

/**
 * Guardar las imputaciones que PROPONE la regla. Se re-calcula antes: cada
 * trabajo tiene que seguir yendo a un paquete según la regla de ahora, y se
 * guarda al paquete que la regla dice (nunca uno del payload).
 */
export const persistPackageAllocationsFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(persistAllocationsSchema)
  .handler(async ({ data, context }) => {
    const byId = new Map((await classifiedNow()).map((j) => [j.quoteRequestId, j]))
    let saved = 0
    for (const id of data.quoteRequestIds) {
      const j = byId.get(id)
      if (!j?.packageAllocation) throw new Error(`ALLOCATION_NOT_DUE: ${id}`)
      if (j.packageAllocation.persisted) continue
      await allocateJobToPackage(id, j.packageAllocation.packageId, context.user.id)
      saved += 1
    }
    return { saved }
  })

/** Deshacer (o rechazar la propuesta de) una imputación, con motivo. */
export const undoPackageAllocationFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(undoAllocationSchema)
  .handler(async ({ data, context }) => {
    const j = (await classifiedNow()).find((x) => x.quoteRequestId === data.quoteRequestId)
    if (!j?.packageAllocation) throw new Error(`ALLOCATION_NOT_DUE: ${data.quoteRequestId}`)
    await undoJobPackageAllocation(data.quoteRequestId, j.packageAllocation.packageId, data.reason, context.user.id)
    return { ok: true as const }
  })

/** Volver a dejar que la regla impute ese trabajo. */
export const reopenPackageAllocationFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(reopenAllocationSchema)
  .handler(async ({ data, context }) => {
    await reopenJobPackageAllocation(data.quoteRequestId, context.user.id)
    return { ok: true as const }
  })

export { PARTNER_PACKAGES_UNAVAILABLE }

export type PackagesView =
  | { available: false }
  | { available: true; rows: Array<PackageRow>; today: string }

/**
 * Los paquetes con su uso y estado, calculados con la MISMA regla que
 * Liquidaciones (saldo = trabajos − imputados guardados y propuestos). Con
 * `partnerId`, sólo los de ese proveedor (la ficha).
 */
export const getPackagesViewFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ partnerId: z.string().uuid().optional().catch(undefined) }).optional())
  .handler(async ({ data }): Promise<PackagesView> => {
    const [facts, today] = await Promise.all([loadFacts(), baToday()])
    if (!facts?.packages) return { available: false }
    const partners = new Map(facts.partners.map((p) => [p.id, p]))
    const jobs = classifyFeeJobs(facts.jobs, partners, PARTNER_FEE_CONFIG, facts.packages)
    const usage = new Map<string, { persisted: number; provisional: number }>()
    for (const j of jobs) {
      if (!j.packageAllocation) continue
      const u = usage.get(j.packageAllocation.packageId) ?? { persisted: 0, provisional: 0 }
      if (j.packageAllocation.persisted) u.persisted += 1
      else u.provisional += 1
      usage.set(j.packageAllocation.packageId, u)
    }
    // Una imputación guardada de un trabajo que ya no es liquidable sigue
    // ocupando saldo (no se deshizo): se cuenta igual.
    const counted = new Set(jobs.filter((j) => j.packageAllocation?.persisted).map((j) => j.quoteRequestId))
    for (const a of facts.packages.allocations) {
      if (a.undoneAt !== null || counted.has(a.quoteRequestId)) continue
      const u = usage.get(a.packageId) ?? { persisted: 0, provisional: 0 }
      u.persisted += 1
      usage.set(a.packageId, u)
    }
    const pkgs = data?.partnerId
      ? { ...facts.packages, packages: facts.packages.packages.filter((p) => p.partnerId === data.partnerId) }
      : facts.packages
    const rows = packageRows(pkgs, usage, (id) => partners.get(id)?.name ?? 'Proveedor borrado', today)
    return { available: true, rows, today }
  })

async function baToday(): Promise<string> {
  const r = await sqlOne<{ d: string }>(`select to_char(now() at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD') as d`)
  return r?.d ?? ''
}

// ── Partners › Proveedores: los hechos de cobro por proveedor ───────────────

export type ProvidersFactsData =
  | { available: false }
  | {
      available: true
      today: string
      packagesAvailable: boolean
      /** Por partner: trabajos, gratis, paquete vigente, por cobrar, «Alta por». */
      byPartner: Record<string, ProviderFacts>
      /** Comerciales con algún alta, para el filtro. */
      sourcers: Array<{ memberId: string; name: string }>
    }

/**
 * Lo que Partners › Proveedores suma por proveedor, con la MISMA regla que
 * Liquidaciones. Sin la 038 (`available: false`) la pantalla muestra «—» en
 * esas columnas y el resto sigue andando.
 */
export const getProvidersFactsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<ProvidersFactsData> => {
    const [facts, today, ids] = await Promise.all([
      loadFacts(),
      baToday(),
      sql<{ id: string }>(`select id from partners`),
    ])
    if (!facts) return { available: false }
    const allIds = ids.map((r) => r.id)
    const partnerFacts = await listFeePartnerFacts(allIds)
    const partners = new Map(partnerFacts.map((p) => [p.id, p]))
    const jobs = classifyFeeJobs(facts.jobs, partners, PARTNER_FEE_CONFIG, facts.packages)
    const usage = new Map<string, { persisted: number; provisional: number }>()
    for (const j of jobs) {
      if (!j.packageAllocation) continue
      const u = usage.get(j.packageAllocation.packageId) ?? { persisted: 0, provisional: 0 }
      if (j.packageAllocation.persisted) u.persisted += 1
      else u.provisional += 1
      usage.set(j.packageAllocation.packageId, u)
    }
    const rows = facts.packages
      ? packageRows(facts.packages, usage, (id) => partners.get(id)?.name ?? '', today)
      : []
    const sourcers = new Map<string, { memberId: string; name: string }>()
    for (const p of partnerFacts) if (p.sourcer) sourcers.set(p.id, { memberId: p.sourcer.memberId, name: p.sourcer.name })
    const byPartner = Object.fromEntries(providerFacts(allIds, jobs, rows, sourcers, today.slice(0, 7)))
    const uniq = new Map<string, { memberId: string; name: string }>()
    for (const s of sourcers.values()) uniq.set(s.memberId, s)
    return {
      available: true,
      today,
      packagesAvailable: facts.packages !== null,
      byPartner,
      sourcers: [...uniq.values()].sort((a, b) => a.name.localeCompare(b.name, 'es')),
    }
  })

/** Corregir el precio pagado de un paquete (cada uno se vende al precio que se pacte). */
export const setPartnerPackagePriceFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(setPackagePriceSchema)
  .handler(async ({ data, context }) => {
    await setPartnerPackagePrice(data.packageId, data.pricePaid, data.reason || null, context.user.id)
    return { ok: true as const }
  })
