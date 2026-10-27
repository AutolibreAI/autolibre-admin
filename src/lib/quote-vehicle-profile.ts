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
  /**
   * El kilometraje que ve la persona en la app — NO `vehicles.odometer_value`
   * a secas. El backend lo COMPONE (`Vehicle.currentOdometer`): la base que
   * cargó a mano más lo que el contador de la ECU avanzó desde el baseline
   * (`current_distance_since_dtc_clear_km − distance_since_dtc_clear_baseline_km`).
   * `null` = no hay nada cargado (base en 0 y sin escáner).
   */
  odometerKm: number | null
  /** De dónde sale `odometerKm` y CUÁNDO, para saber si está viejo. */
  odometer: QuoteOdometerFreshness
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

/**
 * Pasado esto, el km se pinta ámbar: un auto anda ~1.000 km por mes, y un
 * número de hace un trimestre ya puede estar corrido un service entero.
 */
export const ODOMETER_STALE_AFTER_DAYS = 90

/**
 * Cuándo se cargó el kilometraje. No hay una columna "fecha del km": se arma
 * con lo que sí queda escrito.
 *
 * - **La base a mano**: la última fila `field = 'odometer'` de
 *   `vehicle_audit_logs`. El backend la escribe en CADA cambio que hace la
 *   persona (no en el alta, y no si confirma el mismo número), y empezó a
 *   escribirla el `historyStartAt` (13/09/2026 en producción).
 *   - Sin fila y el auto se dio de alta DESPUÉS de esa fecha ⇒ el km viene del
 *     alta (`'alta'`, fecha = alta del auto).
 *   - Sin fila y el auto es ANTERIOR ⇒ no se sabe (`'unknown'`): se cargó
 *     entre el alta y `historyStartAt`. Se dice así, no se inventa una fecha.
 * - **Lo que sumó el escáner**: `dtc_clear_reading_at`, la última lectura de
 *   la ECU. Sólo cuenta si movió el número (`ecuDeltaKm ≠ 0`).
 */
export interface QuoteOdometerFreshness {
  /** La base que cargó la persona. `null` si está en 0. */
  manualKm: number | null
  manualAt: string | null
  manualSource: 'reading' | 'alta' | 'unknown'
  /** Alta del auto, para el caso `'unknown'` ("entre el alta y …"). */
  vehicleCreatedAt: string
  /** Desde cuándo el backend registra los cambios. `null` = esta base no tiene ninguno. */
  historyStartAt: string | null
  /** Km que contó la ECU sobre la base. `0` = el escáner no movió el número. */
  ecuDeltaKm: number
  /** Última lectura de la ECU, sólo si `ecuDeltaKm ≠ 0`. */
  ecuAt: string | null
  /**
   * Días (hora de Buenos Aires) desde la fecha más nueva que se conoce, base o
   * escáner. Lo calcula Postgres: la ficha es SSR y el reloj del navegador
   * daría un mismatch de hidratación. Con `'unknown'` y sin escáner es el
   * mínimo: los días desde `historyStartAt` ("hace más de N").
   */
  daysSince: number | null
  /** `daysSince` es un piso, no el número exacto. */
  daysSinceIsLowerBound: boolean
}

export const getQuoteVehicleProfileSchema = z.object({ vehicleId: z.uuid() })
export type GetQuoteVehicleProfileInput = z.infer<typeof getQuoteVehicleProfileSchema>
