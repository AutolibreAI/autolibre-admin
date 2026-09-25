import { z } from 'zod'
import { multiSelectParam } from './catalog'
import type { ScanMetric } from './scan-sessions'

/**
 * El comparador de escaneos — `/escaneres/comparar`.
 *
 * ── Qué reemplaza ───────────────────────────────────────────────────────────
 *
 * La consulta que nadie arma: abrir el jsonb `driving_telemetry_analysis.metrics`
 * de N escaneos del mismo modelo y compararlos a ojo. La pregunta tipo es
 * *"¿cuál es el LTFT normal de un Vento 2.5?"* — y, detrás, comparar autos
 * iguales o parecidos que difieren en algo (DTCs, km, mantenimiento, año).
 *
 * ── Qué dato hay ────────────────────────────────────────────────────────────
 *
 * El RESUMEN por escaneo y por PID (`min/max/avg/stdDev/sampleCount`). Las
 * curvas en el tiempo están en DigitalOcean y quedaron fuera (decidido el
 * 2026-09-25). Para "¿cuál es el valor normal?" alcanza con la media de cada
 * escaneo; la pantalla dice sobre cuántos escaneos y cuántos AUTOS está hecha
 * la cuenta, porque con 49 análisis en toda la base casi ningún grupo pasa de
 * 3 autos.
 *
 * ── "Similar" son tres niveles, sin adivinar ────────────────────────────────
 *
 * `vehicle_catalog_specs.engine` está vacío en la mayoría de los catálogos
 * escaneados, así que no sirve para agrupar por cilindrada; y parsear "2.5"
 * del `trim` sería adivinar. Los niveles salen de columnas que existen:
 *
 *  - `exact`   — el mismo `vehicle_catalogs.id` (VENTO 2.5 2007).
 *  - `version` — misma marca + modelo + versión, cualquier año (VENTO 2.5 2007 y 2015).
 *  - `model`   — misma marca + modelo (suma el VENTO 1.4TSI 2019).
 *
 * ── Comparar es AGRUPAR, no pintar ──────────────────────────────────────────
 *
 * El design system no tiene una paleta categórica que pase la validación de
 * accesibilidad (Action Dark y los grises no leen como color; los de estado
 * están reservados). Cada característica parte las filas en BLOQUES, cada uno
 * con su mediana. → `~/components/PidRangeChart`
 *
 * ── Ni una escritura ────────────────────────────────────────────────────────
 */

export const COMPARE_LEVELS = ['exact', 'version', 'model'] as const
export type CompareLevel = (typeof COMPARE_LEVELS)[number]

export const COMPARE_LEVEL_LABELS: Record<CompareLevel, string> = {
  exact: 'Exacto',
  version: 'Misma versión, cualquier año',
  model: 'Mismo modelo, cualquier versión',
}

/**
 * Por qué característica se parten las filas. `vehicle` es el default: un
 * bloque por auto, que es lo que hace visible que 7 escaneos del mismo Vento
 * no son 7 Ventos.
 */
export const COMPARE_GROUP_BY = [
  'vehicle',
  'dtc',
  'maintenance',
  'year',
  'km',
  'transmission',
  'fuel',
  'none',
] as const
export type CompareGroupBy = (typeof COMPARE_GROUP_BY)[number]

export const COMPARE_GROUP_BY_LABELS: Record<CompareGroupBy, string> = {
  vehicle: 'Auto',
  dtc: 'Con / sin DTCs',
  maintenance: 'Mantenimiento previo',
  year: 'Año',
  km: 'Kilometraje',
  transmission: 'Caja',
  fuel: 'Combustible',
  none: 'Sin agrupar',
}

/**
 * Ventana de "mantenimiento previo": hubo uno HECHO en los N días anteriores
 * al escaneo. 90 días es un corte nuestro (un service reciente todavía puede
 * explicar un PID), no un dato del dominio — la pantalla lo dice.
 */
export const COMPARE_MAINTENANCE_WINDOW_DAYS = 90

/** Tramos de km del auto. `odometer_value` es el km ACTUAL, no el del día del escaneo. */
export const COMPARE_KM_BUCKETS: ReadonlyArray<{ upTo: number; label: string }> = [
  { upTo: 50_000, label: 'hasta 50.000 km' },
  { upTo: 100_000, label: '50.000 a 100.000 km' },
  { upTo: 150_000, label: '100.000 a 150.000 km' },
  { upTo: Infinity, label: 'más de 150.000 km' },
]

/** Los PIDs que se muestran si no se eligió ninguno: los que más dicen de un motor. */
export const COMPARE_DEFAULT_PIDS = [
  'longFuelTrim',
  'shortFuelTrim',
  'engineTemp',
  'rpm',
  'maf',
  'engineLoad',
] as const

/**
 * Search params calificados (`compare*`): TanStack mergea los de TODAS las
 * rutas y un `level`/`groupBy` pelado es el próximo nombre que otra pantalla va
 * a querer. → `.claude/rules/notifications.md`
 *
 * Vehículos, escaneos y PIDs vacíos = "todos" (o los PIDs default), nunca
 * "ninguno" — mismo criterio que los multiselect de `/partners/listado`.
 */
export const scanCompareSearchSchema = z.object({
  compareCatalogId: z.uuid().optional().catch(undefined),
  compareLevel: z.enum(COMPARE_LEVELS).catch('version').default('version'),
  compareVehicles: multiSelectParam(z.uuid()),
  compareSessions: multiSelectParam(z.uuid()),
  comparePids: multiSelectParam(z.string().trim().max(40)),
  compareGroupBy: z.enum(COMPARE_GROUP_BY).catch('vehicle').default('vehicle'),
  /** Incluir los escaneos de lectura dudosa (`isSuspectSession`). Default no. */
  compareIncludeSuspect: z.coerce.boolean().catch(false).default(false),
})
export type ScanCompareSearch = z.infer<typeof scanCompareSearchSchema>

/** Un modelo del catálogo con al menos un escaneo analizado — las opciones del selector. */
export interface CompareCatalogOption {
  id: string
  label: string
  sessions: number
  vehicles: number
}

/** Un escaneo, con lo necesario para compararlo contra otros. */
export interface CompareSession {
  id: string
  startedAt: string
  durationSeconds: number | null
  totalReadings: number

  vehicleId: string
  plate: string
  alias: string | null
  userId: string
  userLabel: string

  catalogId: string
  catalogLabel: string
  year: number | null
  fuelType: string | null
  transmission: string | null
  /** El km ACTUAL del auto. `null` si no está cargado (0 cuenta como no cargado). */
  odometerKm: number | null
  distanceSinceDtcClearKm: number | null

  dtcCodes: Array<string>
  /** El último mantenimiento HECHO hasta el día del escaneo, y cuántos días antes. */
  lastMaintenanceName: string | null
  lastMaintenanceDaysBefore: number | null

  metrics: Record<string, ScanMetric>
}

export interface CompareView {
  /** El catálogo elegido; `null` si el id no existe o no tiene escaneos analizados. */
  reference: CompareCatalogOption | null
  /** Los catálogos que entraron con el nivel elegido (el de referencia incluido). */
  catalogs: Array<{ id: string; label: string }>
  /** TODOS los escaneos analizados del grupo. La selección se aplica en el cliente. */
  sessions: Array<CompareSession>
}
