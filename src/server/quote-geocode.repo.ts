import '@tanstack/react-start/server-only'

import { sqlOne } from './db'
import type { QuoteGeocode, QuoteGeocodeStatus } from '~/lib/quote-requests'

/**
 * La geocodificación de un pedido con ubicación TIPEADA — SÓLO LECTURA.
 *
 * Desde el 2026-11-09 geocodifica el BACKEND (0140): `quote_requests.geocoded_*`,
 * sólo para `location_source = 'typed'` (`chk_quote_requests_geocoded_only_typed`).
 * Lo encolan el alta pública/app, el PUT de ubicación y
 * `POST /admin/quote-requests/:id/geocode`. El panel ya no tiene geocoder
 * propio (`src/server/geocode.ts` se borró) ni escribe `ops.quote_request_geocode`.
 *
 * La tabla de la 021 queda como FALLBACK TRANSICIONAL de lectura: al
 * 2026-11-09 producción tiene 80 tipeados y 0 con `geocoded_at`, y los pines
 * viejos salen sólo de ahí. Se usa sólo si el backend no tiene `geocoded_at`
 * para esa fila. Criterio de salida: cuando el backfill de producción de los
 * pedidos tipeados ABIERTOS esté hecho, se borra esta lectura y una migración
 * nueva dropea la tabla y `ops.set_quote_request_geocode`.
 */

/** Las columnas de la 0140 que se leen. Guard propio, NO `READ_COLUMNS` (mismo motivo que la 0124/0143). */
const GEOCODED_COLUMNS = ['geocoded_at', 'geocoded_latitude', 'geocoded_longitude', 'geocoded_locality', 'geocoded_province'] as const

async function backendGeocodeColumnsAvailable(): Promise<boolean> {
  const row = await sqlOne<{ ok: boolean }>(
    `select count(*) = $1::int as ok
       from information_schema.columns
      where table_schema = 'public' and table_name = 'quote_requests'
        and column_name = any($2::text[])`,
    [GEOCODED_COLUMNS.length, [...GEOCODED_COLUMNS]],
  )
  return row?.ok === true
}

/** ¿Está aplicada la 021? Sin ella no hay fallback que leer. */
async function legacyGeocodeAvailable(): Promise<boolean> {
  const row = await sqlOne<{ ok: boolean }>(`select to_regclass('ops.quote_request_geocode') is not null as ok`)
  return row?.ok === true
}

/**
 * El texto que la 021 guardaba como `query` — copiado del geocoder borrado
 * para seguir pudiendo chequear la VIGENCIA del punto viejo: si la dirección
 * cambió después, el punto apunta a otro lado y no se usa.
 */
function legacyGeocodeQuery(address: string | null, locality: string | null, province: string | null): string | null {
  const parts = [address, locality, province].map((p) => (p ?? '').trim()).filter((p) => p !== '')
  if (parts.length === 0 || (address ?? '').trim() === '') return null
  const unique = parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i)
  const joined = unique.join(', ')
  return /argentina/i.test(joined) ? joined : `${joined}, Argentina`
}

interface BackendGeocodeRow {
  geocoded_at: string | null
  geocoded_latitude: number | null
  geocoded_longitude: number | null
  geocoded_locality: string | null
  geocoded_province: string | null
}

export interface QuoteGeocodeRead {
  geocode: QuoteGeocode
  geocodedLocality: string | null
  geocodedProvince: string | null
}

/**
 * Lee el geocode del backend y, si hace falta, el punto viejo de la 021, y
 * deriva el estado (`QuoteGeocodeStatus`, ver `~/lib/quote-requests`).
 */
export async function readQuoteGeocode(
  quoteRequestId: string,
  location: { source: string | null; address: string | null; locality: string | null; province: string | null },
): Promise<QuoteGeocodeRead> {
  const empty = (status: QuoteGeocodeStatus, backendColumns: boolean): QuoteGeocodeRead => ({
    geocode: { status, backendColumns, geocodedAt: null, point: null, legacyPoint: null },
    geocodedLocality: null,
    geocodedProvince: null,
  })

  const backendColumns = await backendGeocodeColumnsAvailable()
  if (location.source === 'device') return empty('device', backendColumns)
  if (location.source !== 'typed') return empty('no_location', backendColumns)

  let row: BackendGeocodeRow | null = null
  if (backendColumns) {
    row = await sqlOne<BackendGeocodeRow>(
      `select to_char(geocoded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as geocoded_at,
              geocoded_latitude, geocoded_longitude, geocoded_locality, geocoded_province
         from quote_requests where id = $1`,
      [quoteRequestId],
    )
  }

  if (row?.geocoded_at) {
    const lat = row.geocoded_latitude === null ? null : Number(row.geocoded_latitude)
    const lng = row.geocoded_longitude === null ? null : Number(row.geocoded_longitude)
    const point = lat !== null && lng !== null ? { lat, lng } : null
    return {
      geocode: {
        status: point ? 'located' : 'not_found',
        backendColumns,
        geocodedAt: row.geocoded_at,
        point,
        legacyPoint: null,
      },
      geocodedLocality: row.geocoded_locality,
      geocodedProvince: row.geocoded_province,
    }
  }

  // Sin `geocoded_at`: el fallback transicional de la 021, con su chequeo de vigencia.
  const query = legacyGeocodeQuery(location.address, location.locality, location.province)
  if (query && (await legacyGeocodeAvailable())) {
    const legacy = await sqlOne<{ query: string; latitude: number; longitude: number; precise: boolean }>(
      `select query, latitude, longitude, precise from ops.quote_request_geocode where quote_request_id = $1`,
      [quoteRequestId],
    )
    if (legacy && legacy.query === query && legacy.latitude !== null && legacy.longitude !== null) {
      return {
        geocode: {
          status: 'legacy',
          backendColumns,
          geocodedAt: null,
          point: null,
          legacyPoint: { lat: Number(legacy.latitude), lng: Number(legacy.longitude), precise: legacy.precise },
        },
        geocodedLocality: null,
        geocodedProvince: null,
      }
    }
  }

  return empty('pending', backendColumns)
}
