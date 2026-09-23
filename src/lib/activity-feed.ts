import { z } from 'zod'

/**
 * El feed de actividad de la app — `/actividad`.
 *
 * ── Qué consulta reemplaza ───────────────────────────────────────────────────
 *
 * Ninguna, y por el peor de los motivos: **hoy no hay forma de contestar "¿qué
 * está pasando en la app?"**. Cada pantalla del panel mira UNA tabla
 * (`/chats` las conversaciones, `/documentos` los OCR, `/escaneres` las
 * sesiones), así que saber qué hizo la gente hoy son quince `select … order by
 * created_at desc limit 20` sueltos y un merge a ojo. Eso no lo corre nadie.
 *
 * Esta pantalla ES ese merge, hecho por Postgres: un `UNION ALL` normalizado a
 * una forma común, ordenado por cuándo pasó.
 *
 * ── Qué cuenta como actividad ───────────────────────────────────────────────
 *
 * **Lo que hizo una PERSONA en la app.** Decidido el 2026-09-16, y el corte
 * tiene consecuencias:
 *
 *  - **Entran** las filas que sólo existen porque alguien tocó la app: se
 *    registró, cargó un auto, habló con el asistente, escaneó, subió un
 *    documento, anotó un mantenimiento, pidió un presupuesto, consultó multas o
 *    datos de su patente, registró el teléfono, inició sesión, mandó feedback.
 *  - **No entran** los hechos que escribe el sistema solo. Y no es una
 *    omisión: cada uno ya tiene su pantalla, y mezclarlos ahogaría al resto.
 *
 * | Fuera | Por qué |
 * |---|---|
 * | `notifications` (242 filas) | Es lo que NOSOTROS le mandamos, no lo que hizo. Tiene `/notificaciones`. |
 * | `fines` (659) | Las escribe el proveedor al sincronizar. La ACCIÓN es la consulta, y esa entra una vez por auto (`consulta_multas`). |
 * | `vehicle_inspections` con `source='provider'` (46) | Un lookup a una API por patente, no un documento que alguien subió. Mismo predicado que `/documentos`. |
 * | `legal_acceptances` (298) | Subproducto del alta: dos filas por usuario, en el mismo segundo que su `alta_usuario`. No agrega un hecho, agrega ruido. |
 * | `assistant_proposals` (5) | La propone la IA. Aceptarla sí es del usuario, pero con 5 filas todavía no vale una rama. |
 * | `partner_applications` (14) | Es un taller, no un usuario de la app — la columna "quién" quedaría vacía. Tiene `/solicitudes`. |
 * | `recommendation_impressions`, `leads` | 0 filas en producción. |
 *
 * Si mañana una de esas se vuelve importante, es una rama más en
 * `activity-feed.repo.ts` + una entrada acá. Eso es todo.
 *
 * ── Relación con `~/lib/activity` ───────────────────────────────────────────
 *
 * `USER_ACTIVITY_SIGNALS` (ese otro archivo) lista tres tablas y contesta otra
 * pregunta: "¿cuándo fue la ÚLTIMA vez que esta persona hizo algo?", para la
 * columna de `/usuarios` y el churn de `/negocio`. Este feed es un superconjunto
 * suyo y NO se deriva de él: acá cada rama necesita sus propias columnas de
 * detalle, y allá lo que importa es que las dos pantallas usen la misma lista.
 * **Agregar una rama acá no la convierte en señal de churn** — eso se decide
 * aparte, en ese archivo.
 *
 * ── Ni una escritura ────────────────────────────────────────────────────────
 *
 * Un evento es un hecho que pasó, no un estado que el admin mueva — mismo
 * criterio que `driving_sessions`, `conversations` y `notifications`. Si aparece
 * un `UPDATE`/`INSERT` en `activity-feed.repo.ts`, está mal.
 */

// ── Los tipos de evento ──────────────────────────────────────────────────────

export const ACTIVITY_KINDS = [
  'alta_usuario',
  'vehiculo',
  'chat',
  'escaneo',
  'seguro',
  'cedula',
  'registro',
  'vtv',
  'mantenimiento',
  'plan_mantenimiento',
  'pedido',
  'consulta_multas',
  'consulta_datos',
  'dispositivo',
  'login',
  'feedback',
] as const

export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

/**
 * La etiqueta es una FRASE EN PASADO, no un sustantivo: la fila se lee
 * "Fulano · habló con el asistente · sobre el Corolla". Un "Chat" suelto ahí
 * obliga a reconstruir mentalmente qué pasó.
 */
export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  alta_usuario: 'Se registró',
  vehiculo: 'Cargó un vehículo',
  chat: 'Habló con el asistente',
  escaneo: 'Escaneó el auto',
  seguro: 'Cargó el seguro',
  cedula: 'Cargó la cédula',
  registro: 'Cargó el registro',
  vtv: 'Cargó la VTV',
  mantenimiento: 'Anotó un mantenimiento',
  plan_mantenimiento: 'Creó un plan de mantenimiento',
  pedido: 'Pidió un presupuesto',
  consulta_multas: 'Consultó las multas',
  consulta_datos: 'Consultó datos de la patente',
  dispositivo: 'Registró un dispositivo',
  login: 'Inició sesión',
  feedback: 'Mandó feedback',
}

/** Etiqueta corta para los chips del filtro, donde la frase en pasado no entra. */
export const ACTIVITY_KIND_SHORT: Record<ActivityKind, string> = {
  alta_usuario: 'Altas',
  vehiculo: 'Vehículos',
  chat: 'Chats',
  escaneo: 'Escaneos',
  seguro: 'Seguros',
  cedula: 'Cédulas',
  registro: 'Registros',
  vtv: 'VTV',
  mantenimiento: 'Mantenimiento',
  plan_mantenimiento: 'Planes',
  pedido: 'Pedidos',
  consulta_multas: 'Multas',
  consulta_datos: 'Datos de patente',
  dispositivo: 'Dispositivos',
  login: 'Logins',
  feedback: 'Feedback',
}

// ── El destino de cada fila ──────────────────────────────────────────────────

/**
 * Los tipos que tienen ficha propia EN ESTA sección (`/actividad/:tipo/:id`).
 *
 * Decidido el 2026-09-16: **una fila lleva a la pantalla que ya es dueña de esa
 * entidad**, no a una copia. Un chat abre `/chats/:id` con la conversación
 * entera; un escaneo abre `/escaneres/sesiones/:id` con su telemetría. Repetir
 * esas pantallas acá sería el mismo error que el `CLAUDE.md` prohíbe en su
 * premisa: una pantalla que no reemplaza ninguna consulta.
 *
 * Esta lista es el RESTO — lo que hoy no tiene dueño en el panel. Ahí sí hace
 * falta una ficha, porque si no el click no lleva a ningún lado.
 *
 * **Corolario operativo**: el día que exista, por ejemplo, una ficha de
 * vehículo, `vehiculo` sale de esta lista y entra en `ownerHref()`. Los dos
 * lugares se tocan juntos, y el tipo lo obliga (`ActivityDetailKind` es el
 * parámetro de la ruta y la clave de `DETAIL_QUERIES`).
 */
export const ACTIVITY_DETAIL_KINDS = [
  'vehiculo',
  'mantenimiento',
  'plan_mantenimiento',
  'consulta_multas',
  'consulta_datos',
  'dispositivo',
  'login',
] as const

export type ActivityDetailKind = (typeof ACTIVITY_DETAIL_KINDS)[number]

export const isActivityDetailKind = (v: string): v is ActivityDetailKind =>
  (ACTIVITY_DETAIL_KINDS as ReadonlyArray<string>).includes(v)

/**
 * Adónde lleva cada fila, dicho en palabras.
 *
 * **El destino de verdad NO está acá**: está en `<ActivityLink>`
 * (`~/components/ActivityCells`), como un `switch` de `<Link>` TIPADOS
 * (`to="/chats/$conversationId"` + `params`). Se hizo así y no con un href
 * armado a mano porque un string se le puede pasar a `<Link>` sin que el
 * compilador mire nada: un destino mal escrito compila, buildea, y recién
 * falla cuando alguien lo clickea.
 *
 * Lo que mantiene sincronizadas a las dos mitades es
 * `ACTIVITY_DETAIL_KINDS`: el `default` de ese `switch` asigna el `kind`
 * restante a un `ActivityDetailKind`, así que **agregar un tipo de evento sin
 * darle destino no compila**.
 *
 * Este `Record` es completo (todos los tipos): un label que falte se leería
 * como una fila que no va a ningún lado.
 */
export const ACTIVITY_TARGET_LABELS: Record<ActivityKind, string> = {
  alta_usuario: 'Ver el usuario',
  chat: 'Ver el chat',
  escaneo: 'Ver el escaneo',
  /**
   * Los cuatro documentos abren `/documentos/:tipo/:id`, que los muestra TODOS
   * —su consulta de detalle filtra sólo por id—, incluso los pocos que no
   * tienen archivo y por eso no aparecen en el LISTADO de `/documentos` (que sí
   * exige `file_id is not null`). Es a propósito: el usuario cargó ese seguro
   * igual, y la ficha muestra la verdad.
   */
  seguro: 'Ver el documento',
  cedula: 'Ver el documento',
  registro: 'Ver el documento',
  vtv: 'Ver el documento',
  pedido: 'Ver el pedido',
  vehiculo: 'Ver el detalle',
  mantenimiento: 'Ver el detalle',
  plan_mantenimiento: 'Ver el detalle',
  consulta_multas: 'Ver el detalle',
  consulta_datos: 'Ver el detalle',
  dispositivo: 'Ver el detalle',
  login: 'Ver el detalle',
  /** Desde el 2026-09-23, `/feedback` es la pantalla dueña — no una ficha acá. */
  feedback: 'Ver el feedback',
}

// ── El resultado de un evento ────────────────────────────────────────────────

/**
 * El código crudo que devuelve el SQL (`ok`, `sin_datos`, `failed`, `closed`…),
 * traducido para mostrar. Un valor que no esté acá **se muestra crudo**, nunca
 * se esconde — mismo criterio que `ANOMALY_TYPE_LABELS` y `DOC_STATUS_LABELS`:
 * un enum copiado se desincroniza el día que el backend agrega un valor, y la
 * pantalla tiene que sobrevivirlo.
 *
 * El tono NO es decorativo: `warn` es la única forma de barrer el feed buscando
 * lo que salió mal (un escaneo que no trajo nada, una consulta fallada) sin
 * leer fila por fila.
 */
export type OutcomeTone = 'ok' | 'warn' | 'muted'

export const ACTIVITY_OUTCOMES: Record<string, { label: string; tone: OutcomeTone }> = {
  // driving_sessions — el mismo corte que `scanners.repo.ts`
  ok: { label: 'trajo datos', tone: 'ok' },
  sin_datos: { label: 'sin datos', tone: 'warn' },
  fallado: { label: 'falló', tone: 'warn' },
  pendiente: { label: 'pendiente', tone: 'muted' },
  // conversations
  sin_mensajes: { label: 'sin mensajes', tone: 'muted' },
  // document_status
  active: { label: 'vigente', tone: 'ok' },
  expired: { label: 'vencido', tone: 'warn' },
  pending_renewal: { label: 'a renovar', tone: 'warn' },
  // vehicle_data_query_status
  queued: { label: 'en cola', tone: 'muted' },
  processing: { label: 'procesando', tone: 'muted' },
  completed: { label: 'completada', tone: 'ok' },
  failed: { label: 'falló', tone: 'warn' },
  // quote_request_status
  received: { label: 'sin contactar', tone: 'warn' },
  contacted: { label: 'contactado', tone: 'muted' },
  answered: { label: 'respondido', tone: 'ok' },
  closed: { label: 'cerrado', tone: 'muted' },
  // mantenimiento
  hecha: { label: 'hecha', tone: 'ok' },
  archivada: { label: 'archivada', tone: 'muted' },
  inactivo: { label: 'inactivo', tone: 'muted' },
  // varios
  archivado: { label: 'archivado', tone: 'muted' },
  con_deuda: { label: 'con deuda', tone: 'warn' },
  sin_deuda: { label: 'sin deuda', tone: 'ok' },
  admin: { label: 'admin', tone: 'muted' },
  provider: { label: 'provider', tone: 'muted' },
}

export function outcomeLabel(code: string): string {
  return ACTIVITY_OUTCOMES[code]?.label ?? code
}

export function outcomeTone(code: string): OutcomeTone {
  return ACTIVITY_OUTCOMES[code]?.tone ?? 'muted'
}

// ── Search params ────────────────────────────────────────────────────────────

export const ACTIVITY_KIND_FILTERS = ['all', ...ACTIVITY_KINDS] as const
export type ActivityKindFilter = (typeof ACTIVITY_KIND_FILTERS)[number]

export const ACTIVITY_WINDOWS = ['24h', '7d', '30d', 'all'] as const
export type ActivityWindow = (typeof ACTIVITY_WINDOWS)[number]

export const ACTIVITY_WINDOW_LABELS: Record<ActivityWindow, string> = {
  '24h': 'Últimas 24 h',
  '7d': '7 días',
  '30d': '30 días',
  all: 'Todo',
}

export const ACTIVITY_WINDOW_HOURS: Record<ActivityWindow, number | null> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
  all: null,
}

/**
 * Los search params van CALIFICADOS por dominio (`activityKind`, no `kind`).
 *
 * `kind` ya lo usan `/documentos` y `/notificaciones` con enums disjuntos, y
 * TanStack mergea los search params de TODAS las rutas en un solo tipo: dos
 * enums bajo la misma clave rompen el typecheck de la ruta AJENA, no de ésta.
 * Ya rompió un build de producción una vez. → `.claude/rules/notifications.md`
 *
 * `q` se comparte sin problema: coincide en tipo (`string`) en todas las rutas.
 */
export const activitySearchSchema = z.object({
  /** Busca en usuario (email/nombre), patente y el texto del detalle. */
  q: z.string().trim().max(120).optional(),
  activityKind: z.enum(ACTIVITY_KIND_FILTERS).catch('all').default('all'),
  activityWindow: z.enum(ACTIVITY_WINDOWS).catch('all').default('all'),
  /**
   * El feed NO es ordenable por columna, y es a propósito: el orden ES la
   * pregunta ("qué pasó recién"). Lo único que se invierte es la dirección del
   * tiempo — agrupar por usuario o por tipo es lo que hacen los FILTROS, con un
   * resultado más útil que un `order by`.
   */
  activityDir: z.enum(['desc', 'asc']).catch('desc').default('desc'),
})

export type ActivitySearch = z.infer<typeof activitySearchSchema>

/** El corte del listado. Igual que `/usuarios` y `/documentos`: no pagina. */
export const ACTIVITY_LIMIT = 500

// ── Formas de lectura ────────────────────────────────────────────────────────

export interface ActivityEvent {
  kind: ActivityKind
  id: string
  occurredAt: string
  /**
   * Cuánto hace, EN MINUTOS Y CALCULADO POR POSTGRES.
   *
   * La pantalla es SSR completo: restar contra `new Date()` en el render daría
   * un string en el servidor y otro en el cliente, que es un mismatch de
   * hidratación en cada fila de la tabla. Mismo patrón que `ExpiryCell` en
   * `/documentos` con `days_until_expiration`.
   */
  ageMinutes: number
  userId: string | null
  userEmail: string | null
  userName: string | null
  vehicleId: string | null
  vehiclePlate: string | null
  vehicleLabel: string | null
  detail: string | null
  outcome: string | null
}

export interface ActivityEventDetail {
  kind: ActivityDetailKind
  id: string
  occurredAt: string
  userId: string | null
  userEmail: string | null
  userName: string | null
  userRole: string | null
  vehicleId: string | null
  vehiclePlate: string | null
  vehicleLabel: string | null
  vehicleArchived: boolean | null
  outcome: string | null
  /**
   * Los campos de ESE evento, en el orden en que los arma su SELECT.
   *
   * Es una lista de pares y no un objeto por dos razones, las dos aprendidas en
   * este repo: un `Record<string, unknown>` **no compila** (TanStack Start
   * valida en tipos que lo que devuelve un server function sea serializable, y
   * `unknown` no lo es — la trampa que documenta `scan-sessions.md`), y un
   * `jsonb` reordena sus claves, así que el orden de la ficha se perdería.
   * `json_build_array` de pares conserva las dos cosas.
   *
   * `kind` NO es formato: es qué ES el valor. El SQL lo declara y la pantalla
   * decide cómo se ve, con los `formatDate`/`formatDateTime` de `~/lib/format`
   * que usa todo el panel. Una fecha ya formateada desde Postgres se vería
   * distinta al resto en cuanto alguien toque uno de los dos lados.
   */
  fields: Array<{ label: string; value: string | null; kind: 'text' | 'date' | 'datetime' }>
}

/**
 * "Hace cuánto", desde los minutos que contó Postgres.
 *
 * Sin `Intl.RelativeTimeFormat`: los cortes son nuestros (un evento de hace 90
 * minutos se lee mejor como "hace 1 h" que como "hace 2 horas" redondeado) y el
 * resultado tiene que ser el MISMO string en el servidor y en el cliente.
 */
export function formatAge(minutes: number): string {
  if (minutes < 1) return 'recién'
  if (minutes < 60) return `hace ${Math.floor(minutes)} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `hace ${hours} h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `hace ${days} ${days === 1 ? 'día' : 'días'}`
  const months = Math.floor(days / 30)
  if (months < 12) return `hace ${months} ${months === 1 ? 'mes' : 'meses'}`
  const years = Math.floor(days / 365)
  return `hace ${years} ${years === 1 ? 'año' : 'años'}`
}
