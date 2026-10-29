import { z } from 'zod'

/**
 * Revisión mensual de los rubros "Otro" que declaran los proveedores al
 * anotarse (`partner_applications.service_other`, texto libre) — tarjeta
 * "Revisar rubros "Otro" declarados por proveedores y crear/asignar servicios
 * faltantes".
 *
 * Lo que se lee es real; la marca de "revisado" no tiene dónde guardarse
 * todavía (`~/mocks/service-other-review`).
 */

export const SERVICE_OTHER_REVIEW_FILTERS = ['pending', 'all'] as const
export type ServiceOtherReviewFilter = (typeof SERVICE_OTHER_REVIEW_FILTERS)[number]

export const serviceOtherReviewSearchSchema = z.object({
  /** Calificado por dominio: `review`/`status` pelados chocan con otras rutas. */
  serviceOtherReview: z.enum(SERVICE_OTHER_REVIEW_FILTERS).catch('pending').default('pending'),
})

export interface ServiceOtherReview {
  reviewedAt: string
  reviewedBy: string
  note: string
}

export interface ServiceOtherRow {
  applicationId: string
  businessName: string
  status: string
  createdAt: string
  /** El texto tal cual lo escribió el proveedor. */
  serviceOther: string
  /** `null` = la solicitud todavía no se aprobó: no hay partner al que asignarle nada. */
  partner: {
    id: string
    name: string
    /** Ids de `services` que tiene hoy. */
    assignedServiceIds: Array<string>
  } | null
}
