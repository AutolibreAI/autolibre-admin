import { createServerFn } from '@tanstack/react-start'
import {
  conversationChangesInputSchema,
  listConversationsInputSchema,
  markReadInputSchema,
  messageChangesInputSchema,
  partnerConversationsInputSchema,
  sendMessageInputSchema,
  threadInputSchema,
  type ConversationChanges,
  type ConversationPage,
  type MessageChanges,
  type PartnerConversations,
  type ReadResult,
  type SendResult,
  type ThreadPage,
} from '~/lib/whatsapp-inbox'
import {
  getWhatsAppConversationsByPartner,
  getWhatsAppThread,
  listWhatsAppConversations,
  markWhatsAppConversationRead,
  sendWhatsAppMessage,
  whatsappConversationChanges,
  whatsappMessageChanges,
} from '~/server/backend'
import { requestSignal } from '~/server/request'
import {
  mockConversationChanges,
  mockConversationsByPartner,
  mockListConversations,
  mockMarkRead,
  mockMessageChanges,
  mockSendMessage,
  mockThread,
} from '~/mocks/whatsapp-inbox'
import { adminMiddleware } from './middleware'

/**
 * Bandeja de WhatsApp — el borde RPC. Todo por HTTP contra el backend hex
 * (`/admin/whatsapp/…`), con el token de Clerk del admin.
 *
 * `adminMiddleware` en todo: devuelve números completos y conversaciones con
 * terceros, y el envío le escribe a una persona real por WhatsApp.
 *
 * ── El mock, y por qué se elige ACÁ ──────────────────────────────────────────
 *
 * Mientras el contrato no se congele, en DESARROLLO los handlers responden con
 * `~/mocks/whatsapp-inbox` (stateful, en memoria). Se elige en el server
 * function y no en la UI para que la pantalla pase SIEMPRE por el borde real:
 * el día del cambio se borra este `if` y el archivo del mock, nada más.
 * `WHATSAPP_INBOX_MOCK=0` en el `.env` apunta al backend local.
 * En producción el mock no corre NUNCA (`import.meta.env.DEV`).
 */
const useMock = () => import.meta.env.DEV && process.env.WHATSAPP_INBOX_MOCK !== '0'

/** Para el cartel de "datos de ejemplo" (regla dura 8). */
export const getWhatsAppInboxSourceFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<'mock' | 'backend'> => (useMock() ? 'mock' : 'backend'))

export const listWhatsAppConversationsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(listConversationsInputSchema)
  .handler(async ({ data }): Promise<ConversationPage> =>
    useMock() ? mockListConversations(data) : listWhatsAppConversations(data, { signal: requestSignal() }),
  )

export const whatsappConversationChangesFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(conversationChangesInputSchema)
  .handler(async ({ data }): Promise<ConversationChanges> =>
    useMock() ? mockConversationChanges(data) : whatsappConversationChanges(data, { signal: requestSignal() }),
  )

/** Para linkear desde la ficha de un partner al hilo, sin el número en la URL. */
export const getWhatsAppConversationsByPartnerFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(partnerConversationsInputSchema)
  .handler(async ({ data }): Promise<PartnerConversations> =>
    useMock() ? mockConversationsByPartner(data) : getWhatsAppConversationsByPartner(data, { signal: requestSignal() }),
  )

export const getWhatsAppThreadFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(threadInputSchema)
  .handler(async ({ data }): Promise<ThreadPage> =>
    useMock() ? mockThread(data) : getWhatsAppThread(data, { signal: requestSignal() }),
  )

export const whatsappMessageChangesFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(messageChangesInputSchema)
  .handler(async ({ data }): Promise<MessageChanges> =>
    useMock() ? mockMessageChanges(data) : whatsappMessageChanges(data, { signal: requestSignal() }),
  )

/**
 * El envío. Sin `requestSignal()` a propósito: si el admin cierra la pestaña a
 * mitad de camino, cortar el fetch no des-manda el mensaje — sólo nos deja sin
 * saber si salió. El reintento con el mismo `clientMessageId` es la red.
 */
export const sendWhatsAppMessageFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(sendMessageInputSchema)
  .handler(async ({ data, context }): Promise<SendResult> =>
    useMock() ? mockSendMessage(data, { id: context.user.id, name: context.user.name }) : sendWhatsAppMessage(data),
  )

export const markWhatsAppReadFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(markReadInputSchema)
  .handler(async ({ data, context }): Promise<ReadResult> =>
    useMock() ? mockMarkRead(data, { id: context.user.id, name: context.user.name }) : markWhatsAppConversationRead(data),
  )
