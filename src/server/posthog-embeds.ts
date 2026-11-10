// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY MODULE
//
// Lee las URLs para embeber los tableros de PostHog. Son links públicos (quien
// los tenga ve el tablero sin login), así que viven en variables del servidor y
// nunca en el bundle del cliente. → `~/lib/posthog-dashboards`
// ─────────────────────────────────────────────────────────────────────────────
import '@tanstack/react-start/server-only'
import {
  POSTHOG_DASHBOARDS,
  POSTHOG_EMBED_URL_RE,
  type PosthogDashboardKey,
  type PosthogEmbedConfig,
} from '~/lib/posthog-dashboards'

/**
 * Se lee en cada llamada, no en scope de módulo: una variable que falta no puede
 * llevarse puesto el cold start (mismo criterio que `db.ts`), y cambiarla en el
 * despliegue no exige volver a buildear.
 */
export function readPosthogEmbed(key: PosthogDashboardKey): PosthogEmbedConfig {
  const raw = process.env[POSTHOG_DASHBOARDS[key].envVar]?.trim()
  if (!raw) return { status: 'missing', url: null }
  if (!POSTHOG_EMBED_URL_RE.test(raw)) return { status: 'invalid', url: null }
  return { status: 'ok', url: raw }
}
