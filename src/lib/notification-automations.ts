import { z } from 'zod'
import { BROADCAST_BODY_MAX, BROADCAST_TITLE_MAX } from './notifications'
import { EFFECT_ACTIONS } from './notification-effect'

/**
 * Automatizaciones de notificaciones POR EVENTO (`/notificaciones/automatizaciones`)
 * — tarjeta "Configurar notificaciones desde el admin (puntuales y
 * recurrentes)", y la base de "Notificaciones: … reglas de seguimiento a
 * usuarios con pedidos abiertos".
 *
 * Lo que ya existía y NO se toca: el envío puntual (`BroadcastComposer`, real)
 * y los envíos programados por calendario (`ops.notification_schedule`,
 * reales pero sin motor). Lo que faltaba es lo de acá: un disparador que sale de
 * un hecho del pedido, y el canal. Ninguna de las dos cosas tiene dónde
 * guardarse ni quién la ejecute, así que esta pantalla corre contra
 * `~/mocks/notification-automations`.
 *
 * El disparador, el canal y los topes son catálogos CERRADOS, igual que las
 * audiencias por condición: lo que se guarda es `{kind, …}` validado, nunca una
 * expresión libre.
 */

/** Cuánto dura un pedido abierto. No está modelado en la base (no hay `expires_at`). */
export const QUOTE_REQUEST_LIFETIME_HOURS = 72

/**
 * Las reglas del pedido que las automatizaciones tienen que respetar (decididas
 * por producto; ninguna está modelada en la base todavía):
 *
 * - dura `QUOTE_REQUEST_LIFETIME_HOURS` (72 h) abierto;
 * - recibe hasta `QUOTE_PROPOSAL_CAP` (3) propuestas;
 * - el tope sube a `QUOTE_PROPOSAL_CAP_EXTENDED` (5) sólo si la 4ª y la 5ª son
 *   de un Aliado (`tier = founding`) o de su taller de cabecera (este último no
 *   existe todavía en ningún lado del sistema);
 * - se puede extender, pero SÓLO si la persona lo confirma: ningún aviso
 *   extiende un pedido por su cuenta.
 *
 * Por eso «llegó una propuesta» admite 1ª a 5ª, y la 4ª/5ª lo dicen; y el
 * aviso de extensión pregunta, no avisa que se extendió.
 */
export const QUOTE_PROPOSAL_CAP = 3
export const QUOTE_PROPOSAL_CAP_EXTENDED = 5
export const QUOTE_PROPOSAL_ORDINALS = [1, 2, 3, 4, 5] as const
export type QuoteProposalOrdinal = (typeof QUOTE_PROPOSAL_ORDINALS)[number]

export const AUTOMATION_CHANNELS = ['push', 'email', 'whatsapp', 'user_choice'] as const
export type AutomationChannel = (typeof AUTOMATION_CHANNELS)[number]

export const AUTOMATION_CHANNEL_LABELS: Record<AutomationChannel, string> = {
  push: 'Push',
  email: 'Mail',
  whatsapp: 'WhatsApp',
  user_choice: 'El que eligió la persona en el pedido',
}

/**
 * Por qué un canal no se puede usar todavía. `null` = disponible.
 * `notification_channel` del backend es `push | email | sms`, y todo lo enviado
 * hasta hoy es push.
 */
export const AUTOMATION_CHANNEL_BLOCKERS: Record<AutomationChannel, string | null> = {
  push: null,
  email: 'El backend tiene el canal pero nunca mandó un mail: falta el proveedor (Brevo).',
  whatsapp: 'No existe el canal WhatsApp en el backend.',
  user_choice: 'Falta guardar en el pedido si la persona quiere avisos por WhatsApp.',
}

export const QUOTE_TRIGGERS = [
  'open_reminder',
  'proposal_received',
  'hours_left',
  'extension_offer',
  'proposals_unviewed',
] as const
export type QuoteTrigger = (typeof QUOTE_TRIGGERS)[number]

export const QUOTE_TRIGGER_LABELS: Record<QuoteTrigger, string> = {
  open_reminder: 'Pedido abierto sin propuestas',
  proposal_received: 'Llegó una propuesta',
  hours_left: 'Quedan pocas horas del pedido',
  extension_offer: 'Ofrecer extender la búsqueda',
  proposals_unviewed: 'Propuestas sin mirar',
}

/** Qué hecho del backend hace falta para que el disparador funcione. */
export const QUOTE_TRIGGER_NEEDS: Record<QuoteTrigger, string> = {
  open_reminder: 'Un job que revise los pedidos abiertos sin propuestas.',
  proposal_received:
    'El evento quote_proposal_sent con el número de propuesta (1ª a 5ª). La 4ª y la 5ª, además, que el backend deje pasar el tope de 3 con Aliados o el taller de cabecera.',
  hours_left: 'La hora de vencimiento del pedido (72 h) y un job que la mire.',
  extension_offer:
    'La hora de vencimiento (72 h), un endpoint para que la persona confirme la extensión desde la app, y cuánto se extiende.',
  proposals_unviewed: 'El evento quote_proposal_viewed desde la app.',
}

export const automationTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('open_reminder'), afterHours: z.number().int().min(1).max(71) }),
  z.object({
    kind: z.literal('proposal_received'),
    ordinal: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  }),
  z.object({ kind: z.literal('hours_left'), hoursLeft: z.number().int().min(1).max(71) }),
  z.object({ kind: z.literal('extension_offer'), hoursLeft: z.number().int().min(1).max(71) }),
  z.object({ kind: z.literal('proposals_unviewed'), afterHours: z.number().int().min(1).max(71) }),
])
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>

export const automationSchema = z
  .object({
    name: z.string().trim().min(1, 'Ponele un nombre.').max(80),
    trigger: automationTriggerSchema,
    channel: z.enum(AUTOMATION_CHANNELS),
    title: z
      .string()
      .trim()
      .min(1, 'El título es obligatorio.')
      .max(BROADCAST_TITLE_MAX, `El título admite hasta ${BROADCAST_TITLE_MAX} caracteres.`),
    body: z
      .string()
      .trim()
      .min(1, 'El mensaje es obligatorio.')
      .max(BROADCAST_BODY_MAX, `El mensaje admite hasta ${BROADCAST_BODY_MAX} caracteres.`),
    /** Horario permitido, hora de Buenos Aires: lo que caiga afuera espera al próximo inicio. */
    sendFromHour: z.number().int().min(0).max(23),
    sendToHour: z.number().int().min(1).max(24),
    /** Pregunta de cierre (¿contrataste? ¿con quién?) al final del aviso. */
    asksClosing: z.boolean(),
    /**
     * Objetivo: la acción buscada, de la MISMA lista que mide «Efecto por
     * envío». Cada envío que dispare la regla lo hereda. Opcional; ausente o
     * `null` = sin objetivo. Va en el modelo único de reglas pedido al backend.
     */
    targetAction: z.enum(EFFECT_ACTIONS).nullable().optional(),
  })
  .refine((a) => a.sendFromHour < a.sendToHour, {
    message: 'La hora de inicio tiene que ser anterior a la de fin.',
    path: ['sendToHour'],
  })
export type AutomationInput = z.infer<typeof automationSchema>

export interface Automation extends AutomationInput {
  id: string
  active: boolean
  /** Viene de una plantilla de seguimiento precargada. */
  fromTemplate: string | null
  updatedAt: string
}

/** El disparador en una frase. Determinístico: nada de esto lo decide la IA. */
export function describeTrigger(t: AutomationTrigger): string {
  switch (t.kind) {
    case 'open_reminder':
      return `El pedido sigue abierto y sin propuestas ${t.afterHours} h después de creado.`
    case 'proposal_received':
      return t.ordinal > QUOTE_PROPOSAL_CAP
        ? `Se le envió su ${t.ordinal}ª propuesta. Sólo pasa si el tope subió de ${QUOTE_PROPOSAL_CAP} a ${QUOTE_PROPOSAL_CAP_EXTENDED} por un Aliado o su taller de cabecera.`
        : `Se le envió su ${t.ordinal}ª propuesta${t.ordinal === QUOTE_PROPOSAL_CAP ? ` (llegó al tope de ${QUOTE_PROPOSAL_CAP})` : ''}.`
    case 'hours_left':
      return `Quedan ${t.hoursLeft} h para que venza el pedido (dura ${QUOTE_REQUEST_LIFETIME_HOURS} h).`
    case 'extension_offer':
      return `Quedan ${t.hoursLeft} h de las ${QUOTE_REQUEST_LIFETIME_HOURS}: se le pregunta si quiere seguir buscando. Sin su confirmación, el pedido vence igual.`
    case 'proposals_unviewed':
      return `Tiene propuestas y no abrió ninguna ${t.afterHours} h después de la última.`
  }
}

/** Variables que puede usar el texto. Las resuelve el backend al mandar. */
export const AUTOMATION_VARIABLES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'codigo', label: 'Código del pedido (AL-…)' },
  { key: 'propuestas', label: 'Cantidad de propuestas activas' },
  { key: 'horas_restantes', label: 'Horas que le quedan al pedido' },
]

export function automationIssues(a: AutomationInput): Array<string> {
  const out: Array<string> = []
  const blocker = AUTOMATION_CHANNEL_BLOCKERS[a.channel]
  if (blocker) out.push(`Canal: ${blocker}`)
  out.push(`Disparador: ${QUOTE_TRIGGER_NEEDS[a.trigger.kind]}`)
  return out
}
