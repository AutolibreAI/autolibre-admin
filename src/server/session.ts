import '@tanstack/react-start/server-only'

import { auth } from '@clerk/tanstack-react-start/server'
import { sqlOne } from './db'
import type { SessionUser, UserRole } from '~/lib/types'

/**
 * Who is asking, and are they allowed in.
 *
 * TWO INDEPENDENT CHECKS, and conflating them is the bug this file exists to
 * prevent:
 *
 *  1. **Clerk** answers "is this a real, signed-in identity?" It owns the
 *     session cookie and the token. It does NOT know about roles.
 *  2. **Postgres** answers "what is this identity allowed to do?" The `users`
 *     row carries `role`, and that is the only authority on it.
 *
 * A valid Clerk session is therefore NOT sufficient to enter the panel. Every
 * AutoLibre app user has one.
 */

interface UserRow {
  id: string
  email: string
  name: string | null
  role: UserRole
}

/**
 * Resolve the caller to an AutoLibre user, or `null`.
 *
 * The lookup key is the pair `(auth_provider, external_auth_id)` — never the
 * email. That is the backend's rule, and it matters here: emails are mutable
 * and can be reassigned, so keying on one would let a recycled address inherit
 * someone else's role.
 */
export async function readSessionUser(): Promise<SessionUser | null> {
  const { userId } = await auth()
  if (!userId) return null

  const row = await sqlOne<UserRow>(
    `SELECT id, email, name, role
       FROM users
      WHERE auth_provider = 'clerk'
        AND external_auth_id = $1`,
    [userId],
  )

  if (!row) {
    // A valid Clerk identity with no AutoLibre user yet. The backend provisions
    // `users` by webhook (`user.created`) with JIT as a safety net, so this is
    // a real race on a brand-new account — not an error worth throwing.
    return null
  }

  return {
    id: row.id,
    email: row.email,
    name: row.name ?? row.email,
    role: row.role,
  }
}

/**
 * The admin gate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * KNOWN RISK — read before changing this predicate.
 *
 * As of 2026-08-26 the `users` table holds 761 rows with `role = 'admin'` and
 * `auth_provider = 'native'`, against 2 with `role = 'admin'` and
 * `auth_provider = 'clerk'`. 28% of the user base is nominally admin, which
 * almost certainly is not a decision — it looks like a default left over from
 * the pre-Clerk era.
 *
 * Those 761 cannot reach the panel today: the lookup above is scoped to
 * `auth_provider = 'clerk'`, and a native row never matches a Clerk identity.
 * That is a side effect, NOT a safeguard. The day someone migrates a native
 * account onto Clerk, it inherits `admin`.
 *
 * Do not "fix" this by widening the query to accept native rows. The fix is a
 * data audit on the backend side, and it is not this repo's call to make.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function isAdmin(user: SessionUser | null): user is SessionUser {
  return user?.role === 'admin'
}
