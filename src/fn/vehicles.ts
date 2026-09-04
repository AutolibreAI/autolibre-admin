import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { vehicleSearchSchema } from '~/lib/vehicles'
import {
  findVehicleDetail,
  listDistinctVehicleBrands,
  listDistinctVehicleModels,
  listVehicles,
} from '~/server/vehicles.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { VehicleDetail, VehicleListItem } from '~/lib/vehicles'

/**
 * El borde RPC de Vehículos. Las dos son de LECTURA y las dos pasan por
 * `adminMiddleware` igual — mismo motivo que `users.ts`: un server function es
 * un endpoint HTTP público, y esto devuelve patente, VIN, kilometraje y el
 * email del dueño de un vehículo real.
 */

export const listAppVehicles = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(vehicleSearchSchema)
  .handler(async ({ data }): Promise<Array<VehicleListItem>> =>
    listVehicles(data, { signal: requestSignal() }),
  )

/** El uuid entra por `z.uuid()`, no como string suelto — mismo motivo que `getAppUser`. */
export const getAppVehicle = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ vehicleId: z.uuid() }))
  .handler(async ({ data }): Promise<VehicleDetail> => {
    const found = await findVehicleDetail(data.vehicleId, { signal: requestSignal() })
    if (!found) throw new Error(`NOT_FOUND:${data.vehicleId}`)
    return found
  })

/** Las opciones del filtro de Marca — salen de los datos, nunca hardcodeadas. */
export const getVehicleBrandOptions = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<string>> => listDistinctVehicleBrands({ signal: requestSignal() }))

/** Ídem para Modelo. */
export const getVehicleModelOptions = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<string>> => listDistinctVehicleModels({ signal: requestSignal() }))
