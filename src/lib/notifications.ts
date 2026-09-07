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
 * `notification_type` — los seis valores del enum de Postgres. Se listan a mano
 * (no hay forma de alcanzar el contrato del backend desde este repo) con la
 * misma red que el resto: un valor que no esté acá se renderiza CRUDO, no en
 * blanco. Los chips del filtro se arman con los `type` que de hecho aparecen en
 * la base, así que un valor nuevo del enum aparece solo aunque falte su label.
 */
export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  document_expiration: 'Vencimiento de documento',
  maintenance_reminder: 'Recordatorio de mantenimiento',
  diagnostic_available: 'Diagnóstico disponible',
  fine_pending: 'Multa pendiente',
  dtc_active: 'DTC activo',
  vehicle_data_ready: 'Datos del vehículo listos',
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
   * El `notification_type`. La clave del search param es `kind` y no `type` a
   * propósito: `/chats` ya tiene un `type` que es un `z.enum` cerrado, y
   * TanStack Router arma un tipo unión de TODOS los search params del router —
   * un `type: string` acá ensancharía el de chats y rompería sus
   * `<Link search={(prev) => …}>`. La columna en la base y el campo de la fila
   * siguen siendo `type`; sólo la llave de la URL cambia.
   *
   * Texto libre, no un `z.enum`: las opciones se arman con los valores
   * presentes en la base (`listNotificationFacets`), así un valor nuevo del
   * enum aparece sin tocar código. Mismo criterio que el filtro de modelo en
   * `chats.ts`.
   */
  kind: z.string().trim().max(60).optional(),
  channel: z.string().trim().max(20).optional(),
  /** Estado derivado — acá SÍ es lista cerrada, es vocabulario nuestro. */
  state: z.enum(NOTIFICATION_STATE_FILTERS).optional(),
  sort: z.enum(NOTIFICATION_SORT_KEYS).catch('scheduledAt').default('scheduledAt'),
  dir: z.enum(NOTIFICATION_SORT_DIRS).catch('desc').default('desc'),
})

export type NotificationSearch = z.infer<typeof notificationSearchSchema>

export interface NotificationFacets {
  /** `type`s presentes en la base, para los chips. */
  types: Array<string>
  channels: Array<string>
}
