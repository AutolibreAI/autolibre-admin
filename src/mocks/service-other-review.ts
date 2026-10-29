import type { ServiceOtherReview } from '~/lib/service-other-review'

/**
 * ⚠ MOCK — la marca de "revisado" de un rubro "Otro" no tiene dónde guardarse.
 *
 * Reemplaza a: `service_other_reviewed_at/_by` + nota y
 * `POST /admin/partner-applications/:id/service-other-review`. Tarjeta
 * "Revisar rubros "Otro" declarados por proveedores…".
 *
 * Vive en memoria del navegador, a propósito: se pierde al recargar. Guardarla
 * en `localStorage` la haría parecer persistida (y por persona) cuando no lo
 * es. Arranca vacía: nada figura como revisado.
 */
const reviews = new Map<string, ServiceOtherReview>()

export async function fetchServiceOtherReviewsMock(): Promise<Map<string, ServiceOtherReview>> {
  return new Map(reviews)
}

export async function markServiceOtherReviewedMock(
  applicationId: string,
  note: string,
): Promise<ServiceOtherReview> {
  const review: ServiceOtherReview = {
    reviewedAt: new Date().toISOString(),
    reviewedBy: 'vos (ejemplo)',
    note,
  }
  reviews.set(applicationId, review)
  return review
}

export async function unmarkServiceOtherReviewedMock(applicationId: string): Promise<void> {
  reviews.delete(applicationId)
}
