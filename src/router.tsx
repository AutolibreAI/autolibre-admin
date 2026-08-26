import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { DefaultError, DefaultNotFound, RoutePending } from '~/components/Fallbacks'
import type { SessionUser } from '~/lib/types'

/**
 * Router context is the typed channel between the request and every route.
 * It starts empty here and is filled by the root route's `beforeLoad`, which
 * runs on the server during SSR and on the client during navigation.
 */
export interface RouterContext {
  user: SessionUser | null
}

/** Start calls this on both sides to construct the (per-request) router. */
export function getRouter() {
  return createRouter({
    routeTree,
    context: { user: null } satisfies RouterContext,

    // Prefetch a route's loader on link hover/focus. Combined with server
    // functions this makes most navigations feel instant without a cache layer.
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 30_000,

    // Loader results stay fresh for 30s, so bouncing between list and detail
    // does not re-hit the server.
    defaultStaleTime: 30_000,

    // Only show a pending state if the navigation actually takes a moment —
    // avoids a flash of spinner on fast loaders.
    defaultPendingMs: 250,
    defaultPendingMinMs: 400,

    defaultErrorComponent: DefaultError,
    defaultNotFoundComponent: DefaultNotFound,
    defaultPendingComponent: RoutePending,

    scrollRestoration: true,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
