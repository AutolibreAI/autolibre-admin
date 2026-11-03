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
 * Mirrors the Postgres enum `user_role` exactly: `user | admin | partner`.
 *
 * Era `provider` hasta la migración 0138 del backend
 * (`ALTER TYPE user_role RENAME VALUE 'provider' TO 'partner'`, 2026-11-03).
 * Este espejo se despliega JUNTO con esa migración: `users.repo.ts` castea el
 * filtro a `$n::user_role`, así que un valor que la base no conoce es un 22P02.
 * Un enum de front que no coincide con la base renderiza filas en blanco el
 * día que aparece un valor que no conoce.
 */
export type UserRole = 'user' | 'admin' | 'partner'

export interface SessionUser {
  /** `users.id` (uuid) — la identidad de AutoLibre, no la de Clerk. */
  id: string
  email: string
  name: string
  role: UserRole
}
