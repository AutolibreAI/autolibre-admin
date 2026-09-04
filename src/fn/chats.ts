import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { chatSearchSchema } from '~/lib/chats'
import { findChatDetail, listChats, listDistinctChatModels } from '~/server/chats.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { ChatDetail, ChatListItem } from '~/lib/chats'

/**
 * El borde RPC de Chats. Mismo guard que `users.ts` y por el mismo motivo: el
 * contenido de una conversación es tan sensible como el padrón — más, en
 * algunos casos, porque es lo que la persona le escribió al asistente tal
 * cual. Sin `adminMiddleware` cualquier sesión válida de la app se baja
 * cualquier chat de cualquiera con sólo saber el uuid.
 */

export const listAppChats = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(chatSearchSchema)
  .handler(async ({ data }): Promise<Array<ChatListItem>> =>
    listChats(data, { signal: requestSignal() }),
  )

export const listAppChatModels = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<string>> => listDistinctChatModels())

export const getAppChat = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ conversationId: z.uuid() }))
  .handler(async ({ data }): Promise<ChatDetail> => {
    const found = await findChatDetail(data.conversationId, { signal: requestSignal() })
    if (!found) throw new Error(`NOT_FOUND:${data.conversationId}`)
    return found
  })
