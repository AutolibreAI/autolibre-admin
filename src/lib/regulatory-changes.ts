/**
 * Cambios normativos que tocan un .md del asistente (`/conocimiento/cambios`).
 *
 * Tarjeta "automatizar cambios normativos a .md de la IA". Una FICHA es un
 * cambio detectado en una norma (tema, jurisdicción, valor anterior y nuevo,
 * vigencia, norma, URL y cita textual) más el diff propuesto sobre UNA sección
 * de un .md del RAG. La IA puede armar la ficha; aprobarla es siempre de una
 * persona, y aprobar = subir una versión nueva del .md con el diff aplicado
 * (`supersedesDocumentId`), cosa que hoy NO pasa: las fichas viven en
 * `~/mocks/regulatory-changes`.
 *
 * Lo de este archivo es determinístico: el diff, el chequeo de coherencia y las
 * reglas de aprobar/rechazar salen de reglas fijas, no de la IA.
 */

export const REGULATORY_CHANGE_STATUSES = ['pending', 'approved', 'rejected'] as const
export type RegulatoryChangeStatus = (typeof REGULATORY_CHANGE_STATUSES)[number]

export const REGULATORY_CHANGE_STATUS_LABELS: Record<RegulatoryChangeStatus, string> = {
  pending: 'A revisar',
  approved: 'Aprobado',
  rejected: 'Rechazado',
}

/** La cola es amarilla (a revisar). Aprobado en verde, rechazado gris. */
export const REGULATORY_CHANGE_STATUS_CLASSES: Record<RegulatoryChangeStatus, string> = {
  pending: 'border-status-yellow/40 bg-status-yellow-bg text-status-yellow',
  approved: 'border-status-green/30 bg-status-green-bg text-status-green',
  rejected: 'border-border bg-secondary text-muted-foreground',
}

export interface RegulatoryChange {
  id: string
  topic: string
  jurisdiction: string
  oldValue: string
  newValue: string
  /** `YYYY-MM-DD`: desde cuándo rige el valor nuevo. */
  effectiveFrom: string
  norm: string
  sourceUrl: string
  /** La cita TEXTUAL de la norma. Sin cita no hay ficha. */
  quote: string
  /** Quién armó la ficha: el detector (IA) o una persona. */
  proposedBy: 'detector' | 'person'
  detectedAt: string
  /** El .md al que apunta y la sección (`## …`) que cambia. */
  documentTitle: string
  section: string
  /** El texto de la sección HOY y el propuesto. */
  sectionBefore: string
  sectionAfter: string
  status: RegulatoryChangeStatus
  reviewedBy: string | null
  reviewedAt: string | null
  /** Obligatorio al rechazar. */
  rejectionReason: string | null
  /** El renglón del changelog que deja aprobar. */
  changeSummary: string | null
}

// ── Diff por renglón ────────────────────────────────────────────────────────

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

/**
 * Diff de renglones por LCS. Determinístico y sin dependencias: las secciones
 * son de decenas de renglones, así que el O(n·m) no pesa.
 */
export function diffLines(before: string, after: string): Array<DiffLine> {
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  const n = a.length
  const m = b.length
  const lcs: Array<Array<number>> = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const out: Array<DiffLine> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: 'del', text: a[i++]! })
    else out.push({ kind: 'add', text: b[j++]! })
  }
  while (i < n) out.push({ kind: 'del', text: a[i++]! })
  while (j < m) out.push({ kind: 'add', text: b[j++]! })
  return out
}

// ── Chequeos antes de aprobar ───────────────────────────────────────────────

export interface RegulatoryCheck {
  id: string
  ok: boolean
  label: string
}

const has = (haystack: string, needle: string) =>
  needle.trim() !== '' && haystack.toLowerCase().includes(needle.trim().toLowerCase())

/**
 * Lo que tiene que cumplir una ficha para poder aprobarse. Es coherencia de la
 * ficha consigo misma, no juicio sobre la norma: eso lo hace la persona.
 */
export function regulatoryChecks(c: RegulatoryChange): Array<RegulatoryCheck> {
  const diff = diffLines(c.sectionBefore, c.sectionAfter)
  const added = diff.filter((d) => d.kind === 'add').map((d) => d.text).join('\n')
  const removed = diff.filter((d) => d.kind === 'del').map((d) => d.text).join('\n')
  return [
    { id: 'quote', ok: c.quote.trim() !== '', label: 'Tiene cita textual de la norma' },
    { id: 'source', ok: /^https:\/\//.test(c.sourceUrl), label: 'Tiene URL de la fuente (https)' },
    { id: 'changes', ok: diff.some((d) => d.kind !== 'same'), label: 'El diff cambia algo' },
    { id: 'new', ok: has(added, c.newValue), label: 'El valor nuevo aparece en lo que se agrega' },
    { id: 'old', ok: has(removed, c.oldValue), label: 'El valor anterior aparece en lo que se saca' },
    {
      id: 'stale',
      ok: !has(c.sectionAfter, c.oldValue),
      label: 'El valor anterior no queda en otro renglón de la sección',
    },
  ]
}

export const REGULATORY_REASON_MAX = 500

/** Aprobar: todos los chequeos, la confirmación de haber leído la fuente y un resumen. */
export function approvalProblem(c: RegulatoryChange, input: { readSource: boolean; summary: string }): string | null {
  if (c.status !== 'pending') return 'La ficha ya se revisó.'
  const failed = regulatoryChecks(c).filter((x) => !x.ok)
  if (failed.length > 0) return `No se puede aprobar: ${failed.map((f) => f.label.toLowerCase()).join('; ')}.`
  if (!input.readSource) return 'Confirmá que leíste la norma en la fuente.'
  if (input.summary.trim() === '') return 'Escribí qué cambió (va al historial del documento).'
  if (input.summary.length > REGULATORY_REASON_MAX) return `El resumen supera ${REGULATORY_REASON_MAX} caracteres.`
  return null
}

export function rejectionProblem(c: RegulatoryChange, reason: string): string | null {
  if (c.status !== 'pending') return 'La ficha ya se revisó.'
  if (reason.trim() === '') return 'Decí por qué se rechaza.'
  if (reason.length > REGULATORY_REASON_MAX) return `El motivo supera ${REGULATORY_REASON_MAX} caracteres.`
  return null
}
