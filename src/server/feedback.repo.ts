import '@tanstack/react-start/server-only'

import { sql } from './db'
import { lastSignalSql } from '~/lib/activity'
import type { FeedbackListItem, FeedbackSearch, FeedbackSortKey } from '~/lib/feedback'

/**
 * Feedback — solo lectura, mismo criterio que `chats.repo.ts`: `feedback` es
 * dominio del backend (`feedback/`), este repo sólo consulta.
 */

const toInt = (value: unknown): number => Number(value ?? 0)
const toIso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : String(value)
const toIsoRequired = (value: unknown): string => toIso(value) ?? ''

interface FeedbackRow {
  id: string
  user_id: string
  user_email: string
  user_name: string | null
  message: string
  app_version: string | null
  platform: string | null
  device_model: string | null
  os_version: string | null
  submitted_at: Date | string
  vehicle_count: number | string
  last_activity_at: Date | string | null
  feedback_count: number | string
  push_token_count: number | string
}

/**
 * Mapa cerrado `FeedbackSortKey → expresión SQL`, mismo patrón que
 * `SORT_COLUMNS` en `chats.repo.ts` y `users.repo.ts` — seguro de interpolar
 * porque sale de un `Record` que los tipos obligan a cubrir.
 */
const SORT_COLUMNS: Record<FeedbackSortKey, string> = {
  submittedAt: 'submitted_at',
  appVersion: 'app_version',
  platform: 'platform',
  user: 'user_email',
  messageLength: 'char_length(message)',
}

/**
 * El listado. Envuelto en `select * from (...) s`, mismo motivo que
 * `listChats`: `vehicle_count`, `last_activity_at` y `feedback_count` son
 * subconsultas escalares del SELECT, y `q` busca sobre `user_email` /
 * `user_name` / `message`, que ya son columnas planas acá — pero se mantiene
 * el envoltorio por consistencia con el resto del repo y porque
 * `feedback_count` sí depende de agregación por usuario.
 *
 * `join` y no `left join` a `users`: `feedback.user_id` es NOT NULL con FK.
 */
export async function listFeedback(
  search: FeedbackSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<FeedbackListItem>> {
  void opts.signal

  const params: Array<unknown> = []
  const outerWhere: Array<string> = []

  if (search.q) {
    params.push(`%${search.q}%`)
    outerWhere.push(
      `(message ilike $${params.length} or user_email ilike $${params.length} or coalesce(user_name, '') ilike $${params.length})`,
    )
  }

  if (search.feedbackPlatform) {
    params.push(search.feedbackPlatform)
    outerWhere.push(`platform = $${params.length}`)
  }

  if (search.feedbackAppVersion) {
    params.push(search.feedbackAppVersion)
    outerWhere.push(`app_version = $${params.length}`)
  }

  if (search.userId) {
    params.push(search.userId)
    outerWhere.push(`user_id = $${params.length}`)
  }

  if (search.feedbackWindow !== 'all') {
    const hours = { '7d': 24 * 7, '30d': 24 * 30, '90d': 24 * 90 }[search.feedbackWindow]
    params.push(hours)
    outerWhere.push(`submitted_at > now() - make_interval(hours => $${params.length}::int)`)
  }

  const sortColumn = SORT_COLUMNS[search.sort]

  const rows = await sql<FeedbackRow>(
    `
    select * from (
      select
        f.id,
        f.user_id,
        u.email as user_email,
        u.name as user_name,
        f.message,
        f.app_version,
        f.platform::text as platform,
        f.device_model,
        f.os_version,
        f.submitted_at,
        (select count(*) from vehicles v where v.user_id = f.user_id)::int as vehicle_count,
        ${lastSignalSql('f.user_id')} as last_activity_at,
        (select count(*) from feedback f2 where f2.user_id = f.user_id)::int as feedback_count,
        (select count(*) from expo_push_tokens ept where ept.user_id = f.user_id)::int as push_token_count
      from feedback f
      join users u on u.id = f.user_id
    ) s
    ${outerWhere.length ? `where ${outerWhere.join(' and ')}` : ''}
    order by ${sortColumn} ${search.dir} nulls last, id
    limit 500
    `,
    params,
  )

  return rows.map(
    (r): FeedbackListItem => ({
      id: r.id,
      userId: r.user_id,
      userEmail: r.user_email,
      userName: r.user_name,
      message: r.message,
      appVersion: r.app_version,
      platform: r.platform,
      deviceModel: r.device_model,
      osVersion: r.os_version,
      submittedAt: toIsoRequired(r.submitted_at),
      vehicleCount: toInt(r.vehicle_count),
      lastActivityAt: toIso(r.last_activity_at),
      feedbackCount: toInt(r.feedback_count),
      pushTokenCount: toInt(r.push_token_count),
    }),
  )
}

/**
 * Los valores que realmente aparecen en la base, para los chips de filtro.
 * Nunca hardcodeado — mismo criterio que `listDistinctChatModels`.
 */
export async function listDistinctFeedbackPlatforms(
  opts: { signal?: AbortSignal } = {},
): Promise<Array<string>> {
  void opts.signal
  const rows = await sql<{ platform: string }>(
    `select distinct platform::text as platform from feedback where platform is not null order by 1`,
  )
  return rows.map((r) => r.platform)
}

export async function listDistinctFeedbackAppVersions(
  opts: { signal?: AbortSignal } = {},
): Promise<Array<string>> {
  void opts.signal
  const rows = await sql<{ app_version: string }>(
    `select distinct app_version from feedback where app_version is not null order by 1`,
  )
  return rows.map((r) => r.app_version)
}
