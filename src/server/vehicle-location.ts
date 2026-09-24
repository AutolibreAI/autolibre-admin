import '@tanstack/react-start/server-only'

import rawLocalities from './pba-localities.json'
import { sql } from './db'
import { INTERNAL_PREDICATE } from './ops.repo'
import {
  AMBA_PARTIDOS,
  PROVINCES,
  PROVINCE_LABELS,
  VEHICLE_REGIONS,
  type LocationBreakdownRow,
  type LocationGap,
  type Province,
  type ProvinceOption,
  type VehicleLocation,
  type VehicleLocationBreakdown,
  type VehicleRegion,
} from '~/lib/vehicle-location'

/**
 * Radicación de vehículos — el clasificador y los fragmentos de SQL. SOLO
 * LECTURA: `vehicle_plate_lookups` la escribe el backend cuando alguien
 * consulta una patente.
 *
 * ── SQL agrupa por el crudo, JS clasifica ──────────────────────────────────
 *
 * La clasificación (provincia normalizada, localidad → partido, AMBA) necesita
 * un dataset de ~2.300 localidades y reglas de normalización que en SQL serían
 * una tabla de referencia en `ops` + una migración. Pero los valores CRUDOS
 * distintos son pocos (≈90 pares `(province, city)` para 222 consultas al
 * 2026-09-24), así que:
 *
 *   1. `loadLocationTable()` trae los pares distintos y los clasifica en JS;
 *   2. `locationJoin()` inyecta esa tabla clasificada como `unnest(...)` de
 *      arrays paralelos, y el SQL de cada pantalla filtra, ordena y agrupa
 *      sobre ella como si fuera una columna más.
 *
 * Mismo patrón que el pivot de `/escaneres` (`scanner-compatibility.md`):
 * Postgres cuenta, JS decide la forma. Un par que aparezca entre las dos
 * consultas (una patente consultada justo en ese milisegundo) no está en la
 * tabla y cae en `sin_clasificar` por el `coalesce` de `locationJoin` — nunca
 * desaparece la fila.
 *
 * → `.claude/rules/vehicle-location.md`
 */

// ── Normalización ──────────────────────────────────────────────────────────

/**
 * Mayúsculas, sin acentos, sin puntuación, espacios colapsados. U+FFFD (el
 * carácter que vino ROTO del proveedor, `LAN\ufffdS OESTE`) se conserva: el match lo
 * trata como comodín de un carácter.
 */
function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\ufffd]+/g, ' ')
    .trim()
}

// ── Provincias ─────────────────────────────────────────────────────────────

/**
 * Normalizado → clave. Las 24 por su nombre, más las formas alternativas que
 * el proveedor usa de hecho (`CAPITAL FEDERAL` convive con `Ciudad Autónoma de
 * Buenos Aires`) o que son nombres oficiales largos.
 */
const PROVINCE_BY_NAME = new Map<string, Province>([
  ...PROVINCES.map((p) => [norm(PROVINCE_LABELS[p]), p] as const),
  ['CIUDAD AUTONOMA DE BUENOS AIRES', 'caba'],
  ['CIUDAD DE BUENOS AIRES', 'caba'],
  ['CAPITAL FEDERAL', 'caba'],
  ['C A B A', 'caba'],
  ['PROVINCIA DE BUENOS AIRES', 'buenos_aires'],
  ['BS AS', 'buenos_aires'],
  ['TIERRA DEL FUEGO ANTARTIDA E ISLAS DEL ATLANTICO SUR', 'tierra_del_fuego'],
])

/** Una "ciudad" que en realidad es CABA — pasa cuando la provincia vino como Buenos Aires. */
const CABA_CITY_NAMES = new Set([
  'CABA',
  'C A B A',
  'CAPITAL FEDERAL',
  'C AUTONOMA DE BS AS',
  'CIUDAD AUTONOMA DE BUENOS AIRES',
])

// ── Localidades de PBA ─────────────────────────────────────────────────────

/** Normalizado → partidos posibles (un nombre puede repetirse en varios partidos). */
const PARTIDOS_BY_PLACE = new Map<string, Set<string>>()
function addPlace(name: string, partido: string) {
  const k = norm(name)
  const set = PARTIDOS_BY_PLACE.get(k) ?? new Set<string>()
  set.add(partido)
  PARTIDOS_BY_PLACE.set(k, set)
}
for (const pair of (rawLocalities as { pairs: Array<Array<string>> }).pairs) {
  const [name, partido] = pair
  if (!name || !partido) continue
  addPlace(name, partido)
  // El partido también es un nombre válido: `MORON` o `EZEIZA` a secas.
  addPlace(partido, partido)
}

/**
 * Lo que el dataset no resuelve solo, con el motivo de cada entrada. Relevado
 * el 2026-09-24 contra los valores reales de producción: el proveedor usa el
 * nombre corto del barrio, y Georef el largo (o no lo tiene).
 *
 * Agregar un alias es una línea acá. El bloque ámbar de `/metricas` lista lo
 * que falta.
 */
const PLACE_ALIASES: Record<string, string> = {
  BOULOGNE: 'San Isidro', // Georef: "Boulogne Sur Mer"
  ACASSUSO: 'San Isidro', // barrio de San Isidro, no está en Georef
  'DON TORCUATO': 'Tigre', // Georef: "Don Torcuato Este" / "Don Torcuato Oeste", los dos Tigre
  'NUEVE DE ABRIL': 'Esteban Echeverría', // Georef: "9 de Abril"
  NORDELTA: 'Tigre', // barrio cerrado de Tigre, no está en Georef
  // Único homónimo con regiones DISTINTAS en los datos reales: San Miguel
  // (AMBA) vs. Hipólito Yrigoyen (interior de PBA). Se elige San Miguel porque
  // es el único de los dos donde hay usuarios de la app; si aparece un auto de
  // Hipólito Yrigoyen, este alias lo va a ubicar mal y hay que sacarlo.
  'BELLA VISTA': 'San Miguel',
}

const AMBA = new Set(AMBA_PARTIDOS.map(norm))
const isAmba = (partido: string) => AMBA.has(norm(partido))

const ALL_PLACE_KEYS = [...PARTIDOS_BY_PLACE.keys()]

function lookupPlace(key: string): Set<string> | null {
  if (!key) return null
  const alias = PLACE_ALIASES[key]
  if (alias) return new Set([alias])
  const exact = PARTIDOS_BY_PLACE.get(key)
  if (exact) return exact
  if (key.includes('\ufffd')) {
    const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\ufffd/g, '.')}$`)
    const found = new Set<string>()
    for (const k of ALL_PLACE_KEYS) {
      if (re.test(k)) for (const p of PARTIDOS_BY_PLACE.get(k)!) found.add(p)
    }
    return found.size ? found : null
  }
  return null
}

/**
 * Localidad cruda → partidos candidatos. El proveedor escribe cosas como
 * `VILLA LUZURIAGA-LA MATANZA`, `T. SUAREZ - EZEIZA`,
 * `MONTE GRANDE PDO. E.ECHEVERRIA` o `GRAL.PACHECO`: se prueba el string
 * entero y después cada segmento, y se INTERSECAN los segmentos que matchean
 * (`Villa Luzuriaga` ∩ `La Matanza`). Si la intersección es vacía, gana el
 * primer segmento que matchee — el que suele ser la localidad.
 */
function partidosForCity(rawCity: string): Set<string> | null {
  const cleaned = rawCity
    .toUpperCase()
    .replace(/\bGRAL\b\.?\s*/g, 'GENERAL ')
    .replace(/\bPDO\b\.?/g, ' - ')
    .replace(/\bBS\s*\.?\s*AS\b\.?/g, ' ')

  const whole = lookupPlace(norm(cleaned))
  if (whole) return whole

  const segments = cleaned.split(/[-,/]/).map(norm).filter(Boolean)
  const matches = segments.map(lookupPlace).filter((m): m is Set<string> => m !== null)
  if (matches.length === 0) return null

  const intersection = matches.reduce(
    (acc, m) => new Set([...acc].filter((p) => m.has(p))),
  )
  return intersection.size ? intersection : matches[0]!
}

// ── El clasificador ────────────────────────────────────────────────────────

export interface ClassifiedLocation {
  region: VehicleRegion
  /** Clave normalizada o, si no se reconoció, el crudo. */
  province: string | null
  provinceLabel: string | null
  partido: string | null
}

/**
 * Par crudo del registro → región. Reglas, en orden:
 *
 *  - sin provincia → `sin_dato` (hubo consulta, pero sin `currentLocation`).
 *  - provincia no reconocida → `sin_clasificar`, con el crudo como etiqueta.
 *  - CABA → `caba`. Buenos Aires con una "ciudad" que es CABA → también.
 *  - Buenos Aires: localidad → partido(s).
 *      · un partido → AMBA o resto según `AMBA_PARTIDOS`;
 *      · varios, TODOS de la misma región → esa región, partido `null`
 *        (`DEL VISO` es José C. Paz y Pilar: los dos AMBA, da igual cuál);
 *      · varios de regiones distintas, o ninguno → `sin_clasificar`.
 *        NUNCA se elige un partido por orden de aparición.
 *  - cualquier otra provincia → `interior`.
 */
export function classifyLocation(
  rawProvince: string | null,
  rawCity: string | null,
): ClassifiedLocation {
  if (!rawProvince) return { region: 'sin_dato', province: null, provinceLabel: null, partido: null }

  const province = PROVINCE_BY_NAME.get(norm(rawProvince))
  if (!province) {
    return { region: 'sin_clasificar', province: rawProvince, provinceLabel: rawProvince, partido: null }
  }
  const base = { province, provinceLabel: PROVINCE_LABELS[province] }

  if (province === 'caba') return { ...base, region: 'caba', partido: null }
  if (province !== 'buenos_aires') return { ...base, region: 'interior', partido: null }

  if (rawCity && CABA_CITY_NAMES.has(norm(rawCity))) {
    return { region: 'caba', province: 'caba', provinceLabel: PROVINCE_LABELS.caba, partido: null }
  }

  const partidos = rawCity ? partidosForCity(rawCity) : null
  if (!partidos) return { ...base, region: 'sin_clasificar', partido: null }

  const regions = new Set<VehicleRegion>(
    [...partidos].map((p): VehicleRegion => (isAmba(p) ? 'amba_pba' : 'resto_pba')),
  )
  if (regions.size > 1) return { ...base, region: 'sin_clasificar', partido: null }

  return {
    ...base,
    region: [...regions][0]!,
    partido: partidos.size === 1 ? [...partidos][0]! : null,
  }
}

// ── La tabla clasificada, inyectable en SQL ────────────────────────────────

/**
 * Las tres expresiones crudas sobre el alias `vpl` (`vehicle_plate_lookups`).
 * `jsonb_typeof` es la guarda: el `payload` no es un contrato nuestro, y si el
 * proveedor cambia la forma, el auto sale "sin dato" en vez de un 500.
 */
const RAW_PROVINCE = `case when jsonb_typeof(vpl.payload->'data'->'currentLocation') = 'object'
  then nullif(btrim(vpl.payload->'data'->'currentLocation'->>'province'), '') end`
const RAW_CITY = `case when jsonb_typeof(vpl.payload->'data'->'currentLocation') = 'object'
  then nullif(btrim(vpl.payload->'data'->'currentLocation'->>'city'), '') end`
const SOURCE_DATE = `case when jsonb_typeof(vpl.payload->'data') = 'object'
  then nullif(vpl.payload->'data'->>'sourceDate', '') end`

interface LocationTable {
  rawProvince: Array<string>
  rawCity: Array<string>
  region: Array<string>
  province: Array<string | null>
  provinceLabel: Array<string | null>
  partido: Array<string | null>
}

/** Los pares crudos distintos de la base, clasificados. ~90 filas al 2026-09-24. */
export async function loadLocationTable(): Promise<LocationTable> {
  const rows = await sql<{ raw_province: string; raw_city: string | null }>(
    `select distinct ${RAW_PROVINCE} as raw_province, ${RAW_CITY} as raw_city
       from vehicle_plate_lookups vpl
      where ${RAW_PROVINCE} is not null`,
  )
  const t: LocationTable = {
    rawProvince: [],
    rawCity: [],
    region: [],
    province: [],
    provinceLabel: [],
    partido: [],
  }
  for (const r of rows) {
    const c = classifyLocation(r.raw_province, r.raw_city)
    t.rawProvince.push(r.raw_province)
    // `''` y no `null`: el join compara `coalesce(city, '')` de los dos lados,
    // y `null = null` no matchea.
    t.rawCity.push(r.raw_city ?? '')
    t.region.push(c.region)
    t.province.push(c.province)
    t.provinceLabel.push(c.provinceLabel)
    t.partido.push(c.partido)
  }
  return t
}

/**
 * Los dos joins y las columnas de radicación para una consulta que ya tiene
 * `vehicles` con el alias `v`. Empuja los seis arrays a `params` (así la
 * numeración de `$n` la sigue llevando el llamador) y devuelve:
 *
 *  - `joins`: van después del `FROM … vehicles v`.
 *  - `columns`: `loc_region`, `loc_province`, `loc_province_label`,
 *    `loc_partido`, `loc_city`, `loc_source_date` — siempre presentes.
 *
 * `vehicle_plate_lookups` tiene `UNIQUE (plate)`: el join es 1:1, sin fan-out.
 * La patente matchea tal cual (213 de 233 al 2026-09-24; normalizarla no
 * sumaba ninguna).
 */
export function locationJoin(params: Array<unknown>, table: LocationTable) {
  params.push(table.rawProvince, table.rawCity, table.region, table.province, table.provinceLabel, table.partido)
  const n = params.length
  const p = (i: number) => `$${n - 5 + i}`
  const joins = `
    left join vehicle_plate_lookups vpl on vpl.plate = v.plate
    left join unnest(${p(0)}::text[], ${p(1)}::text[], ${p(2)}::text[], ${p(3)}::text[], ${p(4)}::text[], ${p(5)}::text[])
      as loc(raw_province, raw_city, region, province, province_label, partido)
      on loc.raw_province = ${RAW_PROVINCE} and loc.raw_city = coalesce(${RAW_CITY}, '')`
  const columns = `
    coalesce(loc.region, case when ${RAW_PROVINCE} is null then 'sin_dato' else 'sin_clasificar' end) as loc_region,
    coalesce(loc.province, ${RAW_PROVINCE}) as loc_province,
    coalesce(loc.province_label, ${RAW_PROVINCE}) as loc_province_label,
    loc.partido as loc_partido,
    ${RAW_CITY} as loc_city,
    ${SOURCE_DATE} as loc_source_date`
  return { joins, columns }
}

/**
 * Orden de región para el `ORDER BY`: el de `VEHICLE_REGIONS`. Se arma desde
 * la constante para que agregar una región no deje un `CASE` desactualizado.
 */
export const REGION_RANK_SQL = `case loc_region ${VEHICLE_REGIONS.map((r, i) => `when '${r}' then ${i}`).join(' ')} end`

export interface LocationQueryColumns {
  loc_region: string
  loc_province: string | null
  loc_province_label: string | null
  loc_partido: string | null
  loc_city: string | null
  loc_source_date: string | null
}

export function mapLocation(r: LocationQueryColumns): VehicleLocation {
  const region = (VEHICLE_REGIONS as ReadonlyArray<string>).includes(r.loc_region)
    ? (r.loc_region as VehicleRegion)
    : 'sin_clasificar'
  return {
    region,
    province: (PROVINCES as ReadonlyArray<string>).includes(r.loc_province ?? '')
      ? (r.loc_province as Province)
      : null,
    provinceLabel: r.loc_province_label,
    partido: r.loc_partido,
    city: r.loc_city,
    sourceDate: r.loc_source_date,
  }
}

// ── Opciones del filtro de provincia ───────────────────────────────────────

/**
 * Las provincias que EXISTEN en la base, con cuántos autos — no las 24 fijas:
 * un chip que nunca filtra nada es ruido. Mismo patrón que
 * `listFineJurisdictions` / `listDistinctChatModels`. Cuenta todo el padrón
 * (archivados incluidos), igual que el default de `/vehiculos/listado`.
 */
export async function listProvinceOptions(): Promise<Array<ProvinceOption>> {
  const params: Array<unknown> = []
  const { joins, columns } = locationJoin(params, await loadLocationTable())
  const rows = await sql<{ loc_province: string; loc_province_label: string; vehicles: number }>(
    `select loc_province, loc_province_label, count(*)::int as vehicles
       from (select ${columns} from vehicles v ${joins}) s
      where loc_province is not null
      group by 1, 2
      order by 3 desc, 2`,
    params,
  )
  return rows.map((r) => ({ value: r.loc_province, label: r.loc_province_label, vehicles: Number(r.vehicles) }))
}

// ── Métricas ───────────────────────────────────────────────────────────────

/**
 * Dónde están radicados los autos — el bloque de `/metricas`.
 *
 * Universo: autos ACTIVOS de usuarios reales (`INTERNAL_PREDICATE` negado,
 * el mismo de las cards de Inicio). Grano: vehículo, con las patentes únicas
 * al lado — el mismo auto cargado por dos usuarios es una fila cruda y una
 * patente, igual que la card "115 activos / 106 únicos".
 *
 * Todo en UNA sentencia agrupada por (región, provincia, partido): el total,
 * las filas y los huecos salen del mismo snapshot, así que el cuadre de la
 * tabla (suma de filas = total) no depende de que nadie inserte en el medio.
 * Los subtotales (AMBA, por región) se suman en JS.
 */
export async function vehicleLocationBreakdown(): Promise<VehicleLocationBreakdown> {
  const params: Array<unknown> = []
  const { joins, columns } = locationJoin(params, await loadLocationTable())
  const rows = await sql<{
    loc_region: string
    loc_province: string | null
    loc_province_label: string | null
    loc_partido: string | null
    gap_city: string | null
    vehicles: number
    unique_plates: number
    source_min: string | null
    source_max: string | null
  }>(
    `select
       loc_region, loc_province, loc_province_label, loc_partido,
       -- Sólo para los huecos: la localidad cruda que no se pudo ubicar.
       case when loc_region = 'sin_clasificar' then loc_city end as gap_city,
       count(*)::int as vehicles,
       count(distinct nullif(btrim(upper(plate)), ''))::int as unique_plates,
       min(loc_source_date) as source_min,
       max(loc_source_date) as source_max
     from (
       select v.plate, ${columns}
         from vehicles v
         join users u on u.id = v.user_id
         ${joins}
        where not v.archived and not ${INTERNAL_PREDICATE}
     ) s
     group by 1, 2, 3, 4, 5`,
    params,
  )

  const byKey = new Map<string, LocationBreakdownRow>()
  const gaps: Array<LocationGap> = []
  let totalVehicles = 0
  let sourceDateMin: string | null = null
  let sourceDateMax: string | null = null

  for (const r of rows) {
    const vehicles = Number(r.vehicles)
    const uniquePlates = Number(r.unique_plates)
    totalVehicles += vehicles
    if (r.source_min && (!sourceDateMin || r.source_min < sourceDateMin)) sourceDateMin = r.source_min
    if (r.source_max && (!sourceDateMax || r.source_max > sourceDateMax)) sourceDateMax = r.source_max

    const region = mapLocation({ ...r, loc_city: null, loc_source_date: null }).region
    if (region === 'sin_clasificar') {
      gaps.push({ province: r.loc_province_label, city: r.gap_city, vehicles })
    }

    // `gap_city` parte las filas de `sin_clasificar` por localidad; para la
    // tabla se vuelven a juntar por (región, provincia, partido).
    const key = [region, r.loc_province ?? '', r.loc_partido ?? ''].join('\u001f')
    const prev = byKey.get(key)
    if (prev) {
      prev.vehicles += vehicles
      prev.uniquePlates += uniquePlates
    } else {
      byKey.set(key, {
        region,
        province: r.loc_province,
        provinceLabel: r.loc_province_label,
        partido: r.loc_partido,
        vehicles,
        uniquePlates,
      })
    }
  }

  // Las patentes únicas del TOTAL no son la suma de las filas: un auto cargado
  // por dos usuarios está en una sola fila (misma patente ⇒ misma radicación),
  // así que acá SÍ se puede sumar sin doble conteo. Se suma igual por fila
  // para que el pie y las filas digan lo mismo.
  const out = [...byKey.values()]
  const totalUniquePlates = out.reduce((n, r) => n + r.uniquePlates, 0)

  gaps.sort((a, b) => b.vehicles - a.vehicles)
  return { totalVehicles, totalUniquePlates, rows: out, gaps, sourceDateMin, sourceDateMax }
}
