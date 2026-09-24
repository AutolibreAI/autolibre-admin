import { z } from 'zod'
import { multiSelectParam } from './catalog'

/**
 * Radicación de vehículos — dónde está registrado cada auto, leído de
 * `vehicle_plate_lookups.payload->'data'->'currentLocation'` (`{city, province}`).
 *
 * ── Qué es y qué NO es ─────────────────────────────────────────────────────
 *
 * Es el domicilio del TITULAR según el registro, a la fecha del dato del
 * proveedor (`data.sourceDate`). No es dónde vive ni dónde usa el auto nuestro
 * usuario: si el auto se vendió, o está a nombre de un familiar, no es él.
 * Para "entender el público" es una aproximación, y la UI lo dice.
 *
 * ── Tres niveles ───────────────────────────────────────────────────────────
 *
 *  - provincia: normalizada contra la lista oficial de 24 jurisdicciones. No
 *    es el mapeo adivinado que `partners-coverage.md` prohíbe para
 *    `coverage_zone`: la lista es cerrada y lo único que se corrige es forma
 *    (`CAPITAL FEDERAL` / `Ciudad Autónoma de Buenos Aires`, `NEUQUEN` /
 *    `Neuquén`). Un valor que no matchea se muestra CRUDO.
 *  - partido: sólo para PBA, de la localidad vía el dataset oficial de Georef
 *    (`src/server/pba-localities.json`, server-only).
 *  - región: CABA / AMBA-PBA / resto de PBA / interior, más los dos "no sé".
 *
 * El clasificador vive en `src/server/vehicle-location.ts` (necesita el JSON);
 * acá está sólo el vocabulario que la UI comparte.
 * → `.claude/rules/vehicle-location.md`
 */

// ── Provincias ────────────────────────────────────────────────────────────

/** Las 24 jurisdicciones. El orden es el de visualización por defecto. */
export const PROVINCES = [
  'caba',
  'buenos_aires',
  'catamarca',
  'chaco',
  'chubut',
  'cordoba',
  'corrientes',
  'entre_rios',
  'formosa',
  'jujuy',
  'la_pampa',
  'la_rioja',
  'mendoza',
  'misiones',
  'neuquen',
  'rio_negro',
  'salta',
  'san_juan',
  'san_luis',
  'santa_cruz',
  'santa_fe',
  'santiago_del_estero',
  'tierra_del_fuego',
  'tucuman',
] as const
export type Province = (typeof PROVINCES)[number]

export const PROVINCE_LABELS: Record<Province, string> = {
  caba: 'CABA',
  buenos_aires: 'Buenos Aires',
  catamarca: 'Catamarca',
  chaco: 'Chaco',
  chubut: 'Chubut',
  cordoba: 'Córdoba',
  corrientes: 'Corrientes',
  entre_rios: 'Entre Ríos',
  formosa: 'Formosa',
  jujuy: 'Jujuy',
  la_pampa: 'La Pampa',
  la_rioja: 'La Rioja',
  mendoza: 'Mendoza',
  misiones: 'Misiones',
  neuquen: 'Neuquén',
  rio_negro: 'Río Negro',
  salta: 'Salta',
  san_juan: 'San Juan',
  san_luis: 'San Luis',
  santa_cruz: 'Santa Cruz',
  santa_fe: 'Santa Fe',
  santiago_del_estero: 'Santiago del Estero',
  tierra_del_fuego: 'Tierra del Fuego',
  tucuman: 'Tucumán',
}

// ── AMBA ──────────────────────────────────────────────────────────────────

/**
 * Los 40 municipios de la Región Metropolitana de Buenos Aires. **Decidido el
 * 2026-09-24 con el dueño de producto**: "conurbano" y "AMBA" en este panel
 * son ESTOS 40, no los 24 partidos del INDEC — el público de "zona norte"
 * incluye Pilar y Escobar, y el de "zona sur" La Plata.
 *
 * Los nombres son los de `departamento.nombre` de Georef, escritos igual que en
 * `pba-localities.json`: el clasificador compara normalizado, pero escribirlos
 * iguales hace que un `grep` los encuentre en los dos lados. Cambiar de
 * definición es tocar esta lista y nada más.
 */
export const AMBA_PARTIDOS = [
  // Los 24 partidos del Gran Buenos Aires (INDEC).
  'Almirante Brown',
  'Avellaneda',
  'Berazategui',
  'Esteban Echeverría',
  'Ezeiza',
  'Florencio Varela',
  'General San Martín',
  'Hurlingham',
  'Ituzaingó',
  'José C. Paz',
  'La Matanza',
  'Lanús',
  'Lomas de Zamora',
  'Malvinas Argentinas',
  'Merlo',
  'Moreno',
  'Morón',
  'Quilmes',
  'San Fernando',
  'San Isidro',
  'San Miguel',
  'Tigre',
  'Tres de Febrero',
  'Vicente López',
  // Los 16 que completan la Región Metropolitana.
  'Berisso',
  'Brandsen',
  'Campana',
  'Cañuelas',
  'Ensenada',
  'Escobar',
  'Exaltación de la Cruz',
  'General Las Heras',
  'General Rodríguez',
  'La Plata',
  'Luján',
  'Marcos Paz',
  'Pilar',
  'Presidente Perón',
  'San Vicente',
  'Zárate',
] as const

// ── Regiones ──────────────────────────────────────────────────────────────

/**
 * El orden ES el de la tabla de `/metricas` y el del sort por radicación.
 *
 *  - `sin_clasificar`: HAY dato del registro pero no se pudo ubicar — una
 *    localidad de PBA que el dataset no conoce, o una provincia que no está en
 *    la lista. Es trabajo pendiente (un alias), no ruido: se pinta ámbar.
 *  - `sin_dato`: el auto no tiene consulta por patente, o la consulta no trajo
 *    `currentLocation`. No es "no se sabe dónde queda": es "no preguntamos".
 */
export const VEHICLE_REGIONS = [
  'caba',
  'amba_pba',
  'resto_pba',
  'interior',
  'sin_clasificar',
  'sin_dato',
] as const
export type VehicleRegion = (typeof VEHICLE_REGIONS)[number]

export const VEHICLE_REGION_LABELS: Record<VehicleRegion, string> = {
  caba: 'CABA',
  amba_pba: 'Conurbano (AMBA)',
  resto_pba: 'Resto de Buenos Aires',
  interior: 'Interior',
  sin_clasificar: 'Sin clasificar',
  sin_dato: 'Sin dato',
}

/** Etiqueta corta para la celda de la tabla, al lado del partido. */
export const VEHICLE_REGION_SHORT: Record<VehicleRegion, string> = {
  caba: 'CABA',
  amba_pba: 'AMBA',
  resto_pba: 'PBA',
  interior: 'Interior',
  sin_clasificar: 'sin clasificar',
  sin_dato: 'sin dato',
}

export function vehicleRegionOf(value: string | null | undefined): VehicleRegion {
  return (VEHICLE_REGIONS as ReadonlyArray<string>).includes(value ?? '')
    ? (value as VehicleRegion)
    : 'sin_dato'
}

/**
 * Lo que las tablas de vehículos muestran de un auto. `provinceLabel` es la
 * etiqueta normalizada, o el valor CRUDO si la provincia no se reconoció.
 */
export interface VehicleLocation {
  region: VehicleRegion
  province: Province | null
  provinceLabel: string | null
  /** Sólo PBA. `null` fuera de PBA, o si la localidad era ambigua entre partidos de la MISMA región. */
  partido: string | null
  /** La localidad cruda del registro, como vino. */
  city: string | null
  /** `data.sourceDate` del proveedor — la fecha del dato, no de la consulta. */
  sourceDate: string | null
}

/** "San Isidro · AMBA", "Rosario · Santa Fe", "CABA". Una línea, para la celda. */
export function vehicleLocationLabel(loc: VehicleLocation): string {
  if (loc.region === 'sin_dato') return 'sin dato'
  if (loc.region === 'caba') return 'CABA'
  if (loc.region === 'amba_pba' || loc.region === 'resto_pba') {
    return `${loc.partido ?? titleCase(loc.city) ?? 'Buenos Aires'} · ${VEHICLE_REGION_SHORT[loc.region]}`
  }
  const place = titleCase(loc.city)
  return place ? `${place} · ${loc.provinceLabel ?? '?'}` : (loc.provinceLabel ?? '?')
}

function titleCase(s: string | null): string | null {
  if (!s) return null
  return s.toLowerCase().replace(/(^|[\s(-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())
}

// ── Filtros (`/vehiculos/listado`) ────────────────────────────────────────

/**
 * Calificados por dominio — `vehicleRegions` / `vehicleProvinces`, nunca
 * `regions`/`provinces` pelados (`.claude/rules/notifications.md`). Multiselect
 * con la misma semántica que `/partners/listado`: vacío = sin filtro, O
 * dentro del grupo, Y entre grupos.
 *
 * `vehicleProvinces` acepta cualquier string corto y no el enum `PROVINCES`:
 * una provincia no reconocida viaja CRUDA y también tiene que poder filtrarse.
 */
export const vehicleLocationSearchShape = {
  vehicleRegions: multiSelectParam(z.enum(VEHICLE_REGIONS)),
  vehicleProvinces: multiSelectParam(z.string().trim().min(1).max(80)),
}

/** Una opción del chip de provincia: la clave que viaja y la etiqueta que se ve. */
export interface ProvinceOption {
  value: string
  label: string
  vehicles: number
}

// ── Métricas (`/metricas`) ────────────────────────────────────────────────

export interface LocationBreakdownRow {
  region: VehicleRegion
  /** Clave normalizada, o el crudo para una provincia no reconocida. `null` en `sin_dato`. */
  province: string | null
  provinceLabel: string | null
  partido: string | null
  vehicles: number
  /** Patentes únicas — el mismo auto cargado por dos usuarios cuenta una vez. */
  uniquePlates: number
}

/** Un par crudo del registro que no se pudo ubicar — el bloque ámbar. */
export interface LocationGap {
  province: string | null
  city: string | null
  vehicles: number
}

export interface VehicleLocationBreakdown {
  /** Sólo autos activos de usuarios reales — ver `vehicleLocationBreakdown`. */
  totalVehicles: number
  totalUniquePlates: number
  rows: Array<LocationBreakdownRow>
  gaps: Array<LocationGap>
  /** Rango de `sourceDate` del universo, para decir de cuándo es el dato. */
  sourceDateMin: string | null
  sourceDateMax: string | null
}
