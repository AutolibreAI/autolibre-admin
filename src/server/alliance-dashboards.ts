// SERVER-ONLY: resuelve los links de los tableros de las alianzas. Algunos dan
// acceso sin login y viven en variables del servidor. → `~/lib/alliance-dashboards`
import '@tanstack/react-start/server-only'
import { ALLIANCE_DASHBOARDS, type AllianceDashboard } from '~/lib/alliance-dashboards'

/** Se lee en cada llamada (no en scope de módulo). Nunca loguear el valor. */
export function readAllianceDashboards(): Array<AllianceDashboard> {
  return ALLIANCE_DASHBOARDS.map((d) => {
    const fromEnv = d.envVar ? process.env[d.envVar]?.trim() : undefined
    const url = d.url ?? (fromEnv && /^https:\/\//.test(fromEnv) ? fromEnv : null)
    return {
      key: d.key,
      name: d.name,
      what: d.what,
      access: d.access,
      url,
      missingEnv: d.envVar && !url ? d.envVar : null,
    }
  })
}
