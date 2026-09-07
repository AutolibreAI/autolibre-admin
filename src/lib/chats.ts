import { z } from 'zod'

/**
 * Chats de IA — `/chats`.
 *
 * Reemplaza el `select * from conversations c join conversation_messages m on
 * m.conversation_id = c.id where c.user_id = '...'` que hoy sería la única
 * forma de ver de qué habló un usuario con el asistente. No colgaba de
 * `/usuarios` porque la pregunta es la opuesta: no es "qué tiene este
 * usuario", es "qué chats hay" — con el usuario como una columna más, no como
 * el punto de entrada.
 *
 * ── `type` es derivado, no una columna ───────────────────────────────────────
 *
 * `conversations` no tiene `type`. Lo que sí tiene es `vehicle_id`, nullable,
 * y la propia definición del pedido lo dice: un chat "de diagnóstico" es el
 * que tiene un auto asociado; uno "general" es el que no. No hace falta
 * inventar una columna — la que ya existe alcanza, con el nombre correcto.
 *
 * ── `title` tampoco es una columna ───────────────────────────────────────────
 *
 * `conversations` no tiene `title`. Lo que se muestra es el CONTENIDO del
 * primer mensaje del usuario — verificado contra la base: de las 22
 * conversaciones con al menos un mensaje, las 22 arrancan con `author =
 * 'user'`, nunca con la IA. Es el mismo patrón que cualquier chat (el título
 * es lo primero que se dijo), y no inventa dominio: es un mensaje real,
 * mostrado tal cual. 48 de las 70 conversaciones de la base no tienen NINGÚN
 * mensaje — ahí no hay título que derivar, y la pantalla lo dice así, no lo
 * esconde.
 */

export type ChatType = 'diagnostico' | 'general'

export const CHAT_TYPE_LABELS: Record<ChatType, string> = {
  diagnostico: 'Diagnóstico',
  general: 'General',
}

export const CONVERSATION_STATUS_LABELS: Record<string, string> = {
  active: 'Activa',
  closed: 'Cerrada',
}

export interface ChatListItem {
  id: string
  userId: string
  userEmail: string
  userName: string | null
  type: ChatType
  vehicleId: string | null
  vehiclePlate: string | null
  vehicleBrand: string | null
  vehicleModel: string | null
  vehicleYear: number | null
  /**
   * El modelo de IA usado — de la respuesta MÁS RECIENTE. Verificado: ninguna
   * conversación de la base uso más de un modelo distinto, así que "el más
   * reciente" y "el único" coinciden hoy; el día que no coincidan, mostrar el
   * más reciente sigue siendo la lectura correcta ("con qué está respondiendo
   * ahora"). `null` cuando la IA todavía no contestó nada.
   */
  model: string | null
  userMessageCount: number
  aiMessageCount: number
  /**
   * Costo de IA de la conversación entera, en USD: la suma de
   * `ops.v_ai_usage_costed.total_usd` de sus mensajes `author = 'ai'`.
   *
   * `null` — nunca `0` — cuando no se puede saber: la conversación no tiene
   * ningún mensaje de IA medido, o TODOS sus mensajes usan un modelo sin tarifa
   * cargada. Cero es un precio; null es "no sabemos". `formatUsd(null)` rinde
   * "—". Mismo criterio que `totalUsd` en `~/lib/ai-usage`.
   */
  costUsd: number | null
  /**
   * Mensajes de IA de esta conversación cuyo modelo cayó fuera de toda vigencia
   * de precio. Viaja al lado de `costUsd` para que el número nunca se muestre
   * solo: si es > 0, el costo mostrado deja afuera esos mensajes.
   */
  unpricedMessages: number
  /** El contenido del primer mensaje del usuario, sin truncar — trunca la UI. */
  title: string | null
  status: string
  startedAt: string
}

export interface ChatMessage {
  id: string
  author: 'user' | 'ai'
  content: string
  model: string | null
  promptTokens: number | null
  completionTokens: number | null
  sentAt: string
}

export interface ChatDetail {
  id: string
  userId: string
  userEmail: string
  userName: string | null
  type: ChatType
  vehicleId: string | null
  vehiclePlate: string | null
  vehicleBrand: string | null
  vehicleModel: string | null
  vehicleYear: number | null
  status: string
  startedAt: string
  createdAt: string
  updatedAt: string
  messages: Array<ChatMessage>
}

// ── Search params ────────────────────────────────────────────────────────────

export const CHAT_TYPE_FILTERS = ['all', 'diagnostico', 'general'] as const
export type ChatTypeFilter = (typeof CHAT_TYPE_FILTERS)[number]

/**
 * "Con mensajes": la conversación tiene al menos un mensaje de cualquiera de
 * los dos lados. Es el DEFAULT — las conversaciones vacías son la mayoría de la
 * base (48 de 70 al relevar esto) y casi siempre ruido: se crean y quedan ahí.
 * Quien las quiera ve las tiene a un click, pero no son lo primero que se
 * muestra.
 *
 * "Sin respuesta de IA": mandó mensaje(s) y el asistente nunca contestó — un
 * corte real, no uno inventado. "Sin mensajes": la conversación existe
 * (`conversations` tiene la fila) y no se escribió nada, ninguno de los dos
 * lados. "Todos" incluye las vacías.
 */
export const CHAT_MESSAGE_FILTERS = ['withMessages', 'all', 'noAiReply', 'empty'] as const
export type ChatMessageFilter = (typeof CHAT_MESSAGE_FILTERS)[number]

export const CHAT_SORT_KEYS = [
  'user',
  'type',
  'vehicle',
  'model',
  'userMessages',
  'aiMessages',
  'cost',
  'title',
  'startedAt',
] as const
export type ChatSortKey = (typeof CHAT_SORT_KEYS)[number]

export const CHAT_SORT_DIRS = ['asc', 'desc'] as const
export type ChatSortDir = (typeof CHAT_SORT_DIRS)[number]

export const chatSearchSchema = z.object({
  /** Busca en usuario (email/nombre), patente del vehículo y título. */
  q: z.string().trim().max(120).optional(),
  type: z.enum(CHAT_TYPE_FILTERS).catch('all').default('all'),
  /**
   * Texto libre y no un enum: el modelo no es vocabulario nuestro, es lo que
   * `conversation_messages.model` tenga cargado. Un enum acá se desincroniza
   * el día que se agregue un modelo — mismo motivo por el que `scanners.repo`
   * no hardcodea firmwares. El listado de valores posibles se arma con los
   * datos (`listDistinctChatModels`), no con esta lista.
   */
  model: z.string().trim().max(120).optional(),
  /**
   * Default `withMessages`: las conversaciones vacías se ocultan salvo que se
   * pidan. `.catch` cae al mismo default — un `?messages=basura` de un link
   * viejo muestra el listado útil, no un error.
   */
  messages: z.enum(CHAT_MESSAGE_FILTERS).catch('withMessages').default('withMessages'),
  sort: z.enum(CHAT_SORT_KEYS).catch('startedAt').default('startedAt'),
  dir: z.enum(CHAT_SORT_DIRS).catch('desc').default('desc'),
})

export type ChatSearch = z.infer<typeof chatSearchSchema>

/**
 * El "título" del detalle: el primer mensaje del USUARIO, explícito y no por
 * posición — `chat.messages[0]` da lo mismo hoy (verificado: el primer
 * mensaje siempre es del usuario), pero buscarlo por autor no depende de que
 * ese invariante se siga cumpliendo.
 */
export function firstUserMessage(chat: ChatDetail): string | null {
  return chat.messages.find((m) => m.author === 'user')?.content ?? null
}
