import { createServerFn } from '@tanstack/react-start'
import {
  excludedDomainSchema,
  growthSearchSchema,
  opsSearchSchema,
  removeExcludedDomainSchema,
  vehicleDistSearchSchema,
} from '~/lib/ops'
import {
  adoptionPulse,
  adoptionSeries,
  catalogGaps,
  excludedDomains,
  failureReasons,
  leadFunnel,
  marketplaceHealth,
  queueHealth,
  removeExcludedDomain,
  upsertExcludedDomain,
  vehicleDistribution,
} from '~/server/ops.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type {
  CatalogGap,
  ExcludedDomain,
  FailureReason,
  GrowthSeries,
  OpsPulse,
  QueueHealth,
  VehicleDistribution,
} from '~/lib/ops'

/**
 * Operación — el borde RPC.
 *
 * TODO pasa por `adminMiddleware`, y no por simetría con los otros módulos: hay
 * dos motivos concretos.
 *
 *  1. `getCatalogGaps` devuelve PATENTES que usuarios reales buscaron. Es dato
 *     personal indirecto — una patente identifica un auto y por lo tanto a su
 *     dueño.
 *  2. `getOpsPulse` publica el tamaño real del negocio: cuántos usuarios hay,
 *     cuántos partners, cuántos leads se ganaron. Eso no se le contesta a
 *     cualquiera con una sesión de la app mobile.
 *
 * Un server function es un endpoint HTTP público. El guard de `_authed` modela
 * lo que la UI OFRECE; esto es lo que el servidor ACEPTA. Son dos cosas y hay
 * que escribir las dos.
 */

/**
 * Las tres tarjetas del pulso en UNA llamada.
 *
 * Van juntas porque la pantalla no puede renderizar ninguna sin las otras dos —
 * son una sola fila visual. Separarlas en tres server functions serían tres
 * round trips para pintar una fila, y tres momentos distintos de `now()`.
 *
 * Las tres consultas sí salen en paralelo contra el pool: `Promise.all` sobre
 * un pool de 5 conexiones, no en serie.
 */
export const getOpsPulse = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<OpsPulse> => {
    const signal = requestSignal()
    const [adoption, marketplace, leads] = await Promise.all([
      adoptionPulse({ signal }),
      marketplaceHealth({ signal }),
      leadFunnel({ signal }),
    ])
    return { adoption, marketplace, leads }
  })

/**
 * Las dos series de crecimiento (`/graficos`). Mismo `adminMiddleware` que el
 * resto: publica el tamaño y la velocidad de crecimiento del negocio, que no se
 * le contesta a cualquiera con una sesión de la app.
 */
export const getAdoptionSeries = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(growthSearchSchema)
  .handler(async ({ data }): Promise<GrowthSeries> =>
    adoptionSeries(data.unit, { signal: requestSignal() }),
  )

/**
 * La tabla de "cuántos usuarios tienen N autos" de `/graficos`. Mismo
 * `adminMiddleware`: publica el tamaño del padrón de usuarios y autos.
 */
export const getVehicleDistribution = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(vehicleDistSearchSchema)
  .handler(async ({ data }): Promise<VehicleDistribution> =>
    vehicleDistribution(data, { signal: requestSignal() }),
  )

export const getQueueHealth = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<QueueHealth>> => queueHealth({ signal: requestSignal() }))

export const getFailureReasons = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(opsSearchSchema)
  .handler(async ({ data }): Promise<Array<FailureReason>> =>
    failureReasons(data.window, { signal: requestSignal() }),
  )

export const getCatalogGaps = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(opsSearchSchema)
  .handler(async ({ data }): Promise<Array<CatalogGap>> =>
    catalogGaps(data.window, { signal: requestSignal() }),
  )

export const getExcludedDomains = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<ExcludedDomain>> =>
    excludedDomains({ signal: requestSignal() }),
  )

/**
 * ── Las dos escrituras del módulo ───────────────────────────────────────────
 *
 * Se permiten porque `ops` es del panel y porque NO deciden nada del negocio:
 * no cambian qué hace la app, cambian a quién cuentan las métricas de este
 * panel. Esa es la línea exacta.
 *
 * Lo que NO va a aparecer acá, por más cómodo que sería: reintentar una
 * notificación fallida, pausar un partner, reencolar una consulta VTV. Cada una
 * de esas mueve estado del dominio, y el dominio lo mueve el backend con su TDD
 * — no un UPDATE lanzado desde el panel. La pantalla de Operación muestra el
 * problema; el arreglo se pide como caso de uso.
 */
export const saveExcludedDomain = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(excludedDomainSchema)
  .handler(async ({ data }): Promise<ExcludedDomain> =>
    upsertExcludedDomain(data, { signal: requestSignal() }),
  )

export const deleteExcludedDomain = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(removeExcludedDomainSchema)
  .handler(async ({ data }): Promise<{ removed: boolean }> => ({
    removed: await removeExcludedDomain(data.domain, { signal: requestSignal() }),
  }))
