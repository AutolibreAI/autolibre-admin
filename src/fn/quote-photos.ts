import { createServerFn } from '@tanstack/react-start'
import {
  quotePhotoFinishSchema,
  quotePhotoRequestSchema,
  quotePhotoUploadSchema,
  type QuotePhotoUrls,
  type QuoteRequestPhotos,
} from '~/lib/quote-photos'
import { adminFileSignedUrl, confirmUpload, requestUploadUrl } from '~/server/backend'
import {
  addQuoteRequestFile,
  listQuoteRequestPhotos,
  quotePhotosAvailability,
  quoteRequestFileIds,
} from '~/server/quote-photos.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'

/**
 * Fotos de un pedido — el borde RPC. Todo con `adminMiddleware`: son fotos de
 * autos (patentes, a veces caras) de personas reales.
 *
 * La subida es la misma de los manuales, en tres pasos y sin que la foto pase
 * por Vercel (`vehicle-manuals.md`, trampa 2):
 *
 *   1. requestQuotePhotoUploadUrlFn → { fileId, uploadUrl }
 *   2. PUT del navegador a Spaces           ← la foto va POR ACÁ
 *   3. finishQuotePhotoUploadFn     → confirma en el backend y ata al pedido (020)
 */

export const listQuoteRequestPhotosFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(quotePhotoRequestSchema)
  .handler(async ({ data }): Promise<QuoteRequestPhotos> =>
    listQuoteRequestPhotos(data.quoteRequestId, { signal: requestSignal() }),
  )

/**
 * Las URLs firmadas de las fotos de UN pedido.
 *
 * Recibe el pedido, no los ids de archivo: los ids salen de la base, así que
 * este endpoint no sirve para firmar un archivo cualquiera. Se pide desde el
 * componente al montarse (no en el loader): la ficha no depende de que el
 * backend esté arriba, y las URLs vencen a los minutos — pedirlas en el SSR las
 * empezaría a gastar antes de que nadie mire.
 *
 * Un error en una foto no tira las demás (`allSettled`): viaja como texto en
 * esa foto.
 */
export const getQuoteRequestPhotoUrlsFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(quotePhotoRequestSchema)
  .handler(async ({ data }): Promise<QuotePhotoUrls> => {
    const { table } = await quotePhotosAvailability()
    if (!table) return {}
    const ids = await quoteRequestFileIds(data.quoteRequestId)
    const results = await Promise.allSettled(ids.map((id) => adminFileSignedUrl(id)))
    const out: QuotePhotoUrls = {}
    results.forEach((r, i) => {
      out[ids[i]!] =
        r.status === 'fulfilled'
          ? { url: r.value.url }
          : { error: r.reason instanceof Error ? r.reason.message : String(r.reason) }
    })
    return out
  })

async function assertCanUpload() {
  const { table, sp } = await quotePhotosAvailability()
  if (!table || !sp) throw new Error('QUOTE_PHOTOS_UNAVAILABLE')
}

/** Paso 1. Se chequea la 020 ANTES de subir nada: si no se puede atar, no se sube. */
export const requestQuotePhotoUploadUrlFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(quotePhotoUploadSchema)
  .handler(async ({ data }): Promise<{ fileId: string; uploadUrl: string }> => {
    await assertCanUpload()
    return requestUploadUrl({
      originalName: data.originalName,
      mimeType: data.mimeType,
      sizeBytes: data.sizeBytes,
    })
  })

/**
 * Paso 3 — confirmar el objeto (el backend mira los magic bytes) y atarlo.
 *
 * No es atómico, igual que los manuales: si el atado falla, el archivo ya
 * quedó registrado y el error lleva el `fileId` (`LINK_FAILED:`) para
 * reintentar sin volver a subir. El confirm es idempotente del lado del
 * backend y el SP también, así que reintentar el paso entero es seguro.
 */
export const finishQuotePhotoUploadFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(quotePhotoFinishSchema)
  .handler(async ({ data, context }): Promise<{ fileId: string }> => {
    await assertCanUpload()
    await confirmUpload({ fileId: data.fileId, originalName: data.originalName, mimeType: data.mimeType })
    try {
      await addQuoteRequestFile({ quoteRequestId: data.quoteRequestId, fileId: data.fileId }, context.user.id)
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`LINK_FAILED:${data.fileId}:${raw}`)
    }
    return { fileId: data.fileId }
  })
