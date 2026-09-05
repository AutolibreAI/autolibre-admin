import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import type {
  ChatDetail,
  ChatListItem,
  ChatMessage,
  ChatSearch,
  ChatSortKey,
} from '~/lib/chats'

/**
 * Chats de IA — solo lectura, igual que `users.repo.ts` y por el mismo
 * motivo: `conversations`/`conversation_messages` son dominio del backend
 * (`assistant/`), este repo sólo consulta.
 *
 * El listado además LEE `ops.v_ai_usage_costed` para el costo por chat. Sigue
 * siendo solo lectura, y sigue el mismo criterio que `ops.repo.ts`: el SQL que
 * cruza a `ops` vive en el repo, no en una función. El costeo NO se
 * reimplementa acá — la vista es la única definición.
 */

const toInt = (value: unknown): number => Number(value ?? 0)

/**
 * Para PLATA: preserva el `null`. `pg` devuelve `numeric` como string, así que
 * `Number()` directo daría `NaN` sobre null y `0` sobre "0" — y acá `null`
 * ("no sabemos el costo") NO es `0` ("costó cero"). Mismo par `toInt`/`toNum`
 * que `ai-usage.repo.ts`.
 */
const toNum = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)

const toIso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : String(value)

const toIsoRequired = (value: unknown): string => toIso(value) ?? ''

// ── Listado ──────────────────────────────────────────────────────────────────

interface ChatListRow {
  id: string
  user_id: string
  user_email: string
  user_name: string | null
  vehicle_id: string | null
  vehicle_plate: string | null
  vehicle_brand: string | null
  vehicle_model: string | null
  vehicle_year: number | string | null
  model: string | null
  user_message_count: number | string
  ai_message_count: number | string
  cost_usd: string | null
  unpriced_messages: number | string
  title: string | null
  status: string
  started_at: Date | string
}

/**
 * Mapa cerrado `ChatSortKey → expresión SQL`, mismo patrón que
 * `SORT_COLUMNS` en `users.repo.ts` — seguro de interpolar porque sale de un
 * `Record` que los tipos obligan a cubrir, nunca de texto suelto.
 */
const SORT_COLUMNS: Record<ChatSortKey, string> = {
  user: 'user_email',
  // Orden booleano: los de diagnóstico (vehicle_id no nulo) primero en desc.
  type: '(vehicle_id is not null)',
  vehicle: 'vehicle_plate',
  model: 'model',
  userMessages: 'user_message_count',
  aiMessages: 'ai_message_count',
  cost: 'cost_usd',
  title: 'title',
  startedAt: 'started_at',
}

/**
 * El listado. Envuelto en `select * from (...) s`, mismo motivo que
 * `listUsers`: `model`, los contadores de mensajes y `title` son subconsultas
 * escalares del SELECT, y el filtro de texto (`q`) necesita buscar sobre
 * `title` y `vehicle_plate` — que no existen todavía en el nivel de `where`
 * interno, porque son el resultado de esas subconsultas.
 *
 * `vehicle_*` sale de un LEFT JOIN encadenado (vehículo → spec → catálogo),
 * los tres LEFT porque `c.vehicle_id` es nullable: un chat general no tiene
 * auto, y un INNER acá lo haría desaparecer del listado en vez de mostrarlo
 * con las columnas de auto vacías.
 */
export async function listChats(
  search: ChatSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<ChatListItem>> {
  void opts.signal

  const params: Array<unknown> = []
  const outerWhere: Array<string> = []

  if (search.q) {
    params.push(`%${search.q}%`)
    outerWhere.push(
      `(user_email ilike $${params.length} or coalesce(user_name, '') ilike $${params.length} ` +
        `or coalesce(vehicle_plate, '') ilike $${params.length} or coalesce(title, '') ilike $${params.length})`,
    )
  }

  if (search.type === 'diagnostico') {
    outerWhere.push('vehicle_id is not null')
  } else if (search.type === 'general') {
    outerWhere.push('vehicle_id is null')
  }

  if (search.model) {
    params.push(search.model)
    outerWhere.push(`model = $${params.length}`)
  }

  if (search.messages === 'withMessages') {
    outerWhere.push('(user_message_count > 0 or ai_message_count > 0)')
  } else if (search.messages === 'noAiReply') {
    outerWhere.push('user_message_count > 0 and ai_message_count = 0')
  } else if (search.messages === 'empty') {
    outerWhere.push('user_message_count = 0 and ai_message_count = 0')
  }

  const sortColumn = SORT_COLUMNS[search.sort]

  const rows = await sql<ChatListRow>(
    `
    select * from (
      select
        c.id,
        c.user_id,
        u.email as user_email,
        u.name as user_name,
        c.vehicle_id,
        v.plate as vehicle_plate,
        vc.brand as vehicle_brand,
        vc.model as vehicle_model,
        vc.year as vehicle_year,
        c.status,
        c.started_at,
        -- El modelo de la respuesta MAS RECIENTE. author = 'ai' siempre
        -- trae model; author = 'user' siempre lo trae null (verificado:
        -- 61/61 y 0/61) -- no hace falta filtrar por null ademas de por autor.
        (select m.model from conversation_messages m
           where m.conversation_id = c.id and m.author = 'ai'
           order by m.sent_at desc limit 1) as model,
        (select count(*)::int from conversation_messages m
           where m.conversation_id = c.id and m.author = 'user') as user_message_count,
        (select count(*)::int from conversation_messages m
           where m.conversation_id = c.id and m.author = 'ai') as ai_message_count,
        -- El "título": el primer mensaje del usuario, tal cual — no existe
        -- una columna de título en el dominio.
        (select m.content from conversation_messages m
           where m.conversation_id = c.id and m.author = 'user'
           order by m.sent_at asc limit 1) as title,
        -- Costo de IA de la conversación entera: la suma de total_usd de sus
        -- mensajes de IA, ya costeados por ops.v_ai_usage_costed (uso × tarifa
        -- vigente al MOMENTO de cada llamada). Es la MISMA fuente que
        -- /ai-costos — el costeo se define una sola vez, en la vista, no acá.
        --
        -- La vista expone event_id (= conversation_messages.id) pero no
        -- conversation_id, así que se mapea con un join de vuelta a
        -- conversation_messages por PK. Barato, y no toca el schema de ops.
        --
        -- sum() saltea los NULL: un modelo sin tarifa no rompe el total, pero
        -- tampoco lo infla — queda contado aparte en unpriced_messages. Si NO
        -- hay ningun mensaje de IA medido (o todos son unpriced), sum() da NULL,
        -- que es lo correcto: "no sabemos", nunca "costo 0". Por eso el mapeo
        -- usa toNum y no toInt.
        (select sum(vuc.total_usd)
           from ops.v_ai_usage_costed vuc
           join conversation_messages cm on cm.id = vuc.event_id
          where vuc.surface = 'assistant' and cm.conversation_id = c.id) as cost_usd,
        (select count(*)::int
           from ops.v_ai_usage_costed vuc
           join conversation_messages cm on cm.id = vuc.event_id
          where vuc.surface = 'assistant' and cm.conversation_id = c.id
            and vuc.unpriced) as unpriced_messages
      from conversations c
      join users u on u.id = c.user_id
      left join vehicles v on v.id = c.vehicle_id
      left join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
      left join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
    ) s
    ${outerWhere.length ? `where ${outerWhere.join(' and ')}` : ''}
    order by ${sortColumn} ${search.dir} nulls last, id
    limit 500
    `,
    params,
  )

  return rows.map(
    (r): ChatListItem => ({
      id: r.id,
      userId: r.user_id,
      userEmail: r.user_email,
      userName: r.user_name,
      type: r.vehicle_id ? 'diagnostico' : 'general',
      vehicleId: r.vehicle_id,
      vehiclePlate: r.vehicle_plate,
      vehicleBrand: r.vehicle_brand,
      vehicleModel: r.vehicle_model,
      vehicleYear: r.vehicle_year === null ? null : toInt(r.vehicle_year),
      model: r.model,
      userMessageCount: toInt(r.user_message_count),
      aiMessageCount: toInt(r.ai_message_count),
      costUsd: toNum(r.cost_usd),
      unpricedMessages: toInt(r.unpriced_messages),
      title: r.title,
      status: r.status,
      startedAt: toIsoRequired(r.started_at),
    }),
  )
}

/**
 * Los modelos que realmente aparecen en la base, para el chip de filtro. Nunca
 * hardcodeado — un modelo nuevo aparece acá solo, sin tocar código, mismo
 * criterio que `scanner_type`/firmware en `scanners.repo.ts`: las columnas
 * (acá, las opciones del filtro) son datos, no vocabulario nuestro.
 */
export async function listDistinctChatModels(
  opts: { signal?: AbortSignal } = {},
): Promise<Array<string>> {
  void opts.signal

  const rows = await sql<{ model: string }>(
    `select distinct model from conversation_messages where model is not null order by model`,
  )
  return rows.map((r) => r.model)
}

// ── Detalle ──────────────────────────────────────────────────────────────────

interface ChatRow {
  id: string
  user_id: string
  user_email: string
  user_name: string | null
  vehicle_id: string | null
  vehicle_plate: string | null
  vehicle_brand: string | null
  vehicle_model: string | null
  vehicle_year: number | string | null
  status: string
  started_at: Date | string
  created_at: Date | string
  updated_at: Date | string
}

interface MessageRow {
  id: string
  author: 'user' | 'ai'
  content: string
  model: string | null
  prompt_tokens: number | string | null
  completion_tokens: number | string | null
  sent_at: Date | string
}

/**
 * El detalle: la conversación y sus mensajes, en orden cronológico — es
 * literalmente el chat, para leerlo como se escribió.
 *
 * Dos consultas y no una: los mensajes no tienen límite razonable para traer
 * en la misma fila que la conversación (sería un `array_agg` de jsonb sin
 * necesidad), y acá no hay riesgo de fan-out que evitar con una subconsulta —
 * es una tabla aparte que se muestra aparte.
 */
export async function findChatDetail(
  conversationId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ChatDetail | null> {
  void opts.signal

  const convo = await sqlOne<ChatRow>(
    `select c.id, c.user_id, u.email as user_email, u.name as user_name,
            c.vehicle_id, v.plate as vehicle_plate,
            vc.brand as vehicle_brand, vc.model as vehicle_model, vc.year as vehicle_year,
            c.status, c.started_at, c.created_at, c.updated_at
     from conversations c
     join users u on u.id = c.user_id
     left join vehicles v on v.id = c.vehicle_id
     left join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
     left join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
     where c.id = $1`,
    [conversationId],
  )
  if (!convo) return null

  const messages = await sql<MessageRow>(
    `select id, author::text as author, content, model, prompt_tokens, completion_tokens, sent_at
     from conversation_messages
     where conversation_id = $1
     order by sent_at asc`,
    [conversationId],
  )

  return {
    id: convo.id,
    userId: convo.user_id,
    userEmail: convo.user_email,
    userName: convo.user_name,
    type: convo.vehicle_id ? 'diagnostico' : 'general',
    vehicleId: convo.vehicle_id,
    vehiclePlate: convo.vehicle_plate,
    vehicleBrand: convo.vehicle_brand,
    vehicleModel: convo.vehicle_model,
    vehicleYear: convo.vehicle_year === null ? null : toInt(convo.vehicle_year),
    status: convo.status,
    startedAt: toIsoRequired(convo.started_at),
    createdAt: toIsoRequired(convo.created_at),
    updatedAt: toIsoRequired(convo.updated_at),
    messages: messages.map(
      (m): ChatMessage => ({
        id: m.id,
        author: m.author,
        content: m.content,
        model: m.model,
        promptTokens: m.prompt_tokens === null ? null : toInt(m.prompt_tokens),
        completionTokens: m.completion_tokens === null ? null : toInt(m.completion_tokens),
        sentAt: toIsoRequired(m.sent_at),
      }),
    ),
  }
}
