import { useEffect, useMemo, useState } from 'react'
import { fetchPartnerPlansMock, subscribePartnerPlansMock } from '~/mocks/partner-plans'
import type { PartnerPlanAssignment } from '~/mocks/partner-plans'
import type { PartnerPlan } from '~/lib/partner-plans'

/**
 * El plan de cada proveedor, para Propuestas, Estudio y la ficha. Hoy sale de
 * `~/mocks/partner-plans` (no existe `partners.plan`); el día que exista, este
 * hook cambia el fetch y ninguna pantalla se entera.
 *
 * Se re-lee cuando alguien guarda un plan, así la ficha, la tabla del mes y la
 * histórica muestran lo mismo en la misma sesión.
 */
export function usePartnerPlans(partnerIds: ReadonlyArray<string>) {
  const key = partnerIds.join(',')
  const [assignments, setAssignments] = useState<Map<string, PartnerPlanAssignment>>(new Map())
  const [version, setVersion] = useState(0)

  useEffect(() => subscribePartnerPlansMock(() => setVersion((v) => v + 1)), [])

  useEffect(() => {
    let cancelled = false
    void fetchPartnerPlansMock(partnerIds).then((m) => {
      if (!cancelled) setAssignments(m)
    })
    return () => {
      cancelled = true
    }
    // `partnerIds` cambia sólo si cambia `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version])

  const plans = useMemo(() => {
    const out = new Map<string, PartnerPlan>()
    for (const [id, a] of assignments) if (a.plan) out.set(id, a.plan)
    return out
  }, [assignments])

  return { assignments, plans }
}
