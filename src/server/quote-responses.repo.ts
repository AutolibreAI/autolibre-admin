import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import type {
  AddQuoteResponseInput,
  DeleteQuoteResponseInput,
  QuoteResponse,
  ReorderQuoteResponsesInput,
  UpdateQuoteResponseInput,
} from '~/lib/quote-responses'

/**
 * Lo que contestó cada taller — `ops.quote_request_response` (migración 015).
 *
 * ── Las escrituras son SÓLO llamadas a los SP de `ops` ─────────────────────
 *
 * La tabla es nuestra, así que un `INSERT` directo desde acá "funcionaría" —
 * y sería el mismo error que en `public`: el SP escribe `ops.action_log` en la
 * MISMA sentencia, y separarlos deja el modo de falla peor posible (el cambio
 * queda y el registro de quién lo hizo no). Si aparece un
 * `INSERT INTO ops.quote_request_response` suelto, está mal.
 *
 * ── Columnas explícitas, nunca `select r.*` ────────────────────────────────
 *
 * Misma disciplina que el resto del repo.
 */

const toNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const toInt = (v: unknown): number => Number(v ?? 0)
const toIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v)

/**
 * `date` de Postgres. `pg` lo entrega como `Date` a medianoche LOCAL del
 * proceso, así que `toISOString().slice(0,10)` devuelve el día ANTERIOR si el
 * proceso corre al este de UTC — la misma trampa que `toPlainDay()` en
 * `ai-usage.repo.ts`. Se leen los componentes locales, que son los que `pg`
 * escribió.
 */
const toPlainDay = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  if (!(v instanceof Date)) return String(v).slice(0, 10)
  const y = v.getFullYear()
  const m = String(v.getMonth() + 1).padStart(2, '0')
  const d = String(v.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// ── Disponibilidad ─────────────────────────────────────────────────────────

/**
 * ¿Está aplicada la 015 en esta base?
 *
 * Mismo guard que `quoteRequestsAvailability()` y por el mismo motivo —`pg`
 * tira el error de relación inexistente en la PRIMERA consulta, no al cargar
 * el módulo, así que ni el typecheck ni el build lo ven— pero la causa es
 * distinta y por eso el mensaje también: acá la tabla es NUESTRA, así que si
 * falta es que falta correr `pnpm db:migrate`, no que el backend no desplegó.
 *
 * `to_regclass` y no un `select … limit 0` con try/catch: un catch que se
 * traga errores de SQL termina tragándose también los reales.
 */
export async function quoteResponsesAvailable(opts: { signal?: AbortSignal } = {}): Promise<boolean> {
  void opts.signal

  const row = await sqlOne<{ ok: boolean }>(
    `select to_regclass('ops.quote_request_response') is not null as ok`,
  )
  return row?.ok === true
}

// ── Lectura ────────────────────────────────────────────────────────────────

interface ResponseRow {
  id: string
  quote_request_id: string
  position: number
  partner_id: string | null
  partner_status: string | null
  partner_tier: string | null
  provider_name: string | null
  provider_address: string | null
  provider_phone: string | null
  resolved_name: string
  resolved_address: string | null
  resolved_phone: string | null
  resolved_hours: string | null
  amount_min: string | null
  amount_max: string | null
  currency: string
  detail: string
  valid_until: Date | string | null
  internal_notes: string | null
  created_at: Date | string
  expired: boolean | null
}

/**
 * ── El contacto se RESUELVE en el SELECT, no en el componente ─────────────
 *
 * `coalesce(p.name, r.provider_name)`: del directorio si es un partner (y
 * entonces sigue al directorio cuando le corrigen la dirección), del campo
 * tipeado si es de afuera. Resolverlo acá y no en la UI es lo que hace que el
 * mensaje de WhatsApp y la tarjeta muestren siempre lo mismo — son dos
 * consumidores de la misma fila.
 *
 * El `LEFT JOIN` es `LEFT` porque `partner_id` ES nullable: un `JOIN` haría
 * desaparecer del listado justo a los talleres de afuera, que son la mitad del
 * caso de uso. Y no hay FK que lo garantice (guardrail 6), así que un partner
 * borrado deja la respuesta viva con `resolved_name` en NULL — de ahí el
 * `coalesce` final con un texto, para no romper el tipo `string`.
 *
 * ── `expired` lo calcula Postgres ──────────────────────────────────────────
 *
 * La ficha es SSR completo: comparar contra el reloj del navegador daría un
 * booleano distinto del que mandó el servidor, o sea un mismatch de
 * hidratación por fila. Mismo patrón que `age_minutes` en `/actividad`.
 */
const SELECT_COLUMNS = `
  r.id,
  r.quote_request_id,
  r.position,
  r.partner_id,
  p.status::text as partner_status,
  p.tier::text as partner_tier,
  r.provider_name,
  r.provider_address,
  r.provider_phone,
  coalesce(p.name, r.provider_name, '(taller sin nombre)') as resolved_name,
  nullif(btrim(coalesce(p.address, r.provider_address, '')), '') as resolved_address,
  nullif(btrim(coalesce(p.whatsapp, r.provider_phone, '')), '') as resolved_phone,
  nullif(btrim(coalesce(p.hours, '')), '') as resolved_hours,
  r.amount_min,
  r.amount_max,
  r.currency,
  r.detail,
  r.valid_until,
  r.internal_notes,
  r.created_at,
  (r.valid_until is not null and r.valid_until < (now() at time zone 'UTC')::date) as expired
`

function mapRow(r: ResponseRow): QuoteResponse {
  return {
    id: r.id,
    quoteRequestId: r.quote_request_id,
    position: toInt(r.position),
    partnerId: r.partner_id,
    partnerStatus: r.partner_status,
    partnerTier: r.partner_tier,
    providerName: r.provider_name,
    providerAddress: r.provider_address,
    providerPhone: r.provider_phone,
    name: r.resolved_name,
    address: r.resolved_address,
    phone: r.resolved_phone,
    hours: r.resolved_hours,
    // `numeric` llega como STRING desde `pg`, y acá `null` ("no pasó precio")
    // NO es `0` ("sin cargo"): `toNum` preserva el null a propósito.
    amountMin: toNum(r.amount_min),
    amountMax: toNum(r.amount_max),
    currency: r.currency,
    detail: r.detail,
    validUntil: toPlainDay(r.valid_until),
    createdAt: toIso(r.created_at) ?? '',
    internalNotes: r.internal_notes,
    // `null` (sin vigencia declarada) no es `false` (vigente): la UI los
    // distingue — "sin vencimiento" vs "vence el …".
    expired: r.valid_until === null ? null : r.expired === true,
  }
}

/**
 * Las respuestas de UN pedido, en el orden del MENSAJE.
 *
 * `position` y no `amount_min`: el orden es editorial. En el mensaje real que
 * motivó esta pantalla, el primero era el que daba diagnóstico sin cargo y en
 * el día — y ninguno de los tres tenía precio, así que ordenar por importe
 * habría dado un orden arbitrario. `created_at` desempata para que el orden
 * sea estable entre dos filas que quedaron con la misma posición.
 */
export async function listQuoteResponses(
  quoteRequestId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<QuoteResponse>> {
  void opts.signal

  const rows = await sql<ResponseRow>(
    `select ${SELECT_COLUMNS}
       from ops.quote_request_response r
       left join partners p on p.id = r.partner_id
      where r.quote_request_id = $1
      order by r.position asc, r.created_at asc`,
    [quoteRequestId],
  )
  return rows.map(mapRow)
}

// ── Escrituras: los SP de `ops` de la migración 015 ─────────────────────────
//
// Parámetros NOMBRADOS, igual que el resto de las escrituras de pedidos: hay
// siete opcionales seguidos en la firma y por posición se cruzan sin que nada
// avise.
//
// Este SQL está copiado LITERAL en el bloque de integración de
// `migrations/015_ops_respuestas_de_talleres.test.sql`, con `PREPARE` sin
// tipos —como los manda `pg`—. Si se toca uno, se toca el otro.

/** `''` y ausente viajan como NULL: el SP normaliza `''` igual, `p_note` no. */
const blankToNull = (v: string | undefined): string | null => (v === undefined || v === '' ? null : v)

type SpRow = { r: ResponseRow | null }

/**
 * El SP devuelve `to_jsonb(r)` de la fila cruda de `ops`: no trae el join a
 * `partners`. La ficha se recarga igual (`router.invalidate()`), así que lo
 * resuelto llega por el SELECT de arriba; lo que se devuelve acá es el efecto
 * verificable de la escritura, no lo que se pinta.
 */
function fromSp(row: SpRow | null): QuoteResponse {
  if (!row?.r) throw new Error('QUOTE_RESPONSE_WRITE_FAILED')
  return mapRow({
    ...row.r,
    partner_status: null,
    partner_tier: null,
    resolved_name: row.r.provider_name ?? '(taller del directorio)',
    resolved_address: row.r.provider_address,
    resolved_phone: row.r.provider_phone,
    resolved_hours: null,
  })
}

export async function addQuoteResponse(
  input: AddQuoteResponseInput,
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<QuoteResponse> {
  void opts.signal

  const row = await sqlOne<SpRow>(
    `SELECT ops.add_quote_request_response(
       p_quote_request_id => $1,
       p_actor_id         => $2,
       p_detail           => $3,
       p_partner_id       => $4,
       p_provider_name    => $5,
       p_provider_address => $6,
       p_provider_phone   => $7,
       p_amount_min       => $8,
       p_amount_max       => $9,
       p_currency         => $10,
       p_valid_until      => $11,
       p_internal_notes   => $12,
       p_note             => $13
     ) AS r`,
    [
      input.quoteRequestId,
      actorId,
      input.detail,
      input.partnerId ?? null,
      blankToNull(input.providerName),
      blankToNull(input.providerAddress),
      blankToNull(input.providerPhone),
      input.amountMin ?? null,
      input.amountMax ?? null,
      input.currency,
      blankToNull(input.validUntil),
      blankToNull(input.internalNotes),
      blankToNull(input.auditNote),
    ],
  )
  return fromSp(row)
}

/**
 * Reemplazo COMPLETO, no parche: lo que manda el formulario es lo que queda
 * guardado, y un opcional que no viene se borra — incluido el PRECIO, que así
 * se puede quitar cuando se cargó por error. Misma decisión que el formulario
 * de `set_partner_contact` (`.claude/rules/ops-write-actions.md`).
 */
export async function updateQuoteResponse(
  input: UpdateQuoteResponseInput,
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<QuoteResponse> {
  void opts.signal

  const row = await sqlOne<SpRow>(
    `SELECT ops.update_quote_request_response(
       p_id               => $1,
       p_actor_id         => $2,
       p_detail           => $3,
       p_partner_id       => $4,
       p_provider_name    => $5,
       p_provider_address => $6,
       p_provider_phone   => $7,
       p_amount_min       => $8,
       p_amount_max       => $9,
       p_currency         => $10,
       p_valid_until      => $11,
       p_internal_notes   => $12,
       p_note             => $13
     ) AS r`,
    [
      input.id,
      actorId,
      input.detail,
      input.partnerId ?? null,
      blankToNull(input.providerName),
      blankToNull(input.providerAddress),
      blankToNull(input.providerPhone),
      input.amountMin ?? null,
      input.amountMax ?? null,
      input.currency,
      blankToNull(input.validUntil),
      blankToNull(input.internalNotes),
      blankToNull(input.auditNote),
    ],
  )
  return fromSp(row)
}

/** Devuelve la fila BORRADA: después del `DELETE` ya no hay dónde leerla. */
export async function deleteQuoteResponse(
  input: DeleteQuoteResponseInput,
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<QuoteResponse> {
  void opts.signal

  const row = await sqlOne<SpRow>(
    `SELECT ops.delete_quote_request_response(
       p_id       => $1,
       p_actor_id => $2,
       p_note     => $3
     ) AS r`,
    [input.id, actorId, blankToNull(input.auditNote)],
  )
  return fromSp(row)
}

/**
 * Reordenar. Viaja la lista COMPLETA de ids: el SP rechaza una incompleta, con
 * duplicados o con ids de otro pedido, así que un orden pisado por otra
 * pestaña falla en vez de mezclarse.
 *
 * Devuelve la lista releída y ordenada, no un `void`: es el efecto verificable
 * desde cualquier otro llamador, mismo criterio que `setPartnerLinks`.
 */
export async function reorderQuoteResponses(
  input: ReorderQuoteResponsesInput,
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<QuoteResponse>> {
  void opts.signal

  await sqlOne<{ r: unknown }>(
    `SELECT ops.reorder_quote_request_responses(
       p_quote_request_id => $1,
       p_ids              => $2::uuid[],
       p_actor_id         => $3,
       p_note             => $4
     ) AS r`,
    [input.quoteRequestId, input.ids, actorId, null],
  )
  return listQuoteResponses(input.quoteRequestId, opts)
}
