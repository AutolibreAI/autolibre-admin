import { z } from 'zod'
import { readableQuoteRequestError } from '~/lib/quote-requests'
import { canChangeQuoteLocation } from '~/lib/quote-location'

/**
 * Identificar el vehículo de un pedido por la patente —
 * `PUT /admin/quote-requests/:id/plate` del backend (`AdminGuard`, 2026-11-09).
 * Octava vez que el `grep` dio positivo: el backend guarda la patente y, con
 * el proveedor de patentes, resuelve el modelo de catálogo
 * (`quote_requests.vehicle_catalog_id`) que el despacho por WhatsApp exige
 * (`missing_vehicle_catalog`). Un `UPDATE` por SQL no consultaría al proveedor.
 *
 * Regla del negocio: el vehículo de un pedido NO cambia. Mientras no tenga
 * catálogo, otra patente reemplaza a la guardada; con catálogo, queda fijo y
 * el backend responde 400 `INVALID_STATE_TRANSITION` sin consultar nada.
 *
 * Client-safe: lo usan el componente, el server function y `backend.ts`.
 */

/** Sentinela de `backendError(..., { quotePlate: true })`. */
export const QUOTE_PLATE_ERROR = 'QUOTE_PLATE_ERROR'

/**
 * El proveedor de patentes puede tardar hasta ~10 s (su propio timeout en el
 * backend). Holgura para el resto del request, y lejos del de clasificar (5 s).
 */
export const QUOTE_PLATE_TIMEOUT_MS = 30_000

/**
 * Las cuatro formas que acepta el VO `Plate` del backend, sin separadores:
 * auto legacy (ABC123), auto Mercosur (AB123CD), moto legacy (123ABC) y moto
 * Mercosur (A123BCD). Espejadas para avisar ANTES de gastar una consulta al
 * proveedor; el backend vuelve a validar igual.
 */
const PLATE_PATTERNS: ReadonlyArray<RegExp> = [
  /^[A-Z]{3}\d{3}$/,
  /^[A-Z]{2}\d{3}[A-Z]{2}$/,
  /^\d{3}[A-Z]{3}$/,
  /^[A-Z]\d{3}[A-Z]{3}$/,
]

/** La patente pelada (mayúsculas, sin espacios ni guiones), o `null` si no tiene forma de patente. */
export function canonicalPlate(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/[\s-]/g, '')
  return PLATE_PATTERNS.some((p) => p.test(s)) ? s : null
}

/** Se ofrece sólo con el pedido abierto y SIN catálogo: después el vehículo queda fijo. */
export function canIdentifyQuoteVehicle(status: string, vehicleCatalogId: string | null): boolean {
  return canChangeQuoteLocation(status) && vehicleCatalogId === null
}

export const identifyQuotePlateSchema = z
  .object({
    quoteRequestId: z.uuid(),
    plate: z
      .string()
      .max(20)
      .transform((v, ctx) => {
        const plate = canonicalPlate(v)
        if (plate === null) {
          ctx.addIssue({ code: 'custom', message: 'No es una patente válida (ej.: AB123CD o ABC123).' })
          return z.NEVER
        }
        return plate
      }),
  })
  .strict()
export type IdentifyQuotePlateInput = z.input<typeof identifyQuotePlateSchema>

// ── La respuesta ─────────────────────────────────────────────────────────────

export const QUOTE_PLATE_STATUSES = ['resolved', 'searching', 'not_found', 'insufficient_data'] as const
export type QuotePlateStatus = (typeof QUOTE_PLATE_STATUSES)[number]

export const quotePlateResultSchema = z.object({
  status: z.enum(QUOTE_PLATE_STATUSES),
  vehicleCatalogId: z.uuid().nullable(),
})
export type QuotePlateResult = z.infer<typeof quotePlateResultSchema>

export interface ReadableQuotePlateResult {
  text: string
  tone: 'green' | 'yellow' | 'red'
}

/** Qué le dice la ficha al operador después de un 200. La patente quedó guardada en los cuatro. */
export function readableQuotePlateResult(status: QuotePlateStatus): ReadableQuotePlateResult {
  switch (status) {
    case 'resolved':
      return { text: 'Listo: se guardó la patente y el modelo del vehículo. El despacho ya lo puede usar.', tone: 'green' }
    case 'searching':
      return {
        text: 'Se guardó la patente, pero el proveedor todavía la está buscando. Volvé a tocar «Identificar vehículo» con la misma patente en unos minutos.',
        tone: 'yellow',
      }
    case 'not_found':
      return {
        text: 'Se guardó la patente, pero el proveedor no la encontró. Revisá que esté bien escrita; si lo está, el modelo se va a tener que cargar a mano (todavía no hay pantalla para eso).',
        tone: 'red',
      }
    case 'insufficient_data':
      return {
        text: 'Se guardó la patente, pero lo que devolvió el proveedor no alcanza para saber el modelo (le falta el año o la versión). El modelo se va a tener que cargar a mano (todavía no hay pantalla para eso).',
        tone: 'red',
      }
  }
}

// ── Errores ──────────────────────────────────────────────────────────────────

export interface QuotePlateErrorInfo {
  /** 0 = timeout (el PUT salió y no volvió). */
  status: number
  code: string
  message: string
  /** 404 «Cannot PUT …»: el backend desplegado no tiene el endpoint. */
  cannotRoute: boolean
}

/** Lee `QUOTE_PLATE_ERROR:<json>`. `null` si no es ese formato. */
export function parseQuotePlateError(cause: unknown): QuotePlateErrorInfo | null {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const at = raw.indexOf(`${QUOTE_PLATE_ERROR}:`)
  if (at === -1) return null
  try {
    const v = JSON.parse(raw.slice(at + QUOTE_PLATE_ERROR.length + 1)) as Record<string, unknown>
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
 * - `retry`: se puede volver a tocar el botón con la misma patente (timeout,
 *   409, proveedor caído). Reintentar es seguro: el backend no deja nada a medias.
 * - `stale`: el pedido se cerró o ya tiene modelo; se relee la ficha.
 * - `fix`: hay que corregir algo, o no hay nada que reintentar.
 */
export type QuotePlateErrorAction = 'retry' | 'stale' | 'fix'

export interface ReadableQuotePlateError {
  text: string
  action: QuotePlateErrorAction
}

export function readableQuotePlateError(cause: unknown): ReadableQuotePlateError {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const fix = (text: string): ReadableQuotePlateError => ({ text, action: 'fix' })
  const retry = (text: string): ReadableQuotePlateError => ({ text, action: 'retry' })

  const unreachable = /BACKEND_UNREACHABLE:(\S+)/.exec(raw)
  if (unreachable)
    return fix(`No se pudo llegar al backend (${unreachable[1]}). Revisá AUTOLIBRE_BACKEND_URL. No se guardó nada.`)

  const e = parseQuotePlateError(raw)
  if (!e) return fix(readableQuoteRequestError(raw))

  if (e.status === 0)
    return retry(
      'El backend no contestó a tiempo. Puede que la patente ya haya quedado guardada: reintentá con la misma patente, no duplica nada.',
    )
  if (e.status === 400 && e.code === 'INVALID_STATE_TRANSITION')
    return {
      text: 'Este pedido ya no acepta patente: está cerrado o ya tiene el modelo del vehículo (el vehículo de un pedido no se cambia). Se recargó la ficha.',
      action: 'stale',
    }
  if (e.status === 400)
    return fix(
      e.message
        ? `El backend rechazó la patente: «${e.message}». No se guardó nada.`
        : 'El backend rechazó la patente. No se guardó nada.',
    )
  if (e.status === 401) return fix('Tu sesión venció para el backend. Cerrá sesión y volvé a entrar. No se guardó nada.')
  if (e.status === 403) return fix('Tu usuario no es admin para el backend. No se guardó nada.')
  if (e.status === 404 && e.cannotRoute)
    return fix(
      'El backend desplegado todavía no tiene «Identificar vehículo» (PUT /admin/quote-requests/:id/plate). Hay que desplegarlo. No se guardó nada.',
    )
  if (e.status === 404) return fix('Este pedido ya no existe en el backend. Recargá la pantalla.')
  if (e.status === 409) return retry('El pedido cambió mientras se guardaba. Reintentá con la misma patente.')
  if (e.status === 503 || e.status === 504)
    return retry(
      'El proveedor de patentes no está respondiendo (o se quedó sin consultas por hoy). No se guardó nada: reintentá más tarde.',
    )
  if (e.status >= 500) return retry('El backend falló. Reintentá en un rato con la misma patente: no duplica nada.')
  return fix(`El backend contestó ${e.status}${e.message ? `: «${e.message}»` : ''}. No se guardó nada.`)
}
