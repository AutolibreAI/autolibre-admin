import { automationSchema } from './notification-automations'
import type { AutomationInput } from './notification-automations'

/**
 * Plantillas de seguimiento a personas con pedidos abiertos — tarjeta
 * "Notificaciones: pensar y crear reglas de seguimiento a usuarios con pedidos
 * abiertos (recordatorio, propuestas recibidas, horas restantes)".
 *
 * Se precargan en Automatizaciones, PAUSADAS. Los textos son un BORRADOR para
 * revisar, no copy aprobado. El canal es el que eligió la persona al crear el
 * pedido (tarjeta de avisos por WhatsApp), que todavía no existe.
 *
 * La última ("propuestas sin mirar" + pregunta de cierre) absorbe la tarjeta
 * "Pedidos: seguimiento cuando los talleres respondieron y el usuario no
 * volvió" — ver Solapamientos en `docs/necesidades-backend-admin.md`.
 */
export interface FollowUpTemplate {
  key: string
  input: AutomationInput
}

const base = { channel: 'user_choice', sendFromHour: 9, sendToHour: 21, asksClosing: false } as const

export const QUOTE_FOLLOW_UP_TEMPLATES: ReadonlyArray<FollowUpTemplate> = [
  {
    key: 'open_reminder',
    input: {
      ...base,
      name: 'Recordatorio: pedido abierto',
      trigger: { kind: 'open_reminder', afterHours: 24 },
      title: 'Tu pedido sigue abierto',
      body: 'Seguimos buscando proveedores para tu pedido {{codigo}}. Te avisamos apenas llegue una propuesta.',
    },
  },
  {
    key: 'proposal_1',
    input: {
      ...base,
      name: 'Primera propuesta recibida',
      trigger: { kind: 'proposal_received', ordinal: 1 },
      title: 'Te llegó una propuesta',
      body: 'Ya tenés la primera propuesta para tu pedido {{codigo}}. Entrá a la app para verla.',
    },
  },
  {
    key: 'proposal_2',
    input: {
      ...base,
      name: 'Segunda propuesta recibida',
      trigger: { kind: 'proposal_received', ordinal: 2 },
      title: 'Te llegó otra propuesta',
      body: 'Ya son 2 propuestas para tu pedido {{codigo}}. Compará y elegí la que más te sirva.',
    },
  },
  {
    key: 'proposal_3',
    input: {
      ...base,
      name: 'Tercera propuesta recibida',
      trigger: { kind: 'proposal_received', ordinal: 3 },
      title: 'Ya tenés 3 propuestas',
      body: 'Tu pedido {{codigo}} ya tiene 3 propuestas. Elegí la tuya desde la app.',
    },
  },
  {
    key: 'hours_left',
    input: {
      ...base,
      name: 'Quedan pocas horas',
      trigger: { kind: 'hours_left', hoursLeft: 12 },
      title: 'Tu pedido vence pronto',
      body: 'Quedan {{horas_restantes}} h para elegir entre las {{propuestas}} propuestas de tu pedido {{codigo}}.',
    },
  },
  {
    key: 'proposals_unviewed',
    input: {
      ...base,
      asksClosing: true,
      name: 'Propuestas sin mirar + cierre',
      trigger: { kind: 'proposals_unviewed', afterHours: 24 },
      title: 'Tenés propuestas sin ver',
      body: 'Tenés {{propuestas}} propuestas para tu pedido {{codigo}}. ¿Ya contrataste a alguien? Contanos con quién desde la app.',
    },
  },
]

// Guardrail en tiempo de módulo, como el de `quote-templates.ts`: una plantilla
// que no pasa el schema (título de más de 25, horario al revés) rompe al
// importar, no en la pantalla.
const invalid = QUOTE_FOLLOW_UP_TEMPLATES.filter((t) => !automationSchema.safeParse(t.input).success).map((t) => t.key)
if (invalid.length > 0) throw new Error(`Plantillas de seguimiento inválidas: ${invalid.join(', ')}`)
