import { PARTNER_PLANS } from '~/lib/partner-plans'
import type { PartnerPlan } from '~/lib/partner-plans'

/**
 * ⚠ MOCK — datos de ejemplo, no de la base.
 *
 * `src/mocks/` es la ÚNICA capa de datos inventados del panel: un archivo por
 * tarjeta, cada uno con la forma de la respuesta que se le pidió al backend en
 * `docs/necesidades-backend-admin.md`. Reemplazar un mock es cambiar el import
 * de la pantalla por el server function o el endpoint real; la pantalla no
 * cambia. Toda pantalla que lea de acá muestra `<MockBanner/>`.
 *
 * Reemplaza a: `partners.plan` (columna nueva) o el `plan` de
 * `GET /admin/partner-proposal-usage`. Tarjeta "Admin: conteo mensual de
 * propuestas por proveedor + tope por plan".
 *
 * El plan sale de un hash del id, así es estable entre recargas y reparte los
 * cuatro planes para que se vean el semáforo y el "sin límite". No significa
 * nada sobre el proveedor real.
 */
export async function fetchPartnerPlansMock(
  partnerIds: ReadonlyArray<string>,
): Promise<Map<string, PartnerPlan>> {
  const out = new Map<string, PartnerPlan>()
  for (const id of partnerIds) {
    let h = 0
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
    const bucket = h % 10
    out.set(id, bucket < 5 ? PARTNER_PLANS[0] : bucket < 7 ? PARTNER_PLANS[1] : bucket < 9 ? PARTNER_PLANS[2] : PARTNER_PLANS[3])
  }
  return out
}
