import { toWhatsAppAR } from '~/lib/whatsapp-ar'

/**
 * Seguimiento de pedidos (`/leads/pedidos/seguimiento`) — el porteo al admin del
 * prototipo https://claude.ai/artifact/29GyDSkTxsbLuk9QVydxWV (tarjeta de Trello
 * «Pantalla de seguimiento de pedidos en el admin»).
 *
 * Qué pedidos entran (criterio de la tarjeta, lo aplica el SQL): desde el
 * 1/9/26, sin resultado (`outcome` vacío o `no_response`, y `user_outcome`
 * vacío o `pending`), sin cierres `duplicate`/`resolved`/`cancelled_by_user`,
 * sin cancelación `created_by_mistake`, sin pedidos de admins ni de cuentas
 * internas, sin notas con «pedido de prueba». La descripción «perfecto estado»
 * se descarta acá (`buildFollowupContacts`).
 *
 * Se agrupa por PERSONA (teléfono normalizado). Una persona está «enviada» si
 * TODOS sus pedidos tienen el envío guardado (`ops.quote_followup_send`, 041);
 * si apareció uno nuevo después, vuelve a pendiente con «Pedido nuevo».
 *
 * Los textos de los mensajes y de las respuestas rápidas son los del
 * prototipo, tal cual: los escribió Nicolás.
 */

export const FOLLOWUP_SINCE = '2026-09-01'

export interface FollowupProposal {
  id: string
  partnerId: string | null
  name: string
}

export interface FollowupOrder {
  id: string
  n: number
  /** `YYYY-MM-DD`, hora de Buenos Aires. */
  fecha: string
  status: string
  outcome: string | null
  cierre: string | null
  answeredAt: string | null
  nombre: string | null
  tel: string | null
  plate: string | null
  auto: string | null
  servicios: string | null
  descr: string | null
  proposals: Array<FollowupProposal>
  elegido: string | null
  /** El envío guardado de este pedido (041). */
  sentAt: string | null
  sentByName: string | null
}

export type FollowupGroup = 'prop' | 'sin' | 'f0'

export const FOLLOWUP_TABS = ['prop', 'sin', 'f0', 'all'] as const
export type FollowupTab = (typeof FOLLOWUP_TABS)[number]

export const FOLLOWUP_TAB_LABELS: Record<FollowupTab, string> = {
  prop: 'Con propuestas',
  sin: 'Sin propuestas',
  f0: 'Último intento',
  all: 'Todos',
}

export interface FollowupContact {
  /** Teléfono en dígitos (549… si se pudo normalizar). */
  key: string
  waDigits: string | null
  nombre: string | null
  pedidos: Array<FollowupOrder>
  group: FollowupGroup
  last: string
  reciente: boolean
  /** Todos sus pedidos tienen el envío guardado. */
  sent: boolean
  /** Le escribimos por algunos, pero apareció un pedido nuevo. */
  newOrder: boolean
  /** El envío más reciente, para mostrar. */
  lastSentAt: string | null
  lastSentBy: string | null
  msg: string
}

// ── Formateo (del prototipo) ────────────────────────────────────────────────

const KEEP_UP = new Set(['BMW', 'VW', 'GTS', 'THP', 'HDI', 'TDCI', 'MPI', 'LS', 'SW', 'AC', 'ABS', 'SR', 'EX', 'GNC', 'XEI', 'GL', 'MT', 'AT', 'CVT', '4X4', 'SXIE', 'XS', 'TDI', 'GTI', 'SUV', 'II'])

export function fmtAuto(a: string | null): string {
  if (!a) return ''
  const words = String(a).replace(/\s+/g, ' ').trim().split(' ')
  const out = words.map((w) => {
    const up = w.toUpperCase()
    if (w === up && /[A-ZÁÉÍÓÚÑ]/.test(w)) {
      if (KEEP_UP.has(up) || /\d/.test(w)) return up
      return w.charAt(0) + w.slice(1).toLowerCase()
    }
    return w
  })
  let s = out.join(' ')
  s = s.charAt(0).toUpperCase() + s.slice(1)
  return s.length > 40 ? s.split(' ').slice(0, 4).join(' ') : s
}

function firstName(n: string | null): string {
  if (!n) return ''
  const w = String(n).trim().split(/\s+/)[0] ?? ''
  if (w.length < 2) return ''
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
}

function lowerFirst(s: string): string {
  if (!s) return s
  if (/^[A-ZÁÉÍÓÚÑ]{2,}/.test(s)) return s
  return s.charAt(0).toLowerCase() + s.slice(1)
}

/** Qué necesita, corto. */
export function que(p: Pick<FollowupOrder, 'descr' | 'servicios'>): string {
  const d = String(p.descr ?? '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '')
  if (d && d.length <= 70) return lowerFirst(d)
  if (p.servicios) return p.servicios.split(' + ').slice(0, 2).join(' y ').toLowerCase()
  if (d) {
    let cut = d.split(/(?<=[.;])\s/)[0] ?? d
    if (cut.length > 70) cut = cut.slice(0, 67).replace(/\s+\S*$/, '') + '…'
    return lowerFirst(cut.replace(/[.]$/, ''))
  }
  return ''
}

function joinY(arr: Array<string>): string {
  const a = arr.filter(Boolean)
  if (a.length <= 1) return a.join('')
  return a.slice(0, -1).join(', ') + ' y ' + a[a.length - 1]
}

export const talleres = (p: FollowupOrder) => p.proposals.map((x) => x.name.trim().replace(/[.]+$/, '')).filter(Boolean)

/** Días entre dos `YYYY-MM-DD`, sin `Date` local (la pantalla es SSR). */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10))
  return Math.round((b - a) / 86400000)
}

export const fmtFecha = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}`

export function fmtPhone(d: string): string {
  if (/^54911\d{8}$/.test(d)) return `+54 9 11 ${d.slice(5, 9)}-${d.slice(9)}`
  if (/^549\d{10}$/.test(d)) return `+54 9 ${d.slice(3, 6)} ${d.slice(6, 9)}-${d.slice(9)}`
  return `+${d}`
}

// ── El mensaje según el caso ────────────────────────────────────────────────

export function buildFollowupMessage(c: Pick<FollowupContact, 'nombre' | 'pedidos' | 'group'>, today: string, sender = 'Nicolás'): string {
  const ps = c.pedidos
  const name = firstName(c.nombre)
  const hola = name ? `Hola ${name}, ¿cómo estás?` : 'Hola, ¿cómo estás?'
  const yo = `Soy ${sender}, de AutoLibre.`
  if (ps.length > 1) {
    const first = ps[0]!
    const sameAuto = ps.every((p) => fmtAuto(p.auto) === fmtAuto(first.auto)) && first.auto
    const items = ps.map((p) => `AL-${p.n} (${que(p) || fmtAuto(p.auto)})`)
    const del = sameAuto ? ` del ${fmtAuto(first.auto)}` : ''
    if (c.group === 'f0')
      return `${hola} ${yo} Hace un tiempo nos pediste ayuda${del} con ${joinY(items)}. ¿Lo pudiste resolver? Me sirve mucho saber cómo terminó para mejorar el servicio.`
    const conProp = ps.some((p) => p.proposals.length > 0)
    return `${hola} ${yo} Te escribo por tus pedidos${del}: ${joinY(items)}. ¿Pudiste resolverlos? Contame si los hiciste con ${conProp ? 'alguno de los mecánicos que te pasamos' : 'algún mecánico'}, con otro o si siguen pendientes.`
  }
  const p = ps[0]!
  const auto = fmtAuto(p.auto)
  const ref = `tu pedido AL-${p.n}${auto ? ` (${auto})` : ''}`
  const q = que(p)
  const qtxt = q ? `: ${q}` : ''
  if (c.group === 'f0')
    return `${hola} ${yo} Hace un tiempo nos pediste ayuda con ${ref}${qtxt}. ¿Lo pudiste resolver? Me sirve mucho saber cómo terminó para mejorar el servicio.`
  if (p.proposals.length > 0) {
    const ts = talleres(p)
    if (p.elegido)
      return `${hola} ${yo} Te escribo por ${ref}${qtxt}. Vi que elegiste la propuesta de ${p.elegido.replace(/[.]+$/, '')}. ¿Ya te hicieron el trabajo? Contame cómo te fue.`
    if (daysBetween(p.fecha, today) <= 3)
      return `${hola} ${yo} Te escribo por ${ref}${qtxt}. ¿Pudiste ver ${ts.length > 1 ? `las propuestas de ${joinY(ts)}` : `la propuesta de ${ts[0]}`}? Si querés que te ayude a elegir o tenés alguna duda, decime.`
    const lleg = ts.length > 1 ? `Te habían llegado ${ts.length} propuestas (${joinY(ts)})` : `Te había llegado una propuesta de ${ts[0]}`
    return `${hola} ${yo} Te escribo por ${ref}${qtxt}. ${lleg}. ¿Pudiste resolverlo? Contame si lo hiciste con ${ts.length > 1 ? 'alguno de ellos' : 'ellos'}, con otro mecánico o si todavía está pendiente.`
  }
  if (p.cierre === 'no_workshops_found')
    return `${hola} ${yo} Te escribo por ${ref}${qtxt}. En ese momento no conseguimos mecánicos de tu zona que te pasaran propuesta. ¿Lo pudiste resolver? Si todavía lo necesitás, decime y vuelvo a buscar.`
  return `${hola} ${yo} Te escribo por ${ref}${qtxt}. ¿Lo pudiste resolver? Contame si lo hiciste con algún mecánico o si todavía está pendiente; si lo necesitás, te consigo propuestas.`
}

// ── Respuestas rápidas (del prototipo) ──────────────────────────────────────

export const FOLLOWUP_QUICK_REPLIES: ReadonlyArray<{ when: string; admin: string; text: string }> = [
  { when: 'Si lo hizo con un mecánico de AutoLibre', admin: 'Cargá: fue, con el taller', text: '¡Qué bueno! ¿Cómo te fue? Si querés, mandame una foto de la factura y la guardo en el historial de tu auto.' },
  { when: 'Si lo hizo con otro mecánico', admin: 'Cargá: no fue (lo contrató fuera de la red)', text: 'Perfecto, gracias por contarme. La próxima vez que necesites algo del auto, pedime propuestas y te las consigo para comparar.' },
  { when: 'Si no lo hizo por precio o plata', admin: 'Cargá: no fue (falta de plata)', text: 'Gracias por contarme. Si te sirve, lo podés pagar en cuotas: las arma Moni, que trabaja con nosotros. ¿Querés que le pase tu nombre, tu teléfono y el pedido para que te contacte?' },
  { when: 'Si todavía está pendiente', admin: 'Cargá: todavía no (o dejalo sin cambios)', text: 'Dale, quedo atento. Si querés que vuelva a pedir propuestas o te ayudo a elegir entre las que tenés, decime.' },
  { when: 'Si ya no hace falta', admin: 'Cargá: no fue (ya no hace falta)', text: 'Buenísimo, gracias por avisarme. Cualquier cosa del auto, escribime por acá.' },
]

// ── Agrupado ────────────────────────────────────────────────────────────────

function phoneKey(tel: string | null): { key: string; wa: string | null } | null {
  if (!tel) return null
  const wa = toWhatsAppAR(tel)
  if (wa.ok) return { key: wa.digits, wa: wa.digits }
  const d = tel.replace(/\D/g, '')
  return d ? { key: d, wa: null } : null
}

export function buildFollowupContacts(rows: ReadonlyArray<FollowupOrder>, today: string): Array<FollowupContact> {
  const map = new Map<string, { key: string; wa: string | null; nombre: string | null; pedidos: Array<FollowupOrder> }>()
  for (const r of rows) {
    if (/^perfecto estado\.?$/i.test(String(r.descr ?? '').trim())) continue
    const k = phoneKey(r.tel)
    if (!k) continue
    const c = map.get(k.key) ?? { key: k.key, wa: k.wa, nombre: null, pedidos: [] }
    if (!c.nombre && r.nombre) c.nombre = r.nombre
    c.pedidos.push(r)
    map.set(k.key, c)
  }
  const out: Array<FollowupContact> = [...map.values()].map((c) => {
    c.pedidos.sort((a, b) => b.fecha.localeCompare(a.fecha) || b.n - a.n)
    const ps = c.pedidos
    const group: FollowupGroup = ps.some((p) => p.proposals.length > 0 && !p.outcome)
      ? 'prop'
      : ps.some((p) => !p.outcome)
        ? 'sin'
        : 'f0'
    const sentRows = ps.filter((p) => p.sentAt)
    const sent = sentRows.length === ps.length
    const lastSent = [...sentRows].sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''))[0] ?? null
    const last = ps[0]!.fecha
    const base = { nombre: c.nombre, pedidos: ps, group }
    return {
      key: c.key,
      waDigits: c.wa,
      ...base,
      last,
      reciente: group === 'prop' && daysBetween(last, today) <= 3,
      sent,
      newOrder: sentRows.length > 0 && !sent,
      lastSentAt: lastSent?.sentAt ?? null,
      lastSentBy: lastSent?.sentByName ?? null,
      msg: buildFollowupMessage(base, today),
    }
  })
  const order: Record<FollowupGroup, number> = { prop: 0, sin: 1, f0: 2 }
  return out.sort((a, b) => order[a.group] - order[b.group] || b.last.localeCompare(a.last))
}

export function matchesFollowupSearch(c: FollowupContact, q: string): boolean {
  const s = q.trim().toLowerCase()
  if (!s) return true
  const hay = [c.nombre, c.key, ...c.pedidos.map((p) => `al-${p.n} ${p.n} ${p.auto ?? ''} ${p.plate ?? ''} ${p.descr ?? ''}`)]
    .join(' ')
    .toLowerCase()
  return hay.includes(s)
}
