import { z } from 'zod'
import { readableQuoteRequestError, type QuoteRequestStatus } from '~/lib/quote-requests'

/**
 * Corregir la ubicación de un pedido — `PUT /admin/quote-requests/:id/location`
 * del backend (`AdminGuard`, `ChangeQuoteRequestLocationDto`). Séptima vez que
 * el `grep` dio positivo (2026-11-09): es el MISMO caso de uso que usa la
 * persona desde la app, así que last write wins entre los dos.
 *
 * Es el ÚNICO camino de escritura de la ubicación desde el panel: desde la
 * migración 028, «Editar datos» (`ops.update_quote_request`) ya no la toca.
 * → `.claude/rules/leads.md`, "Corregir la ubicación".
 *
 * Client-safe: lo usan el componente, el server function y `backend.ts`.
 */

/** Sentinela de `backendError(..., { quoteLocation: true })`. */
export const QUOTE_LOCATION_ERROR = 'QUOTE_LOCATION_ERROR'

/**
 * Sólo se ofrece con el pedido abierto. Un `closed` lo rechaza el backend con
 * `INVALID_STATE_TRANSITION`; la UI ni lo ofrece y dice por qué.
 */
export const QUOTE_LOCATION_EDITABLE_STATUSES = ['received', 'contacted', 'answered'] as const satisfies ReadonlyArray<QuoteRequestStatus>

export function canChangeQuoteLocation(status: string): boolean {
  return (QUOTE_LOCATION_EDITABLE_STATUSES as ReadonlyArray<string>).includes(status)
}

export const QUOTE_LOCATION_ADDRESS_MAX = 300
export const QUOTE_LOCATION_PLACE_MAX = 120

// ── El DTO, espejado ─────────────────────────────────────────────────────────
//
// `.strict()` en los dos: el backend corre con `forbidNonWhitelisted`, un campo
// de más es un 400. Y un opcional en blanco NO viaja (`undefined`, que
// `JSON.stringify` descarta): el backend rechaza `''`, igual que en propuestas.

/** Un texto opcional: recortado; vacío → ausente (nunca `''`). */
function optionalText(max: number, label: string) {
  return z
    .string()
    .trim()
    .max(max, `${label}: hasta ${max} caracteres.`)
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v))
}

export const typedQuoteLocationSchema = z
  .object({
    source: z.literal('typed'),
    address: z
      .string()
      .trim()
      .min(1, 'Falta la dirección.')
      .max(QUOTE_LOCATION_ADDRESS_MAX, `La dirección tiene hasta ${QUOTE_LOCATION_ADDRESS_MAX} caracteres.`),
  })
  .strict()

export const deviceQuoteLocationSchema = z
  .object({
    source: z.literal('device'),
    latitude: z.number().finite().min(-90, 'La latitud va de -90 a 90.').max(90, 'La latitud va de -90 a 90.'),
    longitude: z.number().finite().min(-180, 'La longitud va de -180 a 180.').max(180, 'La longitud va de -180 a 180.'),
    accuracyMeters: z.number().finite().min(0, 'La precisión no puede ser negativa.').optional(),
    address: optionalText(QUOTE_LOCATION_ADDRESS_MAX, 'La dirección'),
    locality: optionalText(QUOTE_LOCATION_PLACE_MAX, 'La localidad'),
    province: optionalText(QUOTE_LOCATION_PLACE_MAX, 'La provincia'),
  })
  .strict()

/**
 * La unión discriminada por `source`. El (0,0) se rechaza acá y no en el
 * objeto: es el punto que devuelve un GPS sin fix ("Null Island"), y el backend
 * también lo rechaza.
 */
export const quoteLocationSchema = z
  .discriminatedUnion('source', [typedQuoteLocationSchema, deviceQuoteLocationSchema])
  .superRefine((loc, ctx) => {
    if (loc.source === 'device' && loc.latitude === 0 && loc.longitude === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['latitude'],
        message: '(0, 0) no es una ubicación: es lo que devuelve un GPS sin señal.',
      })
    }
  })

export type QuoteLocationInput = z.input<typeof quoteLocationSchema>
export type QuoteLocation = z.output<typeof quoteLocationSchema>

/** El payload del server function. `p_actor_id` no existe acá: el token es el del admin. */
export const changeQuoteLocationSchema = z
  .object({
    quoteRequestId: z.uuid(),
    location: quoteLocationSchema,
  })
  .strict()
export type ChangeQuoteLocationInput = z.input<typeof changeQuoteLocationSchema>

// ── Coordenadas tipeadas o pegadas ──────────────────────────────────────────

/**
 * Un número como lo tipea un operador argentino: acepta coma O punto decimal
 * (`-34,6037` y `-34.6037`) y el signo menos tipográfico (`−`, que traen
 * algunos copiados). NO acepta separador de miles: una coordenada nunca lo
 * tiene, así que un punto o una coma son SIEMPRE el decimal. `null` si no es
 * un número.
 */
export function parseCoordinate(raw: string): number | null {
  const s = raw.trim().replace(/[−‒–]/g, '-').replace(',', '.')
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Un par "lat, lng" pegado de Google Maps (clic derecho → copia
 * `-34.60371, -58.38157`). Formas aceptadas:
 *
 *   -34.6037, -58.3816     (Google Maps: punto decimal, coma + espacio)
 *   -34.6037 -58.3816      (separado por espacio)
 *   -34,6037; -58,3816     (coma decimal: el separador TIENE que ser `;` o espacio)
 *   -34,6037, -58,3816     (coma decimal y coma separadora: se acepta SÓLO si
 *                           cada número trae su parte decimal, que es lo que
 *                           desambigua)
 *
 * Lo que no se puede leer sin adivinar devuelve `null`: mejor pedir que lo
 * tipee en los dos campos que poner el pin en otro lado. Igual, la pantalla
 * muestra lat y lng por separado antes de confirmar.
 */
export function parseCoordinatePair(raw: string): { latitude: number; longitude: number } | null {
  const s = raw.trim().replace(/[−‒–]/g, '-').replace(/^\(|\)$/g, '').trim()
  const num = '[-+]?\\d+(?:[.,]\\d+)?'

  // 1. Separador explícito: `;` o espacios (con o sin coma pegada si el decimal es punto).
  const bySemicolon = new RegExp(`^(${num})\\s*;\\s*(${num})$`).exec(s)
  const bySpace = new RegExp(`^(${num})\\s+(${num})$`).exec(s)
  // 2. Punto decimal + coma separadora (lo de Google Maps).
  const dotComma = /^([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)$/.exec(s)
  // 3. Coma decimal + coma separadora: cada número con su parte decimal.
  const commaComma = /^([-+]?\d+,\d+)\s*,\s*([-+]?\d+,\d+)$/.exec(s)

  const m = bySemicolon ?? dotComma ?? commaComma ?? bySpace
  if (!m || m[1] === undefined || m[2] === undefined) return null
  const latitude = parseCoordinate(m[1])
  const longitude = parseCoordinate(m[2])
  if (latitude === null || longitude === null) return null
  return { latitude, longitude }
}

// ── Errores ──────────────────────────────────────────────────────────────────

export interface QuoteLocationErrorInfo {
  /** 0 = timeout (el PUT salió y no volvió: puede haberse guardado). */
  status: number
  code: string
  message: string
  /** 404 «Cannot PUT …»: el backend desplegado no tiene el endpoint. */
  cannotRoute: boolean
}

/** Lee `QUOTE_LOCATION_ERROR:<json>`. `null` si no es ese formato. */
export function parseQuoteLocationError(cause: unknown): QuoteLocationErrorInfo | null {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const at = raw.indexOf(`${QUOTE_LOCATION_ERROR}:`)
  if (at === -1) return null
  try {
    const v = JSON.parse(raw.slice(at + QUOTE_LOCATION_ERROR.length + 1)) as Record<string, unknown>
    return {
      status: typeof v.status === 'number' ? v.status : 0,
      code: typeof v.code === 'string' ? v.code : '',
      message: typeof v.message === 'string' ? v.message : '',
      cannotRoute: v.cannotRoute === true,
    }
  } catch {
    return null
  }
}

/**
 * Qué hace la UI con el error:
 * - `retrySame`: «Reintentar» REENVÍA el payload guardado, idéntico (5xx,
 *   timeout, 409). Nunca se rearma desde el formulario.
 * - `closed`: el pedido está cerrado; se relee la ficha y reintentar no sirve.
 * - `fix`: hay que corregir algo (validación) o no hay nada que reintentar.
 */
export type QuoteLocationErrorAction = 'retrySame' | 'closed' | 'fix'

export interface ReadableQuoteLocationError {
  text: string
  action: QuoteLocationErrorAction
}

export function readableQuoteLocationError(cause: unknown): ReadableQuoteLocationError {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const fix = (text: string): ReadableQuoteLocationError => ({ text, action: 'fix' })

  const unreachable = /BACKEND_UNREACHABLE:(\S+)/.exec(raw)
  if (unreachable)
    return fix(
      `No se pudo llegar al backend (${unreachable[1]}). Revisá AUTOLIBRE_BACKEND_URL. No se envió nada.`,
    )

  const e = parseQuoteLocationError(raw)
  if (!e) return fix(readableQuoteRequestError(raw))

  if (e.status === 0)
    return {
      text: 'El backend no contestó a tiempo. Puede que la ubicación ya haya quedado guardada: reintentá, se manda exactamente lo mismo y no duplica nada.',
      action: 'retrySame',
    }
  if (e.status === 400 && e.code === 'INVALID_STATE_TRANSITION')
    return {
      text: 'El pedido está cerrado (o se cerró mientras tanto): su ubicación ya no se corrige. Se recargó la ficha.',
      action: 'closed',
    }
  if (e.status === 400)
    return fix(
      e.message
        ? `El backend rechazó la ubicación: «${e.message}». No se guardó nada.`
        : 'El backend rechazó la ubicación. No se guardó nada.',
    )
  if (e.status === 401) return fix('Tu sesión venció para el backend. Cerrá sesión y volvé a entrar. No se guardó nada.')
  if (e.status === 403) return fix('Tu usuario no es admin para el backend. No se guardó nada.')
  if (e.status === 404 && e.cannotRoute)
    return fix(
      'El backend desplegado todavía no tiene «Corregir ubicación» (PUT /admin/quote-requests/:id/location). Hay que desplegarlo. No se guardó nada.',
    )
  if (e.status === 404) return fix('Este pedido ya no existe en el backend. Recargá la pantalla.')
  if (e.status === 409)
    return {
      text: 'El pedido cambió dos veces mientras se guardaba. Reintentá: se manda lo mismo.',
      action: 'retrySame',
    }
  if (e.status >= 500)
    return {
      text: 'El backend falló al terminar. La ubicación PUEDE haber quedado guardada (lo que falla es encolar la nueva geolocalización). Reintentá: se reenvía exactamente lo mismo y no duplica nada.',
      action: 'retrySame',
    }
  return fix(`El backend contestó ${e.status}${e.message ? `: «${e.message}»` : ''}. No se guardó nada.`)
}
