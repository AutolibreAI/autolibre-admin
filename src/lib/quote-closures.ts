/**
 * Cierre declarado de un pedido: "Contraté / No contraté", con quién, monto,
 * confirmación del proveedor y disputa — tarjeta "Pedidos: "Contraté / No
 * contraté" con elección de proveedor, historial, confirmación y cierre".
 *
 * Lo que YA existe y se lee real: `quote_requests.user_outcome`
 * (`hired | not_hired | pending`), `selected_proposal_id` (la propuesta que la
 * persona eligió en la app) y `outcome` del operador. Todo lo demás (con quién
 * si no fue una propuesta, monto final, estado del trabajo, motivo de "no
 * contraté", la respuesta del proveedor y la disputa) no tiene columna: estas
 * formas son las del backend pedido, y hoy las llena `~/mocks/quote-closures`.
 */

export const HIRED_WITH = ['proposal', 'other_partner', 'external'] as const
export type HiredWith = (typeof HIRED_WITH)[number]
export const HIRED_WITH_LABELS: Record<HiredWith, string> = {
  proposal: 'Una de las propuestas',
  other_partner: 'Otro proveedor de AutoLibre',
  external: 'Un proveedor externo',
}

export const WORK_STATUSES = ['waiting', 'verified', 'unverified', 'disputed'] as const
export type WorkStatus = (typeof WORK_STATUSES)[number]
export const WORK_STATUS_LABELS: Record<WorkStatus, string> = {
  waiting: 'En espera',
  verified: 'Verificado',
  unverified: 'Sin validar',
  disputed: 'En disputa',
}

/** Los códigos de cierre nuevos (no existen en `quote_request_close_reason`) y los de hoy. */
export const CLOSURE_CODES = [
  'resolved',
  'user_not_hired',
  'too_expensive',
  'no_workshops_found',
  'no_user_response',
  'cancelled_by_user',
] as const
export type ClosureCode = (typeof CLOSURE_CODES)[number]
export const CLOSURE_CODE_LABELS: Record<ClosureCode, string> = {
  resolved: 'Resuelto',
  user_not_hired: 'No contrató (nuevo)',
  too_expensive: 'Muy caro (nuevo)',
  no_workshops_found: 'Sin proveedores',
  no_user_response: 'Sin respuesta de la persona',
  cancelled_by_user: 'Cancelado por la persona',
}
export const NEW_CLOSURE_CODES: ReadonlyArray<ClosureCode> = ['user_not_hired', 'too_expensive']

export const PROVIDER_ANSWERS = ['confirmed', 'not_recognized'] as const
export type ProviderAnswer = (typeof PROVIDER_ANSWERS)[number]
export const PROVIDER_ANSWER_LABELS: Record<ProviderAnswer, string> = {
  confirmed: 'Confirmó el trabajo',
  not_recognized: 'No reconoce el trabajo',
}

export const DISPUTE_DECISIONS = ['validate', 'correct', 'discard'] as const
export type DisputeDecision = (typeof DISPUTE_DECISIONS)[number]
export const DISPUTE_DECISION_LABELS: Record<DisputeDecision, string> = {
  validate: 'Validar lo que dijo la persona',
  correct: 'Corregir',
  discard: 'Descartar la declaración',
}

/** Lo que declaró la persona al cerrar. Va con el pedido, nunca con su teléfono. */
export interface QuoteClosure {
  quoteRequestId: string
  publicNumber: number
  declaredAt: string
  hired: boolean
  hiredWith: HiredWith | null
  /** Nombre resuelto del proveedor (de la propuesta, del directorio o tipeado). */
  providerName: string | null
  /** Sólo si es externo: lo que va a captación (Comercial). */
  externalProviderPhone: string | null
  finalAmount: number | null
  workStatus: WorkStatus
  closureCode: ClosureCode
  notHiredReason: string | null
  providerAnswer: ProviderAnswer | null
  providerAnswerAt: string | null
  providerAnswerNote: string | null
}

export interface DisputeResolution {
  decision: DisputeDecision
  note: string
  resolvedAt: string
}

/** Una nota de resolución es obligatoria y de un renglón. */
export function validDisputeNote(note: string): boolean {
  return note.trim().length >= 3 && note.trim().length <= 500
}
