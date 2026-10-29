/**
 * Aperturas de la app: DAU / WAU / MAU, stickiness, retención por cohorte y
 * "activo con valor" — tarjeta "Medir usuarios activos reales (aperturas de la
 * app)".
 *
 * No existe ningún registro de aperturas (ni en la base ni en el backend): el
 * gráfico "Usuarios activos" de `/metricas` cuenta ACCIONES más la renovación
 * del token push. Estas formas son las de los endpoints pedidos en
 * `docs/necesidades-backend-admin.md`; hoy las llena `~/mocks/app-opens`.
 *
 * Todo lo que se deriva (stickiness, % de retención, totales de la ventana) se
 * calcula acá, en código, sobre conteos agregados. Ningún endpoint devuelve
 * personas.
 */

export const APP_OPEN_WINDOWS = [7, 30, 90] as const
export type AppOpenWindow = (typeof APP_OPEN_WINDOWS)[number]

/** `GET /admin/app-opens/summary?window=` — un punto por día (Buenos Aires). */
export interface AppOpensDay {
  /** `YYYY-MM-DD`. */
  date: string
  /** Personas reales distintas que abrieron la app ese día. */
  dau: number
  /** …en los 7 días que terminan ese día. */
  wau: number
  /** …en los 30 días que terminan ese día. */
  mau: number
  /** De las que abrieron ese día, cuántas además escanearon, chatearon, pidieron o cargaron un documento. */
  valuable: number
}

/** `GET /admin/app-opens/retention` — una fila por semana de alta. */
export interface AppOpensCohort {
  /** Lunes de la semana de alta, `YYYY-MM-DD`. */
  cohortWeek: string
  size: number
  /** Personas de la cohorte que abrieron la app 1, 7 y 30 días después del alta. `null` = todavía no pasó ese plazo. */
  d1: number | null
  d7: number | null
  d30: number | null
}

export interface AppOpensData {
  days: Array<AppOpensDay>
  cohorts: Array<AppOpensCohort>
}

/** DAU/MAU en %, o `null` sin MAU. */
export function stickiness(day: Pick<AppOpensDay, 'dau' | 'mau'>): number | null {
  return day.mau > 0 ? (day.dau / day.mau) * 100 : null
}

export function retentionPct(retained: number | null, size: number): number | null {
  if (retained === null || size === 0) return null
  return (retained / size) * 100
}

export interface AppOpensWindowSummary {
  /** Último día de la ventana. */
  last: AppOpensDay | null
  avgDau: number | null
  avgStickiness: number | null
  /** % de las aperturas diarias que fueron "con valor", sobre toda la ventana. */
  valuableShare: number | null
}

export function summarizeWindow(days: ReadonlyArray<AppOpensDay>): AppOpensWindowSummary {
  if (days.length === 0) return { last: null, avgDau: null, avgStickiness: null, valuableShare: null }
  const totalDau = days.reduce((a, d) => a + d.dau, 0)
  const stick = days.map(stickiness).filter((v): v is number => v !== null)
  return {
    last: days[days.length - 1] ?? null,
    avgDau: totalDau / days.length,
    avgStickiness: stick.length > 0 ? stick.reduce((a, v) => a + v, 0) / stick.length : null,
    valuableShare: totalDau > 0 ? (days.reduce((a, d) => a + d.valuable, 0) / totalDau) * 100 : null,
  }
}
