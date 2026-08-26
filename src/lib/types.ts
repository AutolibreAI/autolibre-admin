/**
 * Wire contract shared by both environments.
 *
 * Types only — no imports from `~/server/*`. Server modules produce values that
 * satisfy these shapes; client components consume them. Keeping the contract in
 * its own module is what lets the server-only boundary stay airtight without
 * the UI losing type safety.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PLACEHOLDER DOMAIN.
 * `RecordItem` is a deliberately generic stand-in so the routing, loader and
 * server-function wiring can be exercised end to end. Replace it with the real
 * entities; the surrounding infrastructure does not need to change.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const RECORD_STATUSES = ['active', 'pending', 'archived'] as const
export type RecordStatus = (typeof RECORD_STATUSES)[number]

export interface RecordItem {
  id: string
  name: string
  category: string
  status: RecordStatus
  updatedAt: string
}

export interface Page<T> {
  items: Array<T>
  total: number
  page: number
  pageSize: number
  pageCount: number
}

export interface Summary {
  total: number
  byStatus: Record<RecordStatus, number>
}

export interface CategoryCount {
  category: string
  count: number
}

/**
 * Mirrors the Postgres enum `user_role` exactly: `user | admin | provider`.
 *
 * `'provider'` is legacy and known to be wrong — the backend says Partner, not
 * Provider — but the enum still carries it because changing it means recreating
 * the type. Do NOT "clean it up" here: a front-end enum that disagrees with the
 * database renders blank rows the day a value appears that it does not know.
 */
export type UserRole = 'user' | 'admin' | 'provider'

export interface SessionUser {
  /** `users.id` (uuid) — the AutoLibre identity, not the Clerk one. */
  id: string
  email: string
  name: string
  role: UserRole
}
