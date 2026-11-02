import { useEffect, useMemo, useState } from 'react'
import { fetchPartnerPlansMock } from '~/mocks/partner-plans'
import type { PartnerPlanAssignment } from '~/mocks/partner-plans'
import type { PartnerPlan } from '~/lib/partner-plans'

/**
 * El plan de cada proveedor, para Propuestas, Estudio y la ficha. Hoy sale de
 * `~/mocks/partner-plans` (no existe `partners.plan`); el día que exista, este
 * hook cambia el fetch y ninguna pantalla se entera.
 */
export function usePartnerPlans(partnerIds: ReadonlyArray<string>) {
  const key = partnerIds.join(',')
  const [assignments, setAssignments] = useState<Map<string, PartnerPlanAssignment>>(new Map())
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
  }, [key])

  const plans = useMemo(() => {
    const out = new Map<string, PartnerPlan>()
    for (const [id, a] of assignments) if (a.plan) out.set(id, a.plan)
    return out
  }, [assignments])

  return { assignments, plans }
}
