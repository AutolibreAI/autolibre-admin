import type { ReactNode } from 'react'
import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { ClerkProvider } from '@clerk/tanstack-react-start'
import { esES } from '@clerk/localizations'

import { getCurrentUser } from '~/fn/session'
import { DefaultError, DefaultNotFound } from '~/components/Fallbacks'
import type { RouterContext } from '~/router'
import appCss from '~/styles.css?url'

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'AutoLibre — Panel' },
      { name: 'description', content: 'Panel de administración de AutoLibre.' },
      { name: 'color-scheme', content: 'light' },
      { name: 'theme-color', content: '#1C2B1C' },
      // Internal tool: keep it out of every index, not just the polite ones.
      { name: 'robots', content: 'noindex, nofollow' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },

      /**
       * Outfit (headings/data) + DM Sans (body/UI) — the same two families the
       * mobile app loads via @expo-google-fonts. Preconnecting to the font CDN
       * before the stylesheet request saves a full connection setup on the
       * critical path; `display=swap` keeps text visible while they load.
       */
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Outfit:wght@600;700&display=swap',
      },

      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
    ],
  }),

  /**
   * Runs once per navigation, before any child loader. On the server this calls
   * the handler in-process (no HTTP round trip); on the client it becomes a
   * fetch. Either way, `context.user` is typed and available to every route
   * below — including `_authed`'s guard.
   *
   * Note this returns the AutoLibre user (a `users` row, with its role), not
   * the Clerk identity. Clerk answers "who"; Postgres answers "allowed to do
   * what". See src/server/session.ts.
   */
  beforeLoad: async (): Promise<RouterContext> => ({
    user: await getCurrentUser(),
  }),

  errorComponent: DefaultError,
  notFoundComponent: DefaultNotFound,

  /**
   * FULL-DOCUMENT SSR.
   *
   * `shellComponent` owns everything from `<html>` down. Start renders this on
   * the server and streams it as one response — there is no static index.html
   * and no client-side document assembly, so `<head>` can depend on route data.
   *
   * `<HeadContent />` renders the merged `head()` output of every matched route.
   * `<Scripts />` emits the hydration payload and module scripts, and must be
   * the last thing in `<body>` so streamed chunks can flush before it.
   */
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    /**
     * ClerkProvider wraps the document, not just the authed subtree: the
     * sign-in route needs it too, and mounting it once here avoids a remount
     * (and a token refetch) when crossing between public and guarded routes.
     *
     * The appearance block keeps Clerk's own UI on the AutoLibre design system
     * — Action Dark as the primary, brand green as the accent, no shadows.
     */
    <ClerkProvider
      localization={esES}
      appearance={{
        variables: {
          colorPrimary: '#1C2B1C',
          colorForeground: '#111827',
          colorMutedForeground: '#6B7280',
          colorBackground: '#FEFEFD',
          colorInput: '#F3F4F6',
          colorInputForeground: '#111827',
          borderRadius: '0.5rem',
          fontFamily: '"DM Sans", ui-sans-serif, system-ui, sans-serif',
        },
        elements: {
          // The design system has no shadows; Clerk's cards ship with one.
          card: 'shadow-none border border-[#E4EAE4]',
        },
      }}
    >
      <html lang="es-AR" className="h-full">
        <head>
          <HeadContent />
        </head>
        <body className="min-h-full">
          {children}
          <Scripts />
        </body>
      </html>
    </ClerkProvider>
  )
}
