import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import {
  QUOTE_TEMPLATES,
  type QuoteMessageTemplate,
  type QuoteMessageTemplateVersion,
  type QuoteTemplateAudience,
  type SaveQuoteMessageTemplateInput,
} from '~/lib/quote-templates'

/**
 * Plantillas de mensaje editables — `ops.quote_message_template_version`
 * (migración 017).
 *
 * ── La semilla es de código, esta tabla es la ficha del que edita ─────────
 *
 * `QUOTE_TEMPLATES` (`~/lib/quote-templates.ts`) sigue siendo la fuente de
 * verdad para un `template_key` sin ninguna versión guardada. El merge entre
 * "lo que hay en `ops`" y "la semilla" pasa ACÁ — no en el cliente — para que
 * `listQuoteMessageTemplatesFn` devuelva una sola lista ya resuelta y ningún
 * componente tenga que repetir esta lógica.
 *
 * ── Las escrituras son SÓLO la llamada al SP ───────────────────────────────
 *
 * `ops.save_quote_message_template` escribe `ops.action_log` en la MISMA
 * sentencia que el `INSERT`. Un `INSERT` directo desde acá separaría el
 * cambio de su auditoría. Si aparece uno, está mal.
 */

const toIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v)

// ── Disponibilidad ─────────────────────────────────────────────────────────

/**
 * ¿Está aplicada la 017 en esta base? Mismo patrón que
 * `quoteResponsesAvailable()`: `to_regclass`, no un `SELECT … LIMIT 0` con
 * try/catch, para no tragarse errores reales.
 */
export async function quoteMessageTemplatesAvailable(opts: { signal?: AbortSignal } = {}): Promise<boolean> {
  void opts.signal
  const row = await sqlOne<{ ok: boolean }>(
    `select to_regclass('ops.quote_message_template_version') is not null as ok`,
  )
  return row?.ok === true
}

// ── Lectura ────────────────────────────────────────────────────────────────

interface VersionRow {
  id: string
  template_key: string
  title: string
  audience: string
  content: string
  archived: boolean
  actor_email: string | null
  created_at: Date | string
}

function mapVersion(r: VersionRow): QuoteMessageTemplateVersion {
  return {
    id: r.id,
    templateKey: r.template_key,
    title: r.title,
    audience: r.audience as QuoteTemplateAudience,
    content: r.content,
    archived: r.archived,
    actorEmail: r.actor_email,
    createdAt: toIso(r.created_at) ?? '',
  }
}

/**
 * La lista completa de plantillas VIGENTES: las 4 semillas (con o sin
 * versión propia) más cualquier plantilla nueva creada desde el panel.
 *
 * "Vigente" para una clave = su última versión, si esa versión NO está
 * archivada. Una clave cuya única versión está archivada no aparece —
 * es el "retiro" de una plantilla custom sin borrar su historial.
 */
export async function listQuoteMessageTemplates(
  opts: { signal?: AbortSignal } = {},
): Promise<Array<QuoteMessageTemplate>> {
  void opts.signal

  const seeded = (): Array<QuoteMessageTemplate> =>
    QUOTE_TEMPLATES.map((t) => ({ ...t, isCustomized: false, currentVersionId: null, updatedAt: null }))

  if (!(await quoteMessageTemplatesAvailable(opts))) return seeded()

  const rows = await sql<VersionRow>(
    `select id, template_key, title, audience, content, archived, created_at
       from (
         select distinct on (template_key) *
           from ops.quote_message_template_version
          order by template_key, created_at desc
       ) latest
      where not archived
      order by created_at asc`,
  )

  const byKey = new Map(rows.map((r) => [r.template_key, r]))
  const seedIds = new Set(QUOTE_TEMPLATES.map((t) => t.id))

  const fromSeed: Array<QuoteMessageTemplate> = QUOTE_TEMPLATES.map((seed) => {
    const row = byKey.get(seed.id)
    if (!row) return { ...seed, isCustomized: false, currentVersionId: null, updatedAt: null }
    return {
      id: row.template_key,
      title: row.title,
      audience: row.audience as QuoteTemplateAudience,
      content: row.content,
      isCustomized: true,
      currentVersionId: row.id,
      updatedAt: toIso(row.created_at),
    }
  })

  // Las que no son de semilla, en el orden en que se crearon.
  const custom: Array<QuoteMessageTemplate> = rows
    .filter((r) => !seedIds.has(r.template_key))
    .map((r) => ({
      id: r.template_key,
      title: r.title,
      audience: r.audience as QuoteTemplateAudience,
      content: r.content,
      isCustomized: true,
      currentVersionId: r.id,
      updatedAt: toIso(r.created_at),
    }))

  return [...fromSeed, ...custom]
}

/** El historial completo de una clave, más nueva primero — para "Historial" en el editor. */
export async function listQuoteMessageTemplateVersions(
  templateKey: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<QuoteMessageTemplateVersion>> {
  void opts.signal

  const rows = await sql<VersionRow>(
    `select v.id, v.template_key, v.title, v.audience, v.content, v.archived,
            u.email as actor_email, v.created_at
       from ops.quote_message_template_version v
       left join users u on u.id = v.actor_id
      where v.template_key = $1
      order by v.created_at desc`,
    [templateKey],
  )
  return rows.map(mapVersion)
}

// ── Escritura ────────────────────────────────────────────────────────────

/** La fila cruda que devuelve el SP — sin `actor_email`, que sólo trae el `LEFT JOIN` de la lectura. */
type RawVersionRow = Omit<VersionRow, 'actor_email'>

/** Guardar una versión nueva — alta (`templateKey` ausente) o edición, vía `ops.save_quote_message_template` (017). */
export async function saveQuoteMessageTemplate(
  input: SaveQuoteMessageTemplateInput,
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<QuoteMessageTemplate> {
  void opts.signal

  const row = await sqlOne<{ t: RawVersionRow }>(
    `SELECT ops.save_quote_message_template(
       p_actor_id     => $1,
       p_title        => $2,
       p_audience     => $3,
       p_content      => $4,
       p_template_key => $5,
       p_archived     => false,
       p_note         => NULL
     ) AS t`,
    [actorId, input.title, input.audience, input.content, input.templateKey ?? null],
  )
  if (!row) throw new Error('QUOTE_MESSAGE_TEMPLATE_SAVE_FAILED')
  return {
    id: row.t.template_key,
    title: row.t.title,
    audience: row.t.audience as QuoteTemplateAudience,
    content: row.t.content,
    isCustomized: true,
    currentVersionId: row.t.id,
    updatedAt: toIso(row.t.created_at),
  }
}
