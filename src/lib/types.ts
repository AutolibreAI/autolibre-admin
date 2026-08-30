/**
 * Wire contract shared by both environments.
 *
 * Types only — no imports from `~/server/*`. Server modules produce values that
 * satisfy these shapes; client components consume them. Keeping the contract in
 * its own module is what lets the server-only boundary stay airtight without
 * the UI losing type safety.
 *
 * Este archivo quedó reducido a la SESIÓN. El dominio placeholder (`RecordItem`
 * y compañía) se borró junto con las pantallas que lo renderizaban; cada
 * contexto real trae el suyo: `~/lib/partners`, `~/lib/catalog`,
 * `~/lib/ai-usage`, `~/lib/ops`.
 */

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
  /** `users.id` (uuid) — la identidad de AutoLibre, no la de Clerk. */
  id: string
  email: string
  name: string
  role: UserRole
}
