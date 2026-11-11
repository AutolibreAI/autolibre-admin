import { createServerFn } from '@tanstack/react-start'
import {
  PROSPECTS_030_UNAVAILABLE,
  PROSPECTS_UNAVAILABLE,
  addInteractionSchema,
  addOriginSchema,
  createProspectSchema,
  importProspectsSchema,
  parseQuoteCode,
  phoneLookupSchema,
  prospectIdSchema,
  prospectMonthSearchSchema,
  prospectSearchSchema,
  prospectSummarySearchSchema,
  quoteCodeLookupSchema,
  searchPartnersSchema,
  updateProspectSchema,
} from '~/lib/partner-prospects'
import {
  addInteraction,
  addProspectOrigin,
  comercialAvailability,
  comercialSummary,
  createProspect,
  currentMonthBA,
  findPhoneMatches,
  findProspect,
  findQuoteRequestIdByNumber,
  importProspects,
  listInteractions,
  listMonthlyRegistrations,
  listPartnerLastContacts,
  listProspectLocalities,
  listProspectOrigins,
  listProspectOwners,
  listProspects,
  listTodayFollowUps,
  listUnlinkedRegistrationCandidates,
  partnerProspectsAvailable,
  prospectSummary,
  searchPartnersForLink,
  suggestPartnersForProspect,
  updateProspect,
} from '~/server/partner-prospects.repo'
import { loadCatalog } from '~/server/partners.repo'
import { chasisAgenciesAvailable, listDueAgencies } from '~/server/chasis-agencies.repo'
import { adminMiddleware } from './middleware'
import type {
  ComercialSummaryResult,
  ImportResult,
  MonthlyRegistrationsResult,
  PartnerMatch,
  PartnerProspect,
  PhoneMatches,
  ProspectDetailResult,
  ProspectFacets,
  ProspectListResult,
  ProspectOrigin,
  ProspectTodayResult,
  ProspectsMissing,
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
 * Comercial necesita la 024 Y la 030: sin la 030 el embudo de la base es el
 * viejo. Un `fetch` directo sin el chequeo sería un 500 con el texto de
 * Postgres. Propuestas y Sellos sólo necesitan la 024 (`partnerProspectsAvailable`).
 */

/** Qué falta para operar Comercial, o `null` si está todo. Y si hay pedidos para el `AL-n`. */
async function comercialGate(): Promise<{
  missing: ProspectsMissing | null
  quotes: boolean
  applications: boolean
}> {
  const a = await comercialAvailability()
  return {
    missing: !a.has024 ? '024' : !a.has030 ? '030' : null,
    quotes: a.quotes,
    applications: a.applications,
  }
}

/** Para las escrituras: tira la sentinela de lo que falta. */
async function assertComercial(): Promise<{ quotes: boolean }> {
  const gate = await comercialGate()
  if (gate.missing === '024') throw new Error(PROSPECTS_UNAVAILABLE)
  if (gate.missing === '030') throw new Error(PROSPECTS_030_UNAVAILABLE)
  return { quotes: gate.quotes }
}

/** Rubros = las categorías del marketplace, del MISMO loader que `/partners`. */
async function loadFacets(): Promise<ProspectFacets> {
  const [origins, owners, catalog, localities] = await Promise.all([
    listProspectOrigins(),
    listProspectOwners(),
    loadCatalog(),
    listProspectLocalities(),
  ])
  return { origins, owners, categories: catalog.map((f) => ({ slug: f.slug, name: f.name })), localities }
}

export const listProspectsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(prospectSearchSchema)
  .handler(async ({ data }): Promise<ProspectListResult> => {
    const gate = await comercialGate()
    if (gate.missing) return { available: false, missing: gate.missing }
    const [list, summary, facets] = await Promise.all([
      listProspects(data, gate.quotes),
      prospectSummary(data),
      loadFacets(),
    ])
    return { available: true, ...list, summary, facets }
  })

export const listTodayFollowUpsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<ProspectTodayResult> => {
    const gate = await comercialGate()
    if (gate.missing) return { available: false, missing: gate.missing }
    // Las agencias de API Chasis (031) vencidas o de hoy van en la misma vista;
    // sin la 031 en la base, la sección no aparece (no es un error de Hoy).
    const [rows, summary, facets, agencies] = await Promise.all([
      listTodayFollowUps(gate.quotes),
      prospectSummary(),
      loadFacets(),
      chasisAgenciesAvailable().then((ok) => (ok ? listDueAgencies() : null)),
    ])
    return { available: true, rows, summary, facets, agencies }
  })

/**
 * El Resumen: conteos, objeciones, trabajos/mes y los seguimientos vencidos o
 * de hoy, todo con los mismos filtros. Sólo lectura.
 */
export const getComercialSummaryFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(prospectSummarySearchSchema)
  .handler(async ({ data }): Promise<ComercialSummaryResult> => {
    const gate = await comercialGate()
    if (gate.missing) return { available: false, missing: gate.missing }
    const [summary, due, facets] = await Promise.all([
      comercialSummary(data),
      listTodayFollowUps(gate.quotes, data),
      loadFacets(),
    ])
    return { available: true, summary, due, facets }
  })

/**
 * Las altas de un mes por "Conseguido por" (para liquidar) y las posibles
 * altas sin vincular. Sólo lectura: vincular va por `updateProspectFn`.
 */
export const getMonthlyRegistrationsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(prospectMonthSearchSchema)
  .handler(async ({ data }): Promise<MonthlyRegistrationsResult> => {
    const gate = await comercialGate()
    if (gate.missing) return { available: false, missing: gate.missing }
    const month = data.prospectMonth ?? (await currentMonthBA())
    const [rows, candidates, facets] = await Promise.all([
      listMonthlyRegistrations(month, gate.quotes),
      listUnlinkedRegistrationCandidates(gate.applications),
      loadFacets(),
    ])
    return { available: true, month, rows, candidates, facets }
  })

/** La ficha de un contacto, con su historial de charlas. `null` si no existe. */
export const getProspectDetailFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(prospectIdSchema)
  .handler(async ({ data }): Promise<ProspectDetailResult | null> => {
    const gate = await comercialGate()
    if (gate.missing) return { available: false, missing: gate.missing }
    const [prospect, interactions, facets] = await Promise.all([
      findProspect(data.id, gate.quotes),
      listInteractions(data.id),
      loadFacets(),
    ])
    if (!prospect) return null
    return { available: true, prospect, interactions, facets }
  })

export const findPhoneMatchesFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(phoneLookupSchema)
  .handler(async ({ data }): Promise<PhoneMatches> => {
    // Lo usa también `/partners/sellos`: sólo necesita la 024.
    if (!(await partnerProspectsAvailable())) throw new Error(PROSPECTS_UNAVAILABLE)
    return findPhoneMatches(data.phones)
  })

export const suggestPartnersForProspectFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(prospectIdSchema)
  .handler(async ({ data }): Promise<Array<PartnerMatch>> => {
    if (!(await partnerProspectsAvailable())) throw new Error(PROSPECTS_UNAVAILABLE)
    return suggestPartnersForProspect(data.id)
  })

export const searchPartnersForLinkFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(searchPartnersSchema)
  .handler(async ({ data }): Promise<Array<PartnerMatch>> => searchPartnersForLink(data.q))

/**
 * El pedido del frente "Por pedido": el operador tipea `AL-1234` y la ficha
 * guarda el uuid. `null` = no existe ese número (o no hay tabla de pedidos).
 */
export const findQuoteByCodeFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(quoteCodeLookupSchema)
  .handler(async ({ data }): Promise<{ id: string; code: string } | null> => {
    const { quotes } = await assertComercial()
    const n = parseQuoteCode(data.code)
    if (n === null || !quotes) return null
    const id = await findQuoteRequestIdByNumber(n)
    return id ? { id, code: `AL-${n}` } : null
  })

// ── Escrituras ──────────────────────────────────────────────────────────────

export const createProspectFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(createProspectSchema)
  .handler(async ({ data, context }): Promise<PartnerProspect> => {
    const { quotes } = await assertComercial()
    return createProspect(data, context.user.id, quotes)
  })

export const updateProspectFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(updateProspectSchema)
  .handler(async ({ data, context }): Promise<PartnerProspect> => {
    const { quotes } = await assertComercial()
    return updateProspect(data.id, data.patch, context.user.id, quotes)
  })

/** Una charla: la guarda y mueve el contacto (estado, paso, seguimiento) en la misma operación. */
export const addInteractionFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(addInteractionSchema)
  .handler(async ({ data, context }): Promise<PartnerProspect> => {
    const { quotes } = await assertComercial()
    return addInteraction(data, context.user.id, quotes)
  })

export const importProspectsFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(importProspectsSchema)
  .handler(async ({ data, context }): Promise<ImportResult> => {
    await assertComercial()
    return importProspects(data.rows, context.user.id)
  })

export const addProspectOriginFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(addOriginSchema)
  .handler(async ({ data, context }): Promise<ProspectOrigin> => {
    await assertComercial()
    return addProspectOrigin(data.label, context.user.id)
  })

/**
 * El último contacto comercial por proveedor del directorio (sólo la fecha),
 * para filtrar y ordenar Partners › Propuestas. Sin la 024, vacío. Sólo lee
 * columnas de la 024, así que no espera a la 030.
 */
export const listPartnerLastContactsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async () => {
    const available = await partnerProspectsAvailable()
    return { available, rows: available ? await listPartnerLastContacts() : [] }
  })
