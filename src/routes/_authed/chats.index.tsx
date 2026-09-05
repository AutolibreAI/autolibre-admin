import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Car, ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react'
import {
  CHAT_MESSAGE_FILTERS,
  CHAT_TYPE_FILTERS,
  CHAT_TYPE_LABELS,
  chatSearchSchema,
  type ChatListItem,
  type ChatMessageFilter,
  type ChatSearch,
  type ChatSortKey,
  type ChatTypeFilter,
} from '~/lib/chats'
import { listAppChatModels, listAppChats } from '~/fn/chats'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { Badge } from '~/components/ui/badge'
import { Input } from '~/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatUsd } from '~/lib/ai-usage'
import { formatDate, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

export const Route = createFileRoute('/_authed/chats/')({
  /**
   * SSR completo, mismo criterio que `/usuarios`: es una pantalla de
   * ENTRADA — `/chats?q=...` pegado en un ticket de soporte suele ser el
   * primer pintado de la sesión.
   */
  validateSearch: chatSearchSchema,
  loaderDeps: ({ search }) => search,

  /**
   * Dos consultas independientes, en paralelo: el listado y los modelos
   * disponibles para el chip de filtro. El segundo no depende del primero.
   */
  loader: async ({ deps, abortController }) => {
    const [chats, models] = await Promise.all([
      listAppChats({ data: deps, signal: abortController.signal }),
      listAppChatModels(),
    ])
    return { chats, models }
  },

  head: () => ({ meta: [{ title: 'Chats de IA — AutoLibre' }] }),
  component: ChatsList,
})

const TYPE_FILTER_LABELS: Record<ChatTypeFilter, string> = {
  all: 'Todos',
  diagnostico: 'Diagnóstico',
  general: 'General',
}

const MESSAGE_FILTER_LABELS: Record<ChatMessageFilter, string> = {
  withMessages: 'Con mensajes',
  all: 'Todos',
  noAiReply: 'Sin respuesta de IA',
  empty: 'Sin mensajes',
}

/**
 * El listado de chats de IA.
 *
 * Reemplaza el `select * from conversations c join conversation_messages m on
 * m.conversation_id = c.id where c.user_id = '...'` que hoy sería la única
 * forma de ver de qué habló un usuario con el asistente — y le agrega lo que
 * ese select no contesta solo: si es de diagnóstico o general, con qué auto,
 * con qué modelo, y cuántos mensajes mandó cada lado.
 */
function ChatsList() {
  const { chats, models } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<ChatSearch>) =>
    navigate({ search: { ...search, ...next }, replace: true })

  /**
   * "Angostado" = el operador tocó algo. El default (`withMessages` y nada
   * más) NO cuenta como filtro puesto, pero SÍ oculta las conversaciones
   * vacías — así que el subtítulo lo dice en vez de mentir con "en total".
   */
  const narrowed =
    Boolean(search.q) ||
    search.type !== 'all' ||
    (search.model?.length ?? 0) > 0 ||
    search.messages !== 'withMessages'

  return (
    <>
      <PageHeader
        title="Chats de IA"
        subtitle={
          narrowed
            ? `${formatInt(chats.length)} con este filtro`
            : `${formatInt(chats.length)} con mensajes · las conversaciones vacías se ocultan`
        }
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <div className="mb-4 flex flex-wrap items-end gap-5">
        <div className="space-y-1.5">
          <label
            htmlFor="q"
            className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            Buscar
          </label>
          <Input
            id="q"
            type="search"
            placeholder="Usuario, patente o título"
            defaultValue={search.q ?? ''}
            className="w-64"
            onChange={(e) => {
              const value = e.currentTarget.value.trim()
              setSearch({ q: value === '' ? undefined : value })
            }}
          />
        </div>

        <FilterGroup label="Tipo">
          {CHAT_TYPE_FILTERS.map((t) => (
            <Chip key={t} active={search.type === t} onClick={() => setSearch({ type: t })}>
              {TYPE_FILTER_LABELS[t]}
            </Chip>
          ))}
        </FilterGroup>

        {/*
          Data-driven: nunca hardcodeado. Si mañana aparece un modelo nuevo,
          el chip aparece solo — no hace falta tocar código.
        */}
        {models.length > 0 ? (
          <FilterGroup label="Modelo">
            <Chip active={!search.model} onClick={() => setSearch({ model: undefined })}>
              Todos
            </Chip>
            {models.map((m) => (
              <Chip key={m} active={search.model === m} onClick={() => setSearch({ model: m })}>
                {m}
              </Chip>
            ))}
          </FilterGroup>
        ) : null}

        {/*
          Tono `warn` para «Sin respuesta de IA»: es la que importa —
          alguien le escribió al asistente y se quedó sin contestar. «Sin
          mensajes» es neutro: son 48 de 70 en la base, la mayoría, no una
          falla.
        */}
        <FilterGroup label="Mensajes">
          {CHAT_MESSAGE_FILTERS.map((m) => (
            <Chip
              key={m}
              tone={m === 'noAiReply' ? 'warn' : 'brand'}
              active={search.messages === m}
              onClick={() => setSearch({ messages: m })}
            >
              {MESSAGE_FILTER_LABELS[m]}
            </Chip>
          ))}
        </FilterGroup>
      </div>

      {chats.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-6 py-16 text-center">
          <p className="text-sm font-medium">Ningún chat con este filtro</p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
            Probá con parte del email, la patente o una palabra del primer mensaje.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHeader label="Usuario" sortKey="user" search={search} />
                <SortableHeader label="Tipo" sortKey="type" search={search} />
                <SortableHeader label="Vehículo" sortKey="vehicle" search={search} />
                <SortableHeader label="Modelo" sortKey="model" search={search} />
                <SortableHeader label="Mensajes" sortKey="userMessages" search={search} align="right" />
                <SortableHeader label="Costo" sortKey="cost" search={search} align="right" />
                <SortableHeader label="Título" sortKey="title" search={search} />
                <SortableHeader label="Fecha" sortKey="startedAt" search={search} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {chats.map((c) => (
                <ChatRow key={c.id} chat={c} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {chats.length === 500 ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Cortado en 500 filas. Afiná la búsqueda — el listado no pagina a
          propósito: paginar sin buscar es hojear un padrón, y nadie encuentra a
          nadie así.
        </p>
      ) : null}
    </>
  )
}

function ChatRow({ chat: c }: { chat: ChatListItem }) {
  return (
    <TableRow>
      <TableCell>
        <Link
          to="/usuarios/$userId"
          params={{ userId: c.userId }}
          className="rounded text-sm font-medium outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {c.userName ?? c.userEmail}
        </Link>
        {c.userName ? <div className="text-xs text-muted-foreground">{c.userEmail}</div> : null}
      </TableCell>

      <TableCell>
        <Badge
          variant="outline"
          className={
            c.type === 'diagnostico'
              ? 'border-brand/25 bg-brand-soft text-brand'
              : 'border-border bg-secondary text-muted-foreground'
          }
        >
          {CHAT_TYPE_LABELS[c.type]}
        </Badge>
      </TableCell>

      <TableCell className="text-sm">
        {c.type === 'diagnostico' && c.vehiclePlate ? (
          <div className="flex items-center gap-1.5">
            <Car className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <div>
              <span className="font-mono font-medium tracking-wide">{c.vehiclePlate}</span>
              <div className="text-xs text-muted-foreground">
                {c.vehicleBrand} {c.vehicleModel} <span className="tabular-nums">{c.vehicleYear}</span>
              </div>
            </div>
          </div>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </TableCell>

      <TableCell className="text-xs">
        {c.model ? (
          <code className="rounded bg-secondary px-1 py-0.5 font-mono">{c.model}</code>
        ) : (
          <span className="text-muted-foreground/50">sin usar</span>
        )}
      </TableCell>

      <TableCell className="text-right text-sm tabular-nums">
        {/*
          Dos números, mismo criterio que «Escaneos» en /usuarios: uno solo
          escondería la asimetría. `3 · 0` es un chat donde el usuario habló
          solo — se ve distinto de `3 · 3`, y tiene que verse distinto.
        */}
        <span title="Mensajes del usuario">{formatInt(c.userMessageCount)}</span>
        <span className="text-muted-foreground"> · </span>
        <span
          className={cn(c.userMessageCount > 0 && c.aiMessageCount === 0 && 'text-status-yellow')}
          title="Mensajes de la IA"
        >
          {formatInt(c.aiMessageCount)}
        </span>
      </TableCell>

      <TableCell className="text-right text-sm tabular-nums">
        <CostCell usd={c.costUsd} unpriced={c.unpricedMessages} />
      </TableCell>

      <TableCell className="max-w-[280px] text-sm">
        {c.title ? (
          <Link
            to="/chats/$conversationId"
            params={{ conversationId: c.id }}
            className="block truncate rounded outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            title={c.title}
          >
            {c.title}
          </Link>
        ) : (
          <Link
            to="/chats/$conversationId"
            params={{ conversationId: c.id }}
            className="rounded text-xs text-muted-foreground/60 underline decoration-dotted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            sin mensajes
          </Link>
        )}
      </TableCell>

      <TableCell className="text-sm tabular-nums text-muted-foreground">
        {formatDate(c.startedAt)}
      </TableCell>
    </TableRow>
  )
}

/**
 * El costo de IA de la conversación, con la misma disciplina que `/ai-costos`:
 * el número NUNCA se muestra solo. `null` (sin mensajes de IA medidos, o todos
 * sin tarifa) rinde "—", nunca "US$ 0" — cero es un precio, null es "no
 * sabemos". Si hay mensajes sin tarifa, el costo mostrado los deja afuera y el
 * "+N" ámbar lo dice.
 */
function CostCell({ usd, unpriced }: { usd: number | null; unpriced: number }) {
  if (usd === null) {
    return unpriced > 0 ? (
      <span
        className="text-status-yellow"
        title={`${unpriced} ${unpriced === 1 ? 'mensaje' : 'mensajes'} de IA sin tarifa cargada para su modelo — no se puede costear`}
      >
        —
      </span>
    ) : (
      <span className="text-muted-foreground/50" title="Sin mensajes de IA medidos">
        —
      </span>
    )
  }

  return (
    <span
      className={cn(unpriced > 0 && 'text-status-yellow')}
      title={
        unpriced > 0
          ? `No incluye ${unpriced} ${unpriced === 1 ? 'mensaje' : 'mensajes'} de IA sin tarifa`
          : undefined
      }
    >
      {formatUsd(usd)}
      {unpriced > 0 ? <span className="text-muted-foreground"> +{unpriced}</span> : null}
    </span>
  )
}

/**
 * Los headers de orden son links, no botones — mismo patrón que `/usuarios`:
 * el orden ES la URL, navegable y compartible.
 */
function SortableHeader({
  label,
  sortKey,
  search,
  align,
}: {
  label: string
  sortKey: ChatSortKey
  search: ChatSearch
  align?: 'right'
}) {
  const active = search.sort === sortKey
  const nextDir = active && search.dir === 'asc' ? 'desc' : 'asc'

  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <Link
        to="/chats"
        search={(prev) => ({ ...prev, sort: sortKey, dir: nextDir })}
        replace
        className={cn(
          'inline-flex items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          align === 'right' && 'flex-row-reverse',
          active && 'text-foreground',
        )}
      >
        {label}
        {active ? (
          search.dir === 'asc' ? (
            <ChevronUp className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <ChevronDown className="size-3.5 shrink-0" aria-hidden />
          )
        ) : (
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground/40" aria-hidden />
        )}
      </Link>
    </TableHead>
  )
}
