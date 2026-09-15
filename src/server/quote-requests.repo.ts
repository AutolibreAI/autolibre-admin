import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import {
  QUOTE_UNCONTACTED_AFTER_HOURS,
  type AddQuoteRequestInternalNoteInput,
  type CloseQuoteRequestInput,
  type MarkQuoteRequestAnsweredInput,
  type MarkQuoteRequestContactedInput,
  type QuoteRequestWriteResult,
  type QuoteRequestDetail,
  type QuoteRequestListItem,
  type QuoteRequestSearch,
  type QuoteRequestStatusSummary,
  type QuoteRequestsAvailability,
  type QuoteSortKey,
} from '~/lib/quote-requests'

/**
 * Pedidos de presupuesto.
 *
 * ── Las escrituras son SÓLO llamadas a los SP de `ops` (migración 011) ──────
 *
 * Contactado / respondido / cerrar / agregar nota: el backend no expone un
 * endpoint con `AdminGuard` en `quotes/`, así que el panel llama a
 * `ops.mark_quote_request_contacted` y compañía con el actor de la sesión
 * (`.claude/rules/ops-write-actions.md`). La guarda de estado, el `FOR UPDATE`
 * y la fila de `ops.action_log` viven adentro del SP. Si aparece un
 * `UPDATE quote_requests` acá, está mal.
 *
 * ── Columnas explícitas, nunca `select qr.*` ───────────────────────────────
 *
 * Misma disciplina que `DrizzleQuoteRequestReader` del backend: lo que no está
 * nombrado no sale de Postgres. Acá además importa por la disponibilidad — la
 * lista de columnas que se LEEN es la misma que `quoteRequestsAvailability()`
 * verifica que existan.
 */

const toInt = (v: unknown): number => Number(v ?? 0)
const toIntOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
/**
 * `numeric` llega como STRING desde `pg`. `Number()` directo convertiría `null`
 * en `0`, y acá `null` ("no declaró monto") no es `$0`. Mismo par que
 * `chats.repo.ts`.
 */
const toNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const toIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v)

// ── Disponibilidad ─────────────────────────────────────────────────────────

/**
 * Toda columna de `quote_requests` que este repo lee. Si falta una, el SELECT
 * explota — así que se verifica ANTES de correrlo. Las que se agregaron en la
 * migración 0093 del backend son las que en la práctica pueden faltar
 * (`public_number`, `close_reason_code`, `cancellation_*`, `proposals_count`,
 * `user_outcome*`); el resto se lista igual porque el chequeo es "¿corre el
 * SELECT?", no "¿qué migración hay?".
 */
const READ_COLUMNS = [
  'id',
  'public_number',
  'channel',
  'user_id',
  'contact_name',
  'contact_phone',
  'contact_email',
  'plate',
  'vehicle_id',
  'description',
  'declared_amount',
  'status',
  'contacted_at',
  'answered_at',
  'closed_at',
  'proposals_count',
  'close_reason_code',
  'closed_reason',
  'cancellation_reason',
  'cancellation_comment',
  'outcome',
  'outcome_note',
  'user_outcome',
  'user_outcome_at',
  'internal_notes',
  'raw_submission',
  'created_at',
  'updated_at',
] as const

/**
 * ¿Existe la tabla, y con todas las columnas que se leen?
 *
 * Existe porque la pantalla se escribió ANTES de que el flujo llegue a
 * producción: al 2026-09-14 `to_regclass('public.quote_requests')` es `NULL`
 * en producción. Sin este guard, `/leads/pedidos` ahí sería un 500 — y `pg`
 * tira el error en la PRIMERA consulta, no al cargar el módulo, así que ni el
 * typecheck ni el build lo ven.
 *
 * `to_regclass` y no `select … from quote_requests limit 0` con try/catch: un
 * error de relación inexistente dentro de una transacción la aborta, y un
 * catch que se traga errores de SQL termina tragándose también los reales.
 */
export async function quoteRequestsAvailability(
  opts: { signal?: AbortSignal } = {},
): Promise<QuoteRequestsAvailability> {
  void opts.signal

  const row = await sqlOne<{ has_table: boolean; missing: Array<string> | null }>(
    `select
       to_regclass('public.quote_requests') is not null as has_table,
       (select array_agg(c.col order by c.ord)
          from unnest($1::text[]) with ordinality as c(col, ord)
         where not exists (
           select 1 from information_schema.columns ic
            where ic.table_schema = 'public'
              and ic.table_name = 'quote_requests'
              and ic.column_name = c.col)) as missing`,
    [READ_COLUMNS],
  )

  if (!row?.has_table) return { available: false, reason: 'no_table' }
  const missing = row.missing ?? []
  if (missing.length > 0) return { available: false, reason: 'missing_0093', missingColumns: missing }
  return { available: true }
}

// ── El SELECT compartido por listado y detalle ─────────────────────────────

/**
 * "Sin contactar": abierto, sin `contacted_at`, más viejo que el umbral. Una
 * sola definición para la columna del listado y la tarjeta del resumen — si
 * divergen, la tarjeta dice 3 y el chip filtra 2.
 *
 * El umbral entra por parámetro (`make_interval`), no interpolado: mismo
 * criterio que los umbrales de `ops.repo.ts`.
 */
const uncontactedPredicate = (alias: string, param: string) =>
  `(${alias}status <> 'closed' and ${alias}contacted_at is null
    and ${alias}created_at < now() - make_interval(hours => ${param}::int))`

/**
 * ── LEFT en las cuatro patas ───────────────────────────────────────────────
 *
 * `user_id` es nullable (web y WhatsApp no tienen cuenta, y un POST público con
 * `channel = app` tampoco): un `JOIN` a `users` haría desaparecer esos pedidos.
 * `vehicle_id` también es nullable (lo vincula el operador, a veces nunca), y
 * `vehicles` apunta al SPEC, no al catálogo — dos saltos, y la FK del spec
 * garantiza el spec, no el catálogo. Misma trampa que `chats.md` y
 * `vehicle-manuals.md` (trampa 3).
 *
 * ── `vehicle_owner_mismatch` sólo con los dos lados ────────────────────────
 *
 * El operador puede vincular un vehículo de OTRO usuario (o archivado). Eso se
 * marca, no se esconde. Pero sin cuenta en el pedido (`user_id` NULL) no hay
 * contra qué comparar: un pedido de WhatsApp con auto vinculado no es un
 * mismatch, es lo normal.
 *
 * ── Tiempos en minutos, contra un solo reloj ───────────────────────────────
 *
 * `floor(extract(epoch …) / 60)::int`. Se castea en SQL porque `extract`
 * devuelve `numeric` y `pg` lo manda como string.
 */
const SELECT_COLUMNS = `
  qr.id,
  qr.public_number,
  qr.created_at,
  floor(extract(epoch from (now() - qr.created_at)) / 3600)::int as age_hours,
  qr.status::text as status,
  qr.channel::text as channel,
  qr.contact_name,
  qr.contact_phone,
  qr.contact_email,
  qr.user_id,
  u.email as user_email,
  u.name as user_name,
  qr.plate,
  qr.vehicle_id,
  v.plate as vehicle_plate,
  v.archived as vehicle_archived,
  nullif(concat_ws(' ', vc.brand, vc.model, vc.trim, vc.year), '') as catalog_label,
  (qr.user_id is not null and v.id is not null
    and v.user_id is distinct from qr.user_id) as vehicle_owner_mismatch,
  -- Normalizadas: la persona tipea "ab 123 cd", el vehiculo guarda "AB123CD".
  coalesce(v.id is not null
    and upper(regexp_replace(qr.plate, '[^A-Za-z0-9]', '', 'g'))
     <> upper(regexp_replace(coalesce(v.plate, ''), '[^A-Za-z0-9]', '', 'g')), false) as plate_mismatch,
  qr.description,
  qr.declared_amount,
  qr.proposals_count,
  qr.contacted_at,
  qr.answered_at,
  qr.closed_at,
  floor(extract(epoch from (qr.contacted_at - qr.created_at)) / 60)::int as minutes_to_contact,
  floor(extract(epoch from (qr.answered_at - qr.created_at)) / 60)::int as minutes_to_answer,
  qr.close_reason_code::text as close_reason_code,
  qr.cancellation_reason::text as cancellation_reason,
  qr.outcome::text as outcome,
  qr.user_outcome::text as user_outcome,
  -- Lineas no vacias del log. chr(10)/chr(13) y no escapes: el SQL vive en un
  -- template literal de JS y un backslash ahi es una trampa de doble escape.
  (select count(*)::int
     from regexp_split_to_table(coalesce(qr.internal_notes, ''), chr(10)) as l(line)
    where btrim(replace(l.line, chr(13), '')) <> '') as note_count,
  ${uncontactedPredicate('qr.', '$1')} as uncontacted
`

const FROM_JOINS = `
  from quote_requests qr
  left join users u on u.id = qr.user_id
  left join vehicles v on v.id = qr.vehicle_id
  left join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
  left join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
`

interface ListRow {
  id: string
  public_number: number | string
  created_at: Date | string
  age_hours: number | string
  status: string
  channel: string
  contact_name: string | null
  contact_phone: string
  contact_email: string | null
  user_id: string | null
  user_email: string | null
  user_name: string | null
  plate: string
  vehicle_id: string | null
  vehicle_plate: string | null
  vehicle_archived: boolean | null
  catalog_label: string | null
  vehicle_owner_mismatch: boolean
  plate_mismatch: boolean
  description: string
  declared_amount: string | number | null
  proposals_count: number | string | null
  contacted_at: Date | string | null
  answered_at: Date | string | null
  closed_at: Date | string | null
  minutes_to_contact: number | string | null
  minutes_to_answer: number | string | null
  close_reason_code: string | null
  cancellation_reason: string | null
  outcome: string | null
  user_outcome: string | null
  note_count: number | string
  uncontacted: boolean
}

/** Campo por campo, nunca un spread de la fila — mismo criterio que `mapCensus`. */
function mapListRow(r: ListRow): QuoteRequestListItem {
  return {
    id: r.id,
    publicNumber: toInt(r.public_number),
    createdAt: toIso(r.created_at) ?? '',
    ageHours: toInt(r.age_hours),
    status: r.status,
    channel: r.channel,
    contactName: r.contact_name,
    contactPhone: r.contact_phone,
    contactEmail: r.contact_email,
    userId: r.user_id,
    userEmail: r.user_email,
    userName: r.user_name,
    plate: r.plate,
    vehicleId: r.vehicle_id,
    vehiclePlate: r.vehicle_plate,
    vehicleArchived: r.vehicle_archived,
    catalogLabel: r.catalog_label,
    vehicleOwnerMismatch: r.vehicle_owner_mismatch,
    plateMismatch: r.plate_mismatch,
    description: r.description,
    declaredAmount: toNum(r.declared_amount),
    proposalsCount: toIntOrNull(r.proposals_count),
    contactedAt: toIso(r.contacted_at),
    answeredAt: toIso(r.answered_at),
    closedAt: toIso(r.closed_at),
    minutesToContact: toIntOrNull(r.minutes_to_contact),
    minutesToAnswer: toIntOrNull(r.minutes_to_answer),
    closeReasonCode: r.close_reason_code,
    cancellationReason: r.cancellation_reason,
    outcome: r.outcome,
    userOutcome: r.user_outcome,
    noteCount: toInt(r.note_count),
    uncontacted: r.uncontacted,
  }
}

// ── Listado ──────────────────────────────────────────────────────────────────

/**
 * Mapa cerrado `QuoteSortKey → expresión SQL` sobre los alias del envoltorio.
 * Es lo que hace seguro interpolar columna y `dir` en el `ORDER BY` — mismo
 * patrón que `SORT_COLUMNS` de `fines.repo.ts`.
 *
 * `status` ordena por el RECORRIDO (recibido → cerrado), no alfabético: "answered"
 * antes que "closed" y "contacted" antes que "received" no le dice nada a nadie.
 * Un valor que el backend agregue da `array_position = NULL` y va al final.
 */
const SORT_COLUMNS: Record<QuoteSortKey, string> = {
  createdAt: 'created_at',
  code: 'public_number',
  status: `array_position(array['received','contacted','answered','closed']::text[], status)`,
  channel: 'channel',
  contact: 'lower(coalesce(contact_name, contact_phone))',
  account: 'user_email',
  plate: 'plate',
  declaredAmount: 'declared_amount',
  proposals: 'proposals_count',
  toContact: 'minutes_to_contact',
  toAnswer: 'minutes_to_answer',
  notes: 'note_count',
}

/**
 * ── Envuelto en `select * from (...) s` ────────────────────────────────────
 *
 * `note_count`, `uncontacted`, los tiempos y los flags de vehículo son
 * expresiones del SELECT; `q` además busca sobre `user_email` y
 * `vehicle_plate`, que salen de los joins. Todos los filtros van en el `where`
 * de AFUERA, igual que `chats.repo.ts`.
 *
 * `$1` es SIEMPRE el umbral de "sin contactar" (lo usa `SELECT_COLUMNS`); los
 * filtros empujan sus parámetros después.
 *
 * Corta en 500 y no pagina — mismo criterio que `/usuarios`: si molesta, el
 * arreglo es buscar mejor.
 */
export async function listQuoteRequests(
  search: QuoteRequestSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<QuoteRequestListItem>> {
  void opts.signal

  const params: Array<unknown> = [QUOTE_UNCONTACTED_AFTER_HOURS]
  const where: Array<string> = []

  if (search.q) {
    params.push(`%${search.q}%`)
    const p = `$${params.length}`
    const ors = [
      `('AL-' || public_number) ilike ${p}`,
      `plate ilike ${p}`,
      `coalesce(vehicle_plate, '') ilike ${p}`,
      `contact_phone ilike ${p}`,
      `coalesce(contact_email, '') ilike ${p}`,
      `coalesce(contact_name, '') ilike ${p}`,
      `coalesce(user_email, '') ilike ${p}`,
      `description ilike ${p}`,
    ]
    // El teléfono se guarda canónico (`5491125120472`) y el operador lo tipea
    // como lo dicta la persona ("11 2512-0472"). Se compara sólo por dígitos.
    const digits = search.q.replace(/\D/g, '')
    if (digits.length >= 3) {
      params.push(`%${digits}%`)
      ors.push(`contact_phone like $${params.length}`)
    }
    where.push(`(${ors.join(' or ')})`)
  }

  if (search.quoteStatus === 'open') {
    where.push(`status <> 'closed'`)
  } else if (search.quoteStatus === 'cancelled_by_user') {
    where.push(`close_reason_code = 'cancelled_by_user'`)
  } else if (search.quoteStatus !== 'all') {
    params.push(search.quoteStatus)
    where.push(`status = $${params.length}`)
  }

  if (search.quoteChannel !== 'all') {
    params.push(search.quoteChannel)
    where.push(`channel = $${params.length}`)
  }

  if (search.quoteOutcome === 'unasked') {
    where.push('outcome is null')
  } else if (search.quoteOutcome !== 'all') {
    params.push(search.quoteOutcome)
    where.push(`outcome = $${params.length}`)
  }

  if (search.quoteUncontacted) where.push('uncontacted')

  const rows = await sql<ListRow>(
    `
    select * from (
      select ${SELECT_COLUMNS}
      ${FROM_JOINS}
    ) s
    ${where.length ? `where ${where.join(' and ')}` : ''}
    order by ${SORT_COLUMNS[search.sort]} ${search.dir} nulls last, created_at, id
    limit 500
    `,
    params,
  )

  return rows.map(mapListRow)
}

// ── Resumen ─────────────────────────────────────────────────────────────────

/**
 * El panorama, SIN los filtros del listado: los cuatro estados siempre, aunque
 * sean cero — mismo criterio que las tarjetas de `/leads/seguros` y las de cola
 * de `/operacion`. Una sola sentencia, un solo `now()`.
 *
 * `cancelled_by_user` se cuenta aparte porque `closed` mezcla dos cosas muy
 * distintas: el operador cerró el caso, o la persona se fue sola.
 */
export async function quoteRequestStatusSummary(
  opts: { signal?: AbortSignal } = {},
): Promise<QuoteRequestStatusSummary> {
  void opts.signal

  const row = await sqlOne<{
    total: number | string
    received: number | string
    contacted: number | string
    answered: number | string
    closed: number | string
    cancelled_by_user: number | string
    uncontacted: number | string
  }>(
    `select
       count(*)::int as total,
       count(*) filter (where status = 'received')::int as received,
       count(*) filter (where status = 'contacted')::int as contacted,
       count(*) filter (where status = 'answered')::int as answered,
       count(*) filter (where status = 'closed')::int as closed,
       count(*) filter (where close_reason_code = 'cancelled_by_user')::int as cancelled_by_user,
       count(*) filter (where ${uncontactedPredicate('', '$1')})::int as uncontacted
     from quote_requests`,
    [QUOTE_UNCONTACTED_AFTER_HOURS],
  )

  return {
    total: toInt(row?.total),
    byStatus: {
      received: toInt(row?.received),
      contacted: toInt(row?.contacted),
      answered: toInt(row?.answered),
      closed: toInt(row?.closed),
    },
    cancelledByUser: toInt(row?.cancelled_by_user),
    uncontacted: toInt(row?.uncontacted),
  }
}

// ── Detalle ─────────────────────────────────────────────────────────────────

interface DetailRow extends ListRow {
  updated_at: Date | string
  vehicle_owner_id: string | null
  vehicle_owner_email: string | null
  user_outcome_at: Date | string | null
  cancellation_comment: string | null
  outcome_note: string | null
  closed_reason: string | null
  internal_notes: string | null
  raw_submission: unknown
}

/**
 * El pedido entero. Mismo SELECT que el listado (una sola definición de los
 * flags y los tiempos) más lo que el listado no necesita: el texto largo, el
 * `raw_submission` y el DUEÑO del vehículo vinculado — que es lo que convierte
 * `vehicle_owner_mismatch` de un flag en algo que se puede ir a mirar.
 */
export async function findQuoteRequestDetail(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<QuoteRequestDetail | null> {
  void opts.signal

  const r = await sqlOne<DetailRow>(
    `select ${SELECT_COLUMNS},
            qr.updated_at,
            v.user_id as vehicle_owner_id,
            vu.email as vehicle_owner_email,
            qr.user_outcome_at,
            qr.cancellation_comment,
            qr.outcome_note,
            qr.closed_reason,
            qr.internal_notes,
            qr.raw_submission
     ${FROM_JOINS}
     left join users vu on vu.id = v.user_id
     where qr.id = $2`,
    [QUOTE_UNCONTACTED_AFTER_HOURS, id],
  )
  if (!r) return null

  return {
    ...mapListRow(r),
    updatedAt: toIso(r.updated_at) ?? '',
    vehicleOwnerId: r.vehicle_owner_id,
    vehicleOwnerEmail: r.vehicle_owner_email,
    userOutcomeAt: toIso(r.user_outcome_at),
    cancellationComment: r.cancellation_comment,
    outcomeNote: r.outcome_note,
    closedReason: r.closed_reason,
    internalNotes: r.internal_notes,
    // `pg` ya parsea `jsonb` a objeto. Se re-serializa acá, en el servidor, para
    // que viaje como string: un `unknown` arbitrario no es un tipo de retorno
    // que el server function pueda garantizar serializable.
    rawSubmissionJson: JSON.stringify(r.raw_submission ?? null, null, 2),
  }
}

// ── Escrituras: los SP de `ops` de la migración 011 ─────────────────────────
//
// Parámetros NOMBRADOS, igual que `setPartnerProfile`: la llamada no depende
// del orden de la firma, y `close_quote_request` tiene cuatro `text` opcionales
// seguidos que por posición se cruzan sin que nada avise.
//
// Este SQL está copiado LITERAL en el bloque de integración de
// `migrations/011_ops_pedidos_de_presupuesto.test.sql`, con `PREPARE` sin tipos
// —como los manda `pg`—. Si se toca uno, se toca el otro.
//
// Ninguna escribe `quote_requests` desde acá: la guarda de estado, el lock y la
// fila de `ops.action_log` son del SP, en la misma sentencia.

/** `''` y ausente viajan como NULL: el SP trata `''` igual, pero `p_note` no lo normaliza. */
const blankToNull = (v: string | undefined): string | null => (v === undefined || v === '' ? null : v)

function toWriteResult(q: { id?: unknown; status?: unknown } | null | undefined, id: string): QuoteRequestWriteResult {
  if (!q || typeof q.id !== 'string') throw new Error(`QUOTE_REQUEST_NOT_FOUND:${id}`)
  return { id: q.id, status: String(q.status) }
}

type SpRow = { q: { id?: unknown; status?: unknown } | null }

/** received → contacted. */
export async function markQuoteRequestContacted(
  input: MarkQuoteRequestContactedInput,
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<QuoteRequestWriteResult> {
  void opts.signal

  const row = await sqlOne<SpRow>(
    `SELECT ops.mark_quote_request_contacted(
       p_quote_request_id => $1,
       p_actor_id         => $2,
       p_note             => $3
     ) AS q`,
    [input.quoteRequestId, actorId, blankToNull(input.auditNote)],
  )
  return toWriteResult(row?.q, input.quoteRequestId)
}

/** contacted → answered, con la cantidad de propuestas (0 es válido). */
export async function markQuoteRequestAnswered(
  input: MarkQuoteRequestAnsweredInput,
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<QuoteRequestWriteResult> {
  void opts.signal

  const row = await sqlOne<SpRow>(
    `SELECT ops.mark_quote_request_answered(
       p_quote_request_id => $1,
       p_proposals_count  => $2,
       p_actor_id         => $3,
       p_note             => $4
     ) AS q`,
    [input.quoteRequestId, input.proposalsCount, actorId, blankToNull(input.auditNote)],
  )
  return toWriteResult(row?.q, input.quoteRequestId)
}

/**
 * Abierto → closed. `outcome` ausente viaja NULL ("no se preguntó"), nunca
 * `no_response`.
 */
export async function closeQuoteRequest(
  input: CloseQuoteRequestInput,
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<QuoteRequestWriteResult> {
  void opts.signal

  const row = await sqlOne<SpRow>(
    `SELECT ops.close_quote_request(
       p_quote_request_id  => $1,
       p_close_reason_code => $2,
       p_actor_id          => $3,
       p_closed_reason     => $4,
       p_outcome           => $5,
       p_outcome_note      => $6,
       p_note              => $7
     ) AS q`,
    [
      input.quoteRequestId,
      input.closeReasonCode,
      actorId,
      blankToNull(input.closedReason),
      input.outcome ?? null,
      blankToNull(input.outcomeNote),
      blankToNull(input.auditNote),
    ],
  )
  return toWriteResult(row?.q, input.quoteRequestId)
}

/** Agrega una línea fechada (hora de Buenos Aires) al hilo de `internal_notes`. */
export async function addQuoteRequestInternalNote(
  input: AddQuoteRequestInternalNoteInput,
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<QuoteRequestWriteResult> {
  void opts.signal

  const row = await sqlOne<SpRow>(
    `SELECT ops.add_quote_request_internal_note(
       p_quote_request_id => $1,
       p_text             => $2,
       p_actor_id         => $3
     ) AS q`,
    [input.quoteRequestId, input.text, actorId],
  )
  return toWriteResult(row?.q, input.quoteRequestId)
}
