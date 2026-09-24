import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { fleetSearchSchema, vehicleSearchSchema } from '~/lib/vehicles'
import { fleetMetrics, fleetSummary, listCatalogUsers, listVehicles } from '~/server/vehicles.repo'
import { listProvinceOptions, vehicleLocationBreakdown } from '~/server/vehicle-location'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { CatalogUserRow, FleetMetricRow, FleetSummary, VehicleListRow } from '~/lib/vehicles'
import type { ProvinceOption, VehicleLocationBreakdown } from '~/lib/vehicle-location'

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

/**
 * "Quién tiene este modelo" — el desplegable de `/vehiculos/catalogo`. Se
 * llama al click de una fila, nunca del loader (`vehiculos.catalogo.index.tsx`
 * espera esto, no la lista completa de 210 modelos). Devuelve email, nombre y
 * patente: mismo dato personal que `getUserVehicleSummaries`, mismo guard.
 */
export const getCatalogUsersFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ catalogId: z.uuid() }))
  .handler(async ({ data }): Promise<Array<CatalogUserRow>> =>
    listCatalogUsers(data.catalogId, { signal: requestSignal() }),
  )

/**
 * Las provincias que existen en la base, para el filtro de radicación de
 * `/vehiculos/listado`. Publica cuántos autos hay por provincia: mismo guard.
 */
export const listVehicleProvinceOptionsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<ProvinceOption>> => listProvinceOptions())

/**
 * "Dónde están radicados" — el bloque de `/metricas`. Agregado, sin datos
 * personales, pero publica el tamaño y la geografía de la flota: mismo guard
 * que `fleetMetricsFn`.
 */
export const getVehicleLocationBreakdownFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<VehicleLocationBreakdown> => vehicleLocationBreakdown())
