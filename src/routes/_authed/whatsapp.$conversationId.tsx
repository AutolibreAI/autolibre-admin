import { createFileRoute } from '@tanstack/react-router'
import { getWhatsAppThreadFn } from '~/fn/whatsapp-inbox'
import { readableWhatsAppInboxError } from '~/lib/whatsapp-inbox'
import { WhatsAppThread } from '~/components/WhatsAppThread'

/**
 * `/whatsapp/:conversationId` — un hilo. El id es el UUID de la conversación,
 * nunca el número (PII). La primera página viene del loader; después todo lo
 * mueve el estado del hilo (cambios por id, envío optimista).
 *
 * `ssr: 'data-only'`, por lo mismo que el layout.
 */
export const Route = createFileRoute('/_authed/whatsapp/$conversationId')({
  ssr: 'data-only',
  loader: ({ params, abortController }) =>
    getWhatsAppThreadFn({ data: { conversationId: params.conversationId }, signal: abortController.signal }),
  head: () => ({ meta: [{ title: 'Conversación — WhatsApp — AutoLibre' }] }),
  errorComponent: ({ error }) => (
    <div className="p-6 text-sm text-status-red">
      {readableWhatsAppInboxError(error instanceof Error ? error.message : String(error))}
    </div>
  ),
  component: ThreadRoute,
})

function ThreadRoute() {
  const page = Route.useLoaderData()
  return <WhatsAppThread key={page.conversation.id} initial={page} />
}
