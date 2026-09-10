import { z } from 'zod'

/**
 * Operación — el contrato compartido de las pantallas de salud del sistema.
 *
 * Qué reemplaza: el `select ... group by status` que hoy alguien corre a mano en
 * DBeaver cada vez que sospecha que una cola se colgó. Cada tipo de acá tiene
 * una consulta atrás y esa consulta está escrita en `src/server/ops.repo.ts`
 * con el comentario de qué pregunta contesta.
 *
 * Regla que ordena todo este módulo: **una métrica que nadie puede accionar no
 * va.** "Usuarios totales" entra porque decide si el marketplace tiene demanda;
 * "mensajes por conversación" no entra hasta que alguien diga qué haría con
 * ese número.
 */

// ── Ventana ──────────────────────────────────────────────────────────────────

export const OPS_WINDOWS = ['24h', '7d', '30d', 'all'] as const
export type OpsWindow = (typeof OPS_WINDOWS)[number]

export const OPS_WINDOW_LABELS: Record<OpsWindow, string> = {
  '24h': 'Últimas 24 h',
  '7d': '7 días',
  '30d': '30 días',
  all: 'Todo',
}

/** `null` = sin corte. Se traduce a `p_from` en el repo, nunca en el componente. */
export const OPS_WINDOW_HOURS: Record<OpsWindow, number | null> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
  all: null,
}

export const opsSearchSchema = z.object({
  window: z.enum(OPS_WINDOWS).catch('7d').default('7d'),
})

export type OpsSearch = z.infer<typeof opsSearchSchema>

// ── Adopción ─────────────────────────────────────────────────────────────────

/**
 * Los totales de gente y autos reales.
 *
 * `usersInternal` NO se resta en silencio: se muestra al lado del total, porque
 * la diferencia entre "3 usuarios" y "3 usuarios + 2.986 cuentas internas" es la
 * diferencia entre un producto que arranca y uno que parece tener tracción.
 * El criterio de "interno" es el MISMO que usa `ops.v_ai_usage` — el dominio del
 * email contra `ops.excluded_email_domains`. Si divergen, el panel dice dos
 * verdades distintas sobre la misma palabra.
 */
export interface AdoptionPulse {
  usersTotal: number
  usersInternal: number
  usersLast7d: number
  usersLast30d: number
  admins: number
  /** Cuentas `native`, previas a Clerk. Hoy NO pueden entrar al panel. */
  legacyNativeAdmins: number
  vehiclesActive: number
  /**
   * `vehiclesActive` deduplicado por patente. Más de un usuario puede cargar el
   * mismo auto —y hoy pasa: 115 filas activas, 106 patentes— así que el conteo
   * crudo infla la flota real. Siempre `<= vehiclesActive`.
   */
  vehiclesUnique: number
  vehiclesArchived: number
  vehiclesLast30d: number
  /** `null` cuando no hay usuarios reales — no 0, que sería una afirmación falsa. */
  vehiclesPerUser: number | null
}

// ── Serie de adopción (pantalla /metricas) ──────────────────────────────────

/**
 * La granularidad temporal de los gráficos de crecimiento. Conjunto cerrado
 * `as const` + `Record` de labels, mismo patrón que `OPS_WINDOWS` — un enum que
 * `validateSearch` necesita fijo en tiempo de compilación.
 */
export const GROWTH_UNITS = ['dia', 'semana', 'mes', 'anio'] as const
export type GrowthUnit = (typeof GROWTH_UNITS)[number]

export const GROWTH_UNIT_LABELS: Record<GrowthUnit, string> = {
  dia: 'Día',
  semana: 'Semana',
  mes: 'Mes',
  anio: 'Año',
}

/** Plural, para ejes y textos ("altas por {mes}s" no, "altas por mes"). */
export const GROWTH_UNIT_SINGULAR: Record<GrowthUnit, string> = {
  dia: 'día',
  semana: 'semana',
  mes: 'mes',
  anio: 'año',
}

export const growthSearchSchema = z.object({
  /**
   * `.catch` y `.default` al mismo valor: un `?unit=quincena` de un link viejo
   * renderiza el default, no una pantalla de error (criterio de `search.ts`).
   * Default `dia` porque es la única unidad con una tendencia visible sobre los
   * pocos días de historia que hay al 2026-09-05.
   */
  unit: z.enum(GROWTH_UNITS).catch('dia').default('dia'),
})

export type GrowthSearch = z.infer<typeof growthSearchSchema>

/**
 * Un punto de la serie: un período con cuántas altas hubo en él (`added`) y
 * cuántas acumuladas hasta el final del período (`total`).
 *
 * `bucket` es `'YYYY-MM-DD'` (el primer día del período, truncado en UTC del
 * lado de Postgres). String y no `Date` a propósito — un `date` de `pg` llega a
 * medianoche local del proceso y `toISOString()` corre la serie un día si el
 * proceso está al este de UTC (la trampa que documenta `ai-costs.md`).
 */
export interface GrowthPoint {
  bucket: string
  added: number
  total: number
}

export interface GrowthSeries {
  unit: GrowthUnit
  users: Array<GrowthPoint>
  vehicles: Array<GrowthPoint>
}

// ── Distribución de vehículos por usuario (tabla de /metricas) ───────────────

/**
 * Qué autos cuenta cada fila de la tabla. `active` = sólo no archivados ("lo que
 * el usuario tiene hoy"); `all` = incluye archivados (cuenta histórica, la misma
 * base que la curva acumulada de vehículos, que tampoco mira `archived`).
 */
export const VEHICLE_DIST_SCOPES = ['active', 'all'] as const
export type VehicleDistScope = (typeof VEHICLE_DIST_SCOPES)[number]

export const VEHICLE_DIST_SCOPE_LABELS: Record<VehicleDistScope, string> = {
  active: 'Autos activos',
  all: 'Incl. archivados',
}

/**
 * Las cinco columnas, cada una ordenable. `pctUsers` es monotónica con `users`
 * y `pctFleet` con `segmentVehicles` —ordenar por el % da el mismo orden que
 * por el conteo— pero son claves propias para que cada header sea clickeable.
 */
export const VEHICLE_DIST_SORT_KEYS = [
  'vehicles',
  'users',
  'pctUsers',
  'segmentVehicles',
  'pctFleet',
] as const
export type VehicleDistSortKey = (typeof VEHICLE_DIST_SORT_KEYS)[number]

export const vehicleDistSearchSchema = z.object({
  /**
   * `fleetScope` calificado por dominio a propósito: un `scope` pelado colisiona
   * con cualquier otra ruta que agregue uno con otro enum, y el merge de search
   * params de TanStack lo rompería en la ruta ajena, no acá.
   * → `.claude/rules/notifications.md`
   */
  fleetScope: z.enum(VEHICLE_DIST_SCOPES).catch('active').default('active'),
  /**
   * `sort`/`dir` pelados: es el nombre que `SortHeader` lee y el que usan todos
   * los listados del panel. `/metricas` no comparte search params con ninguna
   * otra ruta vía `<Link>`, así que no hay colisión que esquivar.
   */
  sort: z.enum(VEHICLE_DIST_SORT_KEYS).catch('vehicles').default('vehicles'),
  dir: z.enum(['asc', 'desc']).catch('asc').default('asc'),
})
export type VehicleDistSearch = z.infer<typeof vehicleDistSearchSchema>

/**
 * Una fila: cuántos usuarios reales tienen exactamente `vehicles` autos.
 *
 * `pctUsers` = `users` sobre el total de usuarios reales. `pctFleet` = los autos
 * que concentra este segmento (`segmentVehicles = vehicles * users`) sobre el
 * padrón total. Los dos porcentajes se derivan en JS, no en SQL, para no
 * arrastrar casts de `double precision` (ver el comentario de `toNum` en el repo).
 */
export interface VehicleDistBucket {
  vehicles: number
  users: number
  pctUsers: number
  segmentVehicles: number
  pctFleet: number
}

export interface VehicleDistribution {
  scope: VehicleDistScope
  /** Usuarios reales (sin cuentas internas). Denominador de `pctUsers`. */
  totalUsers: number
  /** Padrón de autos de esos usuarios, con o sin archivados según `scope`. Denominador de `pctFleet`. */
  totalFleet: number
  buckets: Array<VehicleDistBucket>
}

// ── Marketplace ──────────────────────────────────────────────────────────────

/**
 * La salud del directorio publicado.
 *
 * Las tres columnas `sin*` son las que importan, y cada una es un modo de falla
 * SILENCIOSA — el partner existe, figura activo, y no funciona:
 *
 *  - `activeWithoutServices`: se lista sin filtros y desaparece bajo cualquier
 *    chip. Es exactamente lo que busca la consulta 6 del runbook de aprobación.
 *  - `activeWithoutGeo`: no se puede ordenar por cercanía. El usuario ve un
 *    taller a 400 km arriba de uno a seis cuadras.
 *  - `activeWithoutContact`: el usuario llega y no tiene cómo escribir.
 */
export interface MarketplaceHealth {
  total: number
  active: number
  paused: number
  archived: number
  activeWithoutServices: number
  activeWithoutGeo: number
  activeWithoutContact: number
  founding: number
  fromSheet: number
  fromApplication: number
}

// ── Leads ────────────────────────────────────────────────────────────────────

/**
 * El embudo del marketplace: usuario → taller.
 *
 * `Lead` es el usuario yendo hacia el taller; `PartnerApplication` es el taller
 * viniendo hacia nosotros. Son vocabulario del backend y no son intercambiables.
 */
export interface LeadFunnel {
  total: number
  fresh: number
  contacted: number
  won: number
  lost: number
  /** Mediana, no promedio: un lead olvidado tres semanas corre el promedio y no la mediana. */
  medianHoursToContact: number | null
  /** Sin contactar y con más de 48 h encima. Lo accionable de esta tarjeta. */
  staleUncontacted: number
}

// ── Colas ────────────────────────────────────────────────────────────────────

export const QUEUE_KEYS = [
  'notifications',
  'vehicle_data_queries',
  'driving_sessions',
  'catalog_images',
] as const
export type QueueKey = (typeof QUEUE_KEYS)[number]

export const QUEUE_LABELS: Record<QueueKey, string> = {
  notifications: 'Notificaciones',
  vehicle_data_queries: 'Consultas VTV / deuda',
  driving_sessions: 'Sesiones de manejo',
  catalog_images: 'Imágenes de catálogo',
}

export const QUEUE_TABLES: Record<QueueKey, string> = {
  notifications: 'public.notifications',
  vehicle_data_queries: 'public.vehicle_data_queries',
  driving_sessions: 'public.driving_sessions',
  catalog_images: 'public.vehicle_catalog_images',
}

/**
 * Una fila por proceso asincrónico del sistema.
 *
 * ── Las cuatro columnas NO particionan el total, y es a propósito ────────────
 *
 * Se solapan porque describen cosas distintas de la misma fila:
 *
 *  - `ok`: terminó bien. Terminal.
 *  - `failed`: tiene marca de falla. **No es terminal en notificaciones** — ahí
 *    una fila fallida sigue `pending` y se vuelve a intentar.
 *  - `stuck`: en vuelo pasado el umbral y SIN intento registrado. Nadie la está
 *    procesando. Un `failed` avisa; un `stuck` no avisa nunca — se queda ahí, y
 *    sin esta pantalla se descubre cuando un usuario reclama.
 *  - `retrying`: el backend la va a volver a intentar, **sin tope**.
 *
 * Sumar las cuatro y compararlas contra `total` es un error de lectura, no un
 * bug del dato.
 */
export interface QueueHealth {
  key: QueueKey
  total: number
  ok: number
  failed: number
  stuck: number
  /**
   * Reintento automático en curso, sin límite de intentos.
   *
   * Hoy sólo lo tiene `notifications`, y no por simetría incompleta:
   * `notification-delivery.cron` corre CADA MINUTO sobre
   * `status = 'pending' AND scheduled_at <= now()`, y ni `markAsFailed()` ni
   * `markAsNoToken()` tocan `status` — sólo `deliveryStatus`. No hay contador de
   * intentos en ninguna parte del backend.
   *
   * Consecuencia: una notificación que falla se reintenta cada 60 segundos
   * PARA SIEMPRE. Una `no_token` (usuario sin push token) le pega al proveedor
   * indefinidamente y no va a salir nunca.
   *
   * Este número no es "cuántas están en camino". Es **cuántas están en un loop
   * que nadie va a cortar**. Por eso tiene columna propia y no se suma a
   * `stuck`: un cron caído se arregla levantando el cron; esto no se arregla
   * solo nunca.
   */
  retrying: number
  /** Minutos que un ítem puede estar en vuelo antes de contar como colgado. */
  stuckAfterMinutes: number
  lastEventAt: string | null
}

/** Motivo textual de falla, agrupado. Sirve para saber si es UN problema o veinte. */
export interface FailureReason {
  queue: QueueKey
  reason: string
  count: number
  lastAt: string | null
}

// ── Huecos de catálogo ───────────────────────────────────────────────────────

/**
 * Patentes que un usuario buscó y el catálogo no supo contestar.
 *
 * Es la única métrica del panel que es directamente una lista de trabajo: cada
 * fila es un auto que alguien quiso cargar y no pudo.
 */
export interface CatalogGap {
  plate: string
  state: string | null
  times: number
  lastAt: string
}

// ── Dominios excluidos (acción del panel) ────────────────────────────────────

/**
 * La única ESCRITURA que este módulo habilita, y se puede porque `ops` es del
 * panel: qué dominios de email cuentan como internos.
 *
 * No es una decisión de dominio — no cambia nada de lo que la app hace, cambia
 * a quién cuentan las métricas de este panel. Por eso vive acá y no en un caso
 * de uso del backend. Cualquier acción que SÍ decida algo del negocio (aprobar,
 * pausar, reintentar un envío) no se resuelve con un SQL desde acá.
 */
export interface ExcludedDomain {
  domain: string
  note: string | null
  /** Cuántos usuarios oculta hoy. Un dominio que oculta 0 probablemente esté mal escrito. */
  users: number
  createdAt: string
}

/**
 * Un dominio, no un email y no una URL.
 *
 * El `.toLowerCase()` no es cosmético: `ops.v_ai_usage` compara contra
 * `split_part(lower(email), '@', 2)`, así que un dominio guardado con una
 * mayúscula no matchea NUNCA y el excluido se cuenta igual, sin error visible.
 */
export const excludedDomainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, {
      message: 'Escribí solo el dominio: `ejemplo.com`, sin @ ni https://',
    }),
  note: z.string().trim().max(280).optional(),
})

export const removeExcludedDomainSchema = z.object({
  domain: z.string().trim().toLowerCase().min(3).max(253),
})

// ── Adopción por función (tabla de /metricas) ───────────────────────────────

/**
 * Qué funciones de la app se miden, y en qué orden se DEFINEN (el orden VISUAL
 * de la tabla se calcula por % descendente; este array sólo fija las claves y
 * las etiquetas). Mismo patrón que `QUEUE_LABELS` y `CENSUS_ENTRIES` de
 * `~/lib/users`: una sola lista, no tres lugares que se desincronizan.
 *
 * Cada `key` tiene una subconsulta `count(DISTINCT user_id)` en
 * `usageAdoption()` de `src/server/ops.repo.ts`. Agregar una función es una
 * línea acá y una subconsulta allá.
 */
export const ADOPTION_FEATURES = [
  { key: 'vehicle', label: 'Cargó un vehículo' },
  { key: 'push', label: 'Habilitó notificaciones (push token)' },
  { key: 'fineSync', label: 'Consultó multas' },
  { key: 'chat', label: 'Usó el chat de IA' },
  { key: 'insurance', label: 'Cargó un seguro' },
  { key: 'vtv', label: 'Cargó una VTV' },
  { key: 'regCard', label: 'Cargó la cédula del vehículo' },
  { key: 'scan', label: 'Escaneó con OBD' },
  { key: 'maintenanceDone', label: 'Registró una tarea de mantenimiento hecha' },
  { key: 'maintenanceUpcoming', label: 'Se puso un recordatorio de mantenimiento' },
  { key: 'notified', label: 'Recibió una notificación' },
  { key: 'license', label: 'Cargó la licencia de conducir' },
  { key: 'maintenancePlan', label: 'Creó un plan de mantenimiento' },
  { key: 'odometer', label: 'Cargó el odómetro' },
  { key: 'anyDocument', label: 'Cargó al menos un documento' },
  { key: 'proposalAccepted', label: 'Aceptó algo que propuso el chat' },
] as const

export type AdoptionFeatureKey = (typeof ADOPTION_FEATURES)[number]['key']

/** Una fila de la tabla: cuántos usuarios reales usaron `key` alguna vez. */
export interface AdoptionFeatureRow {
  key: AdoptionFeatureKey
  label: string
  users: number
  /** `users` sobre `totalUsers`. Derivado en JS, no en SQL. 0 si no hay usuarios. */
  pct: number
}

/**
 * "Con qué interactúa la gente y con qué no." El denominador (`totalUsers`) son
 * los usuarios reales — cuentas internas excluidas con el MISMO predicado que
 * `adoptionPulse` (`ops.v_ai_usage` → `ops.excluded_email_domains`).
 */
export interface UsageAdoption {
  totalUsers: number
  features: Array<AdoptionFeatureRow>
}

// ── Preguntas: recurrencia de escaneo (bloque 2 de /metricas) ────────────────

/**
 * Una fila de la distribución: cuántos usuarios hicieron exactamente `scans`
 * escaneos, y el rango de días entre el primero y el último de cada uno.
 *
 * Grano = usuario, universo = TODAS las `driving_sessions` (no sólo las que
 * trajeron datos): la pregunta es "¿quiere saber cómo está su auto?", y un
 * intento fallido también es esa intención. Sin ventana temporal, igual que la
 * matriz de `/escaneres` — la pregunta es acumulativa.
 */
export interface ScanRecurrenceBucket {
  scans: number
  users: number
  /** Días entre la primera y la última sesión, mínimo/máximo/promedio del bucket. */
  spanDaysMin: number
  spanDaysMax: number
  spanDaysAvg: number
}

export interface ScanRecurrence {
  totalUsers: number
  totalSessions: number
  buckets: Array<ScanRecurrenceBucket>
}

// ── Preguntas: qué produce el chat (bloque 3) ───────────────────────────────

export const PROPOSAL_STATUSES = ['pending', 'accepted', 'dismissed'] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  pending: 'Pendientes',
  accepted: 'Aceptadas',
  dismissed: 'Descartadas',
}

export interface ProposalStatusRow {
  status: ProposalStatus
  count: number
  /** De esas, cuántas nacieron de una conversación (`conversation_id IS NOT NULL`). */
  fromConversation: number
}

/**
 * `assistant_proposals` agrupadas por estado.
 *
 * `types` son los valores presentes de `assistant_proposal_type`. Hoy es sólo
 * `['maintenance']`, y el bloque lo dice en voz alta: "pedidos" y "búsqueda de
 * proveedores" desde el chat no es que no se usen — **no se pueden
 * representar**. Mostrar sólo el conteo dejaría creer que las otras dos existen
 * y dan cero. Un valor nuevo del enum del backend aparece solo acá.
 */
export interface ProposalStats {
  total: number
  byStatus: Array<ProposalStatusRow>
  types: Array<string>
}

// ── Preguntas: tareas sin solución (bloque 4) ───────────────────────────────

/**
 * Los tres resultados de cruzar una tarea creada a mano contra el marketplace.
 * Separarlos es el punto: **"no lo entendimos" es un bug de la app y "no lo
 * tenemos" es un hueco del marketplace** — van a equipos distintos.
 */
export const UNSOLVED_KINDS = ['no_service', 'no_partner', 'covered'] as const
export type UnsolvedKind = (typeof UNSOLVED_KINDS)[number]

export interface UnsolvedTaskRow {
  /** `maintenance_occurrences.service_slug` crudo. `null` = la app no clasificó. */
  serviceSlug: string | null
  /** `services.name` si el slug resuelve a un servicio del catálogo. */
  serviceName: string | null
  /** Categoría del servicio — para enlazar a `/partners/cobertura`. */
  categorySlug: string | null
  categoryName: string | null
  kind: UnsolvedKind
  tasks: number
  users: number
  /** Partners activos que ofrecen ese servicio. */
  activePartners: number
}

export interface UnsolvedTasks {
  rows: Array<UnsolvedTaskRow>
  totalTasks: number
}

// ── Preguntas: lo que todavía no se puede medir (bloque 5) ──────────────────

export interface CantMeasureItem {
  question: string
  why: string
  needs: string
}

/**
 * Lista CERRADA. Bloque `tone="warn"` (ámbar: falta un dato, no está roto nada),
 * mismo criterio que "DTCs sin título" en `/escaneres/detecciones`: trabajo
 * pendiente que se ve aunque no se pueda hacer desde acá. Es lo que evita que se
 * vuelva a preguntar en tres meses.
 *
 * Las cuatro son del backend. Ninguna se "arregla" inventando un proxy — mismo
 * criterio que la medición de tokens de IA (`ai-costs.md`) y los clicks de
 * WhatsApp a partners (`leads.md`).
 */
export const CANT_MEASURE_YET: ReadonlyArray<CantMeasureItem> = [
  {
    question: 'Recurrencia de las consultas de multas',
    why: '`vehicle_fine_syncs` es PK por `vehicle_id` y `fine_lookups` es UNIQUE por `plate`: cada consulta pisa la anterior, no queda historial.',
    needs: 'Que el backend escriba append-only cada lookup.',
  },
  {
    question: 'Pedidos con/sin presupuesto y tiempo de entrega del presupuesto',
    why: '`leads` tiene 0 filas y `lead_status` (`new/contacted/won/lost`) no tiene un estado de "presupuesto entregado".',
    needs: 'Que exista el flujo de pedidos, y un sello de tiempo de presupuesto entregado.',
  },
  {
    question: 'Recurrencia de carga del odómetro',
    why: '`vehicle_audit_logs` existe exactamente para esto —su enum `vehicle_audit_field` tiene un único valor, `odometer`— y tiene 0 filas.',
    needs: 'Que el backend escriba esa tabla al actualizar el odómetro.',
  },
  {
    question: 'Pedidos y búsqueda de proveedores desde el chat',
    why: '`assistant_proposal_type` tiene un solo valor: `maintenance`.',
    needs: 'Un valor nuevo en el enum del backend.',
  },
]

// ── Agregado de pantalla ─────────────────────────────────────────────────────

/** Lo que la pantalla de inicio necesita en el primer flush. */
export interface OpsPulse {
  adoption: AdoptionPulse
  marketplace: MarketplaceHealth
  leads: LeadFunnel
}
