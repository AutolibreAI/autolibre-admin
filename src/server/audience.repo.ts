import '@tanstack/react-start/server-only'

import { sql } from './db'
import { INTERNAL_PREDICATE } from './ops.repo'
import { OK } from './scanners.repo'
import { lastSignalSql } from '~/lib/activity'
import {
  AUDIENCE_RECIPIENT_LIMIT,
  operatorNeedsValue,
  operatorsFor,
} from '~/lib/audience'
import type {
  AudienceCondition,
  AudienceFieldKey,
  AudienceInput,
  AudiencePreview,
} from '~/lib/audience'

/**
 * Audiencias — el SQL de las condiciones con las que se arma el grupo al que va
 * una notificación. Solo lectura, sobre `users` y lo que cuelga de él.
 *
 * ── Dueño del SQL: nosotros, sobre tablas de `public` ────────────────────────
 *
 * Mismo caso que `ops.repo.ts` y `notifications.repo.ts`, y el mismo mal menor
 * consciente: una función de `ops` que leyera doce tablas de `public` sería una
 * dependencia cruzada invisible para las migraciones del backend. Con el SQL
 * acá, un rename rompe en runtime igual, pero `rg` lo encuentra y el diff queda
 * versionado.
 *
 * ── Lo único que hace seguro este archivo es que no interpola nada del usuario ─
 *
 * `AUDIENCE_SQL` es un `Record` que los TIPOS obligan a cubrir, con una clave
 * por campo del catálogo de `~/lib/audience`. La condición que llega por HTTP
 * trae una CLAVE de ese record y un operador de un enum de zod: nunca un
 * fragmento de SQL. El único dato del llamador que llega a la consulta es
 * `value`, y va por parámetro (`$n`), jamás concatenado.
 *
 * Es la misma defensa que `SORT_COLUMNS` en `users.repo.ts`, y acá pesa más:
 * ahí lo peor que podía pasar era un orden raro; acá el resultado decide a
 * quiénes les suena el teléfono.
 *
 * ── Ni una escritura ────────────────────────────────────────────────────────
 *
 * Este archivo cuenta y lista usuarios. El envío lo hace `backend.ts` por HTTP.
 * Si aparece un `UPDATE`/`INSERT` acá, está mal.
 */

// ── Las expresiones, una por campo ───────────────────────────────────────────

/**
 * La expresión SQL de cada campo del catálogo, sobre el alias `u` de `users`.
 *
 * Tres formas distintas conviven a propósito, según el `kind` del campo:
 *
 *  - `count`  → una subconsulta escalar que devuelve un entero. Escalar y NO un
 *               JOIN, por el fan-out de siempre (`users.md`, trampa 2): con dos
 *               JOINs, el conteo del primero se multiplica por el segundo y da
 *               un número más grande, no un error.
 *  - `days`   → un timestamp (o `null`).
 *  - `expiry` → una `date` (o `null`) — el vencimiento MÁS PRÓXIMO.
 *  - `flag`   → un booleano.
 *
 * Los predicados que otra pantalla ya usa se repiten TEXTUALMENTE, y eso está
 * anotado en cada uno. Si divergen, dos pantallas del panel dicen dos verdades
 * distintas sobre el mismo usuario y nada lo delata — la misma clase de
 * acoplamiento que `INTERNAL_PREDICATE` entre `ops.repo.ts` y `ops.v_ai_usage`.
 */
/**
 * `EXISTS (auto no archivado de este usuario que cumple `predicate`)` — la
 * forma compartida de los seis campos de grano VEHÍCULO.
 *
 * Sólo "ALGUNO", nunca "TODOS": con cero autos no archivados, `NOT EXISTS
 * (auto que sí cumple X)` sería vacuamente verdadero y mandaría un push a los
 * 51 usuarios sin ningún vehículo cargado — el error contrario al de `null`
 * que documenta `conditionSql`, y en la dirección más cara (manda de más, no
 * de menos). "Alguno" no tiene esa mina: sin autos, la EXISTS de acá da
 * `false` sola.
 *
 * `predicate` referencia `v2` (el alias del auto) y puede sumar sus propios
 * `JOIN`/subconsultas — ver `vehicleNeverScanned`, que necesita el alias `ds`
 * que trae cableado la constante `OK`.
 */
function vehicleFlag(predicate: string): string {
  return `exists (select 1 from vehicles v2
                    where v2.user_id = u.id and not v2.archived
                      and ${predicate})`
}

const AUDIENCE_SQL: Record<AudienceFieldKey, string> = {
  vehicles: `(select count(*) from vehicles v where v.user_id = u.id and not v.archived)`,

  // El corte de "el escaneo sirvió" es el de `scanners.repo.ts` (constante `OK`)
  // y el de la columna «Escaneos» de `users.repo.ts`. Una sesión `completed` con
  // cero lecturas es un pareo que falló, no un escaneo.
  scansOk: `(select count(*) from driving_sessions d
               where d.user_id = u.id
                 and d.status::text = 'completed'
                 and coalesce(d.total_readings, 0) > 0)`,
  scansTotal: `(select count(*) from driving_sessions d where d.user_id = u.id)`,

  // Con al menos un mensaje, igual que `usageAdoption` en `ops.repo.ts`: 48 de
  // las 70 conversaciones de la base no tienen ninguno (`chats.md`), y una
  // conversación vacía no es uso.
  chats: `(select count(*) from conversations c
             where c.user_id = u.id
               and exists (select 1 from conversation_messages m where m.conversation_id = c.id))`,

  maintenanceUpcoming: `(select count(*) from maintenance_occurrences m
                           where m.user_id = u.id and not m.archived and m.performed_at is null)`,

  insurances: `(select count(*) from insurances i where i.user_id = u.id and not i.archived)`,
  inspections: `(select count(*) from vehicle_inspections i where i.user_id = u.id and not i.archived)`,
  registrationCards: `(select count(*) from registration_cards r where r.user_id = u.id and not r.archived)`,
  driverLicenses: `(select count(*) from driver_licenses l where l.user_id = u.id and not l.archived)`,

  // El vencimiento más próximo, no el del documento "principal": si un usuario
  // tiene tres autos y a uno se le vencio la VTV, hay algo que decirle.
  vtvExpiry: `(select min(i.expiration_date) from vehicle_inspections i
                 where i.user_id = u.id and not i.archived)`,
  insuranceExpiry: `(select min(i.expiration_date) from insurances i
                       where i.user_id = u.id and not i.archived)`,
  licenseExpiry: `(select min(l.expiration_date) from driver_licenses l
                     where l.user_id = u.id and not l.archived)`,
  registrationExpiry: `(select min(r.expiration_date) from registration_cards r
                          where r.user_id = u.id and not r.archived)`,

  // `status = 'pending'` es el predicado de deuda de `fines.repo.ts` y de la
  // columna «Monto adeudado» de `users.repo.ts`. `paid` está saldada y
  // `appealed` en disputa: ninguna de las dos es algo para ir a cobrar.
  pendingFines: `(select count(*) from fines f where f.user_id = u.id and f.status::text = 'pending')`,

  // ── Grano VEHÍCULO — `.claude/plans/cambios-2026-09-17.md`, punto A ────────
  //
  // `vehicleFlag()` es el `EXISTS (auto no archivado que cumple X)` compartido.
  // "Todos sus autos" NO se ofrece: con cero autos, un `NOT EXISTS (auto que sí
  // cumple)` sería vacuamente verdadero y mandaría de más — ver `vehicleFlag`.
  vehicleWithoutInsurance: vehicleFlag(
    `not exists (select 1 from insurances i2
                  where i2.vehicle_id = v2.id and not i2.archived)`,
  ),
  // El predicado de "es OCR" de `documents.md`: `file_id is not null`, y
  // `source = 'manual'` para no contar el lookup por patente como si fuera un
  // documento cargado — la misma elección que ya hace la pantalla de VTV.
  vehicleWithoutVtv: vehicleFlag(
    `not exists (select 1 from vehicle_inspections vi2
                  where vi2.vehicle_id = v2.id and not vi2.archived
                    and vi2.file_id is not null and vi2.source::text = 'manual')`,
  ),
  vehicleWithoutRegistration: vehicleFlag(
    `not exists (select 1 from registration_cards r2
                  where r2.vehicle_id = v2.id and not r2.archived)`,
  ),
  // Mismo corte que `fines.repo.ts` y `pendingFines` de arriba, sobre el auto.
  vehicleWithPendingFines: vehicleFlag(
    `exists (select 1 from fines f2
              where f2.vehicle_id = v2.id and f2.status::text = 'pending')`,
  ),
  // `OK`, importado de `scanners.repo.ts` — el mismo corte que la matriz de
  // `/escaneres` y la columna «Escaneos» de `users.repo.ts`. Requiere alias
  // `ds` porque `OK` lo trae cableado.
  vehicleNeverScanned: vehicleFlag(
    `not exists (select 1 from driving_sessions ds where ds.vehicle_id = v2.id and ${OK})`,
  ),
  // Mismo corte que `odometer` en `usageAdoption()` de `ops.repo.ts`.
  vehicleWithoutOdometer: vehicleFlag(`coalesce(v2.odometer_value, 0) = 0`),

  signup: `u.created_at`,

  // Sin piso en `created_at`, a propósito: acá `null` tiene que poder significar
  // "se registró y no hizo nada", que es el mismo `null` de la columna
  // «Última actividad» de /usuarios. El churn de /negocio sí le pone piso, y por
  // eso `lastSignalSql` lo toma por parámetro. → `~/lib/activity`
  lastActivity: lastSignalSql('u.id'),
  lastScan: `(select max(d.created_at) from driving_sessions d where d.user_id = u.id)`,
  lastChat: `(select max(c.created_at) from conversations c where c.user_id = u.id)`,

  pushTokens: `(select count(*) from expo_push_tokens t where t.user_id = u.id)`,
  announcementsReceived: `(select count(*) from notifications n
                             where n.user_id = u.id and n.source_type::text = 'broadcast')`,

  isAdmin: `(u.role::text = 'admin')`,
  isInternal: INTERNAL_PREDICATE,
  isLegacyNative: `(u.auth_provider::text = 'native')`,
}

// ── De condición a SQL ───────────────────────────────────────────────────────

/**
 * Traduce UNA condición a un fragmento de `where`, empujando su `value` a
 * `params`.
 *
 * Dos decisiones que se leen en el código y conviene tener escritas:
 *
 *  1. **`null` nunca matchea.** Un `lastScan` nulo (nunca escaneó) no entra en
 *     "fue hace más de 30 días": en SQL eso da `null`, que el `where` descarta.
 *     Es lo correcto y es lo que casi nadie espera — para "nunca escaneó" está
 *     el operador `never`, que es otra condición y se elige a propósito.
 *  2. **Los intervalos van por parámetro** (`make_interval(days => $n::int)`),
 *     no concatenados. Es un número nuestro validado por zod, pero un `interval`
 *     armado con concatenación es la puerta por la que después entra el primero
 *     que sí venga de la URL — misma regla que `ops.repo.ts`, trampa 7.
 */
function conditionSql(c: AudienceCondition, params: Array<unknown>): string {
  const expr = AUDIENCE_SQL[c.field]

  // Red de seguridad además de zod: el borde RPC ya valida, pero esta función
  // es llamable desde otro repo del servidor y un operador que no corresponde
  // al campo tiene que romper acá, no armar un `where` sin sentido.
  if (!operatorsFor(c.field).includes(c.op)) {
    throw new Error(`AUDIENCE_INVALID_OPERATOR:${c.field}.${c.op}`)
  }
  if (operatorNeedsValue(c.op) && c.value === undefined) {
    throw new Error(`AUDIENCE_MISSING_VALUE:${c.field}.${c.op}`)
  }

  const push = (v: unknown): string => {
    params.push(v)
    return `$${params.length}`
  }

  switch (c.op) {
    case 'eq':
      return `${expr} = ${push(c.value)}::int`
    case 'gte':
      return `${expr} >= ${push(c.value)}::int`
    case 'lte':
      return `${expr} <= ${push(c.value)}::int`

    case 'moreThan':
      return `${expr} < now() - make_interval(days => ${push(c.value)}::int)`
    case 'lessThan':
      return `${expr} >= now() - make_interval(days => ${push(c.value)}::int)`
    case 'never':
      return `${expr} is null`
    case 'ever':
      return `${expr} is not null`

    case 'expired':
      return `${expr} < current_date`
    case 'withinDays':
      return `(${expr} >= current_date and ${expr} <= current_date + ${push(c.value)}::int)`
    case 'valid':
      return `${expr} >= current_date`
    case 'missing':
      return `${expr} is null`

    case 'yes':
      return `(${expr})`
    case 'no':
      return `not (${expr})`
  }
}

/** El `where` completo: todas las condiciones con `AND`. Nunca `OR`, ver `~/lib/audience`. */
function audienceWhere(
  conditions: ReadonlyArray<AudienceCondition>,
  params: Array<unknown>,
): string {
  return conditions.map((c) => conditionSql(c, params)).join('\n        and ')
}

// ── Vista previa ─────────────────────────────────────────────────────────────

interface PreviewRow {
  id: string
  email: string
  name: string | null
  push_tokens: number | string
  matched: number | string
  without_device: number | string
  internal_or_admin: number | string
}

/**
 * Cuántos usuarios cumplen las condiciones, y quiénes son los primeros 500.
 *
 * ── Los tres conteos van con ventana, no con una segunda consulta ───────────
 *
 * `count(*) over ()` se calcula ANTES del `limit`, así que `matched` es el total
 * real aunque sólo vuelvan 500 filas. Con dos consultas serían dos `now()` y dos
 * snapshots: el total podría no corresponderse con la lista de abajo, que es
 * justo el número que el operador va a leer antes de apretar Enviar.
 *
 * ── El orden es `created_at`, y es parte del contrato ───────────────────────
 *
 * Cuando la condición matchea más de 500, el corte tiene que ser el MISMO cada
 * vez que se previsualiza: si no, previsualizar dos veces manda dos grupos
 * distintos y el segundo envío le repite el push a la mitad. Los más viejos
 * primero, con desempate por `id` porque `created_at` puede empatar.
 */
export async function previewAudience(
  input: AudienceInput,
  opts: { signal?: AbortSignal } = {},
): Promise<AudiencePreview> {
  void opts.signal // `pg` no acepta AbortSignal; queda documentado el hueco.

  const params: Array<unknown> = []
  const where = audienceWhere(input.conditions, params)
  params.push(AUDIENCE_RECIPIENT_LIMIT)
  const limitParam = `$${params.length}`

  const rows = await sql<PreviewRow>(
    `
    select
      id,
      email,
      name,
      push_tokens,
      count(*) over ()::int                                 as matched,
      count(*) filter (where push_tokens = 0) over ()::int  as without_device,
      count(*) filter (where internal_or_admin) over ()::int as internal_or_admin
    from (
      select
        u.id,
        u.email,
        u.name,
        u.created_at,
        ${AUDIENCE_SQL.pushTokens}::int as push_tokens,
        (${AUDIENCE_SQL.isAdmin} or ${AUDIENCE_SQL.isInternal}) as internal_or_admin
      from users u
      where ${where}
    ) m
    order by created_at, id
    limit ${limitParam}
    `,
    params,
  )

  const first = rows[0]

  return {
    // Sin filas, los tres conteos de ventana no existen: cero, no `NaN`.
    matched: first ? Number(first.matched) : 0,
    withoutDevice: first ? Number(first.without_device) : 0,
    internalOrAdmin: first ? Number(first.internal_or_admin) : 0,
    recipients: rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      pushTokens: Number(r.push_tokens ?? 0),
    })),
  }
}
