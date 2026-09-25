import { z } from 'zod'
import type { UserMaintenanceTask } from '~/lib/users'

/**
 * El vehículo vinculado a un pedido de presupuesto, para la tarjeta
 * «Vehículo» de sólo lectura de `/leads/pedidos/:id` —
 * `.claude/plans/pedidos-ficha-2026-09-25.md`, Fase 4.
 *
 * No es `UserVehicle` (la ficha de trámites de `/usuarios/:id`, seguro/cédula/
 * VTV) ni `UserVehicleSummary` (el toggle de esa misma pantalla): contesta una
 * pregunta más chica y puntual — "¿qué le pasa a ESTE auto, ahora mismo, para
 * que el operador no tenga que abrir tres pantallas más mientras tiene a la
 * persona al teléfono?". VIN, motor, kilometraje, los códigos activos y las
 * tareas.
 */
export interface QuoteVehicleProfile {
  vin: string | null
  engineNumber: string | null
  /**
   * De dónde salió `engineNumber`: `vehicles` primero, después la última
   * cédula cargada, después el último seguro — en ese orden, porque al
   * relevar (2026-09-25, 8 autos de pedidos `app`) `vehicles.engine_number`
   * estaba vacío en el 100% de los casos y `insurances.engine_number` en el
   * 87%. `null` cuando ninguno de los tres lo tiene.
   */
  engineNumberSource: 'vehicle' | 'registration_card' | 'insurance' | null
  odometerKm: number | null
  /**
   * Los códigos DTC de la sesión de `vehicle_last_dtc_scans` (el escaneo más
   * reciente), con el título del catálogo local si está cargado — mismo
   * `lookupDtc()` que `/escaneres/detecciones` y `/escaneres/sesiones`.
   *
   * `dtcScannedAt: null` = nunca se escaneó este auto. `dtcScannedAt` con
   * fecha y `dtcCodes: []` = se escaneó y no había ningún código. Confundir
   * los dos es el mismo error que `scanner-compatibility.md` ya documenta
   * para "ausencia de evidencia ≠ evidencia de ausencia".
   */
  dtcCodes: Array<{ code: string; title: string | null }>
  dtcScannedAt: string | null
  tasks: Array<UserMaintenanceTask>
}

export const getQuoteVehicleProfileSchema = z.object({ vehicleId: z.uuid() })
export type GetQuoteVehicleProfileInput = z.infer<typeof getQuoteVehicleProfileSchema>
