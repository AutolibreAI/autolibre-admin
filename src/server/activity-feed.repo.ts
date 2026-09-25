import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { FAILED, NO_DATA, OK } from './scanners.repo'
import { notDuplicatePredicate, quoteRequestsAvailability } from './quote-requests.repo'
import {
  ACTIVITY_KINDS,
  ACTIVITY_LIMIT,
  ACTIVITY_WINDOW_HOURS,
  type ActivityDetailKind,
  type ActivityEvent,
  type ActivityEventDetail,
  type ActivityKind,
  type ActivitySearch,
} from '~/lib/activity-feed'

/**
 * El feed de actividad — SOLO LECTURA, igual que `documents.repo.ts` /
 * `chats.repo.ts` / `scan-sessions.repo.ts`.
 *
 * Todo lo que lee lo escribe el backend cuando alguien usa la app. Un evento es
 * un hecho que pasó; no hay nada que el admin mueva acá. Si aparece un
 * `UPDATE`/`INSERT`, está mal.
 *
 * El qué y el por qué de cada rama está en `~/lib/activity-feed`. Este archivo
 * es el SQL.
 */

const toInt = (v: unknown): number => Number(v ?? 0)
const toIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v)
const toIsoRequired = (v: unknown): string => toIso(v) ?? ''

// ── Piezas compartidas por las ramas ─────────────────────────────────────────

/**
 * `vehicles` **no apunta al catálogo**: apunta al SPEC, y recién ese tiene
 * `vehicle_catalog_id`. Son dos saltos, y los dos son `LEFT` aunque
 * `vehicle_catalog_spec_id` sea NOT NULL — la FK garantiza que exista el spec,
 * no el catálogo. Misma trampa que documentan `vehicle-manuals.md` (trampa 3) y
 * `scanner-compatibility.md`.
 *
 * El alias del vehículo es SIEMPRE `v` y el del catálogo `vc`, porque
 * `VEHICLE_LABEL` los tiene cableados. Una rama con vehículo que use otro alias
 * no compila en Postgres.
 */
const CATALOG_JOINS = `
  left join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
  left join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
`

const vehicleJoin = (on: string, mode: 'join' | 'left join' = 'join'): string =>
  `${mode} vehicles v on v.id = ${on} ${CATALOG_JOINS}`

/** La misma etiqueta de catálogo que `quote-requests.repo.ts` y `scan-sessions.repo.ts`. */
const VEHICLE_LABEL = `nullif(concat_ws(' ', vc.brand, vc.model, vc.trim, vc.year), '')`

/** `nullif(btrim(x), '')` — el import del legacy sheet dejó strings vacíos. */
const t = (col: string): string => `nullif(btrim(${col}), '')`

interface BranchSpec {
  /** Expresión del id de la fila. Es lo que viaja en la URL del detalle. */
  id: string
  /** Cuándo PASÓ el hecho, que no siempre es `created_at`. */
  occurredAt: string
  /** El FROM entero, con sus JOINs. Tiene que dejar `u` (users) disponible. */
  from: string
  /** `true` si el FROM deja `v`/`vc` disponibles. */
  vehicle?: boolean
  detail: string
  outcome?: string
  where?: string
}

/**
 * Una rama del `UNION ALL`, normalizada.
 *
 * **Todas las columnas van con alias en TODAS las ramas**, y eso no es estilo.
 * En un `UNION` Postgres toma los nombres de la PRIMERA rama, y acá las ramas se
 * incluyen o no según el filtro de tipo: con `?activityKind=chat` la primera es
 * `chat`. Si los nombres dependieran del orden, el filtro cambiaría el shape del
 * resultado. Por eso también los `null` van casteados.
 *
 * El `kind` se interpola desde `ACTIVITY_KINDS`, una lista cerrada del código —
 * nunca de la URL. Mismo criterio que `SORT_COLUMNS` en `users.repo.ts`.
 */
function branch(kind: ActivityKind, b: BranchSpec): string {
  return `
    select
      ${b.id} as id,
      '${kind}'::text as kind,
      ${b.occurredAt} as occurred_at,
      u.id as user_id, u.email as user_email, u.name as user_name,
      ${b.vehicle ? 'v.id' : 'null::uuid'} as vehicle_id,
      ${b.vehicle ? 'v.plate::text' : 'null::text'} as vehicle_plate,
      ${b.vehicle ? VEHICLE_LABEL : 'null::text'} as vehicle_label,
      ${b.detail} as detail,
      ${b.outcome ?? 'null::text'} as outcome
    from ${b.from}
    ${b.where ? `where ${b.where}` : ''}
  `
}

/**
 * Las 16 ramas. Cada una contesta "alguien hizo esto, cuándo, sobre qué auto".
 *
 * Los joins a `users` y `vehicles` son `JOIN` y no `LEFT JOIN` salvo donde la
 * columna es nullable de verdad (`conversations.vehicle_id`,
 * `quote_requests.user_id`/`vehicle_id` — verificado contra
 * `information_schema`). Un `LEFT` sobre una FK NOT NULL escondería una
 * corrupción de datos detrás de celdas vacías, que es lo que ya documentan
 * `users.md` y `leads.md`.
 */
const BRANCHES: Record<ActivityKind, string> = {
  alta_usuario: branch('alta_usuario', {
    id: 'u.id',
    occurredAt: 'u.created_at',
    from: 'users u',
    detail: `nullif(concat_ws(' · ', u.auth_provider::text, ${t('u.phone')}), '')`,
    // Sólo se marca el rol cuando NO es el default: un feed con 500 chips que
    // dicen "user" no informa nada.
    outcome: `nullif(u.role::text, 'user')`,
  }),

  vehiculo: branch('vehiculo', {
    id: 'v.id',
    occurredAt: 'v.created_at',
    from: `vehicles v
      join users u on u.id = v.user_id
      ${CATALOG_JOINS}`,
    vehicle: true,
    detail: `nullif(concat_ws(' · ',
      ${t('v.alias')},
      case when coalesce(v.odometer_value, 0) > 0 then v.odometer_value::text || ' km' end
    ), '')`,
    outcome: `case when v.archived then 'archivado' end`,
  }),

  chat: branch('chat', {
    id: 'c.id',
    occurredAt: 'c.created_at',
    from: `conversations c
      join users u on u.id = c.user_id
      ${vehicleJoin('c.vehicle_id', 'left join')}`,
    vehicle: true,
    /**
     * El título de un chat es el PRIMER MENSAJE DEL USUARIO, buscado por autor y
     * no `messages[0]` a ciegas — el invariante "toda conversación arranca con
     * el usuario" se cumple hoy, pero buscar por autor no depende de que se siga
     * cumpliendo. Mismo criterio exacto que `firstUserMessage()` en `~/lib/chats`.
     */
    detail: `(select left(btrim(m.content), 160)
               from conversation_messages m
              where m.conversation_id = c.id and m.author::text = 'user'
              order by m.sent_at limit 1)`,
    // Una conversacion SIN mensajes no entra (decidido 2026-09-25): abrir el
    // asistente sin escribir no es algo que la persona hizo, es ruido — 125 de
    // 228 en produccion. Mismo corte que /chats y que "uso el chat" de
    // usageAdoption: al menos un mensaje, de cualquiera de los dos lados.
    where: `exists (select 1 from conversation_messages m2 where m2.conversation_id = c.id)`,
  }),

  escaneo: branch('escaneo', {
    id: 'ds.id',
    // `started_at` y no `created_at`: cuándo escaneó, no cuándo se insertó la
    // fila. Mismo orden que `/escaneres/sesiones`.
    occurredAt: 'ds.started_at',
    from: `driving_sessions ds
      join users u on u.id = ds.user_id
      ${vehicleJoin('ds.vehicle_id')}`,
    vehicle: true,
    detail: `nullif(concat_ws(' · ',
      case when coalesce(ds.total_readings, 0) > 0 then ds.total_readings::text || ' lecturas' end,
      (select case when coalesce(array_length(sn.codes, 1), 0) > 0
                then array_length(sn.codes, 1)::text || ' DTC' end
         from session_dtc_snapshots sn where sn.session_id = ds.id),
      ${t('ds.scanner_firmware')}
    ), '')`,
    /**
     * El corte se IMPORTA de `scanners.repo.ts`, no se recopia: si esta pantalla
     * y `/escaneres` dijeran cosas distintas del mismo escaneo, nada lo
     * delataría. Por eso el alias de la tabla es `ds` — las cadenas lo traen
     * cableado. `sin_datos` es deducción NUESTRA sobre `total_readings`, no un
     * estado del dominio (`failed` tiene 0 filas) → `scanner-compatibility.md`.
     */
    outcome: `case
      when ${OK} then 'ok'
      when ${NO_DATA} then 'sin_datos'
      when ${FAILED} then 'fallado'
      else 'pendiente' end`,
  }),

  seguro: branch('seguro', {
    id: 'i.id',
    occurredAt: 'i.created_at',
    from: `insurances i
      join users u on u.id = i.user_id
      ${vehicleJoin('i.vehicle_id')}`,
    vehicle: true,
    detail: `nullif(concat_ws(' · ', ${t('i.insurer')}, ${t('i.policy_number')}), '')`,
    outcome: `case when i.archived then 'archivado' else i.status::text end`,
  }),

  cedula: branch('cedula', {
    id: 'r.id',
    occurredAt: 'r.created_at',
    from: `registration_cards r
      join users u on u.id = r.user_id
      ${vehicleJoin('r.vehicle_id')}`,
    vehicle: true,
    detail: `nullif(concat_ws(' · ', ${t('r.holder_name')}, ${t('r.registration_number')}), '')`,
    // `registration_cards` no tiene `status` — es la única de las cuatro.
    outcome: `case when r.archived then 'archivado' end`,
  }),

  registro: branch('registro', {
    id: 'l.id',
    occurredAt: 'l.created_at',
    // El registro de conducir es de la PERSONA, no de un auto: no tiene
    // `vehicle_id`. Misma asimetría que en `/documentos`.
    from: `driver_licenses l join users u on u.id = l.user_id`,
    detail: `nullif(concat_ws(' · ',
      ${t(`concat_ws(' ', l.first_name, l.last_name)`)},
      ${t('l.license_number')}
    ), '')`,
    outcome: `case when l.archived then 'archivado' else l.status::text end`,
  }),

  vtv: branch('vtv', {
    id: 'vi.id',
    occurredAt: 'vi.created_at',
    from: `vehicle_inspections vi
      join users u on u.id = vi.user_id
      ${vehicleJoin('vi.vehicle_id')}`,
    vehicle: true,
    detail: `nullif(concat_ws(' · ', ${t('vi.facility')}, ${t('vi.sticker_number')}), '')`,
    outcome: `case when vi.archived then 'archivado' else vi.status::text end`,
    /**
     * `source = 'manual'` — las 46 filas `provider` son una consulta a una API
     * por patente, no un documento que alguien cargó. Mismo predicado que usa
     * `/documentos` para decir "es OCR", y el motivo por el que esta pantalla no
     * las cuenta como actividad de una persona.
     */
    where: `vi.source::text = 'manual'`,
  }),

  mantenimiento: branch('mantenimiento', {
    id: 'mo.id',
    occurredAt: 'mo.created_at',
    from: `maintenance_occurrences mo
      join users u on u.id = mo.user_id
      ${vehicleJoin('mo.vehicle_id')}`,
    vehicle: true,
    detail: `nullif(concat_ws(' · ',
      coalesce(${t('mo.name')}, ${t('mo.service_slug')}, mo.item_type::text),
      ${t('mo.workshop')}
    ), '')`,
    outcome: `case
      when mo.archived then 'archivada'
      when mo.performed_at is not null then 'hecha'
      else 'pendiente' end`,
    /**
     * `plan_id is null` = la creó una PERSONA. Las que genera un plan recurrente
     * no las hizo nadie: aparecerían de a decenas sin que nadie tocara la app.
     * Mismo corte que `unsolvedTasks` en `ops.repo.ts` (`metricas.md`).
     */
    where: 'mo.plan_id is null',
  }),

  plan_mantenimiento: branch('plan_mantenimiento', {
    id: 'mp.id',
    occurredAt: 'mp.created_at',
    from: `maintenance_plans mp
      join users u on u.id = mp.user_id
      ${vehicleJoin('mp.vehicle_id')}`,
    vehicle: true,
    detail: `nullif(concat_ws(' · ',
      coalesce(${t('mp.name')}, ${t('mp.service_slug')}, mp.item_type::text),
      case when mp.km_interval is not null then 'cada ' || mp.km_interval::text || ' km' end,
      case when mp.time_interval_days is not null then 'cada ' || mp.time_interval_days::text || ' días' end
    ), '')`,
    outcome: `case when not mp.active then 'inactivo' end`,
  }),

  pedido: branch('pedido', {
    id: 'qr.id',
    occurredAt: 'qr.created_at',
    /**
     * Los DOS joins son `LEFT`, y es el único caso del archivo: web y WhatsApp
     * no tienen cuenta, **y un POST público con `channel = app` tampoco**
     * (`leads.md`). El vehículo lo vincula el operador a mano, después.
     */
    from: `quote_requests qr
      left join users u on u.id = qr.user_id
      ${vehicleJoin('qr.vehicle_id', 'left join')}`,
    vehicle: true,
    detail: `nullif(concat_ws(' · ',
      'AL-' || qr.public_number::text,
      ${t('qr.contact_name')},
      left(btrim(qr.description), 120)
    ), '')`,
    outcome: `qr.status::text`,
    // Los duplicados NO entran (decidido 2026-09-25): el operador los usa
    // tambien para descartar los pedidos de PRUEBA que manda el equipo, asi que
    // no son "algo que hizo una persona". Predicado IMPORTADO, no recopiado: es
    // el mismo que resta la card "Pedidos totales".
    where: notDuplicatePredicate('qr.'),
  }),

  consulta_multas: branch('consulta_multas', {
    /**
     * `vehicle_fine_syncs` **no tiene columna `id`**: su PK es `vehicle_id`
     * (1:1 por vehículo, `leads.md`). Así que el id del evento ES el del auto, y
     * la ficha lo busca por ahí. Consecuencia buscada: una consulta nueva PISA a
     * la anterior — el feed muestra la última, no el historial, porque la tabla
     * no guarda historial.
     */
    id: 'fs.vehicle_id',
    occurredAt: 'fs.last_synced_at',
    from: `vehicle_fine_syncs fs
      ${vehicleJoin('fs.vehicle_id')}
      join users u on u.id = v.user_id`,
    vehicle: true,
    detail: `(select case when count(*) = 0 then 'sin multas pendientes'
                     else count(*)::text || ' multa' || case when count(*) = 1 then '' else 's' end
                          || ' pendiente' || case when count(*) = 1 then '' else 's' end end
                from fines f
               where f.vehicle_id = fs.vehicle_id and f.status::text = 'pending')`,
    // El predicado de "adeudado" es `status = 'pending'`, el MISMO de
    // `fines.repo.ts` y `users.repo.ts`. Si divergen, el panel dice dos cosas
    // del mismo auto (`vehicles.md`).
    outcome: `case when exists (
        select 1 from fines f2 where f2.vehicle_id = fs.vehicle_id and f2.status::text = 'pending'
      ) then 'con_deuda' else 'sin_deuda' end`,
  }),

  consulta_datos: branch('consulta_datos', {
    id: 'dq.id',
    occurredAt: 'dq.created_at',
    from: `vehicle_data_queries dq
      join users u on u.id = dq.user_id
      ${vehicleJoin('dq.vehicle_id')}`,
    vehicle: true,
    detail: `nullif(concat_ws(' · ',
      ${t('dq.plate')},
      nullif(array_to_string(dq.requested_modules, ', '), '')
    ), '')`,
    outcome: `dq.status::text`,
  }),

  dispositivo: branch('dispositivo', {
    id: 'ept.id',
    // `created_at` y no `updated_at`: el hecho es haber registrado el
    // dispositivo. El token se refresca solo, y eso no lo hizo nadie.
    occurredAt: 'ept.created_at',
    from: `expo_push_tokens ept join users u on u.id = ept.user_id`,
    /**
     * **El token NO se muestra nunca** — es una credencial de envío: con ella se
     * le puede mandar un push a esa persona desde afuera de AutoLibre. La
     * plataforma y el prefijo del `device_id` alcanzan para el diagnóstico.
     * Misma regla que `users.md` (trampa 7).
     */
    detail: `nullif(concat_ws(' · ', ${t('ept.platform')}, left(${t('ept.device_id')}, 12)), '')`,
  }),

  login: branch('login', {
    id: 'le.id',
    occurredAt: 'le.occurred_at',
    /**
     * `login_events` **no tiene `user_id`**: trae el par
     * `(auth_provider, external_auth_id)`, que es exactamente la clave de
     * `idx_users_external_identity_unique` y la única forma correcta de resolver
     * una identidad — NUNCA el email (`CLAUDE.md`, decisión 2).
     *
     * El `JOIN` es inner a propósito, y descarta algo: al 2026-09-16, 2 de 56
     * logins no resuelven a ninguna fila de `users`. Eso no es ruido, es el
     * síntoma del riesgo que documenta el `CLAUDE.md` (alguien con sesión válida
     * de Clerk y sin usuario de AutoLibre) — pero perseguirlo es otra pantalla,
     * y un feed de actividad sin la columna "quién" no sirve.
     */
    from: `login_events le
      join users u
        on u.auth_provider = le.auth_provider
       and u.external_auth_id = le.external_auth_id`,
    detail: `nullif(concat_ws(' · ',
      ${t(`concat_ws(', ', le.city, le.country)`)},
      ${t('le.device_type')},
      ${t(`concat_ws(' ', le.client_name, le.client_version)`)}
    ), '')`,
    // Sólo las aperturas de sesión. `removed`/`ended`/`revoked` son el cierre,
    // que casi siempre lo dispara Clerk y no la persona.
    where: `le.event_type::text = 'created'`,
  }),

  feedback: branch('feedback', {
    id: 'fb.id',
    occurredAt: 'fb.submitted_at',
    from: `feedback fb join users u on u.id = fb.user_id`,
    detail: `nullif(concat_ws(' · ',
      left(btrim(fb.message), 160),
      ${t(`concat_ws(' ', fb.platform::text, fb.app_version)`)}
    ), '')`,
  }),
}

/**
 * La ventana se resuelve UNA vez en JavaScript, no con `now() - interval` por
 * rama. Mismo motivo que `windowStart()` en `ops.repo.ts`: con 16 ramas
 * calculando su propio `now()`, un evento en el borde entra en una y no en otra.
 */
function windowStart(window: ActivitySearch['activityWindow']): Date | null {
  const hours = ACTIVITY_WINDOW_HOURS[window]
  return hours === null ? null : new Date(Date.now() - hours * 60 * 60 * 1000)
}

interface EventRow {
  id: string
  kind: ActivityKind
  occurred_at: Date | string
  age_minutes: number | string
  user_id: string | null
  user_email: string | null
  user_name: string | null
  vehicle_id: string | null
  vehicle_plate: string | null
  vehicle_label: string | null
  detail: string | null
  outcome: string | null
}

/**
 * El feed.
 *
 * ── Por qué los filtros van AFUERA y no adentro de cada rama ────────────────
 *
 * `q` no tiene alternativa: busca sobre `detail`, que es una expresión del
 * SELECT (una subconsulta, un `concat_ws`) y no existe todavía en el `where`
 * interno — mismo motivo que el envoltorio de `chats.repo.ts` y
 * `notifications.repo.ts`.
 *
 * La VENTANA sí podría ir adentro, sobre la columna cruda de cada rama, y sería
 * más rápida. Va afuera igual, y es una decisión: empujar el predicado a 16
 * ramas escritas a mano son 16 oportunidades de olvidarse de una, y el modo de
 * falla de ese olvido es silencioso — ese tipo de evento ignoraría el filtro y
 * nadie lo notaría. Con ~1.000 eventos en producción el costo es cero; el día
 * que no lo sea, la respuesta es un índice, no copiar el predicado 16 veces.
 *
 * ── Por qué no hay `limit` por rama ─────────────────────────────────────────
 *
 * Sería la optimización obvia (`order by … desc limit 500` en cada una) y
 * daría un resultado INCORRECTO: con `q` en el `where` de afuera, recortar
 * antes de filtrar tira filas que sí matcheaban. El top 500 global sólo es
 * derivable de los top 500 por rama cuando TODOS los filtros están adentro.
 *
 * ── El filtro de tipo no filtra: PODA ───────────────────────────────────────
 *
 * `activityKind` decide qué ramas entran al `UNION ALL`, en vez de agregar un
 * `where kind = …` sobre el resultado. Es la única parte del filtrado que
 * realmente baja el trabajo de Postgres, y sale gratis porque las ramas ya son
 * un `Record` cerrado.
 */
export async function listActivity(
  search: ActivitySearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<ActivityEvent>> {
  void opts.signal

  const kinds: Array<ActivityKind> =
    search.activityKind === 'all' ? [...ACTIVITY_KINDS] : [search.activityKind]

  /**
   * `quote_requests` puede no existir en la base (el bounded context `quotes/`
   * del backend puede no estar desplegado) — el mismo guard que protege a
   * `/leads/pedidos`. Acá la respuesta no es una pantalla de error: es sacar la
   * rama y seguir. Un feed de 15 tipos vale; un 500 con el texto de Postgres, no.
   */
  const selected = kinds.includes('pedido')
    ? (await quoteRequestsAvailability()).available
      ? kinds
      : kinds.filter((k) => k !== 'pedido')
    : kinds

  if (selected.length === 0) return []

  const params: Array<unknown> = [windowStart(search.activityWindow)]
  const where: Array<string> = ['($1::timestamptz is null or occurred_at >= $1)']

  if (search.q) {
    params.push(`%${search.q}%`)
    const p = `$${params.length}`
    where.push(
      `(coalesce(user_email, '') ilike ${p} or coalesce(user_name, '') ilike ${p} ` +
        `or coalesce(vehicle_plate, '') ilike ${p} or coalesce(detail, '') ilike ${p})`,
    )
  }

  const rows = await sql<EventRow>(
    `
    select *,
      -- "Hace cuánto" lo calcula Postgres, no el render: la pantalla es SSR
      -- completo y restar contra el reloj del navegador daría un string distinto
      -- del que mandó el servidor, o sea un mismatch de hidratación por fila.
      -- (Sin backticks en los comentarios de SQL: cierran el template literal.)
      (extract(epoch from (now() - occurred_at)) / 60)::bigint as age_minutes
    from (
      ${selected.map((k) => BRANCHES[k]).join('\n      union all\n')}
    ) s
    where ${where.join(' and ')}
    order by occurred_at ${search.activityDir === 'asc' ? 'asc' : 'desc'}, id
    limit ${ACTIVITY_LIMIT}
    `,
    params,
  )

  return rows.map(
    (r): ActivityEvent => ({
      kind: r.kind,
      id: r.id,
      occurredAt: toIsoRequired(r.occurred_at),
      ageMinutes: toInt(r.age_minutes),
      userId: r.user_id,
      userEmail: r.user_email,
      userName: r.user_name,
      vehicleId: r.vehicle_id,
      vehiclePlate: r.vehicle_plate,
      vehicleLabel: r.vehicle_label,
      detail: r.detail,
      outcome: r.outcome,
    }),
  )
}

// ── El detalle de un evento sin pantalla dueña ───────────────────────────────

/**
 * Un campo de la ficha: etiqueta, expresión SQL, y opcionalmente qué ES el
 * valor. Las etiquetas son literales del código (nunca de la URL) y ninguna
 * lleva comilla simple — si alguna la lleva algún día, hay que escaparla.
 */
type FieldSpec =
  | [label: string, expr: string]
  | [label: string, expr: string, kind: 'date' | 'datetime']

/**
 * `json_build_array(json_build_object('label', …, 'value', …, 'kind', …))`,
 * armado desde una lista de campos.
 *
 * Es `json` y NO `jsonb` a propósito: `jsonb` reordena las claves (las guarda
 * normalizadas), así que el orden de los campos de la ficha se perdería. `json`
 * conserva el texto tal cual se escribió, y con él el orden de esta lista, que
 * ES el orden de la pantalla.
 *
 * Todo valor sale `::text`: el tipo de vuelta tiene que ser serializable para
 * TanStack Start, y un `unknown` no compila (`scan-sessions.md`).
 *
 * **Las fechas salen en formato MÁQUINA, no formateadas.** El SQL declara qué
 * es el valor (`kind`) y el formato humano lo pone la pantalla con `formatDate`
 * / `formatDateTime` de `~/lib/format` — los mismos de todo el panel, con la
 * zona pineada en UTC. Un `to_char` con el formato final acá metería
 * presentación adentro de la consulta y daría una fecha distinta a la del resto
 * del panel el día que alguien cambie una de las dos.
 */
const fields = (specs: Array<FieldSpec>): string =>
  `json_build_array(${specs
    .map(([label, expr, kind]) => {
      const value =
        kind === 'date'
          ? `to_char((${expr})::date, 'YYYY-MM-DD')`
          : kind === 'datetime'
            ? `to_char((${expr})::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`
            : `(${expr})::text`
      return `json_build_object('label', '${label}', 'value', ${value}, 'kind', '${kind ?? 'text'}')`
    })
    .join(', ')})`

const DETAIL_USER_COLS = `
  u.id as user_id, u.email as user_email, u.name as user_name, u.role::text as user_role
`
const DETAIL_VEHICLE_COLS = `
  v.id as vehicle_id, v.plate::text as vehicle_plate, ${VEHICLE_LABEL} as vehicle_label,
  v.archived as vehicle_archived
`
const DETAIL_NO_VEHICLE_COLS = `
  null::uuid as vehicle_id, null::text as vehicle_plate, null::text as vehicle_label,
  null::boolean as vehicle_archived
`

/**
 * Una consulta por tipo, porque las tablas no comparten ni una columna. Todas
 * producen la MISMA forma de salida (`DetailRow`) y un solo mapper después —
 * mismo patrón que `DETAIL_QUERIES` en `documents.repo.ts`.
 *
 * `$1` es el id. **`Record<ActivityDetailKind, …>` cerrado**: agregar un tipo a
 * `ACTIVITY_DETAIL_KINDS` sin su consulta no compila, que es justo lo que
 * impide un click que lleva a una pantalla vacía.
 */
const DETAIL_QUERIES: Record<ActivityDetailKind, string> = {
  vehiculo: `
    select v.id as id, v.created_at as occurred_at,
      ${DETAIL_USER_COLS}, ${DETAIL_VEHICLE_COLS},
      case when v.archived then 'archivado' end as outcome,
      ${fields([
        ['Patente', 'v.plate'],
        ['Alias', `nullif(btrim(v.alias), '')`],
        ['Modelo del catálogo', VEHICLE_LABEL],
        ['Motor / caja', `nullif(concat_ws(' · ', vcs.engine, vcs.fuel_type, vcs.transmission), '')`],
        ['VIN', `nullif(btrim(v.vin), '')`],
        ['Nº de motor', `nullif(btrim(v.engine_number), '')`],
        ['Color', `nullif(btrim(v.color), '')`],
        ['Kilometraje', `case when coalesce(v.odometer_value, 0) > 0 then v.odometer_value end`],
        ['Patentado en', 'v.registered_at', 'date'],
        ['Última actualización', 'v.updated_at', 'datetime'],
      ])} as fields
    from vehicles v
    join users u on u.id = v.user_id
    ${CATALOG_JOINS}
    where v.id = $1
  `,

  mantenimiento: `
    select mo.id as id, mo.created_at as occurred_at,
      ${DETAIL_USER_COLS}, ${DETAIL_VEHICLE_COLS},
      case
        when mo.archived then 'archivada'
        when mo.performed_at is not null then 'hecha'
        else 'pendiente' end as outcome,
      ${fields([
        ['Tarea', `coalesce(nullif(btrim(mo.name), ''), nullif(mo.service_slug, ''), mo.item_type::text)`],
        ['Rubro', `nullif(mo.service_slug, '')`],
        ['Servicio puntual', `nullif(mo.service_task_slug, '')`],
        ['Taller', `nullif(btrim(mo.workshop), '')`],
        ['Hecha el', 'mo.performed_at', 'date'],
        ['Vence el', 'mo.due_date', 'date'],
        ['Vence a los', `case when mo.due_km is not null then mo.due_km::text || ' km' end`],
        ['Km al hacerla', 'mo.odometer_at_service'],
        ['Km al anotarla', 'mo.odometer_at_creation'],
        ['Costo', `case when mo.cost_value is not null
                     then coalesce(nullif(mo.cost_currency, ''), 'ARS') || ' ' || mo.cost_value::text end`],
        ['Notas', `nullif(btrim(mo.notes), '')`],
      ])} as fields
    from maintenance_occurrences mo
    join users u on u.id = mo.user_id
    join vehicles v on v.id = mo.vehicle_id
    ${CATALOG_JOINS}
    where mo.id = $1
  `,

  plan_mantenimiento: `
    select mp.id as id, mp.created_at as occurred_at,
      ${DETAIL_USER_COLS}, ${DETAIL_VEHICLE_COLS},
      case when not mp.active then 'inactivo' end as outcome,
      ${fields([
        ['Plan', `coalesce(nullif(btrim(mp.name), ''), nullif(mp.service_slug, ''), mp.item_type::text)`],
        ['Rubro', `nullif(mp.service_slug, '')`],
        ['Servicio puntual', `nullif(mp.service_task_slug, '')`],
        ['Se dispara por', 'mp.trigger_type::text'],
        ['Cada', `case when mp.km_interval is not null then mp.km_interval::text || ' km' end`],
        ['Cada (tiempo)', `case when mp.time_interval_days is not null then mp.time_interval_days::text || ' días' end`],
        ['Ocurrencias generadas', `(select count(*) from maintenance_occurrences o where o.plan_id = mp.id)`],
        ['Última actualización', 'mp.updated_at', 'datetime'],
      ])} as fields
    from maintenance_plans mp
    join users u on u.id = mp.user_id
    join vehicles v on v.id = mp.vehicle_id
    ${CATALOG_JOINS}
    where mp.id = $1
  `,

  /**
   * El id es el del VEHÍCULO — `vehicle_fine_syncs` no tiene otro (su PK es
   * `vehicle_id`). Los montos salen crudos (`round(...)`), sin `$` ni
   * separadores: el formato de pesos vive en `formatArs` del lado del cliente, y
   * meterlo en el SQL sería presentación adentro de la consulta.
   */
  consulta_multas: `
    select fs.vehicle_id as id, fs.last_synced_at as occurred_at,
      ${DETAIL_USER_COLS}, ${DETAIL_VEHICLE_COLS},
      case when exists (
        select 1 from fines f where f.vehicle_id = fs.vehicle_id and f.status::text = 'pending'
      ) then 'con_deuda' else 'sin_deuda' end as outcome,
      ${fields([
        ['Patente consultada', 'v.plate'],
        [
          'Multas pendientes',
          `(select count(*) from fines f where f.vehicle_id = fs.vehicle_id and f.status::text = 'pending')`,
        ],
        [
          'Adeudado (ARS)',
          `(select round(sum(f.amount))::bigint from fines f
              where f.vehicle_id = fs.vehicle_id and f.status::text = 'pending')`,
        ],
        ['Multas registradas en total', `(select count(*) from fines f where f.vehicle_id = fs.vehicle_id)`],
        [
          'Jurisdicciones',
          `(select string_agg(distinct f.jurisdiction::text, ', ')
              from fines f where f.vehicle_id = fs.vehicle_id)`,
        ],
        [
          'Infracción más vieja',
          `(select min(f.infraction_date) from fines f
              where f.vehicle_id = fs.vehicle_id and f.status::text = 'pending')`,
        ],
      ])} as fields
    from vehicle_fine_syncs fs
    join vehicles v on v.id = fs.vehicle_id
    join users u on u.id = v.user_id
    ${CATALOG_JOINS}
    where fs.vehicle_id = $1
  `,

  consulta_datos: `
    select dq.id as id, dq.created_at as occurred_at,
      ${DETAIL_USER_COLS}, ${DETAIL_VEHICLE_COLS},
      dq.status::text as outcome,
      ${fields([
        ['Patente consultada', `nullif(btrim(dq.plate), '')`],
        ['Módulos pedidos', `nullif(array_to_string(dq.requested_modules, ', '), '')`],
        ['Estado', 'dq.status::text'],
        ['Motivo de la falla', `nullif(btrim(dq.failure_reason), '')`],
        ['Job del proveedor', `nullif(btrim(dq.provider_job_id), '')`],
        ['Completada', 'dq.completed_at', 'datetime'],
        ['Saldada', 'dq.settled_at', 'datetime'],
      ])} as fields
    from vehicle_data_queries dq
    join users u on u.id = dq.user_id
    join vehicles v on v.id = dq.vehicle_id
    ${CATALOG_JOINS}
    where dq.id = $1
  `,

  /** Sin el token, por la misma razón que en el listado: es una credencial. */
  dispositivo: `
    select ept.id as id, ept.created_at as occurred_at,
      ${DETAIL_USER_COLS}, ${DETAIL_NO_VEHICLE_COLS},
      null::text as outcome,
      ${fields([
        ['Plataforma', `nullif(btrim(ept.platform), '')`],
        ['Dispositivo (prefijo)', `left(nullif(btrim(ept.device_id), ''), 12)`],
        ['Token', `'— no se muestra: es una credencial de envío'`],
        ['Refrescado', 'ept.updated_at', 'datetime'],
        [
          'Dispositivos de esta cuenta',
          `(select count(*) from expo_push_tokens o where o.user_id = ept.user_id)`,
        ],
      ])} as fields
    from expo_push_tokens ept
    join users u on u.id = ept.user_id
    where ept.id = $1
  `,

  login: `
    select le.id as id, le.occurred_at as occurred_at,
      ${DETAIL_USER_COLS}, ${DETAIL_NO_VEHICLE_COLS},
      null::text as outcome,
      ${fields([
        ['Identidad', `le.auth_provider::text || ' · ' || le.external_auth_id`],
        ['Dónde', `nullif(btrim(concat_ws(', ', le.city, le.country)), '')`],
        // host() saca la máscara: un ::text de inet devuelve '181.81.21.224/32'.
        ['IP', 'host(le.ip_address)'],
        ['Dispositivo', `nullif(btrim(le.device_type), '')`],
        ['Móvil', `case when le.is_mobile then 'sí' else 'no' end`],
        ['Cliente', `nullif(btrim(concat_ws(' ', le.client_name, le.client_version)), '')`],
        ['User agent', `nullif(btrim(le.user_agent), '')`],
        ['Sesión de Clerk', `nullif(btrim(le.external_session_id), '')`],
      ])} as fields
    from login_events le
    join users u
      on u.auth_provider = le.auth_provider
     and u.external_auth_id = le.external_auth_id
    where le.id = $1
  `,

}

interface DetailRow {
  id: string
  occurred_at: Date | string
  user_id: string | null
  user_email: string | null
  user_name: string | null
  user_role: string | null
  vehicle_id: string | null
  vehicle_plate: string | null
  vehicle_label: string | null
  vehicle_archived: boolean | null
  outcome: string | null
  fields: Array<{ label: string; value: string | null; kind: 'text' | 'date' | 'datetime' }>
}

export async function findActivityEvent(
  kind: ActivityDetailKind,
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ActivityEventDetail | null> {
  void opts.signal

  const row = await sqlOne<DetailRow>(DETAIL_QUERIES[kind], [id])
  if (!row) return null

  return {
    kind,
    id: row.id,
    occurredAt: toIsoRequired(row.occurred_at),
    userId: row.user_id,
    userEmail: row.user_email,
    userName: row.user_name,
    userRole: row.user_role,
    vehicleId: row.vehicle_id,
    vehiclePlate: row.vehicle_plate,
    vehicleLabel: row.vehicle_label,
    vehicleArchived: row.vehicle_archived,
    outcome: row.outcome,
    // Un campo sin valor no se muestra: la ficha es "qué sabemos de este
    // evento", y quince renglones vacíos entrenan a no leerla — mismo criterio
    // que la lista de pendientes de Inicio.
    fields: (row.fields ?? []).filter((f) => f.value !== null && f.value !== ''),
  }
}
