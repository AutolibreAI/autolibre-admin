import { createServerFn } from '@tanstack/react-start'
import { readSessionUser } from '~/server/session'
import type { SessionUser } from '~/lib/types'

/**
 * The only auth server function the panel needs.
 *
 * There is no `login` / `logout` here any more: Clerk owns the credential flow
 * end to end (`<SignIn />` on the client, its own session cookie, `<SignOutButton />`
 * to end it). Re-implementing either would mean holding a password in this
 * codebase, which is exactly what adopting Clerk was for.
 *
 * What this DOES own is the second half of the question — Clerk says *who*,
 * `users.role` says *allowed to do what*. See `~/server/session`.
 */
export const getCurrentUser = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SessionUser | null> => readSessionUser(),
)
