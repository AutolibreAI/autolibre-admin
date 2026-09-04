import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { ArrowLeft, Bot, Car, User } from 'lucide-react'
import {
  CHAT_TYPE_LABELS,
  CONVERSATION_STATUS_LABELS,
  firstUserMessage,
  type ChatMessage,
} from '~/lib/chats'
import { getAppChat } from '~/fn/chats'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Badge } from '~/components/ui/badge'
import { Card, CardContent } from '~/components/ui/card'
import { formatDate, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { ReactNode } from 'react'

export const Route = createFileRoute('/_authed/chats/$conversationId')({
  loader: async ({ params, abortController }) => {
    const chat = await getAppChat({
      data: params,
      signal: abortController.signal,
    }).catch((cause: unknown) => {
      if (cause instanceof Error && cause.message.startsWith('NOT_FOUND:')) return null
      throw cause
    })

    if (!chat) throw notFound()
    return chat
  },

  head: ({ loaderData }) => ({
    meta: [{ title: loaderData ? `${firstUserMessage(loaderData) ?? 'Chat'} — Chats de IA` : 'Chat' }],
  }),

  component: ChatDetailScreen,
})

/**
 * El chat, leído tal cual se escribió. No hay columna `title` en el dominio
 * — ver `~/lib/chats` — así que el título de la pantalla es el primer
 * mensaje del usuario, vía `firstUserMessage`.
 */
function ChatDetailScreen() {
  const chat = Route.useLoaderData()
  const title = firstUserMessage(chat)

  return (
    <>
      <Link
        to="/chats"
        className="mb-3 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Chats de IA
      </Link>

      <PageHeader
        title={title ?? 'Chat sin mensajes'}
        subtitle={`${CHAT_TYPE_LABELS[chat.type]} · iniciado ${formatDate(chat.startedAt)}`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <Card className="mb-4">
        <CardContent className="pt-6">
          <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Usuario">
              <Link
                to="/usuarios/$userId"
                params={{ userId: chat.userId }}
                className="rounded text-sm font-medium outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {chat.userName ?? chat.userEmail}
              </Link>
              {chat.userName ? (
                <div className="text-xs text-muted-foreground">{chat.userEmail}</div>
              ) : null}
            </Field>

            <Field label="Vehículo">
              {chat.type === 'diagnostico' && chat.vehiclePlate ? (
                <div className="flex items-center gap-1.5 text-sm">
                  <Car className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="font-mono font-semibold tracking-wide">{chat.vehiclePlate}</span>
                  <span className="text-muted-foreground">
                    {chat.vehicleBrand} {chat.vehicleModel} {chat.vehicleYear}
                  </span>
                </div>
              ) : (
                <span className="text-sm text-muted-foreground/70">
                  {chat.type === 'diagnostico' ? 'auto no encontrado' : 'chat general, sin auto'}
                </span>
              )}
            </Field>

            <Field label="Estado">
              <Badge
                variant="outline"
                className={
                  chat.status === 'active'
                    ? 'border-status-green/20 bg-status-green-bg text-status-green'
                    : 'border-border bg-secondary text-muted-foreground'
                }
              >
                {CONVERSATION_STATUS_LABELS[chat.status] ?? chat.status}
              </Badge>
            </Field>

            <Field label="Mensajes">
              <span className="text-sm tabular-nums">
                {formatInt(chat.messages.filter((m) => m.author === 'user').length)} del usuario ·{' '}
                {formatInt(chat.messages.filter((m) => m.author === 'ai').length)} de la IA
              </span>
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {chat.messages.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              Esta conversación no tiene ningún mensaje. Se creó y quedó ahí — pasa en{' '}
              {/* 48 de 70 al relevar `~/lib/chats`; no es un caso raro, es la mayoría. */}
              la mayoría de los chats de la base.
            </p>
          ) : (
            <ol className="space-y-4">
              {chat.messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </>
  )
}

function MessageBubble({ message: m }: { message: ChatMessage }) {
  const isAi = m.author === 'ai'

  return (
    <li className={cn('flex gap-3', isAi ? 'flex-row' : 'flex-row-reverse')}>
      <div
        className={cn(
          'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border',
          isAi ? 'border-brand/25 bg-brand-soft text-brand' : 'border-border bg-secondary text-muted-foreground',
        )}
        aria-hidden
      >
        {isAi ? <Bot className="size-3.5" /> : <User className="size-3.5" />}
      </div>

      <div className={cn('min-w-0 max-w-[75%]', isAi ? 'text-left' : 'text-right')}>
        <div
          className={cn(
            'inline-block whitespace-pre-wrap rounded-lg border px-3 py-2 text-left text-sm leading-relaxed',
            isAi ? 'border-border bg-secondary' : 'border-brand/20 bg-brand-soft',
          )}
        >
          {m.content}
        </div>
        <div
          className={cn(
            'mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground',
            isAi ? 'justify-start' : 'justify-end',
          )}
        >
          <span className="tabular-nums">{formatDate(m.sentAt)}</span>
          {isAi && m.model ? (
            <>
              <Dot />
              <code className="font-mono">{m.model}</code>
            </>
          ) : null}
          {isAi && (m.promptTokens !== null || m.completionTokens !== null) ? (
            <>
              <Dot />
              <span className="tabular-nums" title="prompt / completion tokens">
                {formatInt(m.promptTokens ?? 0)} / {formatInt(m.completionTokens ?? 0)} tokens
              </span>
            </>
          ) : null}
        </div>
      </div>
    </li>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div>{children}</div>
    </div>
  )
}

function Dot() {
  return (
    <span className="text-muted-foreground/40" aria-hidden>
      ·
    </span>
  )
}
