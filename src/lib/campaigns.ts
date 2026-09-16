import { z } from 'zod'
import type { NotificationState } from './notifications'

/**
 * Envíos (`/notificaciones/envios`) — qué se mandó y qué pasó después.
 *
 * ── Qué consulta reemplaza ───────────────────────────────────────────────────
 *
 * Ninguna, y no por descuido: **hoy no hay forma de mirar un envío ad-hoc como
 * una unidad.** `notifications` guarda una fila por persona con
 * `source_type = 'broadcast'` y `source_id = <el broadcastId>`; agruparlas es un
 * `group by source_id` que nadie corre, y el compositor sólo muestra el
 * resultado del envío que acaba de hacer — al recargar se pierde.
 *
 * ── Un envío NO es una entidad: es un `group by` ────────────────────────────
 *
 * No hay tabla de campañas. Lo que existe es el `source_id` compartido, que el
 * panel genera como clave de idempotencia (`.claude/rules/notifications.md`).
 * Todo lo que esta pantalla muestra se DERIVA de las filas de `notifications`.
 *
 * Consecuencia, y hay que decirla en pantalla: **no se puede saber con qué
 * condición se eligió la audiencia.** Eso vive en el compositor mientras está
 * abierto y no se persiste en ningún lado — guardarlo sería una tabla en `ops`,
 * que es una migración y una decisión aparte. Lo que sí se sabe es a QUIÉNES les
 * llegó, que es lo que hace medible el resultado.
 *
 * ── Lo que tampoco se puede medir, y por qué ────────────────────────────────
 *
 * **Cuándo la leyó.** `notifications` tiene `status = 'read'` pero NO una
 * columna `read_at` (ni `updated_at`): se sabe que la abrió, nunca cuánto tardó.
 * No se estima con `receipts_checked_at` —que es del proveedor push, no de la
 * persona— ni con nada más. Es un agujero del schema del backend, no algo que
 * este repo pueda derivar. Mismo criterio que `CANT_MEASURE_YET` en
 * `.claude/rules/metricas.md`: una fila que no se puede medir se declara, no se
 * rellena con un número plausible.
 */

// ── Qué pasó después ─────────────────────────────────────────────────────────

/**
 * Una tabla de `public` cuya fila nueva, después del envío, cuenta como "hizo
 * algo". Misma forma exacta que `ActivitySignal` en `~/lib/activity`, y por el
 * mismo motivo: declarar CUÁLES cuentan en un solo lugar en vez de repetir
 * subconsultas por toda la consulta.
 */
export interface OutcomeSource {
  table: string
  /** Columna FK al usuario. */
  userColumn: string
  /** Columna de timestamp que se compara contra el momento del envío. */
  tsColumn: string
  /** Predicado extra sobre el alias `t`, si esa tabla lo necesita. */
  where?: string
}

export const CAMPAIGN_OUTCOME_KEYS = [
  'vehicle',
  'document',
  'scan',
  'chat',
  'pushToken',
  'maintenance',
] as const
export type CampaignOutcomeKey = (typeof CAMPAIGN_OUTCOME_KEYS)[number]

export interface CampaignOutcomeDef {
  key: CampaignOutcomeKey
  label: string
  hint: string
  sources: ReadonlyArray<OutcomeSource>
}

/**
 * Las acciones que se miran después de un envío. Lista CERRADA.
 *
 * ── Son las mismas seis para todos los envíos, a propósito ──────────────────
 *
 * Sin una tabla en `ops` no hay dónde guardar "el objetivo de ESTA campaña", así
 * que en vez de inventarlo se muestran las seis siempre. Sale más honesto de lo
 * que parece: si una campaña pidiendo cargar la VTV termina con tres personas
 * escaneando el auto y ninguna cargando el documento, eso también es un
 * resultado, y un objetivo único lo habría escondido.
 *
 * ── Es correlación, no causalidad, y la UI lo dice ──────────────────────────
 *
 * "Lo hizo después de recibirla" no es "lo hizo POR la notificación". No hay
 * grupo de control (mandarle a la mitad y a la otra no es una decisión de
 * producto, no de este archivo) y las seis acciones pasan solas todo el tiempo.
 * El número igual sirve: sin él no hay ninguno.
 *
 * `quote_requests` NO está, aunque "pidió un presupuesto" sería el resultado
 * más valioso: esa tabla puede no existir en la base (`leads.md`, el guard de
 * disponibilidad), y una consulta que explota con un 500 en una pantalla que
 * hoy no necesita ningún guard es un costo peor que el dato que agrega.
 */
export const CAMPAIGN_OUTCOMES: ReadonlyArray<CampaignOutcomeDef> = [
  {
    key: 'vehicle',
    label: 'Cargó un vehículo',
    hint: 'Una fila nueva en `vehicles`, archivada o no.',
    sources: [{ table: 'vehicles', userColumn: 'user_id', tsColumn: 'created_at' }],
  },
  {
    key: 'document',
    label: 'Cargó un documento',
    hint: 'Seguro, VTV, cédula o licencia CON archivo — el mismo "es OCR" de /documentos.',
    sources: [
      {
        table: 'insurances',
        userColumn: 'user_id',
        tsColumn: 'created_at',
        where: 't.file_id is not null',
      },
      {
        table: 'vehicle_inspections',
        userColumn: 'user_id',
        tsColumn: 'created_at',
        where: 't.file_id is not null',
      },
      {
        table: 'registration_cards',
        userColumn: 'user_id',
        tsColumn: 'created_at',
        where: 't.file_id is not null',
      },
      {
        table: 'driver_licenses',
        userColumn: 'user_id',
        tsColumn: 'created_at',
        where: 't.file_id is not null',
      },
    ],
  },
  {
    key: 'scan',
    label: 'Escaneó el auto',
    hint: 'Cualquier sesión, haya traído datos o no: la intención cuenta igual.',
    sources: [{ table: 'driving_sessions', userColumn: 'user_id', tsColumn: 'created_at' }],
  },
  {
    key: 'chat',
    label: 'Habló con el asistente',
    hint: 'Una conversación con al menos un mensaje.',
    sources: [
      {
        table: 'conversations',
        userColumn: 'user_id',
        tsColumn: 'created_at',
        where: 'exists (select 1 from conversation_messages m where m.conversation_id = t.id)',
      },
    ],
  },
  {
    key: 'pushToken',
    label: 'Registró un dispositivo',
    hint: 'Sirve para las campañas que llegaron a gente sin token: volvió a abrir la app.',
    sources: [{ table: 'expo_push_tokens', userColumn: 'user_id', tsColumn: 'created_at' }],
  },
  {
    key: 'maintenance',
    label: 'Registró un mantenimiento',
    hint: 'Ocurrencia cargada por una persona (sin plan), no la que autogenera el plan.',
    sources: [
      {
        table: 'maintenance_occurrences',
        userColumn: 'user_id',
        tsColumn: 'created_at',
        where: 't.plan_id is null',
      },
    ],
  },
]

/**
 * `exists (...)` para una acción, comparada contra el momento del envío.
 *
 * `userRef` y `tsRef` son alias de la consulta que llama (`r.user_id`, `r.ref`),
 * nunca entrada de usuario — mismo contrato que `lastSignalSql` en
 * `~/lib/activity`. `cmp` es `<=` (antes del envío) o `>` (después).
 */
export function outcomeExistsSql(
  outcome: CampaignOutcomeDef,
  cmp: '<=' | '>',
  userRef: string,
  tsRef: string,
): string {
  return outcome.sources
    .map(
      (s) =>
        `exists (select 1 from ${s.table} t where t.${s.userColumn} = ${userRef}` +
        `${s.where ? ` and ${s.where}` : ''} and t.${s.tsColumn} ${cmp} ${tsRef})`,
    )
    .join(' or ')
}

// ── Forma de fila ────────────────────────────────────────────────────────────

export interface CampaignStateCount {
  state: NotificationState
  count: number
}

export interface CampaignListItem {
  broadcastId: string
  /** Todas las filas de un envío comparten título y cuerpo: se toma el de la primera. */
  title: string
  body: string
  recipients: number
  /** `status = 'read'`, contadas aparte porque es LA métrica del envío. */
  read: number
  /** Cuántas no le van a llegar a nadie: «Sin token» + «Rechazada». */
  undelivered: number
  states: Array<CampaignStateCount>
  scheduledAt: string
  /** El primer `sent_at` del lote. `null` = todavía no salió ninguna. */
  sentAt: string | null
  createdAt: string
}

export interface CampaignOutcomeSummary {
  key: CampaignOutcomeKey
  /**
   * De los que recibieron, cuántos NO habían hecho esa acción antes del envío.
   * Es el denominador honesto: quien ya había cargado su auto no podía
   * "convertir".
   */
  pendingBefore: number
  /** De ésos, cuántos la hicieron después. */
  converted: number
}

export interface CampaignRecipientOutcome {
  key: CampaignOutcomeKey
  hadBefore: boolean
  didAfter: boolean
}

export interface CampaignRecipientRow {
  notificationId: string
  userId: string
  email: string
  name: string | null
  state: NotificationState
  sentAt: string | null
  outcomes: Array<CampaignRecipientOutcome>
}

export interface CampaignDetail {
  campaign: CampaignListItem
  outcomes: Array<CampaignOutcomeSummary>
  recipients: Array<CampaignRecipientRow>
}

// ── Search params ────────────────────────────────────────────────────────────

export const CAMPAIGN_SORT_KEYS = ['sentAt', 'recipients', 'read', 'title'] as const
export type CampaignSortKey = (typeof CAMPAIGN_SORT_KEYS)[number]

export const CAMPAIGN_SORT_DIRS = ['asc', 'desc'] as const
export type CampaignSortDir = (typeof CAMPAIGN_SORT_DIRS)[number]

/**
 * `campaignSort` / `campaignDir`, calificados por dominio.
 *
 * `sort` y `dir` ya los usa `/notificaciones` con `NOTIFICATION_SORT_KEYS`, que
 * es un enum disjunto de éste. TanStack arma un tipo unión de TODOS los search
 * params del router y el spread `{...prev}` de un updater arrastra el tipo
 * ancho: dos enums distintos bajo la misma clave rompen el typecheck en la ruta
 * AJENA, en un archivo que nadie tocó. Ya pasó dos veces.
 * → `.claude/rules/notifications.md`
 *
 * `q` sí se comparte: es `string` en las dos y el conflicto es `string` contra
 * enum, o dos enums disjuntos.
 */
export const campaignSearchSchema = z.object({
  q: z.string().trim().max(120).optional(),
  campaignSort: z.enum(CAMPAIGN_SORT_KEYS).catch('sentAt').default('sentAt'),
  campaignDir: z.enum(CAMPAIGN_SORT_DIRS).catch('desc').default('desc'),
})

export type CampaignSearch = z.infer<typeof campaignSearchSchema>
