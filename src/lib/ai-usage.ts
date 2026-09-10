import { z } from 'zod'

/**
 * Costos de IA — contrato de la pantalla.
 *
 * VOCABULARIO. `surface` es el punto del producto donde se gasta IA (el
 * asistente, el diagnóstico), no el proveedor ni el modelo. Los tres se filtran
 * por separado y confundirlos vuelve ilegible cualquier tabla:
 *
 *   surface  → DÓNDE gastamos      (asistente, diagnóstico, imágenes…)
 *   provider → A QUIÉN le pagamos  (anthropic…)
 *   model    → QUÉ contratamos     (claude-haiku-4-5-20251001…)
 *
 * Una superficie puede cambiar de modelo sin que cambie nada más, y un modelo
 * puede servir a varias superficies. Son ejes independientes.
 */

/**
 * Espeja los `surface` de `ops.ai_surface_registry` que hoy tienen medición
 * (`tracked = true`).
 *
 * Es una lista a mano, igual que `APPLICATION_STATUSES` espeja el enum de
 * Postgres, y por el mismo motivo: `validateSearch` necesita un conjunto
 * cerrado en tiempo de compilación. Cuando se instrumente una superficie nueva,
 * se agrega acá — si no, su filtro no existe en la URL. El panel igual la va a
 * mostrar en el informe de cobertura, que sale de la base y no de esta lista.
 */
export const TRACKED_SURFACES = ['assistant', 'diagnostics'] as const
export type TrackedSurface = (typeof TRACKED_SURFACES)[number]

export const SURFACE_LABELS: Record<TrackedSurface, string> = {
  assistant: 'Asistente',
  diagnostics: 'Diagnóstico IA',
}

/**
 * Ventanas de tiempo, cerradas a propósito.
 *
 * Un rango libre (`?from=…&to=…`) es la próxima iteración obvia, pero abre dos
 * problemas que hoy no se pagan solos: rangos inválidos que hay que degradar, y
 * un cache key por combinación. Con cuatro valores el server function cachea
 * bien y la URL sigue siendo compartible.
 */
export const USAGE_WINDOWS = ['7d', '30d', '90d', 'all'] as const
export type UsageWindow = (typeof USAGE_WINDOWS)[number]

export const WINDOW_LABELS: Record<UsageWindow, string> = {
  '7d': '7 días',
  '30d': '30 días',
  '90d': '90 días',
  all: 'Todo',
}

/** Días de cada ventana. `all` no tiene límite inferior. */
export const WINDOW_DAYS: Record<UsageWindow, number | null> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: null,
}

export const aiUsageSearchSchema = z.object({
  /**
   * `.catch()` y no throw: un link viejo con `?window=6m` debe renderizar el
   * default, no una pantalla de error. Es el mismo criterio que `page` en
   * `src/lib/search.ts`.
   */
  window: z.enum(USAGE_WINDOWS).catch('30d').default('30d'),

  /** Sin `.catch()`: una superficie inexistente es un bug de link interno que
   *  conviene ver, no degradar en silencio a "todas". */
  surface: z.enum(TRACKED_SURFACES).optional(),
})

export type AiUsageSearch = z.infer<typeof aiUsageSearchSchema>

// ── Formas de lectura ────────────────────────────────────────────────────────

/**
 * `totalUsd: number | null` — y NO `number`.
 *
 * NULL significa "no lo sabemos", y es distinto de cero. Pasa cuando ningún
 * evento del período tiene precio cargado para su modelo. Si esto se tipara
 * como `number` con un `?? 0`, la pantalla mostraría "US$ 0,00" para un período
 * en el que sí se gastó plata — el error más caro que puede cometer un panel de
 * costos, porque no se ve.
 *
 * `unpricedEvents` viaja al lado para que el total nunca se muestre solo.
 */
export interface UsageSummary {
  events: number
  inputTokens: number
  outputTokens: number
  totalUsd: number | null
  pricedEvents: number
  unpricedEvents: number
  models: number
  users: number
  firstEvent: string | null
  lastEvent: string | null
  /**
   * Llamadas EXCLUIDAS del total por venir de una cuenta interna
   * (`ops.excluded_email_domains`).
   *
   * Existe por el mismo motivo que `unpricedEvents`: el total de arriba ya no
   * las incluye, y sin este número no habría forma de saber cuánto se sacó.
   * Un panel que filtra en silencio es un panel que miente prolijamente.
   */
  internalEvents: number
}

/**
 * Los tres valores de "costo del período" que pidió producto: el gasto de la
 * ventana elegida, ese gasto repartido entre los usuarios reales activos EN LA
 * APP, y repartido entre los que alguna vez usaron el chat del asistente.
 *
 * "Usuario real" = distinto, no interno (`ops.excluded_email_domains`). Los dos
 * denominadores son subconjuntos distintos y **ninguno contiene al otro**:
 *
 *  - `activeUsers`: con actividad en la app (alta de vehículo / conversación /
 *    sesión de manejo) DENTRO de la ventana — misma definición de
 *    `last_activity_at` que `listUsers`. Con ventana `all` son todos los
 *    usuarios reales (sin corte de actividad).
 *  - `activeChatUsers`: con una `conversation` con ≥1 mensaje, ALGUNA VEZ (no se
 *    acota a la ventana). Mismo predicado que la fila `chat` de `usageAdoption`
 *    en `~/lib/ops`.
 *
 * Alguien pudo chatear hace un año y no abrir la app esta semana → estaría en
 * `activeChatUsers` y no en `activeUsers`. Por eso `activeChatUsers` puede ser
 * mayor que `activeUsers`.
 *
 * Las razones se derivan en el componente (`periodUsd / n`), no en SQL, y son
 * `null` si `periodUsd` es `null` (todo sin precio) o el divisor es 0 — nunca 0,
 * que se leería como "gratis".
 */
export interface UsageUnitEconomics {
  /** Gasto de la ventana. `null` si ningún evento tiene precio (ver `formatUsd`). */
  periodUsd: number | null
  /** Llamadas de la ventana sin tarifa vigente — el `periodUsd` no las incluye. */
  unpricedEvents: number
  /** Usuarios reales con actividad en la app dentro de la ventana. */
  activeUsers: number
  /** Usuarios reales que alguna vez tuvieron una conversación con ≥1 mensaje. */
  activeChatUsers: number
}

export interface UsageByModel {
  model: string
  provider: string | null
  events: number
  inputTokens: number
  outputTokens: number
  totalUsd: number | null
  /** Al menos un evento de este modelo cayó fuera de toda vigencia de precio. */
  unpriced: boolean
  inputUsdPerMtok: number | null
  outputUsdPerMtok: number | null
}

export interface UsageDay {
  day: string
  events: number
  inputTokens: number
  outputTokens: number
  totalUsd: number | null
  unpricedEvents: number
}

export interface UsageByUser {
  userId: string | null
  name: string | null
  email: string | null
  events: number
  inputTokens: number
  outputTokens: number
  totalUsd: number | null
}

/**
 * Una fila por superficie de IA del producto, medida o no.
 *
 * `hasTokenColumns` sale de `information_schema`, no de una lista: el día que
 * el backend instrumente la generación de imágenes, esto pasa a `true` solo.
 */
export interface SurfaceCoverage {
  surface: string
  label: string
  sourceTable: string
  tracked: boolean
  hasTokenColumns: boolean
  totalRows: number | null
  measuredEvents: number
  note: string | null
}

export interface ModelPrice {
  id: string
  provider: string
  model: string
  inputUsdPerMtok: number
  outputUsdPerMtok: number
  validFrom: string
  validTo: string | null
  /** Etiqueta legible de la fuente. El link vive en `sourceUrl`. */
  source: string | null
  /**
   * Link a la página de precios del proveedor, para poder auditar la tarifa sin
   * salir del panel.
   *
   * La base lo restringe a `https://` con un CHECK: un link roto en una tabla
   * de auditoría es peor que no tener link, porque promete verificación y no la
   * entrega.
   */
  sourceUrl: string | null
  /**
   * Cuándo se miró esa página por última vez.
   *
   * Es lo que hace útil al link. Sin fecha, no sabés si el número se chequeó
   * ayer o hace dos años — y una tarifa vieja no se anuncia: sigue calculando,
   * prolija y equivocada.
   */
  verifiedAt: string | null
  note: string | null
  /** Vigente ahora: sin `valid_to`, o con uno todavía en el futuro. */
  current: boolean
}

// ── Formato ──────────────────────────────────────────────────────────────────

const usd = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/**
 * Montos chicos se muestran con más decimales, no redondeados a cero.
 *
 * Con Haiku a US$1/US$5 por millón de tokens, una conversación entera cuesta
 * centésimas de centavo. Formatear eso como "US$ 0,00" hace que la pantalla
 * entera parezca rota o vacía justo cuando está funcionando bien.
 */
const usdSmall = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
})

/** `null` se rinde como "—", NUNCA como US$ 0,00. */
export function formatUsd(value: number | null): string {
  if (value === null) return '—'
  if (value !== 0 && Math.abs(value) < 0.01) return usdSmall.format(value)
  return usd.format(value)
}

/**
 * Siempre 4 decimales, para las razones "costo por usuario" — con Haiku a
 * US$1/US$5 el Mtok, el gasto por persona vive en centésimas de centavo y los
 * 2 decimales de `formatUsd` colapsarían dos valores distintos al mismo
 * "US$ 0,02". `null` → "—".
 */
export function formatUsdPrecise(value: number | null): string {
  return value === null ? '—' : usdSmall.format(value)
}

const compact = new Intl.NumberFormat('es-AR', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

/** Tokens en notación compacta: "15,8 mil". Los totales exactos van en tooltip. */
export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : compact.format(n)
}
