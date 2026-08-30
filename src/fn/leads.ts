import { createServerFn } from '@tanstack/react-start'
import { advanceLeadSchema, leadSearchSchema } from '~/lib/leads'
import { advanceLead, listLeads } from '~/server/leads.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { LeadListItem, LeadStatus } from '~/lib/leads'

/**
 * Leads — el borde RPC.
 *
 * `adminMiddleware` en las dos, y acá el motivo de la LECTURA es tan fuerte como
 * el de la escritura: `listLeads` cruza el lead con `users` y devuelve nombre y
 * email de la persona que pidió turno, más el alias o la patente de su auto. Eso
 * es dato personal de usuarios reales, no una métrica agregada.
 *
 * Un server function es un endpoint HTTP público: cualquiera con una sesión
 * válida de la app mobile puede llamarlo con un fetch. El guard de `_authed`
 * modela lo que la UI OFRECE; esto es lo que el servidor ACEPTA.
 */

export const listMarketplaceLeads = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(leadSearchSchema)
  .handler(async ({ data }): Promise<Array<LeadListItem>> =>
    listLeads(data, { signal: requestSignal() }),
  )

/**
 * Mover el lead. El actor sale de la sesión, NUNCA del payload.
 *
 * Misma regla que `approvePartnerApplication`, y con la misma razón de fondo:
 * `ops.action_log` es el único registro de quién movió el embudo. Aceptar el
 * actor por parámetro lo convierte en una firma que cualquiera puede
 * falsificar, o sea en ninguna auditoría.
 */
export const advanceMarketplaceLead = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(advanceLeadSchema)
  .handler(async ({ data, context }): Promise<{ id: string; status: LeadStatus }> =>
    advanceLead(data, context.user.id, { signal: requestSignal() }),
  )
