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

// ── Agregado de pantalla ─────────────────────────────────────────────────────

/** Lo que la pantalla de inicio necesita en el primer flush. */
export interface OpsPulse {
  adoption: AdoptionPulse
  marketplace: MarketplaceHealth
  leads: LeadFunnel
}
