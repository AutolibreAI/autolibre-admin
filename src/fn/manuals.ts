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
import { fileSignedUrl, linkManualToCatalog, uploadFile } from '~/server/backend'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type {
  CatalogDetail,
  CatalogListItem,
  ManualUploadFields,
  ManualUploadResult,
} from '~/lib/manuals'

/**
 * Todo pasa por `adminMiddleware`, las lecturas incluidas.
 *
 * Un server function es un endpoint HTTP público: cualquiera con una sesión
 * válida de la app mobile lo llama con `fetch`, y el guard de `_authed` no lo
 * cubre porque sólo modela lo que la UI ofrece. El catálogo no es secreto, pero
 * `getManualDownloadUrl` sí devuelve una URL firmada a un archivo de storage —
 * y la simetría es lo que hace que nadie tenga que decidir caso por caso cuál
 * de estas funciones era la delicada.
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

// ── La carga ─────────────────────────────────────────────────────────────────

/**
 * El validator del upload, a mano y no con zod.
 *
 * zod no puede describir el binario: en el servidor `File` es el global de
 * Node y en el cliente el del DOM, y `z.instanceof(File)` compila contra uno
 * solo de los dos. Así que el archivo se valida acá y los otros tres campos
 * pasan por `manualUploadFieldsSchema`, que es el mismo schema que la pantalla
 * usa para armar el form.
 *
 * ── Los tres chequeos, y por qué ninguno es la autoridad ────────────────────
 *
 * El backend vuelve a validar los tres, y su versión es más fuerte: sniffea los
 * magic bytes, así que un .zip renombrado a .pdf no le pasa. Estos chequeos
 * existen para NO gastar una subida de 10MB antes de decir que no — y el del
 * tamaño especialmente, porque el 413 del backend llega recién después de haber
 * transferido el archivo entero.
 */
function parseManualUpload(input: unknown): ManualUploadFields & { file: File } {
  if (!(input instanceof FormData)) {
    throw new Error('BAD_REQUEST:Se esperaba un formulario con el archivo')
  }

  const file = input.get('file')

  if (!(file instanceof File) || file.size === 0) {
    throw new Error('NO_FILE')
  }

  /**
   * El tipo se mira sobre `file.type`, que lo declara el navegador a partir de
   * la extensión. Es exactamente el dato en el que el backend NO confía, y con
   * razón. Acá alcanza igual: si miente, el sniffing del backend lo caza y el
   * único costo es una subida perdida.
   */
  if (file.type !== MANUAL_MIME_TYPE) {
    throw new Error('NOT_A_PDF')
  }

  if (file.size > MAX_MANUAL_FILE_SIZE_BYTES) {
    throw new Error('TOO_LARGE')
  }

  const fields = manualUploadFieldsSchema.parse({
    catalogId: input.get('catalogId'),
    version: input.get('version') ?? '',
    language: input.get('language') ?? '',
  })

  return { ...fields, file }
}

/**
 * Subir un manual: las DOS llamadas al backend, en orden.
 *
 * ── Por qué esto no es atómico, y qué se hace al respecto ───────────────────
 *
 * Son dos endpoints y no hay transacción que los abarque: `POST /files` deja el
 * PDF en DigitalOcean Spaces y `POST /vehicle-catalog-manuals` graba la fila.
 * Si el segundo falla, **el archivo ya está subido** y no hay `DELETE /files`
 * en el backend para limpiarlo.
 *
 * La respuesta honesta no es esconderlo: es devolver el `fileId` con
 * `linked: false`, para que el operador pueda reintentar el atado SIN volver a
 * subir 8MB, y para que el archivo huérfano tenga un id anotado en algún lado
 * en vez de quedar sólo en el bucket.
 *
 * Lo que NO se hizo, a propósito: un reintento automático del segundo paso. Los
 * dos motivos por los que falla —catálogo inexistente, rol insuficiente— no se
 * arreglan solos, así que reintentar sólo agrega latencia antes del mismo
 * error.
 */
export const uploadCatalogManual = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(parseManualUpload)
  .handler(async ({ data }): Promise<ManualUploadResult> => {
    const fileId = await uploadFile(data.file)

    try {
      await linkManualToCatalog({
        catalogId: data.catalogId,
        fileId,
        version: data.version,
        language: data.language,
      })
    } catch (cause) {
      /**
       * Se re-tira con el `fileId` pegado al mensaje, no se traga.
       *
       * Devolver `{ linked: false }` como éxito dejaría la pantalla diciendo
       * "listo" sobre un manual que no existe. El id viaja EN el error para que
       * la UI pueda ofrecer el reintento barato, que es la única parte
       * recuperable de esto.
       */
      const raw = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`LINK_FAILED:${fileId}:${raw}`)
    }

    return { fileId, linked: true }
  })

/**
 * Reintentar SÓLO el segundo paso, con un archivo que ya está en storage.
 *
 * Existe por el caso de arriba y nada más. No es un endpoint de propósito
 * general para atar cualquier archivo a cualquier catálogo: el `fileId` que
 * recibe salió de un `uploadCatalogManual` que falló en esta misma sesión.
 *
 * Igual va con `adminMiddleware` y el backend vuelve a exigir `AdminGuard`, así
 * que aunque alguien lo llamara con un id arbitrario, lo peor que consigue es
 * atar un archivo suyo a un catálogo — que es exactamente lo que el endpoint
 * hace de todos modos.
 */
export const retryLinkCatalogManual = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(manualUploadFieldsSchema.extend({ fileId: z.uuid() }))
  .handler(async ({ data }): Promise<ManualUploadResult> => {
    await linkManualToCatalog({
      catalogId: data.catalogId,
      fileId: data.fileId,
      version: data.version,
      language: data.language,
    })
    return { fileId: data.fileId, linked: true }
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
    // `LINK_FAILED:<fileId>:<motivo>` — se muestra el motivo, y el fileId lo
    // usa la UI aparte para ofrecer el reintento.
    const reason = raw.split(':').slice(2).join(':')
    return `El PDF se subió, pero no se pudo asociar al modelo: ${readableManualError(new Error(reason))}`
  }

  if (raw === 'NO_FILE') return 'Elegí un archivo PDF antes de subir.'
  if (raw === 'NOT_A_PDF') return 'Sólo se aceptan PDFs. Un manual en imagen no se puede leer en la app.'
  if (raw === 'TOO_LARGE')
    return `El PDF supera los ${MAX_MANUAL_FILE_SIZE_MB}MB que acepta el backend. Ese límite es del backend, no del panel: hay que subirlo allá o comprimir el PDF.`

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
    return `El backend respondió ${status}: ${rest.join(':')}`
  }

  if (raw.startsWith('BAD_REQUEST:')) return raw.slice('BAD_REQUEST:'.length)
  if (raw.startsWith('NOT_FOUND:')) return 'Ese modelo ya no existe. Recargá la pantalla.'

  if (raw === 'UNAUTHENTICATED') return 'Tu sesión expiró. Volvé a iniciar sesión.'
  if (raw === 'FORBIDDEN') return 'Tu rol no tiene permiso para esta acción.'

  if (raw.includes('AUTOLIBRE_BACKEND_URL'))
    return 'El panel no sabe a qué backend hablarle: falta configurar AUTOLIBRE_BACKEND_URL.'

  // `AbortSignal.timeout` tira un DOMException llamado TimeoutError.
  if (raw.includes('timed out') || raw.includes('TimeoutError'))
    return 'El backend tardó demasiado. Si el PDF es grande, probá de nuevo; si sigue, fijate que el backend esté arriba.'

  return raw
}

/** Saca el `fileId` de un `LINK_FAILED:` para poder ofrecer el reintento. */
export function orphanFileId(cause: unknown): string | null {
  const raw = cause instanceof Error ? cause.message : String(cause)
  if (!raw.startsWith('LINK_FAILED:')) return null
  const fileId = raw.split(':')[1]
  return fileId || null
}
