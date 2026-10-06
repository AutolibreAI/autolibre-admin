import '@tanstack/react-start/server-only'

import { sqlOne } from './db'
import { geocodeAddress, geocodeQueryFor } from './geocode'
import type { QuoteGeocodeOutcome, QuoteGeocodedLocation } from '~/lib/quote-requests'

/**
 * La coordenada geocodificada de un pedido con ubicación TIPEADA (021).
 *
 * `quote_requests` no admite coordenadas con `location_source = 'typed'`
 * (CHECK del backend), así que el punto que el panel saca de la dirección vive
 * en `ops.quote_request_geocode` y se lee aparte. Nunca pisa al GPS: un pedido
 * `device` usa su coordenada y esta tabla no se consulta.
 */

/** ¿Está aplicada la 021? Sin ella no hay dónde leer ni guardar. */
export async function quoteGeocodeAvailable(): Promise<boolean> {
  const row = await sqlOne<{ ok: boolean }>(
    `select to_regclass('ops.quote_request_geocode') is not null as ok`,
  )
  return row?.ok === true
}

interface LocationRow {
  location_source: string | null
  location_address: string | null
  location_locality: string | null
  location_province: string | null
}

/**
 * La coordenada guardada, SÓLO si sigue correspondiendo a la dirección actual.
 * Si el operador cambió la dirección y el geocode no se rehízo, la fila vieja
 * apuntaría a otro lugar: mejor sin pin que con un pin equivocado.
 */
export async function readQuoteGeocode(
  quoteRequestId: string,
  location: { source: string | null; address: string | null; locality: string | null; province: string | null },
): Promise<QuoteGeocodedLocation | null> {
  if (location.source === 'device') return null
  const query = geocodeQueryFor(location.address, location.locality, location.province)
  if (!query) return null
  if (!(await quoteGeocodeAvailable())) return null

  const row = await sqlOne<{ query: string; latitude: number; longitude: number; precise: boolean }>(
    `select query, latitude, longitude, precise
       from ops.quote_request_geocode
      where quote_request_id = $1`,
    [quoteRequestId],
  )
  if (!row || row.query !== query) return null
  return { lat: Number(row.latitude), lng: Number(row.longitude), precise: row.precise }
}

/**
 * Geocodifica la ubicación tipeada del pedido y la guarda (o la borra si ya no
 * hay dirección o el geocoder no la encuentra). Se llama después de crear o
 * editar un pedido, y desde el botón «Ubicar en el mapa» de la ficha.
 *
 * No lanza por el geocoder: un proveedor caído deja el pedido sin pin, no
 * falla la escritura que ya pasó. Sí lanza si el SP rechaza (actor, pedido).
 *
 * SQL copiado LITERAL en `021_ops_ubicacion_geocodificada.test.sql`
 * (`PREPARE p021_set`). Si se toca uno, se toca el otro.
 */
export async function refreshQuoteRequestGeocode(
  quoteRequestId: string,
  actorId: string,
  opts: { force?: boolean } = {},
): Promise<QuoteGeocodeOutcome> {
  if (!(await quoteGeocodeAvailable())) return 'unavailable'

  const loc = await sqlOne<LocationRow>(
    `select location_source::text as location_source, location_address, location_locality, location_province
       from quote_requests where id = $1`,
    [quoteRequestId],
  )
  if (!loc) return 'unavailable'
  if (loc.location_source === 'device') return 'device'

  const query = geocodeQueryFor(loc.location_address, loc.location_locality, loc.location_province)

  if (!opts.force && query) {
    const current = await sqlOne<{ query: string }>(
      `select query from ops.quote_request_geocode where quote_request_id = $1`,
      [quoteRequestId],
    )
    if (current?.query === query) return 'unchanged'
  }

  const hit = query ? await geocodeAddress(query) : null

  await sqlOne(
    `SELECT ops.set_quote_request_geocode(
    p_quote_request_id => $1,
    p_actor_id         => $2,
    p_query            => $3,
    p_latitude         => $4,
    p_longitude        => $5,
    p_precise          => $6,
    p_provider         => $7
  ) AS g`,
    [
      quoteRequestId,
      actorId,
      query,
      hit?.lat ?? null,
      hit?.lng ?? null,
      hit?.precise ?? false,
      hit?.provider ?? 'nominatim',
    ],
  )

  if (!query) return 'no_address'
  return hit ? (hit.precise ? 'located' : 'approximate') : 'no_result'
}
