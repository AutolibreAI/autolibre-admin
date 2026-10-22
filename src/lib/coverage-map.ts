import { z } from 'zod'

/**
 * Mapa de cobertura AMBA (`/partners/cobertura`): demanda (pedidos) contra
 * oferta (partners) por partido del AMBA y comuna de CABA.
 *
 * Spec: `spec-mapa-cobertura-admin.md` (2026-10-22), secciones 3.1, 3.2 y 4.
 * Todo lo de este archivo es PURO — corre en el navegador sobre lo que ya
 * devuelven `listPartnerCandidatesFn` y `getQuoteRequestFn`. La v1 no tiene
 * endpoint propio (decidido el 2026-10-22: sin tocar el servidor), así que las
 * reglas que el spec escribe en SQL viven acá, traducidas una por una. Si el
 * día de mañana existe el endpoint de la sección 3, estas funciones se van con
 * él y la pantalla consume sus filas tal cual.
 *
 * → `.claude/rules/coverage-map.md`
 */

// ── Rubros ───────────────────────────────────────────────────────────────────

/**
 * Los 10 rubros del spec, con sus nombres EXACTOS. No son las 16
 * `service_categories`: agrupan servicios de categorías distintas («Gomería
 * móvil» está en Asistencia y va a Neumáticos; «Baterías» está en Repuestos y
 * va a Electricidad), así que se arman desde el NOMBRE de cada servicio.
 */
export const COVERAGE_RUBROS = [
  'service',
  'mecanica',
  'tren',
  'neumaticos',
  'caja',
  'electricidad',
  'aire',
  'chapa',
  'tramites',
  'lavado',
] as const
export type CoverageRubro = (typeof COVERAGE_RUBROS)[number]

export const COVERAGE_RUBRO_LABELS: Record<CoverageRubro, string> = {
  service: 'Service y lubricentro',
  mecanica: 'Mecánica y diagnóstico',
  tren: 'Tren delantero, suspensión y frenos',
  neumaticos: 'Neumáticos y alineación',
  caja: 'Caja y embrague',
  electricidad: 'Electricidad',
  aire: 'Aire acondicionado',
  chapa: 'Chapa y carrocería',
  tramites: 'Trámites y verificación',
  lavado: 'Lavado y estética',
}

/** Etiqueta corta para el encabezado de la matriz. */
export const COVERAGE_RUBRO_SHORT: Record<CoverageRubro, string> = {
  service: 'Service',
  mecanica: 'Mecánica',
  tren: 'Tren del. y frenos',
  neumaticos: 'Neumáticos',
  caja: 'Caja y embrague',
  electricidad: 'Electricidad',
  aire: 'Aire acond.',
  chapa: 'Chapa',
  tramites: 'Trámites',
  lavado: 'Lavado',
}

/**
 * `services.name` → rubro, copiado del `CASE` de la consulta 3.2. Un servicio
 * que no está acá (Grúa, Seguros, Tasación…) no aporta rubro: el partner igual
 * cuenta en «Todos». `unmappedServiceNames()` los lista en pantalla, para que
 * un servicio renombrado en el catálogo no desaparezca en silencio.
 */
const SERVICE_RUBRO: Record<string, CoverageRubro> = {
  'Service y lubricentro': 'service',
  'Diagnóstico y escaneo': 'mecanica',
  'Inyección nafta': 'mecanica',
  'Inyección diésel': 'mecanica',
  Distribución: 'mecanica',
  'Rectificación y armado de motor': 'mecanica',
  Refrigeración: 'mecanica',
  Turbo: 'mecanica',
  'Escapes y emisiones': 'mecanica',
  GNC: 'mecanica',
  'Mecánico a domicilio': 'mecanica',
  Frenos: 'tren',
  'Suspensión y amortiguación': 'tren',
  'Tren delantero': 'tren',
  Dirección: 'tren',
  'Caja automática': 'caja',
  'Caja manual': 'caja',
  Embrague: 'caja',
  'Diferencial, palieres y tracción 4x4': 'caja',
  Gomería: 'neumaticos',
  'Gomería móvil': 'neumaticos',
  'Venta de neumáticos': 'neumaticos',
  'Alineación y balanceo': 'neumaticos',
  Llantas: 'neumaticos',
  'Aire acondicionado y climatización': 'aire',
  'Electricidad general': 'electricidad',
  'ECU y módulos': 'electricidad',
  Iluminación: 'electricidad',
  'Llaves e inmovilizador': 'electricidad',
  'Tablero e instrumental': 'electricidad',
  Baterías: 'electricidad',
  'Batería a domicilio': 'electricidad',
  'Chapa y pintura': 'chapa',
  'Plásticos y paragolpes': 'chapa',
  'Parabrisas y cristales': 'chapa',
  'Cerraduras y aberturas': 'chapa',
  Ópticas: 'chapa',
  'Registro automotor': 'tramites',
  'Multas e infracciones': 'tramites',
  'VTV y RTO': 'tramites',
  Patentamiento: 'tramites',
  'Informes y antecedentes': 'tramites',
  'Peritaje e inspección pre-compra': 'tramites',
  'Licencias y habilitaciones': 'tramites',
  Lavado: 'lavado',
  'Detailing y corrección de pintura': 'lavado',
  'Limpieza de interiores': 'lavado',
  'Desbarro y limpieza pesada': 'lavado',
}

export function serviceRubro(serviceName: string): CoverageRubro | null {
  return SERVICE_RUBRO[serviceName.trim()] ?? null
}

/**
 * El rubro de un pedido, inferido de la descripción — el `CASE` de la consulta
 * 3.1, en el MISMO orden (el primero que matchea gana). Sin match cae en
 * Mecánica. Es una heurística por palabras y la pantalla lo dice; el arreglo
 * de verdad es guardar el rubro en el pedido (spec, sección 7).
 */
const PEDIDO_RUBRO_RULES: Array<[RegExp, CoverageRubro]> = [
  [/(chapa|pintura|sacabollo|abolladura|choque|agua en)/, 'chapa'],
  [/(amortigu|parrilla|r[oó]tula|freno|buje|tren delantero|suspensi)/, 'tren'],
  [/(caja de cambios|caja autom|embrague)/, 'caja'],
  [/(distribuci|tapa de cilindro)/, 'mecanica'],
  [/(service|aceite|filtro|fluidos)/, 'service'],
  [/(alineaci|balanceo|cubierta|neum|gomer)/, 'neumaticos'],
  [/(aire acond|no enfr|climatiz)/, 'aire'],
  [/(luces|pantalla|llave|inmoviliz|bater|chicharra)/, 'electricidad'],
  [/(gestor|verificador|inspector|vtv|multa)/, 'tramites'],
  [/(lavar|lavado)/, 'lavado'],
]

export function inferPedidoRubro(description: string): CoverageRubro {
  const d = description.toLowerCase()
  for (const [re, rubro] of PEDIDO_RUBRO_RULES) if (re.test(d)) return rubro
  return 'mecanica'
}

// ── Ubicación de un pedido ───────────────────────────────────────────────────

/**
 * Centros de localidad para los pedidos SIN GPS (ubicación tipeada), copiados
 * de la tabla `lugares` de la consulta 3.1. Se recorren en orden y gana el
 * primero. Se busca en localidad + dirección; si esas no tienen ni una letra,
 * en la descripción.
 *
 * No se usa el punto geocodificado de la 021 (`ops.quote_request_geocode`) a
 * propósito: los criterios de aceptación del spec salen de esta tabla, y mezclar
 * las dos fuentes daría otros números que el dashboard de referencia.
 */
const LUGARES: Array<{ pat: RegExp; nombre: string; lat: number; lng: number }> = [
  { pat: /benavidez/, nombre: 'Benavidez', lat: -34.413, lng: -58.686 },
  { pat: /pacheco/, nombre: 'General Pacheco', lat: -34.452, lng: -58.637 },
  { pat: /nordelta/, nombre: 'Nordelta', lat: -34.405, lng: -58.645 },
  { pat: /tigre/, nombre: 'Tigre', lat: -34.425, lng: -58.58 },
  { pat: /beccar/, nombre: 'Beccar', lat: -34.462, lng: -58.542 },
  { pat: /tomkinson/, nombre: 'San Isidro', lat: -34.481, lng: -58.537 },
  { pat: /mart[ií]nez/, nombre: 'Martínez', lat: -34.492, lng: -58.506 },
  { pat: /san isidro/, nombre: 'San Isidro', lat: -34.472, lng: -58.512 },
  { pat: /la plata/, nombre: 'La Plata', lat: -34.921, lng: -57.955 },
  { pat: /lan[uú]s/, nombre: 'Lanús', lat: -34.703, lng: -58.392 },
  { pat: /quilmes/, nombre: 'Quilmes', lat: -34.74, lng: -58.282 },
  { pat: /luj[aá]n/, nombre: 'Luján', lat: -34.57, lng: -59.105 },
  { pat: /la reja/, nombre: 'La Reja', lat: -34.637, lng: -58.825 },
  { pat: /moreno/, nombre: 'Moreno', lat: -34.65, lng: -58.79 },
  { pat: /pilar/, nombre: 'Pilar', lat: -34.459, lng: -58.914 },
  { pat: /palermo/, nombre: 'Palermo', lat: -34.583, lng: -58.425 },
  { pat: /pompeya/, nombre: 'Nueva Pompeya', lat: -34.65, lng: -58.418 },
  { pat: /saavedra/, nombre: 'Saavedra', lat: -34.555, lng: -58.485 },
  { pat: /villa del parque/, nombre: 'Villa del Parque', lat: -34.604, lng: -58.492 },
  { pat: /(villa luro|floresta)/, nombre: 'Floresta', lat: -34.632, lng: -58.49 },
  { pat: /belgrano/, nombre: 'Belgrano', lat: -34.562, lng: -58.457 },
]

const round3 = (n: number) => Math.round(n * 1000) / 1000

export interface PedidoSource {
  id: string
  publicNumber: number
  createdAt: string
  channel: string
  description: string
  locationLocality: string | null
  locationAddress: string | null
  /** GPS del teléfono. `null` = la ubicación se tipeó, o no hay. */
  locationLatitude: number | null
  locationLongitude: number | null
}

export interface CoveragePedido {
  id: string
  numero: number
  createdAt: string
  canal: string
  rubro: CoverageRubro
  /** `null` = sin ubicación utilizable (ni GPS ni una localidad conocida). */
  lat: number | null
  lng: number | null
  /** Centro de localidad, no GPS. */
  aprox: boolean
  localidad: string | null
}

export function toCoveragePedido(p: PedidoSource): CoveragePedido {
  const base = {
    id: p.id,
    numero: p.publicNumber,
    createdAt: p.createdAt,
    canal: p.channel,
    rubro: inferPedidoRubro(p.description),
  }
  if (p.locationLatitude !== null && p.locationLongitude !== null) {
    return {
      ...base,
      // 3 decimales (~100 m), como el endpoint del spec: el mapa no necesita más.
      lat: round3(p.locationLatitude),
      lng: round3(p.locationLongitude),
      aprox: false,
      localidad: p.locationLocality ? p.locationLocality.replace('Buenos Aires', 'CABA') : null,
    }
  }
  const loc = `${p.locationLocality ?? ''} ${p.locationAddress ?? ''}`.toLowerCase()
  const text = /[a-z]/.test(loc) ? loc : p.description.toLowerCase()
  const lugar = LUGARES.find((l) => l.pat.test(text))
  return lugar
    ? { ...base, lat: lugar.lat, lng: lugar.lng, aprox: true, localidad: lugar.nombre }
    : { ...base, lat: null, lng: null, aprox: false, localidad: null }
}

// ── Partners ─────────────────────────────────────────────────────────────────

export interface PartnerSource {
  id: string
  name: string
  modality: string | null
  tier: string
  coverageZone: string
  location: { lat: number; lng: number } | null
  services: Array<{ name: string }>
}

export interface CoverageProveedor {
  id: string
  nombre: string
  modalidad: string
  founding: boolean
  coverageZone: string
  /** A distancia, o mixto / a domicilio sin coordenadas. */
  remoto: boolean
  lat: number | null
  lng: number | null
  /** Zona asignada por TEXTO, sólo sin coordenadas (los cuatro casos de 3.2). */
  zonaIdTexto: string | null
  rubros: Array<CoverageRubro>
}

/**
 * Los cuatro textos de `coverage_zone` que la consulta 3.2 ubica en una zona
 * cuando el partner no tiene coordenadas. Es una excepción ACOTADA a la regla
 * de no normalizar `coverage_zone` (`partners-coverage.md`): son nombres de
 * localidad, no "Zona Norte", y están en el spec con nombre y apellido. No se
 * agrega un quinto acá: el arreglo es cargarle coordenadas al partner.
 */
const ZONE_BY_TEXT: Array<[string, string]> = [
  ['villa crespo', 'caba-c15'],
  ['tigre', 'tigre'],
  ['rafael castillo', 'la-matanza'],
  ['general rodr', 'general-rodriguez'],
]

export function toCoverageProveedor(p: PartnerSource): CoverageProveedor {
  const modalidad = p.modality?.trim() || 'Sin dato'
  const remoto = modalidad === 'A distancia' || (p.location === null && (modalidad === 'Mixto' || modalidad === 'A domicilio'))
  const zoneText = p.coverageZone.trim().toLowerCase()
  const zonaIdTexto = p.location ? null : (ZONE_BY_TEXT.find(([prefix]) => zoneText.startsWith(prefix))?.[1] ?? null)
  const rubros = new Set<CoverageRubro>()
  for (const s of p.services) {
    const r = serviceRubro(s.name)
    if (r) rubros.add(r)
  }
  return {
    id: p.id,
    nombre: p.name,
    modalidad,
    founding: p.tier === 'founding',
    coverageZone: p.coverageZone,
    remoto,
    lat: p.location?.lat ?? null,
    lng: p.location?.lng ?? null,
    zonaIdTexto,
    rubros: COVERAGE_RUBROS.filter((r) => rubros.has(r)),
  }
}

/** Los servicios del catálogo que ningún rubro agrupa, para decirlo en pantalla. */
export function unmappedServiceNames(names: Array<string>): Array<string> {
  return [...new Set(names.filter((n) => serviceRubro(n) === null))].sort((a, b) => a.localeCompare(b, 'es'))
}

// ── Zonas (geojson) ──────────────────────────────────────────────────────────

export const COVERAGE_AREAS = ['CABA', 'Norte', 'Noroeste', 'Oeste', 'Sur', 'Gran La Plata'] as const

export interface CoverageZone {
  id: string
  nombre: string
  area: string
  /** Todos los anillos de todos los polígonos, `[lng, lat]`. */
  rings: Array<Array<[number, number]>>
  /** `[minLng, minLat, maxLng, maxLat]`. */
  bbox: [number, number, number, number]
}

interface GeoFeature {
  properties?: { id?: unknown; nombre?: unknown; area?: unknown }
  geometry?: { type?: unknown; coordinates?: unknown }
}

/** Lee `zonas_amba.geojson`. Un feature con otra forma se descarta, no rompe la pantalla. */
export function parseZones(geojson: unknown): Array<CoverageZone> {
  const features = (geojson as { features?: Array<GeoFeature> } | null)?.features
  if (!Array.isArray(features)) return []
  const out: Array<CoverageZone> = []
  for (const f of features) {
    const { id, nombre, area } = f.properties ?? {}
    const type = f.geometry?.type
    const coords = f.geometry?.coordinates
    if (typeof id !== 'string' || typeof nombre !== 'string' || typeof area !== 'string') continue
    const polygons =
      type === 'Polygon' ? [coords] : type === 'MultiPolygon' && Array.isArray(coords) ? coords : []
    const rings: Array<Array<[number, number]>> = []
    for (const poly of polygons) {
      if (!Array.isArray(poly)) continue
      for (const ring of poly) {
        if (Array.isArray(ring)) rings.push(ring.filter(isPair))
      }
    }
    if (rings.length === 0) continue
    let minLng = Infinity
    let minLat = Infinity
    let maxLng = -Infinity
    let maxLat = -Infinity
    for (const ring of rings) {
      for (const [lng, lat] of ring) {
        minLng = Math.min(minLng, lng)
        maxLng = Math.max(maxLng, lng)
        minLat = Math.min(minLat, lat)
        maxLat = Math.max(maxLat, lat)
      }
    }
    out.push({ id, nombre, area, rings, bbox: [minLng, minLat, maxLng, maxLat] })
  }
  return out
}

function isPair(p: unknown): p is [number, number] {
  return Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number'
}

/** Ray casting par-impar sobre TODOS los anillos (los huecos restan solos). */
export function zoneContains(zone: CoverageZone, lng: number, lat: number): boolean {
  const [minLng, minLat, maxLng, maxLat] = zone.bbox
  if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) return false
  let inside = false
  for (const ring of zone.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!
      const [xj, yj] = ring[j]!
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

export function findZone(zones: Array<CoverageZone>, lng: number, lat: number): CoverageZone | null {
  return zones.find((z) => zoneContains(z, lng, lat)) ?? null
}

/** Equirectangular, como el dashboard: `hypot(Δlng·111.32·cos(lat), Δlat·110.57)`. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const cos = Math.cos((a.lat * Math.PI) / 180)
  return Math.hypot((b.lng - a.lng) * 111.32 * cos, (b.lat - a.lat) * 110.57)
}

// ── Cálculo ──────────────────────────────────────────────────────────────────

/** 3 es el máximo de propuestas por pedido: con 3 cerca, hay de dónde elegir. */
export const COVERED_MIN_PROVIDERS = 3
export const COVERAGE_RADII = [3, 5, 10] as const

export const COVERAGE_PRIORITIES = ['salir', 'reforzar', 'latente', 'cubierta', 'sin_demanda'] as const
export type CoveragePriority = (typeof COVERAGE_PRIORITIES)[number]

export const COVERAGE_PRIORITY_LABELS: Record<CoveragePriority, string> = {
  salir: 'Salir ya',
  reforzar: 'Reforzar',
  latente: 'Demanda latente',
  cubierta: 'Cubierta',
  sin_demanda: 'Sin demanda',
}

/** Lo que no depende del filtro: en qué zona cae cada pedido y cada partner. */
export interface CoveragePlaced {
  zones: Array<CoverageZone>
  zoneById: Map<string, CoverageZone>
  pedidos: Array<CoveragePedido & { zoneId: string | null }>
  proveedores: Array<CoverageProveedor & { zoneId: string | null }>
}

export function placeAll(
  zones: Array<CoverageZone>,
  pedidos: Array<CoveragePedido>,
  proveedores: Array<CoverageProveedor>,
): CoveragePlaced {
  const zoneById = new Map(zones.map((z) => [z.id, z]))
  return {
    zones,
    zoneById,
    pedidos: pedidos.map((p) => ({
      ...p,
      zoneId: p.lat !== null && p.lng !== null ? (findZone(zones, p.lng, p.lat)?.id ?? null) : null,
    })),
    proveedores: proveedores.map((p) => {
      // Los remotos no entran a las zonas, salvo que el texto los ubique.
      let zoneId: string | null = null
      if (p.zonaIdTexto && zoneById.has(p.zonaIdTexto)) zoneId = p.zonaIdTexto
      else if (!p.remoto && p.lat !== null && p.lng !== null) zoneId = findZone(zones, p.lng, p.lat)?.id ?? null
      return { ...p, zoneId }
    }),
  }
}

/**
 * Cuántos partners hay cerca de cada pedido, para un radio: con local, con el
 * rubro DEL PEDIDO, a ≤ R km. Para Trámites se suman los remotos del rubro.
 * Depende del radio y no del filtro de rubro — el filtro sólo elige qué pedidos
 * se miran.
 */
export function nearbyCounts(placed: CoveragePlaced, radiusKm: number): Map<string, number> {
  const local = placed.proveedores.filter((p) => !p.remoto && p.lat !== null && p.lng !== null)
  const remoteByRubro = new Map<CoverageRubro, number>()
  for (const p of placed.proveedores) {
    if (!p.remoto) continue
    for (const r of p.rubros) remoteByRubro.set(r, (remoteByRubro.get(r) ?? 0) + 1)
  }
  const out = new Map<string, number>()
  for (const ped of placed.pedidos) {
    if (ped.lat === null || ped.lng === null) continue
    const here = { lat: ped.lat, lng: ped.lng }
    let n = 0
    for (const p of local) {
      if (p.rubros.includes(ped.rubro) && distanceKm(here, { lat: p.lat!, lng: p.lng! }) <= radiusKm) n++
    }
    if (ped.rubro === 'tramites') n += remoteByRubro.get('tramites') ?? 0
    out.set(ped.id, n)
  }
  return out
}

export interface ZoneStats {
  zone: CoverageZone
  pedidos: number
  sinCobertura: number
  proveedores: number
  /** Promedio de partners cercanos por pedido. `null` sin pedidos. */
  avgNear: number | null
  /** Localidades de los pedidos sin cobertura, para el encabezado. */
  uncoveredLocalidades: Array<string>
  priority: CoveragePriority
}

/**
 * Prioridad, en el orden del spec (sección 4.5). «Demanda latente» necesita
 * usuarios por zona, que la v1 no tiene (no hay de dónde leerlos sin el
 * endpoint nuevo): con `usuarios` nulo esa rama no se cumple nunca, y la
 * pantalla lo dice en vez de pintar zonas a ojo.
 */
export function zonePriority(s: {
  pedidos: number
  sinCobertura: number
  proveedores: number
  avgNear: number | null
  usuariosDomicilio?: number | null
  usuariosIp?: number | null
}): CoveragePriority {
  if (s.sinCobertura >= 2 || (s.sinCobertura >= 1 && s.proveedores === 0)) return 'salir'
  if (s.sinCobertura === 1 || (s.pedidos >= 3 && (s.avgNear ?? 0) < 5)) return 'reforzar'
  if (
    s.pedidos === 0 &&
    s.proveedores <= 1 &&
    ((s.usuariosDomicilio ?? 0) >= 2 || (s.usuariosIp ?? 0) >= 10)
  )
    return 'latente'
  if (s.pedidos > 0 && s.sinCobertura === 0) return 'cubierta'
  return 'sin_demanda'
}

export type RubroFilter = CoverageRubro | 'todos'

export function zoneStats(
  placed: CoveragePlaced,
  near: Map<string, number>,
  rubro: RubroFilter,
): Map<string, ZoneStats> {
  const out = new Map<string, ZoneStats>()
  for (const zone of placed.zones) {
    out.set(zone.id, {
      zone,
      pedidos: 0,
      sinCobertura: 0,
      proveedores: 0,
      avgNear: null,
      uncoveredLocalidades: [],
      priority: 'sin_demanda',
    })
  }
  const nearSum = new Map<string, number>()
  for (const ped of placed.pedidos) {
    if (!ped.zoneId || (rubro !== 'todos' && ped.rubro !== rubro)) continue
    const s = out.get(ped.zoneId)
    if (!s) continue
    const n = near.get(ped.id) ?? 0
    s.pedidos++
    nearSum.set(ped.zoneId, (nearSum.get(ped.zoneId) ?? 0) + n)
    if (n < COVERED_MIN_PROVIDERS) {
      s.sinCobertura++
      if (ped.localidad && !s.uncoveredLocalidades.includes(ped.localidad)) s.uncoveredLocalidades.push(ped.localidad)
    }
  }
  for (const p of placed.proveedores) {
    if (!p.zoneId || (rubro !== 'todos' && !p.rubros.includes(rubro))) continue
    const s = out.get(p.zoneId)
    if (s) s.proveedores++
  }
  for (const s of out.values()) {
    s.avgNear = s.pedidos > 0 ? (nearSum.get(s.zone.id) ?? 0) / s.pedidos : null
    s.priority = zonePriority(s)
  }
  return out
}

/** Prioridad, después sin cobertura, después pedidos — el orden por default. */
export function compareByPriority(a: ZoneStats, b: ZoneStats): number {
  return (
    COVERAGE_PRIORITIES.indexOf(a.priority) - COVERAGE_PRIORITIES.indexOf(b.priority) ||
    b.sinCobertura - a.sinCobertura ||
    b.pedidos - a.pedidos ||
    b.proveedores - a.proveedores ||
    a.zone.nombre.localeCompare(b.zone.nombre, 'es')
  )
}

export function hasSignal(s: ZoneStats): boolean {
  return s.pedidos > 0 || s.proveedores > 0
}

/** Nombre corto para el mapa y el texto: "Comuna 12" en vez de "CABA · Comuna 12". */
export function zoneLabel(zone: CoverageZone): string {
  return zone.nombre
}

/**
 * La frase de arriba: hasta 4 «Salir ya» (con las localidades de sus pedidos
 * sin cobertura entre paréntesis, salvo la que repite el nombre de la zona),
 * hasta 4 «Reforzar», hasta 4 con demanda latente.
 */
export function coverageHeadline(stats: Array<ZoneStats>): Array<{ priority: CoveragePriority; text: string }> {
  const sorted = [...stats].sort(compareByPriority)
  const pick = (p: CoveragePriority) => sorted.filter((s) => s.priority === p).slice(0, 4)
  const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const withPlaces = (s: ZoneStats) => {
    const extra = s.uncoveredLocalidades.filter((l) => !fold(s.zone.nombre).includes(fold(l)))
    return extra.length ? `${s.zone.nombre} (${extra.join(', ')})` : s.zone.nombre
  }
  const out: Array<{ priority: CoveragePriority; text: string }> = []
  const salir = pick('salir')
  if (salir.length) out.push({ priority: 'salir', text: `Salí primero a ${salir.map(withPlaces).join(', ')}.` })
  const reforzar = pick('reforzar')
  if (reforzar.length) out.push({ priority: 'reforzar', text: `Después, reforzá ${reforzar.map(withPlaces).join(', ')}.` })
  const latente = pick('latente')
  if (latente.length)
    out.push({ priority: 'latente', text: `Hay demanda latente en ${latente.map((s) => s.zone.nombre).join(', ')}.` })
  return out
}

export interface AreaStats {
  area: string
  pedidos: number
  sinCobertura: number
  proveedores: number
}

export function areaStats(stats: Iterable<ZoneStats>): Array<AreaStats> {
  const by = new Map<string, AreaStats>(
    COVERAGE_AREAS.map((a) => [a, { area: a, pedidos: 0, sinCobertura: 0, proveedores: 0 }]),
  )
  for (const s of stats) {
    const a = by.get(s.zone.area) ?? { area: s.zone.area, pedidos: 0, sinCobertura: 0, proveedores: 0 }
    a.pedidos += s.pedidos
    a.sinCobertura += s.sinCobertura
    a.proveedores += s.proveedores
    by.set(s.zone.area, a)
  }
  return [...by.values()]
}

// ── Search params ────────────────────────────────────────────────────────────

export const COVERAGE_VIEWS = ['mapa', 'tabla'] as const
export const COVERAGE_SORT_KEYS = ['priority', 'zone', 'area', 'pedidos', 'sinCobertura', 'proveedores'] as const
export type CoverageSortKey = (typeof COVERAGE_SORT_KEYS)[number]

/**
 * Todos calificados `coverage*` (→ `.claude/rules/notifications.md`): `view`,
 * `rubro`, `sort` pelados ya los usan otras rutas con otros enums. `q` se
 * comparte (es `string` en todos lados).
 */
export const coverageMapSearchSchema = z.object({
  coverageView: z.enum(COVERAGE_VIEWS).catch('mapa').default('mapa'),
  coverageRubro: z.enum(['todos', ...COVERAGE_RUBROS]).catch('todos').default('todos'),
  coverageRadius: z.coerce
    .number()
    .refine((n) => (COVERAGE_RADII as ReadonlyArray<number>).includes(n))
    .catch(5)
    .default(5),
  /** Zona resaltada (id del geojson). */
  coverageZona: z
    .string()
    .regex(/^[a-z0-9-]{1,60}$/)
    .optional()
    .catch(undefined),
  /** Buscador del ranking. */
  q: z.string().trim().max(80).optional(),
  coverageSort: z.enum(COVERAGE_SORT_KEYS).catch('priority').default('priority'),
  coverageDir: z.enum(['asc', 'desc']).catch('asc').default('asc'),
})
export type CoverageMapSearch = z.infer<typeof coverageMapSearchSchema>
