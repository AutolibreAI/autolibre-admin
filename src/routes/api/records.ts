import { createFileRoute } from '@tanstack/react-router'
import { listSearchSchema } from '~/lib/search'
import { queryRecords } from '~/server/records.repo'
import { apiSessionMiddleware } from '~/fn/middleware'

/**
 * `GET /api/records?status=active&page=2` — the same data the list page loads,
 * exposed as JSON for scripts and integrations.
 *
 * Three things worth noting:
 *
 *  1. It reuses `listSearchSchema`. The URL contract of the page and the
 *     contract of this endpoint are the same object, so they cannot drift.
 *
 *  2. It calls the repository directly rather than the server *function*.
 *     Server functions exist to be called from the client with types intact;
 *     inside a request handler we are already on the server, so the RPC hop
 *     would be pure overhead. Both paths converge on the same server-only
 *     module, which is where the rules live.
 *
 *  3. It parses with zod's `safeParse` rather than Start's `getValidatedQuery`
 *     helper. That helper's generic is not bound to its parameter, so it
 *     resolves to `any` and silently erases the types this endpoint exists to
 *     guarantee. Going through zod directly keeps the result typed and lets us
 *     return the actual validation issues in the 400.
 */
export const Route = createFileRoute('/api/records')({
  server: {
    middleware: [apiSessionMiddleware],
    handlers: {
      GET: async ({ context, request }) => {
        if (!context.user) {
          return Response.json({ error: 'unauthenticated' }, { status: 401 })
        }
        // A signed-in app user is not staff. This endpoint is reachable with any
        // valid session cookie, so the role check belongs here, not only in the
        // route guard.
        if (context.user.role !== 'admin') {
          return Response.json({ error: 'forbidden' }, { status: 403 })
        }

        const url = new URL(request.url)
        const parsed = listSearchSchema.safeParse(Object.fromEntries(url.searchParams))
        if (!parsed.success) {
          return Response.json(
            {
              error: 'invalid_query',
              issues: parsed.error.issues.map((i) => ({
                path: i.path.join('.'),
                message: i.message,
              })),
            },
            { status: 400 },
          )
        }

        const page = await queryRecords(parsed.data, { signal: request.signal })
        return Response.json(page, {
          headers: { 'cache-control': 'private, max-age=15' },
        })
      },
    },
  },
})
