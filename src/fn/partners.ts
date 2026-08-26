import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import {
  applicationSearchSchema,
  approveSchema,
  updateStatusSchema,
} from '~/lib/partners'
import { editServicesSchema, partnerSearchSchema } from '~/lib/catalog'
import {
  approveApplication,
  editPartnerServices,
  findApplication,
  getPartnerServices,
  listApplications,
  listPartners,
  pipelineHealth,
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
import type { ApprovalResult, EditServicesResult } from '~/server/partners.repo'
import type { PartnerListItem, PartnerServicesView } from '~/lib/catalog'

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
