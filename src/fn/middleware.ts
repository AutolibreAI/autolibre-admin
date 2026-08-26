import { createMiddleware } from '@tanstack/react-start'
import { setResponseHeader } from '@tanstack/react-start/server'
import { readSessionUser } from '~/server/session'
import type { SessionUser } from '~/lib/types'

/**
 * Why these bodies are safe to write next to client code:
 *
 * `.server(fn)` is a compiler-recognised boundary. In the client build Start
 * strips the callback and every import that only it used, so `~/server/session`
 * — and through it the database pool and the Clerk secret — never reach the
 * browser graph. If the compiler ever failed to strip it, the
 * `importProtection` rule in vite.config.ts turns that into a build error
 * rather than a silent leak.
 *
 * Verified after each build with:
 *   grep -rl "sqlOne\|POSTGRES_DATABASE_URL" .output/public
 */

/** Runs for every inbound HTTP request, including document and server-fn requests. */
export const observabilityMiddleware = createMiddleware({ type: 'request' }).server(
  async ({ request, next }) => {
    const startedAt = performance.now()
    const result = await next()
    const ms = performance.now() - startedAt

    setResponseHeader('server-timing', `app;dur=${ms.toFixed(1)}`)
    if (import.meta.env.DEV) {
      const { pathname } = new URL(request.url)
      console.info(`${request.method} ${pathname} — ${ms.toFixed(1)}ms`)
    }
    return result
  },
)

/**
 * Attaches the AutoLibre user to every server function's context.
 *
 * Returning it from `next({ context })` is what makes `context.user` typed
 * downstream — no casting, and no re-doing the Clerk + database round trip in
 * each handler.
 */
export const sessionMiddleware = createMiddleware({ type: 'function' }).server(
  async ({ next }) => next({ context: { user: await readSessionUser() } }),
)

/** Refuses to run the handler at all without a signed-in AutoLibre user. */
export const authedMiddleware = createMiddleware({ type: 'function' })
  .middleware([sessionMiddleware])
  .server(async ({ next, context }) => {
    if (!context.user) throw new Error('UNAUTHENTICATED')
    return next({ context: { user: context.user satisfies SessionUser } })
  })

/**
 * The server-side half of the admin gate.
 *
 * `_authed`'s `beforeLoad` already redirects non-admins, but that is a
 * NAVIGATION guard — it shapes what the UI offers, and a server function is a
 * public HTTP endpoint that anyone with a session cookie can call directly.
 * Every privileged read and every mutation goes through this, not through the
 * route guard.
 */
export const adminMiddleware = createMiddleware({ type: 'function' })
  .middleware([authedMiddleware])
  .server(async ({ next, context }) => {
    if (context.user.role !== 'admin') throw new Error('FORBIDDEN')
    return next({ context: { user: context.user } })
  })

/**
 * Request-level session read, for `server.handlers` on file routes. Server
 * *functions* use `sessionMiddleware` above; plain HTTP endpoints run outside
 * that pipeline and need the request-flavoured variant.
 */
export const apiSessionMiddleware = createMiddleware({ type: 'request' }).server(
  async ({ next }) => next({ context: { user: await readSessionUser() } }),
)
