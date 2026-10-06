import '@tanstack/react-start/server-only'

/**
 * Geocodificar una dirección tipeada — para el pin de un pedido sin GPS (021).
 *
 * Mismos dos proveedores que `scripts/geocode-partners.mjs`, en el mismo orden:
 * Google Geocoding si hay `GOOGLE_GEOCODING_API_KEY` en el entorno, si no
 * Nominatim (OpenStreetMap), gratis, con su `User-Agent` obligatorio.
 *
 * A diferencia del script, acá un resultado IMPRECISO (centroide de localidad)
 * SÍ se guarda, marcado `precise: false`: para ordenar talleres por cercanía a
 * un pedido de "Palermo" el centro de Palermo sirve, y el mapa dice que es
 * aproximado. En el script de partners el punto es la puerta del taller, y ahí
 * un centroide mentiría.
 *
 * Nunca tira: un geocoder caído, lento o sin resultado devuelve `null`. El
 * pedido se guarda igual; sólo se queda sin pin.
 */

export interface GeocodeHit {
  lat: number
  lng: number
  precise: boolean
  provider: 'google' | 'nominatim'
}

const TIMEOUT_MS = 6000

/**
 * El texto que se geocodifica, armado de la ubicación tipeada del pedido.
 * También es la CLAVE de vigencia: si la dirección cambia, el `query` guardado
 * deja de coincidir y la coordenada vieja se ignora. `null` sin dirección.
 */
export function geocodeQueryFor(
  address: string | null,
  locality: string | null,
  province: string | null,
): string | null {
  const parts = [address, locality, province]
    .map((p) => (p ?? '').trim())
    .filter((p) => p !== '')
  if (parts.length === 0 || (address ?? '').trim() === '') return null
  // Sin duplicar ("Lanús, Lanús"): la dirección tipeada a veces ya trae la localidad.
  const unique = parts.filter(
    (p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i,
  )
  const joined = unique.join(', ')
  return /argentina/i.test(joined) ? joined : `${joined}, Argentina`
}

export async function geocodeAddress(query: string): Promise<GeocodeHit | null> {
  const key = process.env.GOOGLE_GEOCODING_API_KEY?.trim()
  try {
    return key ? await geocodeGoogle(query, key) : await geocodeNominatim(query)
  } catch {
    return null
  }
}

async function geocodeGoogle(query: string, key: string): Promise<GeocodeHit | null> {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  url.searchParams.set('address', query)
  url.searchParams.set('region', 'ar')
  url.searchParams.set('components', 'country:AR')
  url.searchParams.set('key', key)

  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) return null
  const body = (await res.json()) as {
    status: string
    results?: Array<{ geometry: { location: { lat: number; lng: number }; location_type: string } }>
  }
  const hit = body.status === 'OK' ? body.results?.[0] : undefined
  if (!hit) return null
  return {
    lat: hit.geometry.location.lat,
    lng: hit.geometry.location.lng,
    precise: hit.geometry.location_type === 'ROOFTOP' || hit.geometry.location_type === 'RANGE_INTERPOLATED',
    provider: 'google',
  }
}

async function geocodeNominatim(query: string): Promise<GeocodeHit | null> {
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('limit', '1')
  url.searchParams.set('countrycodes', 'ar')

  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // La política de uso de Nominatim exige identificarse; sin esto devuelve 403.
    headers: { 'User-Agent': 'autolibre-admin (panel interno; ubicación de pedidos)', 'Accept-Language': 'es' },
  })
  if (!res.ok) return null
  const body = (await res.json()) as Array<{ lat: string; lon: string; category?: string; type?: string; addresstype?: string }>
  const hit = body[0]
  if (!hit) return null
  const lat = Number(hit.lat)
  const lng = Number(hit.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return {
    lat,
    lng,
    precise:
      hit.category === 'building' ||
      hit.type === 'house' ||
      hit.addresstype === 'building' ||
      hit.addresstype === 'house',
    provider: 'nominatim',
  }
}
