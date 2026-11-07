import { createFileRoute } from '@tanstack/react-router'
import { MessagesSquare } from 'lucide-react'

/** El panel derecho sin conversación elegida. SSR heredado del layout. */
export const Route = createFileRoute('/_authed/whatsapp/')({
  component: () => (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
      <MessagesSquare className="size-6" aria-hidden />
      Elegí una conversación de la lista.
    </div>
  ),
})
