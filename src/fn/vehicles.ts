import { createServerFn } from '@tanstack/react-start'
import { fleetSearchSchema, vehicleSearchSchema } from '~/lib/vehicles'
import { fleetMetrics, fleetSummary, listVehicles } from '~/server/vehicles.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { FleetMetricRow, FleetSummary, VehicleListRow } from '~/lib/vehicles'

/**
 * Vehículos — el borde RPC.
 *
 * `adminMiddleware` en las tres. El motivo de la LECTURA es el de siempre:
 * `listVehicles` devuelve patente, VIN indirecto, email y nombre del dueño, y
 * cuánto debe en multas. Es dato personal. `fleetMetrics` es agregado y no
 * expone a nadie, pero va con el mismo guard por simetría y porque publica el
 * tamaño real de la flota.
 *
 * Un server function es un endpoint HTTP público: el guard de `_authed` modela
 * lo que la UI ofrece, esto es lo que el servidor acepta.
 */

export const listVehiclesFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(vehicleSearchSchema)
  .handler(async ({ data }): Promise<Array<VehicleListRow>> =>
    listVehicles(data, { signal: requestSignal() }),
  )

export const fleetMetricsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(fleetSearchSchema)
  .handler(async ({ data }): Promise<Array<FleetMetricRow>> =>
    fleetMetrics(data, { signal: requestSignal() }),
  )

export const fleetSummaryFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<FleetSummary> =>
    fleetSummary({ signal: requestSignal() }),
  )
