import { defineConfig } from 'vite'
import viteReact from '@vitejs/plugin-react'
import tsConfigPaths from 'vite-tsconfig-paths'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitroV2Plugin } from '@tanstack/nitro-v2-vite-plugin'
import tailwindcss from '@tailwindcss/vite'

/**
 * The deployment runtime is a *build* concern, never an application concern.
 * Nothing under `src/` knows or cares which of these is active — the app model
 * is written once against Web `Request`/`Response` and the Start server APIs.
 *
 *   NITRO_PRESET=node-server        pnpm build   # default: node .output/server/index.mjs
 *   NITRO_PRESET=vercel             pnpm build
 *   NITRO_PRESET=netlify            pnpm build
 *   NITRO_PRESET=cloudflare-module  pnpm build
 *   NITRO_PRESET=bun                pnpm build
 */
const preset = process.env.NITRO_PRESET ?? 'node-server'

export default defineConfig({
  // Surfaced to the app as a build-time constant so /api/health can report what
  // it was packaged for. This is the ONLY place the target name reaches src/.
  define: { __DEPLOY_TARGET__: JSON.stringify(preset) },

  plugins: [
    tsConfigPaths({ projects: ['./tsconfig.json'] }),

    tailwindcss(),

    tanstackStart({
      srcDirectory: 'src',
      // Defence in depth for the server-only boundary. The `server-only` marker
      // import inside src/server/* already tags those modules; this rule makes
      // the whole directory unreachable from the client graph even if someone
      // forgets the marker. A violation fails the build instead of silently
      // shipping database code (or secrets) to the browser.
      importProtection: {
        enabled: true,
        behavior: 'error',
        client: {
          files: ['src/server/**'],
          specifiers: ['node:fs', 'node:crypto', 'node:child_process'],
        },
      },
    }),

    viteReact(),

    // Must come last: it consumes the built server environment and packages it
    // for the chosen runtime.
    nitroV2Plugin({ preset }),
  ],
})
