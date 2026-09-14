import { z } from 'zod'

/**
 * Notificaciones — `/notificaciones`, el contrato compartido servidor ↔ cliente.
 *
 * ── Qué consulta reemplaza ───────────────────────────────────────────────────
 *
 * El `select * from notifications where user_id = '…'` que hoy es la única forma
 * de ver de qué le avisamos a una persona y si le llegó. `/usuarios/:id` cuenta
 * esa relación en el censo pero no la muestra; `/operacion` la agrega en cuatro
 * números (`ok` / `failed` / `stuck` / `retrying`) y manda acá para el detalle.
 * Esta pantalla es la fila, con lo que ese `select` no contesta solo: el nombre
 * del usuario, la etiqueta del vehículo, y el estado de entrega leído de las
 * DOS columnas que lo definen.
 *
 * ── `status` y `delivery_status` son DOS ejes, no uno ────────────────────────
 *
 * `notifications.status` es `pending | sent | read` — el ciclo de vida de la
 * fila. `notifications.delivery_status` es `null | sent | failed | no_token` —
 * qué dijo el proveedor push. No se puede leer uno sin el otro:
 *
 *  - `pending` + `delivery_status = null`     → nunca se intentó (programada, o
 *                                               atrasada si venció el `scheduled_at`).
 *  - `pending` + `delivery_status = no_token` → se intentó, la persona no tiene
 *                                               dispositivo. `notification-delivery.cron`
 *                                               NO toca `status`, así que la fila
 *                                               sigue siendo elegible y se
 *                                               reintenta cada minuto, sin tope.
 *  - `sent`    + `delivery_status = sent`     → entregada al proveedor.
 *  - `sent`    + `delivery_status = failed`   → el proveedor la aceptó y después
 *                                               un receipt la rechazó
 *                                               (`receipts_checked_at`). `status`
 *                                               ya quedó en `sent` — es TERMINAL,
 *                                               no se reintenta.
 *  - `read`                                   → la persona la abrió.
 *
 * `sin_token` y `rechazada` se ven parecido y son opuestos: uno reintenta para
 * siempre, el otro no reintenta nunca. Misma distinción que `stuck` vs
 * `retrying` en `.claude/rules/ops-metrics.md`.
 *
 * ── `atrasada` es deducción nuestra, no un estado del dominio ─────────────────
 *
 * El dominio no tiene "atrasada": es `pending` + sin intento + `scheduled_at`
 * vencido pasado el umbral. Nadie la escribe, se deduce del reloj — misma forma
 * que `stuck` en `/operacion` y `noData` en `/escaneres`, y por eso la UI lo
 * dice en voz alta. El umbral es el MISMO que usa `/operacion` para la cola de
 * notificaciones: `NOTIFICATION_DELAYED_AFTER_MIN`, importado por
 * `ops.repo.ts`. Si divergen, el panel dice dos verdades sobre la misma fila.
 */

// ── Vocabulario del dominio ──────────────────────────────────────────────────

/**
 * `notification_type` — los valores del enum de Postgres (siete al 2026-09-14).
 * Se listan a mano (no hay forma de alcanzar el contrato del backend desde este
 * repo) con la misma red que el resto: un valor que no esté acá se renderiza
 * CRUDO, no en blanco. Los chips del filtro se arman con los `type` que de hecho
 * aparecen en la base, así que un valor nuevo del enum aparece solo aunque falte
 * su label.
 */
export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  document_expiration: 'Vencimiento de documento',
  maintenance_reminder: 'Recordatorio de mantenimiento',
  diagnostic_available: 'Diagnóstico disponible',
  fine_pending: 'Multa pendiente',
  dtc_active: 'DTC activo',
  vehicle_data_ready: 'Datos del vehículo listos',
  // El único `type` que no nace de una entidad del dominio: lo manda un admin
  // (`POST /notifications/broadcast`). El backend lo DERIVA de
  // `source_type = 'broadcast'`; nadie lo elige.
  announcement: 'Anuncio',
}

/**
 * `notification_source_type` — de qué entidad salió la notificación. `type` la
 * agrupa (los cuatro documentos caen todos en `document_expiration`); el
 * `source_type` es el grano fino. Nullable en el schema; hoy 100% poblado.
 */
export const NOTIFICATION_SOURCE_LABELS: Record<string, string> = {
  insurance: 'Seguro',
  vehicle_inspection: 'VTV',
  registration_card: 'Cédula',
  driver_license: 'Licencia de conducir',
  fine: 'Multa',
  maintenance_occurrence: 'Service',
  diagnostic_dtc: 'DTC',
  ai_diagnostic: 'Diagnóstico de IA',
  vehicle_data_query: 'Consulta de datos',
  // No apunta a ninguna tabla: `source_id` es el `broadcastId` de la campaña,
  // usado como clave de idempotencia. → `.claude/rules/notifications.md`
  broadcast: 'Envío manual',
}

/**
 * Umbral para marcar una notificación pendiente como `atrasada`.
 *
 * 30 minutos: `notification-delivery.cron` corre cada minuto sobre
 * `status = 'pending' AND scheduled_at <= now()`, así que media hora sin un
 * solo intento registrado no es lentitud, es el cron caído.
 *
 * ⚠ Este número tiene que ser el MISMO que `STUCK_AFTER_MINUTES.notifications`
 * en `src/server/ops.repo.ts` — ese archivo lo importa de acá justamente para
 * que no puedan divergir. → `.claude/rules/ops-metrics.md`, trampa 2.
 */
export const NOTIFICATION_DELAYED_AFTER_MIN = 30

// ── Estado derivado ──────────────────────────────────────────────────────────

/**
 * El estado que muestra la pantalla — derivado de `status` + `delivery_status`
 * + el reloj. Es vocabulario NUESTRO (no un enum del backend), así que la lista
 * es cerrada y va acá, no data-driven. El SQL que lo calcula vive en
 * `notifications.repo.ts` como una única expresión `CASE` reusada por el SELECT
 * y por el WHERE del filtro — mismo patrón que `INTERNAL_PREDICATE`.
 *
 * `desconocida` es la red: si aparece una combinación que el `CASE` no cubre,
 * se ve, no se esconde.
 */
export const NOTIFICATION_STATES = [
  'entregada',
  'leida',
  'rechazada',
  'sin_token',
  'atrasada',
  'programada',
  'enviada',
  'desconocida',
] as const
export type NotificationState = (typeof NOTIFICATION_STATES)[number]

export const NOTIFICATION_STATE_LABELS: Record<NotificationState, string> = {
  entregada: 'Entregada',
  leida: 'Leída',
  rechazada: 'Rechazada',
  sin_token: 'Sin token',
  atrasada: 'Atrasada',
  programada: 'Programada',
  enviada: 'Enviada',
  desconocida: 'Estado desconocido',
}

export type NotificationStateTone = 'ok' | 'warn' | 'bad' | 'neutral'

/**
 * El tono de cada estado. `rechazada` es roja (falló y no reintenta);
 * `sin_token` y `atrasada` son ámbar (algo hay que hacer, pero no está perdido
 * — el cron reintenta). `entregada`/`leida` verde. Lo demás, neutro.
 */
export const NOTIFICATION_STATE_TONE: Record<NotificationState, NotificationStateTone> = {
  entregada: 'ok',
  leida: 'ok',
  rechazada: 'bad',
  sin_token: 'warn',
  atrasada: 'warn',
  programada: 'neutral',
  enviada: 'neutral',
  desconocida: 'neutral',
}

/** Los estados que un operador filtra para encontrar trabajo. Orden de chips. */
export const NOTIFICATION_STATE_FILTERS = [
  'rechazada',
  'sin_token',
  'atrasada',
  'programada',
  'entregada',
  'leida',
] as const
export type NotificationStateFilter = (typeof NOTIFICATION_STATE_FILTERS)[number]

// ── Forma de fila ────────────────────────────────────────────────────────────

export interface NotificationListItem {
  id: string
  userId: string
  userEmail: string
  userName: string | null
  type: string
  sourceType: string | null
  /** Cadena `vehicles → specs → catalogs`, toda LEFT: `vehicle_id` es nullable. */
  vehicleId: string | null
  vehiclePlate: string | null
  vehicleBrand: string | null
  vehicleModel: string | null
  vehicleYear: number | null
  channel: string
  title: string
  body: string
  state: NotificationState
  /** `delivery_error` crudo del proveedor — sólo cuando `state = 'rechazada'`. */
  deliveryError: string | null
  scheduledAt: string
  sentAt: string | null
  createdAt: string
}

// ── Search params ────────────────────────────────────────────────────────────

export const NOTIFICATION_SORT_KEYS = [
  'user',
  'type',
  'vehicle',
  'state',
  'scheduledAt',
  'sentAt',
] as const
export type NotificationSortKey = (typeof NOTIFICATION_SORT_KEYS)[number]

export const NOTIFICATION_SORT_DIRS = ['asc', 'desc'] as const
export type NotificationSortDir = (typeof NOTIFICATION_SORT_DIRS)[number]

/**
 * Ver la nota sobre los dos modos de falla de zod en `~/lib/search`. Todo
 * degrada con `.catch()` menos `userId`: un uuid ilegible en la URL no se
 * recupera a un default sano, así que tira y lo muestra el `errorComponent`.
 */
export const notificationSearchSchema = z.object({
  /** Busca en usuario (email/nombre), patente y el texto del mensaje. */
  q: z.string().trim().max(120).optional(),
  /** Se llega así desde la ficha del usuario. `optional`, no `.catch`. */
  userId: z.uuid().optional(),
  /**
   * El `notification_type`. La clave del search param es `notificationType`, no
   * `type` ni `kind`, y las DOS colisiones que descarta ya pasaron de verdad:
   * `/chats` tiene un `type` que es un `z.enum` cerrado, y `/documentos` tiene
   * un `kind` que también lo es. TanStack Router arma un tipo unión de TODOS
   * los search params del router, así que un `string` acá ensancha el ajeno y
   * rompe sus `<Link search={(prev) => …}>` — un error en un archivo que nadie
   * tocó. La columna en la base y el campo de la fila siguen siendo `type`;
   * sólo la llave de la URL cambia.
   *
   * Texto libre, no un `z.enum`: las opciones se arman con los valores
   * presentes en la base (`listNotificationFacets`), así un valor nuevo del
   * enum aparece sin tocar código. Mismo criterio que el filtro de modelo en
   * `chats.ts`.
   */
  notificationType: z.string().trim().max(60).optional(),
  channel: z.string().trim().max(20).optional(),
  /**
   * Estado derivado — acá SÍ es lista cerrada, es vocabulario nuestro.
   *
   * Calificado por el mismo motivo que `notificationType`: `/vehiculos/listado`
   * ya usa `state` con su propio enum (`all | active | archived`).
   */
  notificationState: z.enum(NOTIFICATION_STATE_FILTERS).optional(),
  /**
   * Las filas de UNA campaña ad-hoc: `source_type = 'broadcast'` y
   * `source_id = <este uuid>`. Se llega así desde el resultado de
   * `BroadcastComposer`. Calificado (no `broadcastId` ni `campaign`) por la
   * regla de `FullSearchSchema`: un nombre genérico es un nombre que otra
   * pantalla va a querer. `optional`, no `.catch`, igual que `userId`.
   */
  notificationBroadcastId: z.uuid().optional(),
  sort: z.enum(NOTIFICATION_SORT_KEYS).catch('scheduledAt').default('scheduledAt'),
  dir: z.enum(NOTIFICATION_SORT_DIRS).catch('desc').default('desc'),
})

export type NotificationSearch = z.infer<typeof notificationSearchSchema>

export interface NotificationFacets {
  /** `type`s presentes en la base, para los chips. */
  types: Array<string>
  channels: Array<string>
}

// ── Envío ad-hoc (`POST /notifications/broadcast`) ───────────────────────────

/**
 * Los topes del DTO del backend (`broadcast-notification.dto.ts`), espejados
 * para avisar ANTES de mandar. Si el backend los cambia y acá no, el síntoma es
 * un 400 legible, no un dato roto: el que decide sigue siendo el backend.
 *
 * El de 500 no es configurable del otro lado a propósito — el alta es un INSERT
 * sincrónico dentro del request. Una campaña más grande es otra feature (un job
 * de background), no un número más alto acá.
 */
export const BROADCAST_MAX_RECIPIENTS = 500
export const BROADCAST_TITLE_MAX = 100
export const BROADCAST_BODY_MAX = 500

/** Debajo de esto el buscador de destinatarios ni pregunta: `ilike '%a%'` es el padrón. */
export const RECIPIENT_SEARCH_MIN_CHARS = 2

/**
 * El payload del envío. Una sola definición para el server function y para el
 * formulario — regla dura 5.
 *
 * Lo que NO está, y es a propósito: **el actor.** Quién manda la campaña lo dice
 * el token de Clerk con el que `backend.ts` llama; un campo de payload sería
 * una firma falsificable (mismo criterio que `p_actor_id` en los SP de `ops`).
 *
 * - `userIds` se deduplica ANTES de medir el tope: el mismo usuario agregado dos
 *   veces es un usuario, y el índice único del backend lo colapsaría igual.
 * - `title`/`body` se trimean acá porque `MaxLength` del DTO mide el string
 *   crudo, mientras `Notification.create()` guarda el trimeado: sin trim, un
 *   título de 98 letras con tres espacios rebota por "demasiado largo".
 * - `scheduledAt` tiene que ser futuro. El backend acepta uno pasado sin quejarse
 *   —el cron lo entrega en el próximo tick—, pero un "programar" en el pasado es
 *   casi siempre un error de zona horaria, y mandar ya algo que se quería mandar
 *   mañana no tiene vuelta atrás.
 */
export const broadcastNotificationSchema = z.object({
  broadcastId: z.uuid(),
  userIds: z
    .array(z.uuid())
    .transform((ids) => [...new Set(ids)])
    .pipe(
      z
        .array(z.string())
        .min(1, 'Elegí al menos un destinatario.')
        .max(
          BROADCAST_MAX_RECIPIENTS,
          `Hasta ${BROADCAST_MAX_RECIPIENTS} destinatarios por envío.`,
        ),
    ),
  title: z
    .string()
    .trim()
    .min(1, 'El título no puede quedar vacío.')
    .max(BROADCAST_TITLE_MAX, `El título admite hasta ${BROADCAST_TITLE_MAX} caracteres.`),
  body: z
    .string()
    .trim()
    .min(1, 'El mensaje no puede quedar vacío.')
    .max(BROADCAST_BODY_MAX, `El mensaje admite hasta ${BROADCAST_BODY_MAX} caracteres.`),
  scheduledAt: z.iso
    .datetime({ offset: true })
    .optional()
    .refine((iso) => iso === undefined || new Date(iso).getTime() > Date.now(), {
      message: 'La fecha programada ya pasó.',
    }),
})

export type BroadcastNotificationInput = z.input<typeof broadcastNotificationSchema>

export const recipientSearchSchema = z.object({
  q: z.string().trim().min(RECIPIENT_SEARCH_MIN_CHARS).max(120),
})

/** Un candidato del buscador del compositor. */
export interface NotificationRecipient {
  id: string
  email: string
  name: string | null
  /**
   * Filas de `expo_push_tokens`. Con `0` la notificación se crea igual y queda
   * `sin_token`, reintentando cada minuto para siempre — por eso la UI lo avisa
   * al elegirlo, no después.
   */
  pushTokens: number
}

/** Lo que Postgres dice que quedó de una campaña, leído por `source_id`. */
export interface BroadcastResult {
  broadcastId: string
  /** Filas creadas. Menos que los elegidos = silenciados o ya existentes. */
  created: number
  byState: Array<{ state: NotificationState; count: number }>
}
