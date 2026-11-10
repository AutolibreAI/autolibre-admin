/**
 * Los cinco tableros de PostHog que Métricas muestra embebidos.
 *
 * Los tableros viven en el proyecto AutolibreAI (id 607170) y ya excluyen las
 * cuentas internas: el panel no crea ni toca nada en PostHog.
 *
 * ── Lo que NO está acá, a propósito: la URL para embeber ────────────────────
 *
 * La URL `/embedded/<código>` es un link PÚBLICO: quien la tenga ve el tablero
 * sin iniciar sesión. Por eso vive en una variable de entorno del SERVIDOR (sin
 * prefijo `VITE_`) y la entrega un server function con `adminMiddleware`
 * (`~/fn/posthog-embeds`). Con `VITE_` el valor quedaría escrito en el
 * JavaScript del cliente, que se sirve sin login.
 *
 * `dashboardUrl` sí va en el código: es el tablero DENTRO de PostHog, que pide
 * iniciar sesión en PostHog. Es el destino de «Abrir en PostHog».
 */

export const POSTHOG_PROJECT_ID = 607170

export const POSTHOG_DASHBOARD_KEYS = ['uso', 'activacion', 'pedidos', 'diagnostico', 'demanda'] as const
export type PosthogDashboardKey = (typeof POSTHOG_DASHBOARD_KEYS)[number]

export interface PosthogDashboard {
  key: PosthogDashboardKey
  /** Rótulo de la pestaña y título del tablero. */
  label: string
  /** Nombre de la variable de entorno del servidor con la URL para embeber. */
  envVar: string
  /** El tablero adentro de PostHog (pide login de PostHog). */
  dashboardUrl: string
  /** Una línea debajo del título: qué muestra. */
  description: string
}

const dashboardUrl = (id: number) => `https://us.posthog.com/project/${POSTHOG_PROJECT_ID}/dashboard/${id}`

export const POSTHOG_DASHBOARDS: Record<PosthogDashboardKey, PosthogDashboard> = {
  uso: {
    key: 'uso',
    label: 'Uso y retención',
    envVar: 'POSTHOG_EMBED_USO',
    dashboardUrl: dashboardUrl(2145288),
    description:
      'Usuarios activos por día y por semana, instalaciones, retención, pantallas más vistas, plataforma y versiones.',
  },
  activacion: {
    key: 'activacion',
    label: 'Activación',
    envVar: 'POSTHOG_EMBED_ACTIVACION',
    dashboardUrl: dashboardUrl(2331621),
    description:
      'Del alta al primer vehículo y al primer documento, cómo cargan el vehículo y cuánto acierta la lectura automática.',
  },
  pedidos: {
    key: 'pedidos',
    label: 'Pedidos · uso en la app',
    envVar: 'POSTHOG_EMBED_PEDIDOS',
    dashboardUrl: dashboardUrl(2145378),
    description:
      'El recorrido de un pedido en la app: por dónde entran, qué campos traban, errores de envío y borradores descartados.',
  },
  diagnostico: {
    key: 'diagnostico',
    label: 'Diagnóstico',
    envVar: 'POSTHOG_EMBED_DIAGNOSTICO',
    dashboardUrl: dashboardUrl(2331624),
    description:
      'El diagnóstico con escáner, por qué y en qué paso falla la conexión, el interés en el escáner y el chat con IA.',
  },
  demanda: {
    key: 'demanda',
    label: 'Demanda y monetización',
    envVar: 'POSTHOG_EMBED_DEMANDA',
    dashboardUrl: dashboardUrl(2331625),
    description:
      'Salidas a WhatsApp por tema, lista de espera por función, planes pagos de proveedores y de la landing a la tienda.',
  },
}

/**
 * Qué devuelve el servidor para un tablero.
 *  - `ok`: hay URL y tiene la forma de un link de PostHog.
 *  - `missing`: la variable no está cargada (o está vacía).
 *  - `invalid`: está cargada pero no es un link `https://us.posthog.com/embedded|shared/…`.
 *    No se embebe: un typo podría apuntar el iframe a cualquier sitio.
 */
export type PosthogEmbedConfig =
  | { status: 'ok'; url: string }
  | { status: 'missing' | 'invalid'; url: null }

/** `https://us.posthog.com/embedded/<código>` o `/shared/<código>`, sin nada más. */
export const POSTHOG_EMBED_URL_RE = /^https:\/\/us\.posthog\.com\/(embedded|shared)\/[A-Za-z0-9_-]+\/?(\?[^\s]*)?$/
