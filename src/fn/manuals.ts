import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import {
  MANUAL_MIME_TYPE,
  MAX_MANUAL_FILE_SIZE_BYTES,
  MAX_MANUAL_FILE_SIZE_MB,
  catalogSearchSchema,
  manualUploadFieldsSchema,
} from '~/lib/manuals'
import { findCatalog, listCatalogs } from '~/server/catalog.repo'
import {
  confirmUpload,
  fileSignedUrl,
  linkManualToCatalog,
  requestUploadUrl,
} from '~/server/backend'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { CatalogDetail, CatalogListItem } from '~/lib/manuals'

/**
 * Todo pasa por `adminMiddleware`, las lecturas incluidas.
 *
 * Un server function es un endpoint HTTP público: cualquiera con una sesión
 * válida de la app mobile lo llama con `fetch`, y el guard de `_authed` no lo
 * cubre porque sólo modela lo que la UI ofrece. El catálogo no es secreto, pero
 * `requestManualUploadUrl` devuelve una credencial de ESCRITURA contra nuestro
 * bucket y `getManualDownloadUrl` una de lectura — la simetría es lo que hace
 * que nadie tenga que decidir caso por caso cuál de estas funciones era la
 * delicada.
 */

export const listVehicleCatalogs = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(catalogSearchSchema)
  .handler(async ({ data }): Promise<Array<CatalogListItem>> =>
    listCatalogs(data, { signal: requestSignal() }),
  )

export const getVehicleCatalog = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ catalogId: z.uuid() }))
  .handler(async ({ data }): Promise<CatalogDetail> => {
    const found = await findCatalog(data.catalogId, { signal: requestSignal() })
    if (!found) throw new Error(`NOT_FOUND:${data.catalogId}`)
    return found
  })

// ── La carga, en tres pasos ──────────────────────────────────────────────────
//
// EL PDF NO PASA POR ACÁ. Es el cambio del 2026-09-04 y el motivo de todo lo
// demás: mientras el panel proxeaba el archivo, Vercel cortaba el cuerpo de la
// request en 4.5MB (límite de plataforma, no configurable) y un manual de 300
// páginas no llegaba ni al backend.
//
//   1. requestManualUploadUrl  → server fn, JSON chico → { fileId, uploadUrl }
//   2. PUT del navegador a Spaces                       ← el archivo va POR ACÁ
//   3. finishManualUpload      → server fn, JSON chico → confirma y asocia
//
// Los pasos 1 y 3 pasan por Vercel y pesan bytes. El 2 no pasa por ningún
// servidor nuestro. → `.claude/rules/vehicle-manuals.md`

/**
 * El archivo, descrito. No el archivo.
 *
 * `sizeBytes` no es informativo: el backend lo firma DENTRO de la URL como
 * `ContentLength` exacto, así que el navegador tiene que subir exactamente ese
 * tamaño o Spaces lo rechaza. Por eso sale de `file.size` y nunca de un input.
 */
const uploadRequestSchema = z.object({
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.literal(MANUAL_MIME_TYPE),
  sizeBytes: z.number().int().positive().max(MAX_MANUAL_FILE_SIZE_BYTES),
})

/**
 * Paso 1 — pedir la URL firmada.
 *
 * El `mimeType` es `z.literal('application/pdf')` y no un enum abierto: el
 * panel sólo carga manuales, y un `.png` como manual es un dato roto que nadie
 * va a poder leer en la app. `POST /files` del backend acepta imágenes; esta
 * pantalla decide no hacerlo.
 */
export const requestManualUploadUrl = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(uploadRequestSchema)
  .handler(async ({ data }): Promise<{ fileId: string; uploadUrl: string }> =>
    requestUploadUrl(data),
  )

/**
 * Paso 3 — confirmar el objeto y asociarlo al catálogo.
 *
 * Son DOS llamadas al backend y no son atómicas, igual que antes. Lo que
 * cambió es cuál es la mitad cara: ahora la transferencia del PDF ya ocurrió y
 * ninguna de estas dos llamadas la repite. Un fallo acá se reintenta con
 * `finishManualUpload` de nuevo, y sale gratis — `POST /files/confirm` es
 * idempotente del lado del backend.
 *
 * Por eso ya NO existe un `retryLinkCatalogManual` aparte: cuando el panel
 * proxeaba, reintentar el atado sin volver a subir 8MB era una optimización que
 * valía su propio endpoint. Ahora reintentar todo el paso 3 cuesta dos JSON.
 */
export const finishManualUpload = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(
    manualUploadFieldsSchema.extend({
      fileId: z.uuid(),
      originalName: z.string().trim().min(1).max(255),
    }),
  )
  .handler(async ({ data }): Promise<{ fileId: string }> => {
    await confirmUpload({
      fileId: data.fileId,
      originalName: data.originalName,
      mimeType: MANUAL_MIME_TYPE,
    })

    try {
      await linkManualToCatalog({
        catalogId: data.catalogId,
        fileId: data.fileId,
        version: data.version,
        language: data.language,
      })
    } catch (cause) {
      /**
       * El archivo YA quedó confirmado y registrado: existe como fila de
       * `files`, sólo que no lo referencia ningún manual. Se re-tira con el id
       * pegado para que la UI pueda ofrecer el reintento sabiendo que el paso
       * caro no hay que repetirlo.
       */
      const raw = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`LINK_FAILED:${data.fileId}:${raw}`)
    }

    return { fileId: data.fileId }
  })

/**
 * La URL firmada para descargar un manual ya cargado. Dura 15 minutos.
 *
 * Se pide al hacer click y no en el loader de la ficha, y es a propósito:
 * pedirla por adelantado para los N manuales de la pantalla gastaría N llamadas
 * al backend para links que probablemente nadie abra, y encima empezaría a
 * consumir los 15 minutos desde el render.
 *
 * Puede fallar con `FILE_NOT_YOURS` aunque el manual exista y el PDF esté ahí
 * — `GET /files/:id/url` del backend está acotado al dueño del archivo. Ver
 * `src/server/backend.ts`.
 */
export const getManualDownloadUrl = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ fileId: z.uuid() }))
  .handler(async ({ data }): Promise<{ url: string; expiresAt: string }> =>
    fileSignedUrl(data.fileId),
  )

/**
 * Traduce las sentinelas de este módulo a castellano de operador.
 *
 * Vive acá y no en el componente porque las tira este archivo y
 * `src/server/backend.ts` — tenerla al lado de quien las produce es lo que hace
 * que agregar una sentinela sin su traducción se note en el mismo diff.
 *
 * Se exporta para el cliente: no toca nada de `~/server`, así que cruzar el
 * borde es seguro. (`~/fn` es el borde RPC, no código server-only.)
 */
export function readableManualError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)

  if (raw.startsWith('LINK_FAILED:')) {
    const reason = raw.split(':').slice(2).join(':')
    return `El PDF se subió y quedó registrado, pero no se pudo asociar al modelo: ${readableManualError(new Error(reason))}`
  }

  if (raw === 'NO_FILE') return 'Elegí un archivo PDF antes de subir.'
  if (raw === 'NOT_A_PDF')
    return 'Sólo se aceptan PDFs. Un manual en imagen no se puede leer en la app.'
  if (raw === 'TOO_LARGE')
    return `El PDF supera los ${MAX_MANUAL_FILE_SIZE_MB}MB que acepta la subida directa. Ese límite es del backend (MAX_DIRECT_UPLOAD_FILE_SIZE_BYTES).`

  /**
   * El PUT del navegador contra Spaces falló.
   *
   * La causa más probable NO es el archivo: es **CORS del bucket**. El PUT sale
   * del navegador hacia `*.digitaloceanspaces.com`, así que el bucket tiene que
   * permitir el origen del panel. Es configuración de DigitalOcean, no código,
   * y sin ella todas las subidas fallan igual — por eso el mensaje lo nombra.
   */
  if (raw.startsWith('STORAGE_PUT_FAILED:')) {
    const detail = raw.slice('STORAGE_PUT_FAILED:'.length)
    return `El navegador no pudo subir el PDF a storage (${detail}). Si esto falla siempre y no sólo con este archivo, lo más probable es que falte configurar CORS en el bucket de DigitalOcean Spaces para el dominio del panel.`
  }

  if (raw === 'FILE_NOT_YOURS')
    return 'No podés descargar este PDF: el backend sólo se lo entrega a quien lo subió. Pedíselo a quien figura como responsable de la carga.'

  if (raw === 'BACKEND_PAYLOAD_TOO_LARGE')
    return `El backend rechazó el archivo por tamaño (límite ${MAX_MANUAL_FILE_SIZE_MB}MB).`
  if (raw === 'BACKEND_UNAUTHENTICATED')
    return 'El backend no aceptó tu sesión. Cerrá sesión y volvé a entrar.'
  if (raw === 'BACKEND_FORBIDDEN')
    return 'El backend dice que tu usuario no es admin. El rol del panel y el del backend salen de la misma fila de `users`, así que esto no debería pasar: avisá.'

  if (raw.startsWith('BACKEND_ERROR:')) {
    const [, status, ...rest] = raw.split(':')
    // El 404 del confirm casi siempre significa lo mismo, y el texto crudo del
    // backend no lo dice: el objeto no llegó a storage.
    if (status === '404')
      return `El backend no encontró el archivo subido. Puede que el PUT haya fallado o que la URL de subida haya vencido — probá de nuevo desde cero. (${rest.join(':')})`
    return `El backend respondió ${status}: ${rest.join(':')}`
  }

  if (raw.startsWith('NOT_FOUND:')) return 'Ese modelo ya no existe. Recargá la pantalla.'

  if (raw === 'UNAUTHENTICATED') return 'Tu sesión expiró. Volvé a iniciar sesión.'
  if (raw === 'FORBIDDEN') return 'Tu rol no tiene permiso para esta acción.'

  if (raw.includes('AUTOLIBRE_BACKEND_URL'))
    return 'El panel no sabe a qué backend hablarle: falta configurar AUTOLIBRE_BACKEND_URL.'

  // `AbortSignal.timeout` tira un DOMException llamado TimeoutError.
  if (raw.includes('timed out') || raw.includes('TimeoutError'))
    return 'El backend tardó demasiado. Probá de nuevo; si sigue, fijate que el backend esté arriba.'

  return raw
}

/**
 * Saca el `fileId` de un `LINK_FAILED:` para poder ofrecer el reintento barato.
 *
 * Sigue existiendo aunque el reintento ya no ahorre una transferencia: ahorra
 * volver a pedir una URL firmada y volver a subir el PDF, que con un manual de
 * 80MB es la diferencia entre reintentar y rendirse.
 */
export function orphanFileId(cause: unknown): string | null {
  const raw = cause instanceof Error ? cause.message : String(cause)
  if (!raw.startsWith('LINK_FAILED:')) return null
  const fileId = raw.split(':')[1]
  return fileId || null
}
