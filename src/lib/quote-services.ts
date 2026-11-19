import { z } from 'zod'

/**
 * Corrección de los SERVICIOS de un pedido por el operador — por HTTP al
 * backend (`PUT /admin/quote-requests/:id/services`, 0155). Client-safe.
 *
 * Por qué no alcanza con `ops.set_quote_request_rubros` (016): esa tabla es del
 * panel y guarda FAMILIAS; el backend NUNCA la leyó, así que «Guardar
 * clasificación» no cambiaba ni los candidatos del despacho ni el `{{2}}` del
 * template. El backend lee la corrección del operador (servicios del catálogo,
 * en orden, sin primario): mientras exista, MANDA sobre la clasificación de la
 * IA, y es candidato quien cubra al menos uno.
 *
 * La 016 se sigue escribiendo, con las familias DERIVADAS de los servicios:
 * la leen la ficha (los rubros con los que se buscan candidatos) y
 * `/partners/estudio` (`listQuoteRequestRubros`). Es un espejo, no la fuente.
 * → `.claude/rules/partner-dispatch.md`
 */

/** La forma de `services.slug` (la misma regex que el DTO del backend). */
const SERVICE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const correctQuoteServicesSchema = z.object({
  quoteRequestId: z.uuid(),
  serviceSlugs: z
    .array(z.string().regex(SERVICE_SLUG, 'Servicio mal formado.'))
    .min(1, 'Elegí al menos un servicio.')
    .refine((s) => new Set(s).size === s.length, 'Hay un servicio repetido.'),
})
export type CorrectQuoteServicesInput = z.infer<typeof correctQuoteServicesSchema>

/** Lo que devuelve el server function. `legacySynced: false` = el backend lo guardó, el espejo de `ops` no. */
export interface CorrectQuoteServicesResult {
  ok: true
  legacySynced: boolean
}

/** La forma mínima del catálogo que hace falta acá (`ServiceFamily` de `~/lib/catalog` la cumple). */
interface CatalogFamily {
  slug: string
  services: ReadonlyArray<{ slug: string }>
}

/** Las familias de esos servicios, sin repetir y en orden de catálogo. Un slug fuera del catálogo no aporta nada. */
export function familiesOfServices(catalog: ReadonlyArray<CatalogFamily>, serviceSlugs: ReadonlyArray<string>): Array<string> {
  const wanted = new Set(serviceSlugs)
  return catalog.filter((f) => f.services.some((s) => wanted.has(s.slug))).map((f) => f.slug)
}

/** ¿Es la misma selección? Como conjunto: el orden sólo decide cómo se le nombran al taller. */
export function sameServiceSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  return sa.size === sb.size && [...sa].every((x) => sb.has(x))
}

// ── Errores ─────────────────────────────────────────────────────────────────

/** Sentinela que arma `backendError(..., { quoteServices: true })`. */
export const QUOTE_SERVICES_ERROR = 'QUOTE_SERVICES_ERROR'

export interface QuoteServicesErrorInfo {
  /** `0` = timeout: pudo haberse guardado. */
  status: number
  code: string
  message: string
  /** `details.serviceSlugs` de un `VALIDATION_ERROR`: los que no están en el catálogo activo. */
  serviceSlugs: Array<string>
  /** 404 «Cannot PUT»: el backend desplegado no tiene el endpoint. */
  cannotRoute: boolean
}

export function parseQuoteServicesError(cause: unknown): QuoteServicesErrorInfo | null {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const at = raw.indexOf(`${QUOTE_SERVICES_ERROR}:`)
  if (at === -1) return null
  try {
    const v = JSON.parse(raw.slice(at + QUOTE_SERVICES_ERROR.length + 1)) as Record<string, unknown>
    return {
      status: typeof v.status === 'number' ? v.status : 0,
      code: typeof v.code === 'string' ? v.code : '',
      message: typeof v.message === 'string' ? v.message : '',
      serviceSlugs: Array.isArray(v.serviceSlugs) ? v.serviceSlugs.filter((s): s is string => typeof s === 'string') : [],
      cannotRoute: v.cannotRoute === true,
    }
  } catch {
    return null
  }
}

export interface ReadableQuoteServicesError {
  text: string
  /** Reintentar con la misma selección tiene sentido (timeout, 409, 5xx). */
  retry: boolean
}

export function readableQuoteServicesError(cause: unknown): ReadableQuoteServicesError {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const fix = (text: string): ReadableQuoteServicesError => ({ text, retry: false })

  const unreachable = /BACKEND_UNREACHABLE:(\S+)/.exec(raw)
  if (unreachable) return fix(`No se pudo llegar al backend (${unreachable[1]}). Revisá AUTOLIBRE_BACKEND_URL. No se guardó nada.`)
  if (raw === 'UNAUTHENTICATED') return fix('Tu sesión expiró. Cerrá sesión y volvé a entrar.')
  if (raw === 'FORBIDDEN') return fix('Tu rol no tiene permiso para esta acción.')
  if (raw.startsWith('QUOTE_REQUESTS_UNAVAILABLE')) return fix('Esta base no tiene la tabla de pedidos. No se guardó nada.')

  const e = parseQuoteServicesError(raw)
  if (!e) return { text: 'No pudimos guardar la clasificación. Reintentá.', retry: true }

  if (e.status === 0)
    return { text: 'El backend no contestó a tiempo. Puede que se haya guardado igual: reintentá, es idempotente.', retry: true }
  if (e.status === 400 && e.code === 'INVALID_STATE_TRANSITION')
    return fix('El pedido está cerrado: su clasificación ya no se corrige. Recargá la ficha.')
  if (e.status === 400 && e.serviceSlugs.length > 0)
    return fix(`Estos servicios no están activos en el catálogo: ${e.serviceSlugs.join(', ')}. Sacalos y volvé a guardar.`)
  if (e.status === 400) return fix(`El backend rechazó la clasificación: «${e.message}». No se guardó nada.`)
  if (e.status === 401) return fix('Tu sesión venció para el backend. Cerrá sesión y volvé a entrar.')
  if (e.status === 403) return fix('Tu usuario no es admin para el backend.')
  if (e.status === 404 && e.cannotRoute)
    return fix('El backend desplegado todavía no tiene la corrección de servicios (PUT /admin/quote-requests/:id/services). No se guardó nada.')
  if (e.status === 404) return fix('Este pedido ya no existe en el backend. Recargá la pantalla.')
  if (e.status === 409) return { text: 'El pedido cambió mientras se guardaba. Reintentá.', retry: true }
  return { text: `El backend contestó ${e.status}: «${e.message}». Reintentá.`, retry: true }
}
