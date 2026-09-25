import { createServerFn } from '@tanstack/react-start'
import { getQuoteVehicleProfileSchema, type QuoteVehicleProfile } from '~/lib/quote-vehicle-profile'
import { findQuoteVehicleProfile } from '~/server/quote-requests.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'

/**
 * El vehículo de un pedido, para la tarjeta de sólo lectura de la ficha.
 * `adminMiddleware`: trae VIN, número de motor y kilometraje — mismo
 * criterio que el resto de `/leads/pedidos/:id`, un server function es un
 * endpoint HTTP público.
 */
export const getQuoteVehicleProfileFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(getQuoteVehicleProfileSchema)
  .handler(async ({ data }): Promise<QuoteVehicleProfile> =>
    findQuoteVehicleProfile(data.vehicleId, { signal: requestSignal() }),
  )
