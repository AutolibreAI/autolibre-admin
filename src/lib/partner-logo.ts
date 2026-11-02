import { z } from 'zod'

/**
 * El logo de un partner: se sube y se quita por HTTP contra el backend hex
 * (`PUT|DELETE /admin/partners/:id/logo`), nunca por SQL. → `~/server/backend`
 *
 * Los topes espejan los del backend (`normalizeLogoDataUrl`, el mismo que usa el
 * alta de solicitudes). Acá cortan antes de hacer viajar el archivo; el que vale
 * es el del backend, que además mira que el contenido sea la imagen que dice ser.
 */
export const MAX_PARTNER_LOGO_BYTES = 512 * 1024
export const PARTNER_LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

/** Largo del base64 de 512 KiB + el prefijo `data:image/jpeg;base64,`. */
const MAX_DATA_URL_LENGTH = Math.ceil(MAX_PARTNER_LOGO_BYTES / 3) * 4 + 32

export const setPartnerLogoSchema = z.object({
  partnerId: z.string().uuid(),
  logoDataUrl: z
    .string()
    .max(MAX_DATA_URL_LENGTH, 'El logo supera los 512 KB.')
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/, 'Sólo PNG, JPG o WebP.'),
})

export const removePartnerLogoSchema = z.object({ partnerId: z.string().uuid() })

export function readablePartnerLogoError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)

  if (raw === 'BACKEND_UNAUTHENTICATED' || raw === 'UNAUTHENTICATED')
    return 'Tu sesión expiró o el backend no la aceptó. Cerrá sesión y volvé a entrar.'
  if (raw === 'BACKEND_FORBIDDEN') return 'El backend dice que tu usuario no es admin.'
  if (raw === 'FORBIDDEN') return 'Tu rol no tiene permiso para esta acción.'
  if (raw === 'BACKEND_PAYLOAD_TOO_LARGE') return 'El logo supera los 512 KB.'
  if (raw.startsWith('BACKEND_UNREACHABLE:')) {
    const url = raw.slice('BACKEND_UNREACHABLE:'.length)
    return `El panel no llega al backend en ${url}. En producción es la variable AUTOLIBRE_BACKEND_URL de Vercel; en desarrollo, si no está en el .env, el panel usa localhost:3005 y el backend tiene que estar corriendo ahí.`
  }
  if (raw.startsWith('BACKEND_BAD_REQUEST:')) {
    const detail = raw.split(':').slice(2).join(':')
    if (detail.includes('exceeds 512 KB')) return 'El logo supera los 512 KB.'
    if (detail.toLowerCase().includes('logo')) return 'El archivo no es una imagen PNG, JPG o WebP válida.'
    return `El backend rechazó el logo: «${detail}».`
  }
  if (raw.startsWith('BACKEND_NOT_FOUND:')) {
    const detail = raw.slice('BACKEND_NOT_FOUND:'.length)
    // Nest contesta "Cannot PUT …" cuando la RUTA no existe: el backend al que
    // le habla el panel todavía no tiene el endpoint.
    if (detail.includes('Cannot PUT') || detail.includes('Cannot DELETE'))
      return 'El backend al que le habla el panel no tiene `/admin/partners/:id/logo` todavía — falta desplegar la rama `feat/admin-partner-logo`.'
    return 'El partner ya no existe. Recargá la pantalla.'
  }
  if (raw.startsWith('BACKEND_ERROR:')) {
    const [, status, ...rest] = raw.split(':')
    return `El backend respondió ${status}: ${rest.join(':')}`
  }
  if (raw.includes('AUTOLIBRE_BACKEND_URL')) return 'Falta configurar AUTOLIBRE_BACKEND_URL.'
  if (raw.includes('timed out') || raw.includes('TimeoutError')) return 'El backend tardó demasiado. Probá de nuevo.'
  return raw
}
