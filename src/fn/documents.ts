import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { DOC_TYPES, documentSearchSchema } from '~/lib/documents'
import { findDocument, listDocuments } from '~/server/documents.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { DocumentDetail, DocumentListItem } from '~/lib/documents'

/**
 * El borde RPC de Documentos. Mismo guard que `users.ts` / `chats.ts` y por el
 * mismo motivo: un server function es un endpoint HTTP público, y esto devuelve
 * DNI, domicilio, nº de póliza y de licencia de personas reales. Sin
 * `adminMiddleware` cualquier sesión válida de la app se baja el padrón de
 * documentos con sólo saber un uuid.
 */

export const listAppDocuments = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(documentSearchSchema)
  .handler(async ({ data }): Promise<Array<DocumentListItem>> =>
    listDocuments(data, { signal: requestSignal() }),
  )

export const getAppDocument = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ docType: z.enum(DOC_TYPES), docId: z.uuid() }))
  .handler(async ({ data }): Promise<DocumentDetail> => {
    const found = await findDocument(data.docType, data.docId, { signal: requestSignal() })
    if (!found) throw new Error(`NOT_FOUND:${data.docId}`)
    return found
  })
