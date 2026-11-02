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
 * Reemplaza a: `partners.plan` (columna nueva, P0) aceptada por el endpoint de
 * edición de partner que ya existe, y el historial de plan (P1). Tarjeta
 * "Admin: conteo mensual de propuestas por proveedor + tope por plan".
 *
 * Relevado el 02/11/26: `partners` no tiene ningún campo de plan, y
 * `ops.set_partner_profile` sólo escribe nombre, zona, descripción y tier. El
 * único "plan" de la base es `ops.partner_prospect.plan` (`free | plus |
 * undecided`), que es lo que un CONTACTO de Comercial dijo que le interesa, no
 * el plan contratado de un proveedor: otra entidad y otro catálogo.
 *
 * - El plan de partida sale de un hash del id, así es estable entre recargas y
 *   reparte los cuatro planes (y "sin plan") para que se vea el semáforo. No
 *   significa nada sobre el proveedor real.
 * - Los cambios hechos desde el panel viven EN MEMORIA, en este módulo: los ven
 *   la ficha, Propuestas y Estudio en la misma sesión, y se pierden al recargar.
 *   Nada en `localStorage`: lo haría parecer guardado.
 */

export interface PartnerPlanAssignment {
  partnerId: string
  /** `null` = sin plan. */
  plan: PartnerPlan | null
  /** `YYYY-MM-DD`, hora de Buenos Aires. `null` = sin fecha de inicio. */
  validFrom: string | null
  /** Email de quien lo cambió desde el panel. `null` = dato de partida del mock. */
  changedBy: string | null
  changedAt: string | null
}

const overrides = new Map<string, PartnerPlanAssignment>()

function seed(partnerId: string): PartnerPlanAssignment {
  let h = 0
  for (let i = 0; i < partnerId.length; i++) h = (h * 31 + partnerId.charCodeAt(i)) >>> 0
  const bucket = h % 10
  const plan: PartnerPlan | null =
    bucket < 4
      ? PARTNER_PLANS[0]
      : bucket < 6
        ? PARTNER_PLANS[1]
        : bucket < 8
          ? PARTNER_PLANS[2]
          : bucket < 9
            ? PARTNER_PLANS[3]
            : null
  return { partnerId, plan, validFrom: plan ? '2026-11-01' : null, changedBy: null, changedAt: null }
}

export async function fetchPartnerPlansMock(
  partnerIds: ReadonlyArray<string>,
): Promise<Map<string, PartnerPlanAssignment>> {
  const out = new Map<string, PartnerPlanAssignment>()
  for (const id of partnerIds) out.set(id, overrides.get(id) ?? seed(id))
  return out
}
