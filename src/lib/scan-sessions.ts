import { z } from 'zod'
import type { SessionBucket } from './scanners'

/**
 * Sesiones de escáner — la pestaña `/escaneres/sesiones`.
 *
 * ── Qué reemplaza ───────────────────────────────────────────────────────────
 *
 * El `select * from driving_sessions order by started_at desc` que nadie corre,
 * más los cinco `select count(*) ... where session_id = '…'` sueltos que hacen
 * falta para saber qué trajo cada escaneo: cuántos DTC, cuántas anomalías, qué
 * distancia desde el último borrado.
 *
 * ── Cómo se relaciona con la matriz de `/escaneres/compatibilidad` ──────────
 *
 * La matriz AGREGA sesiones por catálogo × variante de escáner para contestar
 * "¿con qué autos anda este escáner?". Esta pestaña es la fila cruda: una sesión
 * por línea, todas, ordenables y filtrables. El `SessionsPanel` de la matriz ya
 * mostraba este detalle pero SÓLO detrás de una celda; acá es la vista entera.
 *
 * ── Ni una escritura ────────────────────────────────────────────────────────
 *
 * `driving_sessions` la escribe el backend cuando el teléfono sube los chunks.
 * Un escaneo es un hecho que pasó, no un estado que el admin mueva. Si aparece
 * un `UPDATE`/`INSERT` en `scan-sessions.repo.ts`, está mal.
 */

// ── Severidad de las anomalías ─────────────────────────────────────────────
//
// Es el MISMO eje de tres niveles que el catálogo de DTC del backend
// (`amarillo` / `violeta` / `rojo`, ver `design-system.md`). El JSON de
// `driving_telemetry_analysis.anomalies` lo trae en inglés; se espeja tal cual
// y un valor desconocido se muestra crudo.
export const SCAN_SEVERITIES = ['red', 'violet', 'yellow'] as const
export type ScanSeverity = (typeof SCAN_SEVERITIES)[number]

/** Una anomalía detectada por el análisis de telemetría. `type` y `pid` crudos. */
export interface ScanAnomaly {
  type: string
  /** `ScanSeverity` en la práctica; `string` para tolerar un valor nuevo del backend. */
  severity: string
  /** El PID afectado (`voltage`, `rpm`, `maf`, …). `null` si el JSON no lo trae. */
  pid: string | null
}

/**
 * Etiquetas de los tipos de anomalía que hoy produce el backend. Un tipo sin
 * entrada se muestra CRUDO (`anomalyTypeLabel`), nunca se esconde — mismo
 * criterio que los enums espejados del resto del repo.
 */
export const ANOMALY_TYPE_LABELS: Record<string, string> = {
  LOW_VOLTAGE: 'Tensión baja',
  UNSTABLE_VOLTAGE: 'Tensión inestable',
  UNSTABLE_IDLE: 'Ralentí inestable',
  HIGH_IDLE: 'Ralentí alto',
  UNSTABLE_MAF: 'MAF inestable',
  LOW_MAF_IDLE: 'MAF bajo en ralentí',
  EXCESSIVE_FLUCTUATION: 'Fluctuación excesiva',
  SENSOR_STUCK: 'Sensor trabado',
  FUEL_TRIM_DEVIATION: 'Desvío de fuel trim',
  FUEL_TRIM_AT_LIMIT: 'Fuel trim al límite',
  LTFT_CHRONIC: 'Fuel trim largo crónico',
  FUEL_DELIVERY_SUSPECT: 'Alimentación de combustible sospechosa',
  LOW_FUEL_PRESSURE: 'Presión de combustible baja',
  THERMOSTAT_SUSPECT: 'Termostato sospechoso',
  THERMOSTAT_STABILIZED_LOW: 'Motor estabilizado por debajo de temperatura',
  SLOW_WARMUP_RATE: 'Calentamiento lento',
  OVERHEATING: 'Sobrecalentamiento',
  SUSTAINED_OVER_REV: 'Sobrerrevoluciones sostenidas',
}

export function anomalyTypeLabel(type: string): string {
  return ANOMALY_TYPE_LABELS[type] ?? type
}

// ── La fila ────────────────────────────────────────────────────────────────

export interface ScanSessionRow {
  id: string
  externalSessionId: string
  /** Derivado de `status` + `total_readings`, MISMO corte que la matriz. */
  bucket: SessionBucket
  status: string

  startedAt: string
  endedAt: string | null
  /** `ended_at - started_at` en segundos. `null` si la sesión no cerró. */
  durationSeconds: number | null

  userId: string
  userEmail: string
  userName: string | null

  vehicleId: string
  plate: string
  alias: string | null
  /** `BRAND MODEL TRIM YEAR` si el auto resuelve a un catálogo; si no, `null`. */
  catalogLabel: string | null

  scannerType: string
  firmware: string | null
  obdProtocol: string | null
  /** Texto crudo del handshake, `"14.6V"`. Sucio y sin normalizar. */
  batteryVoltage: string | null
  detectedVin: string | null

  /** Muestras de telemetría que trajo el escaneo. Proxy de "riqueza". */
  totalReadings: number
  totalChunks: number
  chunksUploaded: number
  /** `distance_since_dtc_clear_km`. `null` cuando el vehículo no lo reporta. */
  distanceSinceDtcClearKm: number | null

  /** Códigos DTC vistos en la sesión (`session_dtc_snapshots.codes`). */
  dtcCodes: Array<string>
  dtcCount: number

  /** Anomalías del análisis de telemetría, ordenadas por severidad (roja primero). */
  anomalies: Array<ScanAnomaly>
  anomalyCount: number
  anomaliesBySeverity: { red: number; violet: number; yellow: number }

  producedAiDiagnostic: boolean
  producedTelemetryAnalysis: boolean

  /** De `driving_telemetry_analysis.metrics`. `null` sin análisis o sin ese PID. */
  speedMax: number | null
  rpmMax: number | null
  engineTempMax: number | null
}

// ── Orden y filtros ────────────────────────────────────────────────────────

export const SCAN_SESSION_SORT_KEYS = [
  'date',
  'duration',
  'user',
  'vehicle',
  'readings',
  'dtcs',
  'anomalies',
  'distance',
  'battery',
  'firmware',
  'status',
] as const
export type ScanSessionSortKey = (typeof SCAN_SESSION_SORT_KEYS)[number]

export const SCAN_STATE_FILTERS = ['all', 'ok', 'noData', 'failed', 'pending'] as const
export type ScanStateFilter = (typeof SCAN_STATE_FILTERS)[number]

export const SCAN_STATE_FILTER_LABELS: Record<ScanStateFilter, string> = {
  all: 'Todos',
  ok: 'Trajo datos',
  noData: 'Enganchó sin nada',
  failed: 'Falló',
  pending: 'Subiendo',
}

export const SCAN_DTC_FILTERS = ['all', 'with', 'without'] as const
export type ScanDtcFilter = (typeof SCAN_DTC_FILTERS)[number]

export const SCAN_ANOMALY_FILTERS = ['all', 'with', 'red', 'without'] as const
export type ScanAnomalyFilter = (typeof SCAN_ANOMALY_FILTERS)[number]

/**
 * `scanState` calificado por dominio: `status` y `state` pelados ya colisionan
 * con `/solicitudes`, `/leads/talleres` y `/vehiculos/listado`, y el merge de
 * search params de TanStack rompería el typecheck en la ruta ajena.
 * → `.claude/rules/notifications.md`
 *
 * `sort`/`dir` pelados: es el nombre que `SortHeader` lee y ninguna otra ruta
 * comparte search params con `/escaneres/sesiones` vía `<Link>`.
 */
export const scanSessionSearchSchema = z.object({
  q: z.string().trim().max(80).optional(),
  scanState: z.enum(SCAN_STATE_FILTERS).catch('all').default('all'),
  dtc: z.enum(SCAN_DTC_FILTERS).catch('all').default('all'),
  anomaly: z.enum(SCAN_ANOMALY_FILTERS).catch('all').default('all'),
  sort: z.enum(SCAN_SESSION_SORT_KEYS).catch('date').default('date'),
  dir: z.enum(['asc', 'desc']).catch('desc').default('desc'),
})
export type ScanSessionSearch = z.infer<typeof scanSessionSearchSchema>

/** Duración legible desde segundos. `null` → `null` (la sesión no cerró). */
export function scanDurationLabel(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null
  const min = Math.round(seconds / 60)
  if (min < 1) return `${seconds} s`
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return `${h} h ${min % 60} min`
}
