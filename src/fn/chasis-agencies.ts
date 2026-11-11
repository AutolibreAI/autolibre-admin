import { createServerFn } from '@tanstack/react-start'
import {
  AGENCIES_UNAVAILABLE,
  addAgencyInteractionSchema,
  agencyIdSchema,
  agencySearchSchema,
  createAgencySchema,
  updateAgencySchema,
} from '~/lib/chasis-agencies'
import {
  addAgencyInteraction,
  agencySummary,
  chasisAgenciesAvailable,
  createAgency,
  createProspectFromAgency,
  findAgency,
  listAgencies,
  listAgencyInteractions,
  listAgencyLocalities,
  updateAgency,
} from '~/server/chasis-agencies.repo'
import { comercialAvailability, listProspectOwners } from '~/server/partner-prospects.repo'
import { adminMiddleware } from './middleware'
import type {
  AgenciesMissing,
  AgencyDetailResult,
  AgencyFacets,
  AgencyListResult,
  ChasisAgency,
} from '~/lib/chasis-agencies'

/**
 * API Chasis — el borde RPC. `adminMiddleware` en todo (contactos, teléfonos y
 * notas de charlas con agencias), el actor sale de la sesión, y la
 * disponibilidad se chequea en cada handler: la 031 se apoya en la 024 y la
 * 030 ("Crear contacto de proveedor" crea un contacto con frente).
 */

async function agencyGate(): Promise<AgenciesMissing | null> {
  const [c, has031] = await Promise.all([comercialAvailability(), chasisAgenciesAvailable()])
  return !c.has024 ? '024' : !c.has030 ? '030' : !has031 ? '031' : null
}

async function assertAgencies(): Promise<void> {
  if (await agencyGate()) throw new Error(AGENCIES_UNAVAILABLE)
}

async function loadFacets(): Promise<AgencyFacets> {
  const [owners, localities] = await Promise.all([listProspectOwners(), listAgencyLocalities()])
  return { owners, localities }
}

export const listAgenciesFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(agencySearchSchema)
  .handler(async ({ data }): Promise<AgencyListResult> => {
    const missing = await agencyGate()
    if (missing) return { available: false, missing }
    const [list, summary, facets] = await Promise.all([listAgencies(data), agencySummary(data), loadFacets()])
    return { available: true, ...list, summary, facets }
  })

/** La ficha de una agencia con su historial. `null` si no existe. */
export const getAgencyDetailFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(agencyIdSchema)
  .handler(async ({ data }): Promise<AgencyDetailResult | null> => {
    const missing = await agencyGate()
    if (missing) return { available: false, missing }
    const [agency, interactions, facets] = await Promise.all([
      findAgency(data.id),
      listAgencyInteractions(data.id),
      loadFacets(),
    ])
    if (!agency) return null
    return { available: true, agency, interactions, facets }
  })

export const createAgencyFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(createAgencySchema)
  .handler(async ({ data, context }): Promise<ChasisAgency> => {
    await assertAgencies()
    return createAgency(data, context.user.id)
  })

export const updateAgencyFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(updateAgencySchema)
  .handler(async ({ data, context }): Promise<ChasisAgency> => {
    await assertAgencies()
    return updateAgency(data.id, data.patch, context.user.id)
  })

export const addAgencyInteractionFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(addAgencyInteractionSchema)
  .handler(async ({ data, context }): Promise<ChasisAgency> => {
    await assertAgencies()
    return addAgencyInteraction(data, context.user.id)
  })

export const createProspectFromAgencyFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(agencyIdSchema)
  .handler(async ({ data, context }): Promise<{ prospectId: string; created: boolean }> => {
    await assertAgencies()
    return createProspectFromAgency(data.id, context.user.id)
  })
