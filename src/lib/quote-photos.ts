import { z } from 'zod'

/**
 * Fotos de un pedido de presupuesto (`public.quote_request_files`).
 *
 * Llegan por dos lados:
 *  - la persona las adjunta al pedir desde la APP (el archivo queda a SU
 *    nombre en `files.user_id`);
 *  - por WhatsApp las manda en la charla y el operador las carga desde la ficha
 *    (el archivo queda a nombre del ADMIN que la subió — la única auditoría de
 *    quién la cargó, mismo criterio que los manuales).
 *
 * `purpose` es `problem_photo` o `budget` (un presupuesto adjunto). El panel
 * muestra los dos y sólo carga `problem_photo`.
 *
 * Ver: `.claude/rules/leads.md` (Fotos) y la migración 020.
 */

/** Lo que acepta la subida desde el panel. El backend vuelve a mirar los magic bytes al confirmar. */
export const QUOTE_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type QuotePhotoMimeType = (typeof QUOTE_PHOTO_MIME_TYPES)[number]

/**
 * Tope del PANEL, no del backend (que corta la subida directa en 100MB). Una
 * foto de teléfono pesa 1–5MB; 20MB deja holgura sin dejar pasar un video
 * renombrado.
 */
export const MAX_QUOTE_PHOTO_MB = 20
export const MAX_QUOTE_PHOTO_BYTES = MAX_QUOTE_PHOTO_MB * 1024 * 1024

export const QUOTE_FILE_PURPOSE_LABELS: Record<string, string> = {
  problem_photo: 'Foto del problema',
  budget: 'Presupuesto adjunto',
}

export interface QuoteRequestPhoto {
  /** `quote_request_files.id` */
  id: string
  fileId: string
  purpose: string
  mimeType: string | null
  sizeBytes: number | null
  createdAt: string
  /**
   * Quién es dueño del archivo: la persona del pedido (la subió desde la app),
   * un admin (la cargó desde el panel), u otra cuenta. Sale de `files.user_id`.
   */
  uploadedBy: 'requester' | 'admin' | 'other'
  uploaderEmail: string | null
}

export type QuoteRequestPhotos =
  | { available: false }
  | {
      available: true
      /** La 020 está aplicada: el panel puede atar fotos. Sin ella, sólo se ven. */
      canUpload: boolean
      photos: Array<QuoteRequestPhoto>
    }

/** Por foto: la URL firmada (dura minutos), o por qué no se pudo pedir. */
export type QuotePhotoUrls = Record<string, { url: string } | { error: string }>

export const quotePhotoRequestSchema = z.object({ quoteRequestId: z.uuid() })

export const quotePhotoUploadSchema = z.object({
  quoteRequestId: z.uuid(),
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.enum(QUOTE_PHOTO_MIME_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_QUOTE_PHOTO_BYTES),
})

export const quotePhotoFinishSchema = z.object({
  quoteRequestId: z.uuid(),
  fileId: z.uuid(),
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.enum(QUOTE_PHOTO_MIME_TYPES),
})

export function isQuotePhotoMime(type: string): type is QuotePhotoMimeType {
  return (QUOTE_PHOTO_MIME_TYPES as ReadonlyArray<string>).includes(type)
}

/** Las sentinelas de este flujo a algo que se pueda leer. Corre en el navegador. */
export function readableQuotePhotoError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)

  if (raw.startsWith('LINK_FAILED:')) {
    const reason = raw.split(':').slice(2).join(':')
    return `La foto se subió, pero no se pudo atar al pedido: ${readableQuotePhotoError(new Error(reason))}`
  }
  if (raw === 'NOT_AN_IMAGE') return 'Sólo fotos: JPG, PNG o WebP.'
  if (raw === 'TOO_LARGE') return `La foto supera los ${MAX_QUOTE_PHOTO_MB}MB.`
  if (raw === 'QUOTE_PHOTOS_UNAVAILABLE')
    return 'Esta base no tiene fotos de pedidos (falta `quote_request_files`) o le falta la migración 020 del panel.'
  if (raw.startsWith('STORAGE_PUT_FAILED:'))
    return `El navegador no pudo subir la foto a storage (${raw.slice('STORAGE_PUT_FAILED:'.length)}). Si falla siempre, lo más probable es CORS del bucket de DigitalOcean Spaces.`
  if (raw.includes('FILE_NOT_IMAGE')) return 'El archivo registrado no es una imagen.'
  if (raw.includes('FILE_NOT_FOUND')) return 'El backend no registró el archivo. Probá de nuevo desde cero.'
  if (raw.includes('QUOTE_REQUEST_NOT_FOUND')) return 'El pedido ya no existe. Recargá la pantalla.'
  if (raw === 'BACKEND_UNAUTHENTICATED' || raw === 'UNAUTHENTICATED')
    return 'Tu sesión expiró o el backend no la aceptó. Cerrá sesión y volvé a entrar.'
  if (raw === 'BACKEND_FORBIDDEN') return 'El backend dice que tu usuario no es admin.'
  if (raw === 'FORBIDDEN') return 'Tu rol no tiene permiso para esta acción.'
  if (raw.startsWith('BACKEND_UNREACHABLE:')) {
    const url = raw.slice('BACKEND_UNREACHABLE:'.length)
    return `El panel no llega al backend en ${url}. En producción es la variable AUTOLIBRE_BACKEND_URL de Vercel; en desarrollo, si no está en el .env, el panel usa localhost:3005 y el backend tiene que estar corriendo ahí.`
  }
  if (raw.startsWith('BACKEND_NOT_FOUND:')) {
    const detail = raw.slice('BACKEND_NOT_FOUND:'.length)
    // Nest contesta "Cannot GET …" cuando la RUTA no existe: el backend al que
    // le habla el panel todavía no tiene `GET /admin/files/:id/url`
    // (está en `main` desde el 2026-09-30).
    if (detail.includes('Cannot GET'))
      return 'El backend al que le habla el panel no tiene `GET /admin/files/:id/url` — está en `main` del backend desde el 2026-09-30; falta desplegarlo.'
    return `El backend no encuentra el archivo (${detail}).`
  }
  if (raw.startsWith('BACKEND_ERROR:')) {
    const [, status, ...rest] = raw.split(':')
    return `El backend respondió ${status}: ${rest.join(':')}`
  }
  if (raw.includes('AUTOLIBRE_BACKEND_URL')) return 'Falta configurar AUTOLIBRE_BACKEND_URL.'
  if (raw.includes('timed out') || raw.includes('TimeoutError')) return 'El backend tardó demasiado. Probá de nuevo.'
  return raw
}
