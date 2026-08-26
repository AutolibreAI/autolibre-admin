import { createFileRoute } from '@tanstack/react-router'

/**
 * A plain HTTP endpoint, defined by the same file-based router as the pages.
 * `GET /api/health` — no component, no auth, cheap enough for a load balancer
 * to probe every few seconds.
 *
 * `__DEPLOY_TARGET__` is substituted at build time (see vite.config.ts). The
 * handler itself is identical on every runtime: it takes no Node-specific
 * input and returns a Web `Response`.
 */
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: () =>
        Response.json(
          { status: 'ok', target: __DEPLOY_TARGET__ },
          { headers: { 'cache-control': 'no-store' } },
        ),
    },
  },
})
