import { z } from 'zod'

/**
 * Leads — el usuario yendo HACIA el taller.
 *
 * No confundir con `PartnerApplication`, que es el taller viniendo hacia
 * nosotros. Apuntan en direcciones opuestas y son el par de términos que más
 * fácil desalinea una conversación entera sin que nadie lo note.
 *
 * ── Por qué esta pantalla existe ────────────────────────────────────────────
 *
 * Porque hoy el embudo entero es inalcanzable. Verificado en el backend:
 * `ILeadRepository` tiene `save()`, pero el único caso de uso que lo usa es
 * `submit-lead`, que crea el lead en `new`. **Nada lo mueve de ahí.** Y el
 * propio `lead-status.vo.ts` lo dice:
 *
 *   "La app solo crea leads en `new`; el resto del recorrido lo mueve el equipo
 *    desde SQL, igual que el pipeline de las solicitudes."
 *
 * O sea que el SQL a mano ya estaba designado. Esta pantalla es ese SQL, con
 * nombre, auditoría y sin DBeaver.
 */

export const LEAD_STATUSES = ['new', 'contacted', 'won', 'lost'] as const
export type LeadStatus = (typeof LEAD_STATUSES)[number]

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'Sin contactar',
  contacted: 'Contactado',
  won: 'Ganado',
  lost: 'Perdido',
}

/**
 * Los estados en los que el contacto sigue vivo.
 *
 * Tiene que decir EXACTAMENTE lo mismo que `OPEN_LEAD_STATUSES` del backend y
 * que el `WHERE` de `idx_leads_open_user_partner_vehicle_unique`. Las tres se
 * tocan juntas: si esta lista se separa de las otras dos, la UI ofrece reabrir
 * un lead que la base va a rechazar, o esconde uno que sí se podía.
 */
export const OPEN_LEAD_STATUSES: ReadonlyArray<LeadStatus> = ['new', 'contacted']

export const LEAD_SOURCES = ['marketplace', 'recommendation'] as const
export type LeadSource = (typeof LEAD_SOURCES)[number]

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  marketplace: 'Marketplace',
  recommendation: 'Recomendación',
}

export interface LeadListItem {
  id: string
  status: LeadStatus
  source: LeadSource
  /** Nombre del taller. Es por quién se busca un lead, no por su uuid. */
  partnerName: string
  partnerId: string
  /** Puede faltar: el usuario existe siempre, el nombre cargado no. */
  userName: string | null
  userEmail: string | null
  /** El auto por el que consultó. `null` para leads sin vehículo asociado. */
  vehicleLabel: string | null
  lostReason: string | null
  note: string | null
  createdAt: string
  contactedAt: string | null
  wonAt: string | null
  /** Horas desde el alta hasta el contacto, o hasta ahora si sigue sin contactar. */
  hoursToContact: number | null
  /** Sin contactar y con más de 48 h encima. Lo urgente de la lista. */
  stale: boolean
}

// ── Search params ────────────────────────────────────────────────────────────

export const leadSearchSchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  q: z.string().trim().max(80).optional(),
  /**
   * Por default se muestran los ABIERTOS, igual que la cola de solicitudes
   * oculta las ya publicadas: es una lista de trabajo pendiente, no un
   * histórico. El histórico se pide explícitamente.
   */
  closed: z.enum(['hide', 'show']).catch('hide').default('hide'),
})

export type LeadSearch = z.infer<typeof leadSearchSchema>

/**
 * El payload de `ops.advance_lead`.
 *
 * `p_actor_id` NO está acá: sale de la sesión de Clerk en el server function.
 * `ops.action_log` es el único registro de quién movió el embudo, y un actor por
 * payload lo convierte en una firma falsificable.
 */
export const advanceLeadSchema = z.object({
  leadId: z.uuid(),
  status: z.enum(LEAD_STATUSES),
  /**
   * Opcional en el contrato, aunque un "perdido" sin motivo no sirva de nada.
   *
   * La columna es NULLABLE en el schema del backend y este panel no está para
   * endurecer un contrato ajeno desde afuera. Si el equipo decide que es
   * obligatorio, el lugar es el formulario — donde se puede cambiar de opinión
   * sin una migración.
   */
  lostReason: z.string().trim().max(280).optional(),
  note: z.string().trim().max(280).optional(),
})
