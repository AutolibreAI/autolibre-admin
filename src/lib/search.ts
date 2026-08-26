import { z } from 'zod'
import { RECORD_STATUSES } from './types'

/**
 * Search-param schemas live next to the types because they are the public
 * contract of a URL. A route's `validateSearch` is the only place an untrusted
 * query string becomes typed data — every downstream consumer (loader deps,
 * server functions, components, `<Link search={...}>`) receives the parsed
 * output and is checked against it by the compiler.
 */

export const SORT_FIELDS = ['name', 'updatedAt'] as const
export type SortField = (typeof SORT_FIELDS)[number]

export const listSearchSchema = z.object({
  /** Free-text filter. */
  q: z.string().trim().max(80).optional(),

  /** 1-based. Coerced because a URL only ever carries strings. */
  page: z.coerce.number().int().min(1).catch(1).default(1),

  pageSize: z.coerce.number().int().min(10).max(100).catch(25).default(25),

  status: z.enum(RECORD_STATUSES).optional(),

  sort: z.enum(SORT_FIELDS).catch('updatedAt').default('updatedAt'),

  dir: z.enum(['asc', 'desc']).catch('desc').default('desc'),
})

export type ListSearch = z.infer<typeof listSearchSchema>

/**
 * Note the two different failure modes, both deliberate:
 *
 *  - `.catch(...)` degrades a malformed value to a sane default. A bookmarked
 *    `?page=banana` should still render page 1 rather than an error screen.
 *  - A field with no `.catch()` still throws, and Router surfaces that through
 *    the route's `errorComponent`.
 *
 * Choose per field based on whether a wrong value is recoverable.
 */

export const loginSearchSchema = z.object({
  /** Where to return after signing in. Must be relative — otherwise this is an
   *  open redirect. */
  redirect: z.string().startsWith('/').optional(),
})
