import { createStart } from '@tanstack/react-start'
import { clerkMiddleware } from '@clerk/tanstack-react-start/server'
import { observabilityMiddleware } from '~/fn/middleware'

/**
 * The application-wide Start instance. Start discovers this file by convention
 * (`src/start.ts`) and applies these options to both the server handler and the
 * client runtime.
 */
export const startInstance = createStart(() => ({
  /**
   * Full-document SSR is the default for every route. Individual routes opt
   * out (`ssr: false`) or opt down (`ssr: 'data-only'`) where that is the
   * better trade — see src/routes/settings.tsx and src/routes/reports.tsx.
   */
  defaultSsr: true,

  /**
   * Runs ahead of document renders *and* server-function calls.
   *
   * `clerkMiddleware()` establishes the request-scoped auth context that
   * `auth()` reads in `src/server/session.ts`. It must come before anything
   * that asks who the caller is.
   */
  requestMiddleware: [clerkMiddleware(), observabilityMiddleware],
}))
