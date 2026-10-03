import '@tanstack/react-start/server-only'

import { sql } from './db'
import { INTERNAL_PREDICATE, PG_UNIT } from './ops.repo'
import { notDuplicatePredicate, quoteRequestsAvailability } from './quote-requests.repo'
import { METRICS_TZ, type GrowthUnit } from '~/lib/ops'
import type { ChannelPeople } from '~/lib/channels'

/**
 * Personas por canal de llegada (`~/lib/channels` tiene el porqué completo).
 *
 * La identidad se resuelve en JS con un union-find sobre tres tipos de nodo
 * —teléfono, email, usuario— y no en SQL: es una clausura transitiva (A–X–B),
 * que en SQL es un CTE recursivo difícil de leer y fácil de equivocar. Los
 * pedidos son decenas y los usuarios cientos; traerlos enteros cuesta nada.
 *
 * Dos consultas y no una: pedidos y usuarios son universos distintos. Las dos
 * corren en el mismo `Promise.all` — un usuario creado entre las dos lecturas
 * a lo sumo cuenta como "sin cuenta" en ese instante, no rompe ningún cuadre.
 */

interface RequestRow {
  channel: string
  created_at: Date | string
  phone: string | null
  email: string | null
  user_id: string | null
  is_real: boolean
  internal_email: boolean
}

interface UserRow {
  id: string
  email: string | null
  created_at: Date | string
  internal: boolean
}

const OTHER_CHANNELS = ['whatsapp', 'web'] as const
type OtherChannel = (typeof OTHER_CHANNELS)[number]

class UnionFind {
  private parent = new Map<string, string>()
  find(x: string): string {
    let root = this.parent.get(x) ?? x
    if (root !== x) {
      root = this.find(root)
      this.parent.set(x, root)
    }
    return root
  }
  union(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

const ms = (d: Date | string) => new Date(d).getTime()

export async function channelPeople(
  unit: GrowthUnit,
  opts: { signal?: AbortSignal } = {},
): Promise<ChannelPeople> {
  void opts.signal

  const availability = await quoteRequestsAvailability()

  const usersPromise = sql<UserRow>(
    `select u.id, nullif(lower(btrim(coalesce(u.email, ''))), '') as email, u.created_at,
            ${INTERNAL_PREDICATE} as internal
       from users u`,
  )

  // Sin `quote_requests` no hay otro canal que contar: la tabla queda en cero
  // y lo dice, en vez de explotar al planificar la consulta.
  if (!availability.available) {
    const users = await usersPromise
    return {
      available: false,
      appUsers: users.filter((u) => !u.internal).length,
      appFromWhatsapp: 0,
      appFromWeb: 0,
      whatsappOnly: 0,
      webOnly: 0,
      unit,
      series: [],
    }
  }

  const [users, requests] = await Promise.all([
    usersPromise,
    sql<RequestRow>(
      `select qr.channel::text as channel, qr.created_at,
              nullif(regexp_replace(coalesce(qr.contact_phone, ''), '[^0-9]', '', 'g'), '') as phone,
              nullif(lower(btrim(coalesce(qr.contact_email, ''))), '') as email,
              qr.user_id,
              (${notDuplicatePredicate('qr.')}) as is_real,
              coalesce(
                split_part(lower(qr.contact_email), '@', 2) in (select d.domain from ops.excluded_email_domains d),
                false
              ) as internal_email
         from quote_requests qr`,
    ),
  ])

  const uf = new UnionFind()
  for (const u of users) {
    uf.find(`u:${u.id}`)
    if (u.email) uf.union(`u:${u.id}`, `e:${u.email}`)
  }
  // Un pedido une su teléfono, su email y su cuenta. Los `duplicate` TAMBIÉN
  // unen (un pedido de prueba sigue diciendo que ese teléfono es de esa
  // cuenta); lo que no hacen es contar como llegada.
  for (const r of requests) {
    const nodes = [
      r.phone ? `p:${r.phone}` : null,
      r.email ? `e:${r.email}` : null,
      r.user_id ? `u:${r.user_id}` : null,
    ].filter((n): n is string => n !== null)
    for (let i = 1; i < nodes.length; i++) uf.union(nodes[0]!, nodes[i]!)
    if (nodes.length === 1) uf.find(nodes[0]!)
  }

  interface Group {
    users: Array<UserRow>
    firstContact: { at: number; channel: OtherChannel } | null
    /** Un email de dominio excluido o una cuenta interna. Sólo pesa en los grupos sin cuenta real. */
    contactInternal: boolean
  }
  const groups = new Map<string, Group>()
  const group = (key: string): Group => {
    const root = uf.find(key)
    let g = groups.get(root)
    if (!g) {
      g = { users: [], firstContact: null, contactInternal: false }
      groups.set(root, g)
    }
    return g
  }

  for (const u of users) {
    // Una cuenta interna no es un usuario real, y sus contactos tampoco son
    // "gente sin cuenta": marca el grupo entero como interno.
    if (u.internal) group(`u:${u.id}`).contactInternal = true
    else group(`u:${u.id}`).users.push(u)
  }
  for (const r of requests) {
    const key = r.phone ? `p:${r.phone}` : r.email ? `e:${r.email}` : r.user_id ? `u:${r.user_id}` : null
    if (!key) continue
    const g = group(key)
    if (r.internal_email) g.contactInternal = true
    if (!r.is_real || !(OTHER_CHANNELS as ReadonlyArray<string>).includes(r.channel)) continue
    const at = ms(r.created_at)
    if (!g.firstContact || at < g.firstContact.at) g.firstContact = { at, channel: r.channel as OtherChannel }
  }

  // Sale de la lista de usuarios, no de los grupos: tiene que dar EXACTO
  // "Usuarios reales" de Inicio, haga lo que haga el cruce con los pedidos.
  const appUsers = users.filter((u) => !u.internal).length
  const counts = { appFromWhatsapp: 0, appFromWeb: 0, whatsappOnly: 0, webOnly: 0 }
  const arrivals: Array<{ at: number; channel: OtherChannel }> = []

  for (const g of groups.values()) {
    if (g.users.length > 0) {
      if (!g.firstContact) continue
      // Si un teléfono quedó atado a dos cuentas (raro), la llegada se le
      // atribuye a la más vieja — una persona, una llegada.
      const firstSignup = Math.min(...g.users.map((u) => ms(u.created_at)))
      if (g.firstContact.at < firstSignup) {
        if (g.firstContact.channel === 'whatsapp') counts.appFromWhatsapp++
        else counts.appFromWeb++
        arrivals.push(g.firstContact)
      }
    } else if (g.firstContact && !g.contactInternal) {
      if (g.firstContact.channel === 'whatsapp') counts.whatsappOnly++
      else counts.webOnly++
      arrivals.push(g.firstContact)
    }
  }

  const series = await sql<{ bucket: string; whatsapp: number | string; web: number | string }>(
    `
    with t as (
      select date_trunc($1, x.ts at time zone $2) as bucket, x.ch
        from unnest($3::timestamptz[], $4::text[]) as x(ts, ch)
    ),
    counts as (
      select bucket,
             count(*) filter (where ch = 'whatsapp')::int as whatsapp,
             count(*) filter (where ch = 'web')::int as web
        from t group by 1
    ),
    span as (select min(bucket) as lo, max(bucket) as hi from counts),
    buckets as (
      select generate_series(span.lo, span.hi, ('1 ' || $1)::interval) as bucket from span
    )
    select to_char(b.bucket, 'YYYY-MM-DD') as bucket,
           coalesce(c.whatsapp, 0) as whatsapp,
           coalesce(c.web, 0) as web
      from buckets b
      left join counts c using (bucket)
     order by b.bucket
    `,
    [
      PG_UNIT[unit],
      METRICS_TZ,
      arrivals.map((a) => new Date(a.at).toISOString()),
      arrivals.map((a) => a.channel),
    ],
  )

  return {
    available: true,
    appUsers,
    ...counts,
    unit,
    series: series.map((r) => ({ bucket: r.bucket, whatsapp: Number(r.whatsapp), web: Number(r.web) })),
  }
}
