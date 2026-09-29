import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { lookupDtc } from './dtc-catalog'
import { DERIVED_STATE } from './notifications.repo'
import { mapTaskRow, type TaskRow } from './users.repo'
import {
  loadLocationTable,
  locationJoin,
  mapLocation,
  type LocationQueryColumns,
} from './vehicle-location'
import { NOTIFICATION_STATES, NOTIFICATION_DELAYED_AFTER_MIN, type NotificationState } from '~/lib/notifications'
import { sessionBucket } from '~/lib/scanners'
import {
  VEHICLE_CENSUS_ENTRIES,
  type VehicleCensus,
  type VehicleCensusKey,
  type VehicleDetail,
  type VehicleDtc,
} from '~/lib/vehicles'

/**
 * La ficha de UN vehículo (`/vehiculos/:vehicleId`). SOLO LECTURA.
 *
 * Nació en la rama `listado-vehiculos` (2026-09-04) y se portó el 2026-09-28
 * sobre el panel actual. Lo que cambió al portarla, y por qué:
 *
 *  - **Los DTC salen de `session_dtc_snapshots.codes`, no de `diagnostic_dtcs`.**
 *    La rama armaba el historial con `diagnostic_dtcs`, que sólo tiene los
 *    códigos que alguien BUSCÓ — el error que `scan-detections.md` y la fase 4
 *    de pedidos ya corrigieron. "Activos" = el snapshot del último escaneo;
 *    "inactivos" = los que aparecieron en algún snapshot anterior y ya no.
 *  - **El título del DTC sale de `lookupDtc`** (`dtc-codes.json`), no de
 *    `diagnostic_dtcs.standard_description`, que está 100% NULL en producción.
 *  - **Los chats sin mensajes no se listan** (`chats.md`).
 *  - **El estado de un aviso es `DERIVED_STATE`**, importado de
 *    `notifications.repo.ts`: `status` solo no dice si le llegó
 *    (`notifications.md`).
 *  - **Las tareas reusan `mapTaskRow`** de `users.repo.ts`, y la pantalla el
 *    componente `MaintenanceTasks`: si "vencida" se viera distinto acá que en
 *    `/usuarios/:id`, una de las dos estaría mal.
 *  - **El censo tiene guard de existencia por tabla** (ver `vehicleCensus`).
 *
 * ── `join`, no `left join`, al catálogo y al dueño ─────────────────────────
 *
 * Se arranca DESDE `vehicles`: `vehicle_catalog_spec_id` y `user_id` son NOT
 * NULL con FK, así que un `left join` escondería una corrupción detrás de
 * celdas vacías. Mismo criterio que `findUserDetail` y `listVehicles`.
 */

const toInt = (v: unknown): number => Number(v ?? 0)
const toIntOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v)
const toIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v)
const toIsoRequired = (v: unknown): string => toIso(v) ?? ''

interface VehicleRow extends LocationQueryColumns {
  id: string
  plate: string
  vin: string | null
  alias: string | null
  color: string
  archived: boolean
  created_at: Date | string
  updated_at: Date | string
  registered_at: Date | string | null
  odometer_value: number | string
  engine_number: string | null
  current_distance_since_dtc_clear_km: number | string | null
  dtc_clear_reading_at: Date | string | null
  catalog_id: string
  brand: string
  model: string
  trim: string
  year: number | string
  vehicle_type: string
  engine: string | null
  fuel_type: string | null
  transmission: string | null
  owner_id: string
  owner_name: string | null
  owner_email: string
  owner_phone: string | null
  ins_id: string | null
  ins_file_id: string | null
  ins_expires_at: Date | string | null
  ins_insurer: string | null
  vtv_id: string | null
  vtv_file_id: string | null
  vtv_source: string | null
  vtv_expires_at: Date | string | null
  vtv_facility: string | null
  rc_id: string | null
  rc_file_id: string | null
  rc_created_at: Date | string | null
  rc_registration_number: string | null
  rc_holder_name: string | null
  lds_vehicle_id: string | null
  last_dtc_scan_at: Date | string | null
  active_dtc_codes: Array<string> | null
  fine_consulted_at: Date | string | null
}

/**
 * El vehículo, con catálogo, dueño, documentos y radicación. Los tres
 * documentos van por `left join lateral … limit 1`: son 1:1 efectivos (el más
 * reciente no archivado), mismo orden que las columnas de `listVehicles`.
 */
async function findVehicleRow(vehicleId: string): Promise<VehicleRow | null> {
  const params: Array<unknown> = [vehicleId]
  const location = locationJoin(params, await loadLocationTable())

  return sqlOne<VehicleRow>(
    `select
       v.id, v.plate, nullif(btrim(v.vin), '') as vin, nullif(btrim(v.alias), '') as alias,
       v.color, v.archived, v.created_at, v.updated_at, v.registered_at, v.odometer_value,
       nullif(btrim(v.engine_number), '') as engine_number,
       v.current_distance_since_dtc_clear_km, v.dtc_clear_reading_at,
       vc.id as catalog_id, vc.brand, vc.model, vc.trim, vc.year,
       vc.vehicle_type::text as vehicle_type,
       nullif(btrim(vcs.engine), '') as engine,
       vcs.fuel_type::text as fuel_type, vcs.transmission::text as transmission,
       u.id as owner_id, u.name as owner_name, u.email as owner_email, u.phone as owner_phone,

       ins.id as ins_id, ins.file_id as ins_file_id, ins.expiration_date as ins_expires_at,
       nullif(btrim(ins.insurer), '') as ins_insurer,
       vtv.id as vtv_id, vtv.file_id as vtv_file_id, vtv.source::text as vtv_source,
       vtv.expiration_date as vtv_expires_at, nullif(btrim(vtv.facility), '') as vtv_facility,
       rc.id as rc_id, rc.file_id as rc_file_id, rc.created_at as rc_created_at,
       nullif(btrim(rc.registration_number), '') as rc_registration_number,
       nullif(btrim(rc.holder_name), '') as rc_holder_name,

       lds.vehicle_id as lds_vehicle_id, lds.scanned_at as last_dtc_scan_at,
       snap.codes as active_dtc_codes,
       vfs.last_synced_at as fine_consulted_at,

       ${location.columns}

     from vehicles v
     join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
     join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
     join users u on u.id = v.user_id
     left join lateral (
       select i.id, i.file_id, i.expiration_date, i.insurer from insurances i
        where i.vehicle_id = v.id order by i.archived asc, i.created_at desc limit 1
     ) ins on true
     left join lateral (
       select vi.id, vi.file_id, vi.source, vi.expiration_date, vi.facility from vehicle_inspections vi
        where vi.vehicle_id = v.id order by vi.archived asc, vi.created_at desc limit 1
     ) vtv on true
     left join lateral (
       select r.id, r.file_id, r.created_at, r.registration_number, r.holder_name from registration_cards r
        where r.vehicle_id = v.id order by r.archived asc, r.created_at desc limit 1
     ) rc on true
     left join vehicle_last_dtc_scans lds on lds.vehicle_id = v.id
     left join session_dtc_snapshots snap on snap.session_id = lds.session_id
     left join vehicle_fine_syncs vfs on vfs.vehicle_id = v.id
     ${location.joins}
     where v.id = $1`,
    params,
  )
}

/**
 * El censo, en UNA sentencia (mismo argumento que `CENSUS_SQL` de
 * `users.repo.ts`: todas las cuentas del mismo snapshot).
 *
 * ── El guard de existencia, y por qué va por tabla ─────────────────────────
 *
 * Un `count(*)` contra una tabla que no existe no falla "esa fila": explota
 * la sentencia ENTERA al planificarse. Y `quote_requests` puede no existir
 * (`leads.md`, el guard de disponibilidad), igual que cualquier tabla que el
 * backend sume después. Así que primero se pregunta cuáles existen
 * (`to_regclass`) y las que no, salen `null::int` — "no existe en esta base",
 * que la pantalla dice en vez de un cero que mentiría.
 *
 * Las columnas se llaman `c0…cN` por posición: los `key` son camelCase y
 * Postgres pliega a minúscula un alias sin comillas (la trampa 4 de
 * `notifications.md`, en `campaigns.repo.ts`).
 */
async function vehicleCensus(vehicleId: string): Promise<VehicleCensus> {
  const tables = VEHICLE_CENSUS_ENTRIES.map((e) => e.table)
  const existing = await sql<{ t: string }>(
    `select t from unnest($1::text[]) as t where to_regclass('public.' || t) is not null`,
    [tables],
  )
  const present = new Set(existing.map((r) => r.t))

  const column = (entry: (typeof VEHICLE_CENSUS_ENTRIES)[number], i: number): string => {
    if (!present.has(entry.table)) return `null::int as c${i}`
    switch (entry.via) {
      case 'sus sesiones':
        return `(select count(*) from ${entry.table}
                  where session_id in (select id from driving_sessions where vehicle_id = $1))::int as c${i}`
      case 'sus conversaciones':
        return `(select count(*) from ${entry.table}
                  where conversation_id in (select id from conversations where vehicle_id = $1))::int as c${i}`
      default:
        return `(select count(*) from ${entry.table} where vehicle_id = $1)::int as c${i}`
    }
  }

  // `entry.table` sale de una constante nuestra (`VEHICLE_CENSUS_ENTRIES`),
  // nunca de la request: interpolarla es seguro, igual que `SORT_COLUMNS`.
  const row = await sqlOne<Record<string, number | string | null>>(
    `select ${VEHICLE_CENSUS_ENTRIES.map(column).join(',\n')}`,
    [vehicleId],
  )

  const census = {} as VehicleCensus
  VEHICLE_CENSUS_ENTRIES.forEach((entry, i) => {
    census[entry.key as VehicleCensusKey] = toIntOrNull(row?.[`c${i}`])
  })
  return census
}

interface DtcHistoryRow {
  code: string
  last_seen_at: Date | string
  sessions: number | string
}

interface ScanRow {
  id: string
  started_at: Date | string
  ended_at: Date | string | null
  status: string
  scanner_type: string
  scanner_firmware: string | null
  total_readings: number | string | null
  has_snapshot: boolean
  dtc_count: number | string | null
  distance_since_dtc_clear_km: number | string | null
}

interface ChatRow {
  id: string
  started_at: Date | string
  title: string | null
  model: string | null
  user_message_count: number | string
  ai_message_count: number | string
}

interface AlertRow {
  id: string
  type: string
  title: string
  state: string
  scheduled_at: Date | string
}

interface FineRow {
  id: string
  reason: string
  amount: string
  status: string
  jurisdiction: string | null
  infraction_date: Date | string
}

interface TaxDebtRow {
  id: string
  jurisdiction: string
  period: string
  amount: string
  cleared_at: Date | string | null
  due_date: Date | string | null
}

/** El expediente completo de un vehículo. `null` si el uuid no existe. */
export async function findVehicleDetail(
  vehicleId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<VehicleDetail | null> {
  void opts.signal

  const v = await findVehicleRow(vehicleId)
  if (!v) return null

  const [census, dtcHistory, scans, chats, tasks, alerts, fines, taxDebts] = await Promise.all([
    vehicleCensus(vehicleId),

    /**
     * Un renglón por código DISTINTO que trajo algún escaneo de este auto, con
     * el último escaneo que lo vio y en cuántos apareció. `session_dtc_snapshots`
     * no tiene fecha de creación propia: la fecha es la de la sesión.
     */
    sql<DtcHistoryRow>(
      `select code, max(ds.started_at) as last_seen_at, count(*)::int as sessions
         from session_dtc_snapshots s
         join driving_sessions ds on ds.id = s.session_id
         cross join lateral unnest(s.codes) as code
        where s.vehicle_id = $1
        group by code
        order by max(ds.started_at) desc, code`,
      [vehicleId],
    ),

    sql<ScanRow>(
      `select ds.id, ds.started_at, ds.ended_at, ds.status::text as status,
              ds.scanner_type::text as scanner_type, ds.scanner_firmware, ds.total_readings,
              s.session_id is not null as has_snapshot,
              coalesce(array_length(s.codes, 1), 0) as dtc_count,
              ds.distance_since_dtc_clear_km
         from driving_sessions ds
         left join session_dtc_snapshots s on s.session_id = ds.id
        where ds.vehicle_id = $1
        order by ds.started_at desc`,
      [vehicleId],
    ),

    /** Mismo criterio de `title`/`model` que `listChats` (`chats.md`), y sin las vacías. */
    sql<ChatRow>(
      `select c.id, c.started_at,
              (select m.content from conversation_messages m
                where m.conversation_id = c.id and m.author = 'user'
                order by m.sent_at asc limit 1) as title,
              (select m.model from conversation_messages m
                where m.conversation_id = c.id and m.author = 'ai'
                order by m.sent_at desc limit 1) as model,
              (select count(*)::int from conversation_messages m
                where m.conversation_id = c.id and m.author = 'user') as user_message_count,
              (select count(*)::int from conversation_messages m
                where m.conversation_id = c.id and m.author = 'ai') as ai_message_count
         from conversations c
        where c.vehicle_id = $1
          and exists (select 1 from conversation_messages cm where cm.conversation_id = c.id)
        order by c.started_at desc`,
      [vehicleId],
    ),

    sql<TaskRow>(
      `select o.id, v.plate as vehicle_plate, o.name, o.item_type::text as item_type,
              o.due_date, o.performed_at, o.archived, o.created_at
         from maintenance_occurrences o
         join vehicles v on v.id = o.vehicle_id
        where o.vehicle_id = $1
        order by coalesce(o.performed_at, o.due_date, o.created_at) desc`,
      [vehicleId],
    ),

    /** `$1` es el umbral de `atrasada`: lo exige `DERIVED_STATE`. */
    sql<AlertRow>(
      `select n.id, n.type::text as type, n.title, ${DERIVED_STATE} as state, n.scheduled_at
         from notifications n
        where n.vehicle_id = $2
        order by n.scheduled_at desc`,
      [NOTIFICATION_DELAYED_AFTER_MIN, vehicleId],
    ),

    sql<FineRow>(
      `select id, reason, amount::text as amount, status::text as status,
              jurisdiction::text as jurisdiction, infraction_date
         from fines
        where vehicle_id = $1
        order by infraction_date desc`,
      [vehicleId],
    ),

    sql<TaxDebtRow>(
      `select id, jurisdiction, period, coalesce(updated_amount, amount)::text as amount,
              cleared_at, due_date
         from vehicle_tax_debts
        where vehicle_id = $1
        order by coalesce(due_date, created_at::date) desc`,
      [vehicleId],
    ),
  ])

  // "Activos" = los del snapshot del último escaneo. Sin escaneo el set está
  // vacío y TODO el historial cae del lado "inactivo".
  const scanned = v.lds_vehicle_id !== null
  const activeCodes = new Set(scanned ? (v.active_dtc_codes ?? []) : [])

  const activeDtcs: Array<VehicleDtc> = []
  const inactiveDtcs: Array<VehicleDtc> = []
  for (const row of dtcHistory) {
    const dtc: VehicleDtc = {
      code: row.code,
      title: lookupDtc(row.code)?.title ?? null,
      lastSeenAt: toIsoRequired(row.last_seen_at),
      sessions: toInt(row.sessions),
    }
    ;(activeCodes.has(row.code) ? activeDtcs : inactiveDtcs).push(dtc)
  }

  // "Es OCR" (`documents.md`): con archivo, y la VTV además `source = 'manual'`.
  // Sólo ésos tienen ficha en `/documentos`.
  const vtvIsOcr = v.vtv_file_id !== null && v.vtv_source === 'manual'

  return {
    id: v.id,
    plate: v.plate,
    vin: v.vin,
    alias: v.alias,
    color: v.color,
    archived: v.archived,
    createdAt: toIsoRequired(v.created_at),
    updatedAt: toIsoRequired(v.updated_at),
    registeredAt: toIso(v.registered_at),
    odometerKm: toInt(v.odometer_value),
    engineNumber: v.engine_number,
    distanceSinceDtcClearKm: toIntOrNull(v.current_distance_since_dtc_clear_km),
    dtcClearReadingAt: toIso(v.dtc_clear_reading_at),

    catalogId: v.catalog_id,
    brand: v.brand,
    model: v.model,
    trim: v.trim,
    year: toInt(v.year),
    vehicleType: v.vehicle_type,
    engine: v.engine,
    fuelType: v.fuel_type,
    transmission: v.transmission,

    owner: { id: v.owner_id, name: v.owner_name, email: v.owner_email, phone: v.owner_phone },

    insurance: v.ins_id
      ? {
          expiresAt: toIso(v.ins_expires_at),
          insurer: v.ins_insurer,
          docId: v.ins_file_id ? v.ins_id : null,
        }
      : null,
    vtv: v.vtv_id
      ? {
          expiresAt: toIso(v.vtv_expires_at),
          facility: v.vtv_facility,
          docId: vtvIsOcr ? v.vtv_id : null,
          fromProvider: v.vtv_source === 'provider',
        }
      : null,
    registrationCard: v.rc_id
      ? {
          loadedAt: toIsoRequired(v.rc_created_at),
          registrationNumber: v.rc_registration_number,
          holderName: v.rc_holder_name,
          docId: v.rc_file_id ? v.rc_id : null,
        }
      : null,

    location: mapLocation(v),

    census,

    activeDtcs,
    inactiveDtcs,
    lastDtcScanAt: scanned ? toIso(v.last_dtc_scan_at) : null,

    scans: scans.map((r) => {
      const totalReadings = toInt(r.total_readings)
      return {
        id: r.id,
        startedAt: toIsoRequired(r.started_at),
        endedAt: toIso(r.ended_at),
        bucket: sessionBucket(r.status, totalReadings),
        scannerType: r.scanner_type,
        scannerFirmware: r.scanner_firmware,
        totalReadings,
        dtcCount: r.has_snapshot ? toInt(r.dtc_count) : null,
        distanceSinceDtcClearKm: toIntOrNull(r.distance_since_dtc_clear_km),
      }
    }),

    chats: chats.map((r) => ({
      id: r.id,
      startedAt: toIsoRequired(r.started_at),
      title: r.title,
      model: r.model,
      userMessageCount: toInt(r.user_message_count),
      aiMessageCount: toInt(r.ai_message_count),
    })),

    tasks: tasks.map(mapTaskRow),

    alerts: alerts.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      state: (NOTIFICATION_STATES as ReadonlyArray<string>).includes(r.state)
        ? (r.state as NotificationState)
        : 'desconocida',
      scheduledAt: toIsoRequired(r.scheduled_at),
    })),

    fineConsultedAt: toIso(v.fine_consulted_at),
    fines: fines.map((r) => ({
      id: r.id,
      reason: r.reason,
      amount: Number(r.amount),
      status: r.status,
      jurisdiction: r.jurisdiction,
      infractionDate: toIsoRequired(r.infraction_date),
    })),

    taxDebts: taxDebts.map((r) => ({
      id: r.id,
      jurisdiction: r.jurisdiction,
      period: r.period,
      amount: Number(r.amount),
      clearedAt: toIso(r.cleared_at),
      dueDate: toIso(r.due_date),
    })),
  }
}
