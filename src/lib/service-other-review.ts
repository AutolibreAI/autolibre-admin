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

/**
 * Las tres señales por las que una solicitud entra a la revisión. Una solicitud
 * puede tener varias a la vez; el filtro muestra las que tienen ESA.
 *
 * - `other`: escribió algo en «Otro» (`service_other`).
 * - `freeText`: `declared_services` trae algo que no es ni un servicio ni una
 *   familia activa del catálogo (`resolved.unknownSlugs`: etiquetas del
 *   formulario viejo, como "Chapa y pintura", o rubros dados de baja). La carga
 *   automática no le pone NADA por esas entradas.
 * - `anomalous`: declaró más servicios que la mitad del catálogo activo
 *   (`isAnomalousDeclaredCount`). Casi seguro tildó "todo".
 */
export const SERVICE_OTHER_SIGNALS = ['all', 'other', 'freeText', 'anomalous'] as const
export type ServiceOtherSignalFilter = (typeof SERVICE_OTHER_SIGNALS)[number]

export const SERVICE_OTHER_SIGNAL_LABELS: Record<Exclude<ServiceOtherSignalFilter, 'all'>, string> = {
  other: 'Escribió en «Otro»',
  freeText: 'Servicios en texto libre',
  anomalous: 'Cantidad anómala',
}

export const serviceOtherReviewSearchSchema = z.object({
  /** Calificado por dominio: `review`/`status` pelados chocan con otras rutas. */
  serviceOtherReview: z.enum(SERVICE_OTHER_REVIEW_FILTERS).catch('pending').default('pending'),
  serviceOtherSignal: z.enum(SERVICE_OTHER_SIGNALS).catch('all').default('all'),
})

/**
 * "Número anómalo de servicios declarados": MÁS de la mitad de los servicios
 * activos del catálogo. Cuenta las entradas crudas de `declared_services`
 * (lo que el proveedor tildó), no los servicios resueltos.
 *
 * Por qué la mitad y no un número fijo: relevado el 2026-11-03 contra
 * producción (79 servicios activos), la distribución tiene una masa hasta 39
 * (88 de 97 solicitudes) y una cola de 40 a 74 (9 solicitudes). La mitad del
 * catálogo cae justo en ese corte, y sigue al catálogo si se agregan servicios.
 */
export function isAnomalousDeclaredCount(declaredCount: number, activeServiceCount: number): boolean {
  return activeServiceCount > 0 && declaredCount > activeServiceCount / 2
}

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
  /** El texto tal cual lo escribió el proveedor. `''` = no escribió nada en «Otro». */
  serviceOther: string
  /** Entradas de `declared_services` que no son servicio ni familia activa. */
  freeTextServices: Array<string>
  /** Cuántas entradas tiene `declared_services`, crudas. */
  declaredCount: number
  anomalous: boolean
  /** `null` = la solicitud todavía no se aprobó: no hay partner al que asignarle nada. */
  partner: {
    id: string
    name: string
    /** Ids de `services` que tiene hoy. */
    assignedServiceIds: Array<string>
  } | null
}
