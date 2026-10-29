import { createServerFn } from '@tanstack/react-start'
import {
  PROSPECTS_UNAVAILABLE,
  addOriginSchema,
  createProspectSchema,
  importProspectsSchema,
  phoneLookupSchema,
  prospectIdSchema,
  prospectSearchSchema,
  searchPartnersSchema,
  updateProspectSchema,
} from '~/lib/partner-prospects'
import {
  addProspectOrigin,
  createProspect,
  findPhoneMatches,
  importProspects,
  listProspectOrigins,
  listProspectOwners,
  listProspects,
  listTodayFollowUps,
  partnerProspectsAvailable,
  prospectSummary,
  searchPartnersForLink,
  suggestPartnersForProspect,
  updateProspect,
} from '~/server/partner-prospects.repo'
import { loadCatalog } from '~/server/partners.repo'
import { adminMiddleware } from './middleware'
import type {
  ImportResult,
  PartnerMatch,
  PartnerProspect,
  PhoneMatches,
  ProspectFacets,
  ProspectListResult,
  ProspectOrigin,
  ProspectTodayResult,
} from '~/lib/partner-prospects'

/**
 * Seguimiento comercial — el borde RPC.
 *
 * ── `adminMiddleware` en todo, lecturas incluidas ─────────────────────────
 *
 * Teléfonos, nombres de dueños y notas de conversaciones con proveedores que
 * todavía no aceptaron nada con nosotros. Un server function es un endpoint
 * HTTP público: el guard de `_authed` modela lo que la UI ofrece, esto es lo
 * que el servidor acepta.
 *
 * ── El actor sale de `context.user.id`, NUNCA del payload ─────────────────
 *
 * Ningún schema lo tiene. Es lo que llena `ops.action_log` y `created_by`.
 *
 * ── La disponibilidad se chequea ACÁ, no sólo en el loader ────────────────
 *
 * Sin la 024 la tabla y los SP no existen: un `fetch` directo sería un 500
 * con el texto de Postgres.
 */

async function assertAvailable(): Promise<void> {
  if (!(await partnerProspectsAvailable())) throw new Error(PROSPECTS_UNAVAILABLE)
}

/** Rubros = las categorías del marketplace, del MISMO loader que `/partners`. */
async function loadFacets(): Promise<ProspectFacets> {
  const [origins, owners, catalog] = await Promise.all([
    listProspectOrigins(),
    listProspectOwners(),
    loadCatalog(),
  ])
  return { origins, owners, categories: catalog.map((f) => ({ slug: f.slug, name: f.name })) }
}

export const listProspectsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(prospectSearchSchema)
  .handler(async ({ data }): Promise<ProspectListResult> => {
    if (!(await partnerProspectsAvailable())) return { available: false }
    const [list, summary, facets] = await Promise.all([
      listProspects(data),
      prospectSummary(data),
      loadFacets(),
    ])
    return { available: true, ...list, summary, facets }
  })

export const listTodayFollowUpsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<ProspectTodayResult> => {
    if (!(await partnerProspectsAvailable())) return { available: false }
    const [rows, summary, facets] = await Promise.all([
      listTodayFollowUps(),
      prospectSummary(),
      loadFacets(),
    ])
    return { available: true, rows, summary, facets }
  })

export const findPhoneMatchesFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(phoneLookupSchema)
  .handler(async ({ data }): Promise<PhoneMatches> => {
    await assertAvailable()
    return findPhoneMatches(data.phones)
  })

export const suggestPartnersForProspectFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(prospectIdSchema)
  .handler(async ({ data }): Promise<Array<PartnerMatch>> => {
    await assertAvailable()
    return suggestPartnersForProspect(data.id)
  })

export const searchPartnersForLinkFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(searchPartnersSchema)
  .handler(async ({ data }): Promise<Array<PartnerMatch>> => searchPartnersForLink(data.q))

// ── Escrituras ──────────────────────────────────────────────────────────────

export const createProspectFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(createProspectSchema)
  .handler(async ({ data, context }): Promise<PartnerProspect> => {
    await assertAvailable()
    return createProspect(data, context.user.id)
  })

export const updateProspectFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(updateProspectSchema)
  .handler(async ({ data, context }): Promise<PartnerProspect> => {
    await assertAvailable()
    return updateProspect(data.id, data.patch, context.user.id)
  })

export const importProspectsFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(importProspectsSchema)
  .handler(async ({ data, context }): Promise<ImportResult> => {
    await assertAvailable()
    return importProspects(data.rows, context.user.id)
  })

export const addProspectOriginFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(addOriginSchema)
  .handler(async ({ data, context }): Promise<ProspectOrigin> => {
    await assertAvailable()
    return addProspectOrigin(data.label, context.user.id)
  })
