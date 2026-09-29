import type { ScanMetric } from './scan-sessions'

/**
 * Los PIDs de `driving_telemetry_analysis.metrics` — vocabulario compartido por
 * la ficha de un escaneo (`/escaneres/sesiones/:id`) y el comparador
 * (`/escaneres/comparar`).
 *
 * ── Qué hay en la base, y qué NO ────────────────────────────────────────────
 *
 * Por sesión y por PID, el backend guarda SÓLO el resumen
 * `{min, max, avg, stdDev, sampleCount}`. Las lecturas crudas (la curva en el
 * tiempo) viven en JSON en DigitalOcean Spaces (`driving_session_chunks.object_key`)
 * y el panel no las lee — decidido el 2026-09-25: nada que tenga que ver con
 * DigitalOcean. Todo gráfico de PID del panel es un gráfico de RANGO sobre ese
 * resumen, y la pantalla lo dice.
 *
 * ── Las claves son del backend ──────────────────────────────────────────────
 *
 * 13 claves en producción al 2026-09-25. Una clave sin entrada en `PID_INFO` se
 * muestra CRUDA y ordena al final — nunca se esconde, mismo criterio que
 * `ANOMALY_TYPE_LABELS`.
 */

export interface PidInfo {
  label: string
  /** Nombre corto para columnas y chips. */
  short: string
  unit: string
  /**
   * Rango de dibujo por default: lo que un auto sano recorre. El eje se
   * ESTIRA si el dato se sale (nunca recorta un valor real), así que esto no
   * es un filtro, es el zoom inicial.
   */
  domain: readonly [number, number]
  /**
   * Límites físicos: afuera de esto el valor no es "raro", es imposible — el
   * escáner leyó basura (típicamente el byte crudo en 0x00 o 0xFF). `null` =
   * cualquier valor es representable (carga y acelerador van de 0 a 100 de
   * verdad).
   */
  plausible: readonly [number, number] | null
  /** Línea de referencia fija, si el PID la tiene (fuel trims: 0 = sin corrección). */
  zero?: boolean
}

/**
 * Orden = orden de lectura: primero lo que diagnostica mezcla (trims), después
 * motor, temperaturas, eléctrico. Es el orden de las filas en la ficha.
 *
 * Los límites de `plausible` se calibraron el 2026-09-25 contra producción: con
 * estos cortes caen exactamente 2 sesiones enteras (motor a 181 °C, 227 km/h y
 * 8.280 rpm clavados, trims en −100) y 3 PIDs sueltos en su valor crudo
 * extremo (LTFT 99,2 %, avance −64°). Ningún valor que parezca real.
 */
export const PID_INFO: Record<string, PidInfo> = {
  longFuelTrim: {
    label: 'Corrección de combustible a largo plazo (LTFT)',
    short: 'LTFT',
    unit: '%',
    domain: [-25, 25],
    plausible: [-99, 99],
    zero: true,
  },
  shortFuelTrim: {
    label: 'Corrección de combustible a corto plazo (STFT)',
    short: 'STFT',
    unit: '%',
    domain: [-25, 25],
    plausible: [-99, 99],
    zero: true,
  },
  rpm: { label: 'Revoluciones', short: 'RPM', unit: 'rpm', domain: [0, 4000], plausible: [0, 8000] },
  engineLoad: { label: 'Carga del motor', short: 'Carga', unit: '%', domain: [0, 100], plausible: null },
  throttle: { label: 'Posición del acelerador', short: 'Acelerador', unit: '%', domain: [0, 100], plausible: null },
  maf: { label: 'Caudal de aire (MAF)', short: 'MAF', unit: 'g/s', domain: [0, 40], plausible: [0, 400] },
  timingAdvance: {
    label: 'Avance de encendido',
    short: 'Avance',
    unit: '°',
    domain: [-10, 40],
    plausible: [-63.9, 63.4],
  },
  speed: { label: 'Velocidad', short: 'Velocidad', unit: 'km/h', domain: [0, 120], plausible: [0, 250] },
  engineTemp: {
    label: 'Temperatura del refrigerante',
    short: 'Temp. motor',
    unit: '°C',
    domain: [0, 110],
    plausible: [-40, 150],
  },
  intakeTemp: {
    label: 'Temperatura del aire de admisión',
    short: 'Temp. admisión',
    unit: '°C',
    domain: [0, 60],
    plausible: [-40, 120],
  },
  oilTemp: { label: 'Temperatura del aceite', short: 'Temp. aceite', unit: '°C', domain: [0, 130], plausible: [-40, 170] },
  voltage: { label: 'Tensión de batería', short: 'Tensión', unit: 'V', domain: [11, 15], plausible: [8, 18] },
  fuelPressure: { label: 'Presión de combustible', short: 'Presión comb.', unit: 'kPa', domain: [0, 600], plausible: null },
}

const PID_ORDER = Object.keys(PID_INFO)

export const pidLabel = (pid: string): string => PID_INFO[pid]?.label ?? pid
export const pidShort = (pid: string): string => PID_INFO[pid]?.short ?? pid
export const pidUnit = (pid: string): string => PID_INFO[pid]?.unit ?? ''

/** Orden de lectura: los conocidos en el orden de `PID_INFO`, los crudos al final. */
export function comparePids(a: string, b: string): number {
  const ia = PID_ORDER.indexOf(a)
  const ib = PID_ORDER.indexOf(b)
  if (ia === -1 && ib === -1) return a.localeCompare(b)
  if (ia === -1) return 1
  if (ib === -1) return -1
  return ia - ib
}

/**
 * Por qué este resumen de PID es IMPOSIBLE, o `null` si es representable.
 *
 * Mira min y max, no la media: un LTFT que fue de 0,8 a 99,2 promedia algo
 * plausible y sin embargo leyó basura en algún momento.
 */
export function implausibleReason(pid: string, m: ScanMetric): string | null {
  const limits = PID_INFO[pid]?.plausible
  if (!limits) return null
  const [lo, hi] = limits
  // Estricto: 0 rpm o 0 km/h son reales (motor apagado, auto quieto). Los
  // límites de trims y avance están puestos JUSTO adentro del byte crudo
  // extremo (−100 %, 99,2 %, −64°) — ese valor es "el sensor no contestó".
  if (m.min < lo || m.max > hi) {
    return `fuera de rango físico (${formatPidValue(m.min)} a ${formatPidValue(m.max)} ${pidUnit(pid)})`
  }
  return null
}

/**
 * A partir de cuántos PIDs imposibles la SESIÓN entera deja de ser creíble.
 * Relevado: las sesiones basura tienen 6; las sanas con un PID raro, 1. Con 3
 * PIDs imposibles lo que falló es la lectura, no un sensor — y entonces los
 * PIDs que "pasan" (acelerador clavado en 86,7) tampoco son de fiar.
 */
export const SUSPECT_SESSION_MIN_PIDS = 3

export function implausiblePids(metrics: Record<string, ScanMetric>): Array<string> {
  return Object.entries(metrics)
    .filter(([pid, m]) => implausibleReason(pid, m) !== null)
    .map(([pid]) => pid)
}

export const isSuspectSession = (metrics: Record<string, ScanMetric>): boolean =>
  implausiblePids(metrics).length >= SUSPECT_SESSION_MIN_PIDS

/** Floats del análisis: enteros sin decimales, el resto con hasta 1. `es-AR`. */
export function formatPidValue(n: number): string {
  return Number.isInteger(n)
    ? n.toLocaleString('es-AR')
    : n.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

// ── Estadística de grupo (comparador) ───────────────────────────────────────

/** Cuantil lineal (el mismo método que `percentile_cont`). `null` sin datos. */
export function quantile(values: ReadonlyArray<number>, q: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const a = sorted[lo] as number
  const b = sorted[hi] as number
  return a + (b - a) * (pos - lo)
}

export interface GroupStats {
  /** Cuántos valores entraron (sesiones, o autos si es "por auto"). */
  n: number
  median: number | null
  q1: number | null
  q3: number | null
}

export function groupStats(values: ReadonlyArray<number>): GroupStats {
  return {
    n: values.length,
    median: quantile(values, 0.5),
    q1: quantile(values, 0.25),
    q3: quantile(values, 0.75),
  }
}
