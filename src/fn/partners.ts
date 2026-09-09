import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import {
  applicationSearchSchema,
  approveSchema,
  editApplicationSchema,
  updateStatusSchema,
} from '~/lib/partners'
import {
  editServicesSchema,
  partnerSearchSchema,
  setPartnerContactSchema,
  setPartnerLinksSchema,
  setPartnerLocationSchema,
  setPartnerProfileSchema,
  setPartnerStatusSchema,
} from '~/lib/catalog'
import {
  approveApplication,
  editPartnerServices,
  findApplication,
  getPartnerServices,
  listApplications,
  listPartners,
  loadCatalog,
  partnerCoverageBoard,
  pipelineHealth,
  updatePartnerApplication,
  setPartnerContact,
  setPartnerLinks,
  setPartnerLocation,
  setPartnerProfile,
  setPartnerStatus,
  unstickApplication,
  updateApplicationStatus,
} from '~/server/partners.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type {
  ApplicationDetail,
  ApplicationListItem,
  PipelineHealth,
} from '~/lib/partners'
import type {
  ApprovalResult,
  EditServicesResult,
  PartnerWriteResult,
} from '~/server/partners.repo'
import type {
  PartnerListItem,
  PartnerServicesView,
  ServiceFamily,
} from '~/lib/catalog'
import type { PartnerCoverageBoard } from '~/lib/partners-coverage'

/**
 * Todo el marketplace pasa por `adminMiddleware`, lecturas incluidas.
 *
 * No es simetría por prolijidad: la cola trae el WhatsApp, el email y la
 * dirección de talleres que todavía no aceptaron nada. Un server function es un
 * endpoint HTTP público — cualquiera con una sesión válida de la app puede
 * llamarlo directo, y el guard de `_authed` no lo cubre porque ese guard solo
 * modela lo que la UI ofrece.
 */

export const listPartnerApplications = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(applicationSearchSchema)
  .handler(async ({ data }): Promise<Array<ApplicationListItem>> =>
    listApplications(data, { signal: requestSignal() }),
  )

export const getPartnerApplication = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ applicationId: z.uuid() }))
  .handler(async ({ data }): Promise<ApplicationDetail> => {
    const found = await findApplication(data.applicationId, { signal: requestSignal() })
    if (!found) throw new Error(`NOT_FOUND:${data.applicationId}`)
    return found
  })

export const getPipelineHealth = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<PipelineHealth> => pipelineHealth({ signal: requestSignal() }))

/**
 * Aprobar. El reviewer sale de la sesión, NUNCA del payload.
 *
 * `approve_partner_application()` graba `reviewed_by_id` con FK a `users`, o
 * sea que es el registro de quién publicó a quién. Aceptarlo por parámetro
 * dejaría que quien llama firme con la identidad de otro.
 */
export const approvePartnerApplication = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(approveSchema)
  .handler(async ({ data, context }): Promise<ApprovalResult> =>
    approveApplication(data.applicationId, context.user.id, data.coverageZone),
  )

export const updatePartnerApplicationStatus = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(updateStatusSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await updateApplicationStatus(data.applicationId, data.status)
    return { ok: true }
  })

/**
 * Editar todos los campos del formulario de una solicitud (migración 010).
 *
 * El actor sale de `context.user.id` —la sesión de Clerk—, NUNCA del payload:
 * `ops.action_log` es el único registro de quién tocó qué en el marketplace, y
 * un actor por parámetro lo convierte en una firma falsificable. Misma regla
 * exacta que `setPartnerProfileFn` y `approvePartnerApplication`.
 */
export const updatePartnerApplicationFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(editApplicationSchema)
  .handler(async ({ data, context }): Promise<ApplicationDetail> =>
    updatePartnerApplication(data, context.user.id),
  )

/** Consulta 5 del runbook: devolver a `in_conversation` una solicitud trabada. */
export const unstickPartnerApplication = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ applicationId: z.uuid() }))
  .handler(async ({ data }): Promise<{ unstuck: boolean }> => ({
    unstuck: await unstickApplication(data.applicationId),
  }))

// ── Consultas 6, 7 y 8: partners y sus rubros ────────────────────────────────

export const listMarketplacePartners = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(partnerSearchSchema)
  .handler(async ({ data }): Promise<Array<PartnerListItem>> =>
    listPartners(data, { signal: requestSignal() }),
  )

/**
 * El tablero de cobertura (`/partners/cobertura`).
 *
 * No toma search params: filtrar y enfocar una categoría se hace en el cliente
 * sobre el tablero completo (40 partners, 16 categorías — es chico). Pasa por
 * `adminMiddleware` igual que el resto del marketplace.
 */
export const getPartnerCoverageBoard = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<PartnerCoverageBoard> =>
    partnerCoverageBoard({ signal: requestSignal() }),
  )

/**
 * El catálogo de rubros (16 categorías) y sus servicios (79), para los filtros
 * del Listado. Es el mismo `loadCatalog` que arma la ficha; sólo las categorías
 * con ≥1 servicio activo, en orden de catálogo.
 */
export const getServiceCatalog = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<ServiceFamily>> =>
    loadCatalog(),
  )

export const getPartnerServicesView = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ partnerId: z.uuid() }))
  .handler(async ({ data }): Promise<PartnerServicesView> => {
    const view = await getPartnerServices(data.partnerId, { signal: requestSignal() })
    if (!view) throw new Error(`NOT_FOUND:${data.partnerId}`)
    return view
  })

/**
 * Editar los rubros de un partner.
 *
 * Es la operación que puede dejar un partner invisible (sacarle el último
 * rubro), así que la respuesta devuelve el total resultante — la UI lo usa para
 * avisar en el acto en vez de esperar al próximo chequeo de salud.
 */
export const editPartnerServicesFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(editServicesSchema)
  .handler(async ({ data }): Promise<EditServicesResult> =>
    editPartnerServices(data.partnerId, data.add, data.remove),
  )

// ── Migración 007: editar la ficha del partner ───────────────────────────────
//
// EL ACTOR SALE DE LA SESIÓN, NUNCA DEL PAYLOAD.
//
// Es la misma regla que `approvePartnerApplication` de arriba, y acá pesa más:
// `ops.action_log` es el ÚNICO registro de quién cambió qué en el marketplace —
// `partners` sólo tiene `updated_at`, que dice cuándo y no dice quién. Un actor
// que entra por parámetro convierte esa auditoría en una firma que cualquiera
// puede falsificar, o sea en ninguna auditoría.
//
// Por qué el panel puede escribir esto: `IPartnerRepository` del backend expone
// SÓLO `findActive()` y `findActiveById()`. No hay caso de uso que edite un
// partner en ningún lado. → `.claude/rules/ops-metrics.md`

export const setPartnerStatusFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(setPartnerStatusSchema)
  .handler(async ({ data, context }): Promise<PartnerWriteResult> =>
    setPartnerStatus(data, context.user.id, { signal: requestSignal() }),
  )

/**
 * Cargar coordenadas.
 *
 * El caso que la motiva: al 2026-08-30 los 34 partners activos de producción
 * tienen `latitude IS NULL`, así que el marketplace no puede ordenar por
 * cercanía a nadie.
 */
export const setPartnerLocationFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(setPartnerLocationSchema)
  .handler(async ({ data, context }): Promise<PartnerWriteResult> =>
    setPartnerLocation(data, context.user.id, { signal: requestSignal() }),
  )

export const setPartnerContactFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(setPartnerContactSchema)
  .handler(async ({ data, context }): Promise<PartnerWriteResult> =>
    setPartnerContact(data, context.user.id, { signal: requestSignal() }),
  )

// ── Migración 008: perfil y links ────────────────────────────────────────────
//
// Mismo borde que las tres de arriba: el actor sale de `context.user.id`, o sea
// de la sesión de Clerk, y no está en ningún schema de zod.

/**
 * Zona de cobertura, descripción y badge de aliado.
 *
 * Los tres juntos porque son una sola cosa: cómo se presenta el partner en la
 * tarjeta del marketplace. Tres server functions producirían tres entradas de
 * `ops.action_log` para un solo acto de edición.
 */
export const setPartnerProfileFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(setPartnerProfileSchema)
  .handler(async ({ data, context }): Promise<PartnerWriteResult> =>
    setPartnerProfile(data, context.user.id, { signal: requestSignal() }),
  )

/**
 * El juego completo de links.
 *
 * Devuelve los links tal como quedaron —no un `void`— porque el SP los
 * normaliza: descarta las URLs vacías y deduplica los `other`. Que la UI
 * recargue igual no lo hace redundante: el valor de retorno es lo que hace
 * verificable el efecto desde cualquier otro llamador.
 */
export const setPartnerLinksFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(setPartnerLinksSchema)
  .handler(async ({ data, context }): Promise<Array<{ kind: string; url: string }>> =>
    setPartnerLinks(data, context.user.id, { signal: requestSignal() }),
  )
