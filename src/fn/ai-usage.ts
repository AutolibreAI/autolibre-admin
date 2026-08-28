import { createServerFn } from '@tanstack/react-start'
import { aiUsageSearchSchema } from '~/lib/ai-usage'
import {
  modelPrices,
  surfaceCoverage,
  usageByModel,
  usageByUser,
  usageDaily,
  usageSummary,
} from '~/server/ai-usage.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type {
  ModelPrice,
  SurfaceCoverage,
  UsageByModel,
  UsageByUser,
  UsageDay,
  UsageSummary,
} from '~/lib/ai-usage'

/**
 * Costos de IA — el borde RPC.
 *
 * TODO pasa por `adminMiddleware`, y acá el motivo es más fuerte que en el
 * marketplace: `ai_usage_by_user` cruza consumo con `public.users` y devuelve
 * nombre y email de quién habló con el asistente y cuánto. Eso es actividad
 * individual de usuarios reales.
 *
 * Un server function es un endpoint HTTP público — cualquiera con una sesión
 * válida de la app puede llamarlo directo con fetch. El guard de `_authed` NO
 * lo cubre: ese guard modela lo que la UI ofrece, no lo que el servidor acepta.
 * Sin `adminMiddleware` acá, cualquier usuario de la app mobile podría listar
 * el consumo de todos los demás.
 */

export const getAiUsageSummary = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(aiUsageSearchSchema)
  .handler(async ({ data }): Promise<UsageSummary> =>
    usageSummary(data, { signal: requestSignal() }),
  )

export const getAiUsageByModel = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(aiUsageSearchSchema)
  .handler(async ({ data }): Promise<Array<UsageByModel>> =>
    usageByModel(data, { signal: requestSignal() }),
  )

export const getAiUsageDaily = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(aiUsageSearchSchema)
  .handler(async ({ data }): Promise<Array<UsageDay>> =>
    usageDaily(data, { signal: requestSignal() }),
  )

/**
 * El límite es fijo (20) y NO entra por el payload.
 *
 * Aceptarlo por parámetro convertiría esto en un volcado paginable del consumo
 * de toda la base de usuarios. El panel necesita "quiénes son los que más
 * consumen", que es una pregunta de capacidad; "traeme los 5000" es otra
 * pregunta, y si aparece se resuelve con su propia pantalla y su propia
 * decisión, no ensanchando esta.
 */
export const getAiUsageByUser = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(aiUsageSearchSchema)
  .handler(async ({ data }): Promise<Array<UsageByUser>> =>
    usageByUser(data, 20, { signal: requestSignal() }),
  )

/** Sin validator: no toma parámetros — ver el comentario en el repositorio. */
export const getAiSurfaceCoverage = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<SurfaceCoverage>> =>
    surfaceCoverage({ signal: requestSignal() }),
  )

export const getAiModelPrices = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<ModelPrice>> =>
    modelPrices({ signal: requestSignal() }),
  )
