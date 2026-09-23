import { z } from 'zod'

/**
 * Feedback (`/feedback`).
 *
 * Reemplaza el `select * from feedback order by submitted_at desc` + el join
 * a `users` que hoy nadie corre: el feedback sólo se ve como una fila más del
 * `UNION ALL` de `/actividad` y como un contador en el censo de
 * `/usuarios/:id`. Acá es la pantalla dueña — mismo criterio que `/chats`:
 * `/actividad` mira UNA tabla por fila, y la que tiene dueño no repite su
 * ficha adentro del feed. → `.claude/rules/activity-feed.md`, trampa "Adónde
 * lleva un click".
 *
 * `feedback` es chica (5 filas al 2026-09-23, de 3 usuarios): SSR completo,
 * sin ventana por default (una ventana de 30 días vaciaría la pantalla — el
 * mismo motivo por el que `/metricas` no tiene ventana en la tabla de
 * adopción), y sin paginar (mismo criterio que `/chats` y `/usuarios`: con
 * pocas filas, paginar es peor que buscar).
 */

export interface FeedbackListItem {
  id: string
  userId: string
  userEmail: string
  userName: string | null
  /** Completo, sin truncar — 127 caracteres es el más largo hoy, y el mensaje es el dato. */
  message: string
  appVersion: string | null
  /** `feedback_platform`, hoy `ios | android`. Texto libre para el panel: no es vocabulario nuestro. */
  platform: string | null
  deviceModel: string | null
  osVersion: string | null
  submittedAt: string
  /** Cuántos autos tiene HOY, para leer el mensaje con contexto sin abrir la ficha. */
  vehicleCount: number
  /** `lastSignalSql` de `~/lib/activity` — la MISMA señal que `/usuarios`. `null` = sin ninguna. */
  lastActivityAt: string | null
  /** Cuántos feedbacks mandó ESTA persona en total (esta fila incluida). */
  feedbackCount: number
  /**
   * Filas de `expo_push_tokens` — para el botón "Responder" con un push
   * (`BroadcastComposer`, `presetRecipient`): con `0` la notificación se crea
   * igual y queda `sin_token`, y el compositor ya avisa de eso al elegir un
   * destinatario. `.claude/rules/notifications.md`.
   */
  pushTokenCount: number
}

// ── Search params ────────────────────────────────────────────────────────────

export const FEEDBACK_WINDOWS = ['7d', '30d', '90d', 'all'] as const
export type FeedbackWindow = (typeof FEEDBACK_WINDOWS)[number]

export const FEEDBACK_WINDOW_LABELS: Record<FeedbackWindow, string> = {
  '7d': '7 días',
  '30d': '30 días',
  '90d': '90 días',
  all: 'Todo',
}

export const FEEDBACK_WINDOW_HOURS: Record<FeedbackWindow, number | null> = {
  '7d': 24 * 7,
  '30d': 24 * 30,
  '90d': 24 * 90,
  all: null,
}

export const FEEDBACK_SORT_KEYS = ['submittedAt', 'appVersion', 'platform', 'user', 'messageLength'] as const
export type FeedbackSortKey = (typeof FEEDBACK_SORT_KEYS)[number]

export const FEEDBACK_SORT_DIRS = ['asc', 'desc'] as const
export type FeedbackSortDir = (typeof FEEDBACK_SORT_DIRS)[number]

/**
 * Search params calificados por dominio (`feedbackPlatform`, no `platform`
 * pelado): `platform` es justo el tipo de nombre genérico que otra pantalla
 * va a querer mañana, y TanStack mergea los search params de TODAS las rutas
 * en un solo tipo — dos enums bajo la misma clave rompen el typecheck de la
 * ruta AJENA, no de ésta. Ya rompió un build de producción una vez.
 * → `.claude/rules/notifications.md`
 */
export const feedbackSearchSchema = z.object({
  /** Busca en el mensaje, el email y el nombre. */
  q: z.string().trim().max(120).optional(),
  /** Data-driven (`listDistinctFeedbackPlatforms`), nunca hardcodeado. */
  feedbackPlatform: z.string().trim().max(60).optional(),
  feedbackAppVersion: z.string().trim().max(60).optional(),
  /** Default `all`: con 5 filas en producción, cualquier ventana la vaciaría. */
  feedbackWindow: z.enum(FEEDBACK_WINDOWS).catch('all').default('all'),
  /** Para linkear desde el censo de `/usuarios/:id` y desde `/actividad`. */
  userId: z.uuid().optional(),
  sort: z.enum(FEEDBACK_SORT_KEYS).catch('submittedAt').default('submittedAt'),
  dir: z.enum(FEEDBACK_SORT_DIRS).catch('desc').default('desc'),
})

export type FeedbackSearch = z.infer<typeof feedbackSearchSchema>
