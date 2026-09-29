import { createServerFn } from '@tanstack/react-start'
import {
  MAX_KNOWLEDGE_MARKDOWN_BYTES,
  MAX_KNOWLEDGE_MARKDOWN_KB,
  hasMarkdownExtension,
  knowledgeUploadFieldsSchema,
  type KnowledgeDocumentsListing,
  type KnowledgeUploadFields,
} from '~/lib/knowledge-documents'
import { listKnowledgeDocumentChains } from '~/server/knowledge-documents.repo'
import { uploadMarkdownKnowledgeDocument } from '~/server/backend'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'

/**
 * El borde RPC de `/conocimiento`. Todo con `adminMiddleware`, la lectura
 * incluida: un server function es un endpoint HTTP público, y el alta manda
 * el token del admin al backend. → `.claude/rules/knowledge-documents.md`
 */

export const listKnowledgeDocumentsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<KnowledgeDocumentsListing> =>
    listKnowledgeDocumentChains({ signal: requestSignal() }),
  )

// ── El alta ──────────────────────────────────────────────────────────────────

interface ParsedKnowledgeUpload {
  file: File
  fields: KnowledgeUploadFields
}

/**
 * El input es un `FormData`, no un JSON.
 *
 * TanStack Start acepta `FormData` como `data` de un server function POST
 * (verificado en `@tanstack/start-client-core` 1.170: `ValidateValidatorInput`
 * deja pasar `FormData` sin exigir que sea serializable, y
 * `server-functions-handler.js` lo lee con `request.formData()`). Así el
 * markdown viaja como binario tal cual, sin el +33% de un base64 y sin que el
 * texto pase por `JSON.stringify`, que es donde un encoding raro se rompe en
 * silencio.
 *
 * Se revalida TODO acá aunque el componente ya lo haya chequeado: el chequeo
 * del cliente es para no hacer esperar al operador; éste es el que vale (y
 * detrás de éste, el del backend).
 */
function parseKnowledgeUpload(input: unknown): ParsedKnowledgeUpload {
  if (!(input instanceof FormData)) throw new Error('KNOWLEDGE_INVALID_FORM')

  const file = input.get('file')
  if (!(file instanceof File) || file.size === 0) throw new Error('KNOWLEDGE_NO_FILE')
  if (!hasMarkdownExtension(file.name)) throw new Error('KNOWLEDGE_NOT_MARKDOWN')
  if (file.size > MAX_KNOWLEDGE_MARKDOWN_BYTES) throw new Error('KNOWLEDGE_TOO_LARGE')

  const supersedes = input.get('supersedesDocumentId')
  const parsed = knowledgeUploadFieldsSchema.safeParse({
    title: input.get('title') ?? '',
    // `''` = documento nuevo. Se traduce a ausente acá para que el backend
    // (`forbidNonWhitelisted` + `@IsUUID`) nunca vea un string vacío.
    supersedesDocumentId: typeof supersedes === 'string' && supersedes !== '' ? supersedes : undefined,
  })
  if (!parsed.success) throw new Error('KNOWLEDGE_INVALID_FIELDS')

  return { file, fields: parsed.data }
}

export const uploadKnowledgeDocumentFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator((input: FormData) => parseKnowledgeUpload(input))
  .handler(async ({ data }): Promise<{ id: string }> =>
    uploadMarkdownKnowledgeDocument({
      file: data.file,
      fileName: data.file.name,
      title: data.fields.title,
      supersedesDocumentId: data.fields.supersedesDocumentId,
    }),
  )

/**
 * Traduce las sentinelas de este módulo y de `backend.ts` a castellano de
 * operador. Vive al lado de quien las produce, igual que
 * `readableManualError`, y se exporta al cliente porque no toca `~/server`.
 *
 * Los 400 del backend se muestran con su texto: es el único que sabe en qué
 * línea está la marca `rag:skip` mal puesta, y parafrasearlo lo perdería. Está
 * en inglés — es el `message` de una excepción del backend —, así que se
 * presenta como cita, no como texto nuestro.
 */
export function readableKnowledgeError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)

  if (raw === 'KNOWLEDGE_NO_FILE') return 'Elegí un archivo .md antes de subir.'
  if (raw === 'KNOWLEDGE_NOT_MARKDOWN')
    return 'Sólo se aceptan archivos markdown (.md o .markdown).'
  if (raw === 'KNOWLEDGE_TOO_LARGE' || raw === 'BACKEND_PAYLOAD_TOO_LARGE')
    return `El archivo supera 1 MB (${MAX_KNOWLEDGE_MARKDOWN_KB} KB), que es el límite del backend para markdown.`
  if (raw === 'KNOWLEDGE_INVALID_FIELDS')
    return 'El título es obligatorio y no puede pasar de 200 caracteres.'
  if (raw === 'KNOWLEDGE_INVALID_FORM') return 'El formulario llegó mal armado. Recargá la pantalla y probá de nuevo.'

  if (raw.startsWith('BACKEND_BAD_REQUEST:')) {
    const [, code, ...rest] = raw.split(':')
    const detail = rest.join(':')
    if (code === 'INVALID_STATE_TRANSITION')
      return `La versión que querés reemplazar todavía se está procesando o falló, así que no se puede reemplazar. Recargá la pantalla. (Backend: ${detail})`
    return `El backend rechazó el documento: «${detail}»`
  }

  if (raw.startsWith('BACKEND_CONFLICT:'))
    return 'Ya hay una versión nueva en curso o este documento ya fue reemplazado; recargá la pantalla.'
  if (raw.startsWith('BACKEND_NOT_FOUND:'))
    return 'El documento que querés reemplazar ya no existe. Recargá la pantalla.'

  if (raw === 'BACKEND_UNAUTHENTICATED')
    return 'El backend no aceptó tu sesión. Cerrá sesión y volvé a entrar.'
  if (raw === 'BACKEND_FORBIDDEN')
    return 'Tu usuario no es admin en el backend. El rol del panel y el del backend salen de la misma fila de `users`, así que esto no debería pasar: avisá.'

  if (raw.startsWith('BACKEND_ERROR:')) {
    const [, status, ...rest] = raw.split(':')
    return `El backend respondió ${status}: ${rest.join(':')}`
  }

  if (raw === 'UNAUTHENTICATED') return 'Tu sesión expiró. Volvé a iniciar sesión.'
  if (raw === 'FORBIDDEN') return 'Tu rol no tiene permiso para esta acción.'

  if (raw.includes('AUTOLIBRE_BACKEND_URL'))
    return 'El panel no sabe a qué backend hablarle: falta configurar AUTOLIBRE_BACKEND_URL.'

  if (raw.includes('timed out') || raw.includes('TimeoutError'))
    return 'El backend tardó demasiado. Probá de nuevo; si sigue, fijate que el backend esté arriba.'

  return raw
}
