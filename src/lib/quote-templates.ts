import { z } from 'zod'
import { quotePublicCode, type QuoteRequestDetail } from '~/lib/quote-requests'
import { formatAmount, formatQuoteAmount } from '~/lib/quote-responses'
import type { QuoteProposal } from '~/lib/quote-proposals'
import { partnerProfileUrl } from '~/lib/partners'
import { toWhatsAppAR } from '~/lib/whatsapp-ar'

/**
 * Plantillas de mensajes para la ficha de un pedido (`/leads/pedidos/:id`).
 *
 * Texto para copiar, editar y mandar por WhatsApp sobre ESE pedido puntual. No
 * es dato de dominio — es copy que el equipo redactó a mano, mismo estatus que
 * `MANUAL_LANGUAGES` en `~/lib/manuals`: una lista cerrada que vive en el
 * código porque hoy sólo el panel la escribe.
 *
 * ── Los dos estilos de placeholder ─────────────────────────────────────────
 *
 * Los `{{con_llaves}}` se completan SOLOS con los datos del pedido abierto.
 * Los `[entre corchetes]` del texto FUENTE no pasan por el reemplazo: son lo
 * que el operador completa o borra a mano, y se ven porque el regex sólo toca
 * llaves. La regla para elegir uno u otro no cambió: `{{llave}}` si hay una
 * columna de la que leerlo, `[corchete]` si no la hay.
 *
 * ── "Presupuestos" se reescribió el 2026-09-22, sobre un mensaje REAL ──────
 *
 * Tenía seis `[corchetes]` —proveedor, precio, dirección, horarios, whatsapp,
 * otros detalles— porque "no había columna de la que sacarlos". Ahora la hay y
 * el bloque se arma solo: hasta el 2026-10-27 desde `ops.quote_request_response`
 * (015), desde esa fecha desde las propuestas (`QuoteMessageEntry`).
 *
 * La forma sale de un mensaje que el operador mandó de verdad, no de una idea
 * de cómo debería ser. De ahí salieron cuatro decisiones que no son obvias:
 *
 *   1. **Un mensaje, con TODO lo necesario para avanzar.** Dirección y
 *      teléfono del taller incluidos: el turno lo coordina la persona
 *      directamente con el taller, no nosotros. No hay un segundo mensaje de
 *      "coordinación" — se evaluó y se descartó porque no existe ese paso.
 *   2. **Numerado**, para que la respuesta pueda ser "el 2".
 *   3. **El precio puede no estar, y entonces no hay renglón.** En el mensaje
 *      real los tres talleres contestaron sin precio (era un diagnóstico). Un
 *      renglón "precio: a confirmar" se lee como un error; uno que no está, no.
 *   4. **La recomendación final es un `[corchete]`.** "Si querés avanzar
 *      rápido, X te da el diagnóstico sin costo" es juicio del operador sobre
 *      ese caso; ninguna plantilla la puede escribir sin inventar.
 *
 * ── Dos plantillas más, agregadas el 2026-09-23, para pedir cotización ─────
 *
 * «Pedir cotización — red» y «Pedir cotización — taller nuevo» van al TALLER,
 * no a la persona del pedido — por eso llevan `audience: 'taller'` (ver más
 * abajo) y por eso viaja MENOS dato que en las otras dos: nombre, teléfono,
 * dirección exacta y patente de la persona quedan afuera. Mandárselos a un
 * tercero sin que el taller los necesite para cotizar es la misma deuda de
 * Ley 25.326 que el backend marcó como bloqueante para `/leads/pedidos`
 * (`.claude/rules/leads.md`) — y la patente tampoco hace falta para cotizar.
 */

/**
 * `propuesta` no es un mensaje entero: es el renglón de CADA taller dentro de
 * `{{presupuestos}}` («Formato de cada propuesta», migración 037). Hay uno
 * solo, con la clave `PROPOSAL_ITEM_TEMPLATE_ID`, y no lleva `{{codigo}}` (el
 * mensaje que lo contiene ya lo lleva).
 */
export type QuoteTemplateAudience = 'persona' | 'taller' | 'propuesta'

/** Las audiencias de un mensaje entero: las que se ofrecen en «Nueva plantilla». */
export const MESSAGE_AUDIENCES = ['persona', 'taller'] as const

/** La clave fija del «Formato de cada propuesta» (037: `chk_ops_qmtv_proposal_key`). */
export const PROPOSAL_ITEM_TEMPLATE_ID = 'propuesta_item'

export interface QuoteTemplate {
  id: string
  title: string
  /**
   * A quién va el mensaje. Decide si `<QuoteTemplates/>` puede ofrecer un
   * botón de WhatsApp con el teléfono DEL PEDIDO (`persona`) — para `taller`
   * ese teléfono es el de otra persona, así que el envío se resuelve aparte
   * (`PartnerCandidates`, con el WhatsApp de CADA candidato) y acá sólo queda
   * copiar el texto.
   */
  audience: QuoteTemplateAudience
  /** Cruda, con `{{placeholders}}` — nunca se muestra así, sólo `renderQuoteTemplate()` la usa. */
  content: string
}

export const QUOTE_TEMPLATES: ReadonlyArray<QuoteTemplate> = [
  {
    id: 'apertura',
    title: 'Apertura',
    audience: 'persona',
    content: `Hola! Te escribo desde AutoLibre.ai por el pedido {{codigo}}.
Tenemos registrado:

* {{patente}} + {{vehiculo_completo}}
* {{pedido}}
* {{zona}}
* Para cuándo: {{cuando}}
* Repuestos: {{repuestos}}

Ya estamos trabajando, cualquier duda o correccion avisanos!`,
  },
  {
    id: 'presupuestos',
    title: 'Presupuestos',
    audience: 'persona',
    /**
     * `{{intro}}` es el párrafo entero y no `respuesta de {{cantidad}} para
     * {{vehiculo}}` suelto, porque la gramática cambia con la cantidad: con un
     * solo taller "el detalle de cada uno para que elijas" no se sostiene (no
     * hay entre qué elegir), y con cero, "respuesta de cero talleres" se lee
     * como un bug nuestro. Las tres redacciones están en `introSentence()`.
     */
    content: `Hola! Te escribo por el pedido {{codigo}}. {{intro}}

{{presupuestos}}

[recomendación: cuál conviene y por qué — borrá este renglón si no va]

Cualquier otra cosa que necesites avisá y esperamos tu feedback!`,
  },
  {
    id: 'cotizacion_red',
    title: 'Pedir cotización — red',
    audience: 'taller',
    content: `Hola! Te escribo de AutoLibre.ai por el pedido {{codigo}}.
Tenemos un usuario que necesita:

* {{vehiculo_taller}}
* Motor: {{motor}}
* {{pedido}}
* Servicios: {{servicios}}
{{localidad}}
* Para cuándo: {{cuando}}
* Repuestos: {{repuestos}}
* {{fotos}}

¿Lo podés tomar? ¿Cuándo podrías hacerlo, qué costo estimás y hasta cuándo vale ese precio?`,
  },
  {
    id: 'cotizacion_nuevo',
    title: 'Pedir cotización — taller nuevo',
    audience: 'taller',
    content: `Hola! Somos AutoLibre.ai, una plataforma que conecta dueños de autos con talleres y proveedores.
Tenemos un usuario que necesita lo siguiente (pedido {{codigo}}):

* {{vehiculo_taller}}
* Motor: {{motor}}
* {{pedido}}
* Servicios: {{servicios}}
{{localidad}}
* Para cuándo: {{cuando}}
* Repuestos: {{repuestos}}
* {{fotos}}

¿Les interesaría el trabajo? ¿Cuándo lo pueden hacer? ¿Pueden estimar costo y hasta cuándo vale?`,
  },
  {
    id: PROPOSAL_ITEM_TEMPLATE_ID,
    title: 'Formato de cada propuesta',
    audience: 'propuesta',
    /**
     * Reproduce el bloque que antes armaba el código (`responsesBlock`), más
     * la calificación. Cada renglón se va solo si su variable no tiene dato.
     * `{{telefono_taller}}` sólo tiene valor cuando el número NO se pudo
     * convertir en link de WhatsApp: los dos renglones nunca salen juntos.
     */
    content: `{{numero}}. {{taller}}
⭐ Te lo recomendamos: {{recomendacion}}
📍 {{direccion_taller}}
💬 WhatsApp: {{whatsapp_taller}}
📞 {{telefono_taller}}
🕘 {{horario_taller}}
🔗 Perfil: {{perfil_taller}}
Calificación: {{calificacion}}
💵 {{monto}}
{{items}}
📅 Vigente hasta el {{valido_hasta}}
{{detalle_propuesta}}`,
  },
]

/**
 * Guardrail: ninguna plantilla se puede olvidar el `{{codigo}}` (`AL-xxxx`).
 * Es la única forma de trazar un pedido días después, con varias
 * conversaciones encima — corre en tiempo de módulo para que agregar una
 * plantilla nueva sin el placeholder rompa fuerte, no en silencio.
 */
const templatesWithoutCodigo = QUOTE_TEMPLATES.filter(
  (t) => t.audience !== 'propuesta' && !t.content.includes('{{codigo}}'),
)
if (templatesWithoutCodigo.length > 0) {
  throw new Error(
    `QUOTE_TEMPLATES sin {{codigo}}: ${templatesWithoutCodigo.map((t) => t.id).join(', ')}`,
  )
}

// ── Plantillas EDITABLES — `ops.quote_message_template_version` (016 → 017) ──
//
// Las 4 de arriba quedan como SEMILLA en código. Si un `template_key` no
// tiene ninguna versión guardada en `ops`, el panel usa la semilla — la
// primera edición crea la versión 1 y desde ahí la base manda para esa
// clave. Una plantilla nueva ("Nueva plantilla" en la UI) nace directo en
// `ops`, sin semilla. `~/server/quote-message-templates.repo.ts` hace el
// merge; acá sólo viven los tipos y la validación, universales.

export interface QuoteMessageTemplate extends QuoteTemplate {
  /** `false` = viene de la semilla en código, nadie la editó todavía. */
  isCustomized: boolean
  /** La versión vigente en `ops`, si `isCustomized`. `null` para una semilla sin editar. */
  currentVersionId: string | null
  updatedAt: string | null
}

export interface QuoteMessageTemplateVersion {
  id: string
  templateKey: string
  title: string
  audience: QuoteTemplateAudience
  content: string
  archived: boolean
  actorEmail: string | null
  createdAt: string
}

/**
 * Qué `{{variables}}` puede usar cada audiencia, y por qué: `vehiculo_taller`
 * no tiene sentido en un mensaje a la persona (ya sabe qué auto tiene) y
 * `vehiculo_completo`/`intro`/`presupuestos` no existen para un mensaje al
 * taller (la lógica de "qué talleres respondieron" es del lado de la
 * persona). Validar por audiencia da un error más preciso que validar contra
 * la unión de las dos listas.
 */
export interface TemplateVariable {
  key: string
  label: string
  /** Cómo se ve, para el editor. Inventado a propósito: no es un pedido real. */
  example: string
}

/**
 * Las variables del PEDIDO que valen igual para la persona y para el taller.
 * Ninguna trae contacto de la persona (nombre, teléfono, email, dirección):
 * AutoLibre nunca le pasa el contacto del cliente al taller.
 */
const SHARED_REQUEST_VARIABLES: ReadonlyArray<TemplateVariable> = [
  { key: 'cuando', label: 'Para cuándo lo necesita', example: 'Lo antes posible · Esta semana · 05/12' },
  { key: 'repuestos', label: 'Quién pone los repuestos', example: 'Los pone el taller' },
  { key: 'servicios', label: 'Los servicios del pedido (los del operador; si no hay, los de la IA)', example: 'Frenos, Alineación y balanceo' },
  { key: 'motor', label: 'Motor, combustible y caja del vehículo vinculado (sólo pedidos de la app)', example: '1.6 · Nafta · Manual 5 marchas' },
  { key: 'fotos', label: 'Cuántas fotos del problema hay (sin link: son privadas)', example: 'Hay 2 fotos del problema' },
]

export const TEMPLATE_VARIABLES: Record<QuoteTemplateAudience, ReadonlyArray<TemplateVariable>> = {
  persona: [
    { key: 'codigo', label: 'Código del pedido (AL-1234) — obligatorio', example: 'AL-1234' },
    { key: 'nombre', label: 'El nombre de la persona del pedido', example: 'Laura' },
    { key: 'patente', label: 'Patente tipeada por la persona', example: 'AB123CD' },
    { key: 'vehiculo', label: 'El auto, frase corta', example: 'el Nissan Note (AB123CD)' },
    { key: 'vehiculo_completo', label: 'El auto completo, o un aviso si falta', example: 'NISSAN NOTE ADVANCE 1.6 2019' },
    { key: 'pedido', label: 'La descripción del pedido', example: 'Ruido al frenar' },
    { key: 'zona', label: 'La zona (localidad y provincia, nunca la dirección exacta)', example: 'Olivos, Buenos Aires' },
    ...SHARED_REQUEST_VARIABLES,
    { key: 'intro', label: 'El párrafo de presupuestos, redactado según la cantidad', example: 'Ya tenemos respuesta de dos talleres…' },
    { key: 'presupuestos', label: 'Las propuestas activas, cada una con el «Formato de cada propuesta»', example: '1. Taller Norte…' },
  ],
  taller: [
    { key: 'codigo', label: 'Código del pedido (AL-1234) — obligatorio', example: 'AL-1234' },
    { key: 'vehiculo_taller', label: 'El auto completo (marca, modelo, versión, año), sin patente', example: 'Nissan Note Advance 1.6 2019' },
    { key: 'pedido', label: 'La descripción del pedido', example: 'Ruido al frenar' },
    { key: 'localidad', label: 'La línea de zona — desaparece entera sin dato', example: '* Zona: Olivos' },
    ...SHARED_REQUEST_VARIABLES,
  ],
  propuesta: [
    { key: 'numero', label: 'El número de la propuesta en el mensaje', example: '1' },
    { key: 'taller', label: 'El nombre del taller', example: 'Taller Norte' },
    { key: 'recomendacion', label: 'El motivo, sólo en la recomendada', example: 'Es el que más rápido te atiende' },
    { key: 'direccion_taller', label: 'La dirección del taller', example: 'Av. Maipú 1234, Olivos' },
    { key: 'whatsapp_taller', label: 'Link de WhatsApp del taller (wa.me/549…)', example: 'https://wa.me/5491123456789?text=…' },
    { key: 'telefono_taller', label: 'El teléfono crudo, SÓLO si no se pudo armar el link de WhatsApp', example: '4791-2345' },
    { key: 'horario_taller', label: 'Los horarios del taller (sólo del directorio)', example: 'Lun a vie 8 a 18' },
    { key: 'perfil_taller', label: 'El perfil público del taller en la web', example: 'https://autolibre.ai/proveedores/taller-norte' },
    { key: 'calificacion', label: 'Promedio de reseñas — se va si no tiene', example: '4,6 ★ (12 reseñas)' },
    { key: 'monto', label: 'El precio, o el rango', example: '$ 80.000 a $ 95.000' },
    { key: 'items', label: 'El desglose de la propuesta, con los opcionales aparte', example: '   • Pastillas: $ 45.000' },
    { key: 'valido_hasta', label: 'Hasta cuándo vale el precio', example: '05/12/2026' },
    { key: 'detalle_propuesta', label: 'El párrafo que escribió el operador', example: 'Cambio de pastillas delanteras…' },
  ],
}

/** Los `{{xxx}}` que aparecen en un texto, sin duplicados. */
function extractTemplateVariables(content: string): Array<string> {
  const found = new Set<string>()
  for (const m of content.matchAll(/\{\{(\w+)\}\}/g)) found.add(m[1]!)
  return [...found]
}

/** Las que aparecen en `content` y NO están en la lista de esa audiencia. */
export function unknownTemplateVariables(content: string, audience: QuoteTemplateAudience): Array<string> {
  const known = new Set(TEMPLATE_VARIABLES[audience].map((v) => v.key))
  return extractTemplateVariables(content).filter((k) => !known.has(k))
}

/**
 * Guardar (alta o edición) una versión — `ops.save_quote_message_template`
 * (017). `templateKey` ausente = plantilla nueva; presente = nueva versión de
 * esa clave, sea semilla o ya editada antes.
 *
 * Las dos validaciones de contenido que el SP no puede hacer (no conoce
 * `TEMPLATE_VARIABLES`, vive en código) van acá, con el mismo mensaje que
 * mostraría el form.
 */
export const saveQuoteMessageTemplateSchema = z
  .object({
    templateKey: z.string().trim().min(1).max(60).optional(),
    title: z.string().trim().min(1, 'Falta el título.').max(120),
    audience: z.enum(['persona', 'taller', 'propuesta']),
    content: z.string().trim().min(1, 'Falta el texto del mensaje.').max(4000),
  })
  .superRefine((d, ctx) => {
    if ((d.audience === 'propuesta') !== (d.templateKey === PROPOSAL_ITEM_TEMPLATE_ID)) {
      ctx.addIssue({
        code: 'custom',
        path: ['audience'],
        message: 'El formato de cada propuesta es uno solo y no se puede crear otro ni mudar una plantilla ahí.',
      })
    }
    if (d.audience !== 'propuesta' && !d.content.includes('{{codigo}}')) {
      ctx.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'El mensaje tiene que incluir {{codigo}} — es la única forma de trazar el pedido después.',
      })
    }
    const unknown = unknownTemplateVariables(d.content, d.audience)
    if (unknown.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['content'],
        message: `No existen estas variables para "${d.audience}": ${unknown.map((k) => `{{${k}}}`).join(', ')}.`,
      })
    }
  })
export type SaveQuoteMessageTemplateInput = z.infer<typeof saveQuoteMessageTemplateSchema>

export const listQuoteMessageTemplateVersionsSchema = z.object({
  templateKey: z.string().trim().min(1).max(60),
})
export type ListQuoteMessageTemplateVersionsInput = z.infer<typeof listQuoteMessageTemplateVersionsSchema>

/** Sentinela del handler cuando `ops.quote_message_template_version` no existe en esta base. */
export const QUOTE_MESSAGE_TEMPLATES_UNAVAILABLE = 'QUOTE_MESSAGE_TEMPLATES_UNAVAILABLE'

export function readableQuoteMessageTemplateError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)

  if (raw.includes(QUOTE_MESSAGE_TEMPLATES_UNAVAILABLE))
    return 'Falta aplicar la migración 017 en esta base (pnpm db:migrate). No se aplicó nada.'
  if (raw.includes('TITLE_REQUIRED')) return 'Falta el título.'
  if (raw.includes('INVALID_AUDIENCE: propuesta'))
    return 'Falta aplicar la migración 037 en esta base: todavía no se puede guardar el formato de cada propuesta.'
  if (raw.includes('INVALID_AUDIENCE')) return 'Esa audiencia no existe. Recargá la pantalla.'
  if (raw.includes('PROPOSAL_TEMPLATE_KEY'))
    return 'El formato de cada propuesta es uno solo: no se puede crear otro ni mudar una plantilla ahí.'
  if (raw.includes('CONTENT_REQUIRED')) return 'Falta el texto del mensaje.'
  if (raw.includes('MISSING_CODIGO_PLACEHOLDER'))
    return 'El mensaje tiene que incluir {{codigo}} en algún lugar.'
  if (raw.includes('ACTOR_NOT_FOUND') || raw.includes('ACTOR_REQUIRED'))
    return 'Tu sesión no corresponde a un usuario de AutoLibre. Volvé a iniciar sesión.'
  if (raw === 'FORBIDDEN') return 'Tu rol no tiene permiso para esta acción.'
  if (raw === 'UNAUTHENTICATED') return 'Tu sesión expiró. Volvé a iniciar sesión.'
  return 'No pudimos guardar. No se aplicó nada — es una sola operación en la base.'
}


// ── Piezas del render ───────────────────────────────────────────────────────

/**
 * `MARCA MODELO` del catálogo viene en MAYÚSCULAS (`NISSAN NOTE`), que en un
 * WhatsApp se lee como si estuvieras gritando. Esto es presentación y NO toca
 * el dato: un token de hasta 3 caracteres queda como está (VW, BMW, KIA, RAM,
 * 208), uno más largo pasa a Capitalizado (NISSAN → Nissan, MERCEDES-BENZ →
 * Mercedes-Benz).
 *
 * Es una heurística y tiene límites conocidos —una marca de 4 letras que de
 * verdad va en mayúsculas quedaría capitalizada— pero el error es cosmético,
 * el texto es editable antes de mandarlo, y la alternativa (gritar en cada
 * mensaje) es peor. No se guarda en ningún lado.
 */
function titleCaseModel(raw: string): string {
  return raw
    .split(/([\s-]+)/)
    .map((token) =>
      /^[\s-]+$/.test(token) || token.length <= 3 || /\d/.test(token)
        ? token
        : token.charAt(0).toUpperCase() + token.slice(1).toLowerCase(),
    )
    .join('')
}

const NUMBER_WORDS = ['cero', 'un', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez']

/**
 * El primer párrafo, con la gramática que corresponde a la cantidad.
 *
 * Son tres redacciones y no una con plurales pegados, porque lo que cambia no
 * es sólo la `s`: con UN taller no hay entre qué elegir, y con CERO el mensaje
 * no se manda — el texto lo dice, en vez de salir "respuesta de cero talleres"
 * y dejar que el operador lo descubra después de mandarlo.
 *
 * El "por …" cita la descripción CRUDA del pedido. El operador suele
 * parafrasearla ("el tema de las revoluciones al acelerar") y queda mejor,
 * pero parafrasear no lo puede hacer el panel sin inventar: se cita textual y
 * se reescribe en el cuadro, que es editable.
 */
function introSentence(n: number, vehicle: string, request: string): string {
  const subject = `para ${vehicle} por "${request}"`
  if (n === 0) return `Todavía no tenemos respuestas cargadas ${subject}.`
  if (n === 1) return `Ya tenemos la respuesta de un taller ${subject}. Te paso el detalle:`
  const word = NUMBER_WORDS[n] ?? String(n)
  return `Ya tenemos respuesta de ${word} talleres ${subject}. Te paso el detalle de cada uno para que elijas:`
}

/**
 * Cómo se nombra el auto en el mensaje, del dato más firme al más flojo:
 *
 * 1. Con catálogo (vehículo vinculado): `el Nissan Note (PNZ450)`.
 * 2. Con vehículo ESCRITO (migración 018): `el Peugeot 208 2019 (AB123CD)`,
 *    tal cual lo cargó el operador — sin Title Case: ya lo escribió una
 *    persona, no viene gritado del catálogo.
 * 3. Sólo patente: `el auto patente PNZ450`.
 * 4. Nada: `tu auto`.
 *
 * **No deja un `[corchete]`**: la frase va en el medio de un párrafo, y "tu
 * auto" es cierto y se lee bien. La patente pasó a ser opcional en la 018, así
 * que ya no se puede asumir que está.
 */
function vehiclePhrase(detail: QuoteRequestDetail): string {
  const plate = detail.plate ? ` (${detail.plate})` : ''
  if (detail.catalogShortLabel) return `el ${titleCaseModel(detail.catalogShortLabel)}${plate}`
  if (detail.vehicleText) return `el ${detail.vehicleText}${plate}`
  if (detail.plate) return `el auto patente ${detail.plate}`
  return 'tu auto'
}

/** Sin patente, un aviso a completar — Apertura confirma lo que tenemos, y ahí sí falta. */
function plateValue(detail: QuoteRequestDetail): string {
  return detail.plate ?? '[patente — todavía no la pasó]'
}

/**
 * `vehiculo_completo` es el de la plantilla de Apertura: ahí el mensaje
 * confirma lo que tenemos REGISTRADO, así que la versión y el año son el punto
 * — y si falta el vehículo hay que decirlo, no taparlo con la patente.
 */
function fullVehicleValue(detail: QuoteRequestDetail): string {
  if (detail.vehicleId) return detail.catalogLabel ?? '[vehículo vinculado sin modelo de catálogo]'
  return detail.vehicleText ?? '[sin vehículo cargado]'
}

/**
 * La ZONA de la persona, nunca su dirección exacta (pedido del 2026-10-03):
 * `location_address` del GPS suele ser calle y número ("Lourdes 2021"), y un
 * mensaje de WhatsApp no es lugar para eso. Sale de localidad + provincia; la
 * localidad se omite cuando la provincia ya la nombra ("Córdoba, Córdoba",
 * "Buenos Aires, Ciudad Autónoma de Buenos Aires").
 *
 * Sin localidad ni provincia (un `typed` viejo que sólo trae dirección) la
 * dirección entra SÓLO si no tiene ningún número: "Bariloche" o "Palermo" son
 * una zona; "Caseros 4241" es una dirección y cae en el corchete. Es una
 * heurística y está escrita como tal — ante la duda, el corchete.
 */
export function quoteZoneLabel(detail: Pick<QuoteRequestDetail, 'locationAddress' | 'locationLocality' | 'locationProvince'>): string | null {
  const locality = detail.locationLocality?.trim() || null
  const province = detail.locationProvince?.trim() || null
  if (locality || province) {
    const norm = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    if (locality && province && norm(province).includes(norm(locality))) return province
    return [locality, province].filter(Boolean).join(', ')
  }
  const address = detail.locationAddress?.trim() || null
  if (address && !/\d/.test(address)) return address
  return null
}

/** Sin zona (WhatsApp, o sólo una dirección con número) → aviso, no un vacío. */
function zoneValue(detail: QuoteRequestDetail): string {
  return quoteZoneLabel(detail) ?? '[completar zona — sin la dirección exacta]'
}

/**
 * Cómo se nombra el auto en las plantillas que van al TALLER: `Suzuki Fun 1.4
 * 2007` — versión y año incluidos (el taller cotiza sobre eso), patente
 * afuera (no la necesita, y es dato de la persona). Sin catálogo cae en el
 * vehículo escrito (018); sin ninguno de los dos, un corchete a completar —
 * nunca se adivina el auto.
 */
function workshopVehiclePhrase(detail: QuoteRequestDetail): string {
  if (detail.catalogLabel) return titleCaseModel(detail.catalogLabel)
  if (detail.vehicleText) return detail.vehicleText
  // El modelo que identificó «Identificar vehículo» (tarjeta T73NyHFN), aunque
  // todavía no se haya pasado a `vehicle_description`.
  const rc = detail.requestVehicleCatalog
  if (rc?.available && rc.label) return titleCaseModel(rc.label)
  return '[marca modelo versión año]'
}

/**
 * `null` acá NO cae en un corchete: la línea entera de zona desaparece (ver
 * `applyTemplate`). Es a propósito — un taller sin zona igual puede
 * cotizar, así que forzarlo a completar un corchete de zona sería pedirle al
 * operador que invente un dato que no tiene.
 */
function localityValue(detail: QuoteRequestDetail): string {
  return detail.locationLocality ? `* Zona: ${detail.locationLocality}` : ''
}

/**
 * Un renglón del bloque «Presupuestos»: lo mínimo que el mensaje necesita de un
 * taller, sin importar de qué tabla vino.
 *
 * Desde el 2026-10-27 el mensaje sale de las PROPUESTAS (`quote_request_proposals`,
 * del backend) y no de los presupuestos de `ops.quote_request_response`: el
 * operador carga todo en un solo lugar —«Propuestas en la app»— llegue el
 * pedido por la app o por WhatsApp, y eso mismo arma el WhatsApp. Antes eran
 * dos cargas del mismo dato, y el mensaje y la app podían decir cosas
 * distintas. `proposalToMessageEntry()` es el único traductor.
 */
export interface QuoteMessageEntry {
  name: string
  address: string | null
  phone: string | null
  /** Sólo del directorio: un taller de afuera no tiene horarios cargados. */
  hours: string | null
  /** El perfil público vigente. `null` para un taller de afuera o uno no `active`. */
  partnerSlug: string | null
  /** `null` en las dos = "a confirmar" · `0` = sin cargo. */
  amountMin: number | null
  amountMax: number | null
  currency: string
  items: ReadonlyArray<{ label: string; amount: number; optional: boolean }>
  /** `YYYY-MM-DD`. */
  validUntil: string | null
  /** Contra el reloj de Postgres. `null` = sin vigencia declarada. */
  expired: boolean | null
  /** El párrafo que lee la persona. */
  detail: string
  /** Sólo en la recomendada: el motivo, que es lo que lee la persona. */
  recommendationReason: string | null
  /** Promedio de `partner_reviews` del taller. `null` = taller de afuera, sin reseñas, o base sin la tabla. */
  rating: QuotePartnerRating | null
}

export interface QuotePartnerRating {
  average: number
  count: number
}

/**
 * Una propuesta ACTIVA, como renglón del mensaje. Las notas internas no viajan
 * (son para el operador), y el motivo de recomendación sí: es texto que la
 * persona ya lee en la app.
 */
export function proposalToMessageEntry(p: QuoteProposal): QuoteMessageEntry {
  return {
    name: p.providerName,
    address: p.address,
    phone: p.phone,
    hours: p.hours,
    partnerSlug: p.partnerSlug,
    amountMin: p.amountMin,
    amountMax: p.amountMax,
    currency: p.currency,
    items: p.items,
    validUntil: p.validUntil,
    expired: p.expired,
    detail: p.description,
    recommendationReason: p.isRecommended ? p.recommendationReason : null,
    rating: p.partnerRating,
  }
}

/**
 * Qué entradas entran al mensaje y cuáles no.
 *
 * **Una vencida NO entra**: mandar un precio que ya caducó es peor que mandar
 * uno menos. Se devuelven las dos listas en vez de filtrar en silencio, para
 * que la pantalla pueda decir "2 de 3 entran; una venció" — un renglón que
 * desaparece sin explicación es un bug desde el lado del operador.
 *
 * `expired` lo calculó Postgres, así que esta partición da lo mismo en el
 * servidor y en el cliente.
 */
export function splitQuoteMessageEntries(entries: ReadonlyArray<QuoteMessageEntry>): {
  included: Array<QuoteMessageEntry>
  expired: Array<QuoteMessageEntry>
} {
  return {
    included: entries.filter((r) => r.expired !== true),
    expired: entries.filter((r) => r.expired === true),
  }
}

/**
 * El bloque numerado, con la forma del mensaje real.
 *
 * Cada renglón existe sólo si hay dato. Un taller de afuera sin teléfono
 * cargado simplemente no muestra el 📞 — no queda un "📞 —" que la persona
 * lee como un error nuestro.
 *
 * **La nota interna NO entra.** Se llama interna porque es para el operador
 * ("lo atendió Juan", "me debe una") y esto es texto que lee la persona. Mismo
 * criterio que `closed_reason` en el recorrido del pedido.
 */
/** Un ítem en 0 es "sin cargo", igual que el total (`formatQuoteAmount`). */
function formatItemAmount(amount: number, currency: string): string {
  return amount === 0 ? 'sin cargo' : formatAmount(amount, currency)
}

/**
 * Cómo sale el contacto de un taller en el mensaje.
 *
 * En WhatsApp un número escrito como texto no es un link: al tocarlo aparece
 * un menú, y si no coincide exacto con una cuenta (fijo, sin el 9, con 15…)
 * ofrece "Invitar a WhatsApp". Por eso, si el número se puede normalizar
 * (`toWhatsAppAR`), sale como link `wa.me` que abre el chat directo, con un
 * saludo corto ya escrito (WhatsApp muestra la URL entera). Si no se puede, el
 * mensaje NO se rompe: queda el 📞 con el número tal cual, y la pantalla avisa
 * al operador al lado del taller para que lo corrija a mano. La normalización
 * es sólo para el texto: no se guarda en ningún lado.
 *
 * `phone` ya viene con el WhatsApp como prioridad: es
 * `coalesce(partners.whatsapp, provider_phone)` (`quote-proposals.repo.ts`).
 */
export type QuoteEntryContact =
  | { kind: 'whatsapp'; url: string }
  | { kind: 'phone'; phone: string; reason: string }

export function quoteEntryContact(entry: QuoteMessageEntry, quoteCode: string | null): QuoteEntryContact | null {
  if (!entry.phone) return null
  const r = toWhatsAppAR(entry.phone)
  if (!r.ok) return { kind: 'phone', phone: entry.phone, reason: r.reason }
  const text = `Hola ${entry.name}, te escribo por el presupuesto de AutoLibre${quoteCode ? ` (pedido #${quoteCode})` : ''}`
  // `encodeURIComponent` deja los paréntesis sin codificar, y el linkificador
  // de WhatsApp puede cortar el link en un `)`: se codifican también.
  const encoded = encodeURIComponent(text).replace(/\(/g, '%28').replace(/\)/g, '%29')
  return { kind: 'whatsapp', url: `https://wa.me/${r.digits}?text=${encoded}` }
}

// ── El motor de render ──────────────────────────────────────────────────────

/**
 * Reemplaza `{{variables}}` en `content` con `values`, con la regla de las
 * plantillas desde el 2026-11-24 (tarjeta bMtiAAQZ):
 *
 * - **Una variable sin dato (`''`) se lleva su LÍNEA entera**, no sólo el
 *   hueco: "* Para cuándo: " sin nada al lado se lee como un error nuestro.
 *   Se decide ANTES de reemplazar, línea por línea (después del reemplazo una
 *   línea vacía es indistinguible de una que nunca tuvo dato).
 * - Después se juntan las líneas en blanco dobles que hayan quedado.
 * - Una variable que no está en `values` queda tal cual entre llaves —
 *   visible y buscable— en vez de desaparecer en silencio. Es también lo que
 *   pasa con una variable de otra audiencia: `values` se arma POR audiencia,
 *   así que un `{{nombre}}` en una plantilla para el taller nunca se completa.
 *
 * Las variables viejas que avisan con un `[corchete]` (`{{patente}}`,
 * `{{vehiculo_completo}}`…) no devuelven `''`: su línea se queda, con el aviso.
 */
export function applyTemplate(content: string, values: Readonly<Record<string, string>>): string {
  const lines = content.split('\n').filter((line) => {
    for (const m of line.matchAll(/\{\{(\w+)\}\}/g)) {
      const key = m[1]!
      if (Object.prototype.hasOwnProperty.call(values, key) && values[key]!.trim() === '') return false
    }
    return true
  })
  return lines
    .map((line) =>
      line.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
        Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : match,
      ),
    )
    .join('\n')
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
}

/** Deja en `values` sólo las variables de esa audiencia: lo demás queda entre llaves. */
function forAudience(values: Record<string, string>, audience: QuoteTemplateAudience): Record<string, string> {
  const allowed = new Set(TEMPLATE_VARIABLES[audience].map((v) => v.key))
  return Object.fromEntries(Object.entries(values).filter(([k]) => allowed.has(k)))
}

/** `2026-12-05` → `05/12`, sin pasar por `Date` (correría un día). */
function dayMonth(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day)
  return m ? `${m[2]}/${m[1]}` : day
}

/** `2026-12-05` → `05/12/2026`. */
function fullDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : day
}

/** `{{cuando}}`: lo que dijo la persona (0143), o lo que cargó el operador (036). */
export function quoteTimingValue(detail: Pick<QuoteRequestDetail, 'timingAndParts'>): string {
  const t = detail.timingAndParts
  if (!t.available || !t.timing) return ''
  if (t.timing === 'asap') return 'Lo antes posible'
  if (t.timing === 'this_week') return 'Esta semana'
  if (t.timing === 'date') return t.preferredDate ? dayMonth(t.preferredDate) : ''
  return t.timing
}

/** `{{repuestos}}`. Las etiquetas son las del mensaje, no las de la ficha. */
export function quotePartsValue(detail: Pick<QuoteRequestDetail, 'timingAndParts'>): string {
  const t = detail.timingAndParts
  if (!t.available || !t.partsSupply) return ''
  if (t.partsSupply === 'workshop') return 'Los pone el taller'
  if (t.partsSupply === 'customer') return 'Los lleva el cliente'
  return t.partsSupply
}

function photosValue(n: number | null): string {
  if (!n) return ''
  return n === 1 ? 'Hay 1 foto del problema' : `Hay ${n} fotos del problema`
}

/** `4,6 ★ (12 reseñas)`. Sin reseñas, `''`: la línea se va. */
export function formatPartnerRating(rating: QuotePartnerRating | null): string {
  if (!rating || rating.count <= 0) return ''
  const avg = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(rating.average)
  return `${avg} ★ (${rating.count} ${rating.count === 1 ? 'reseña' : 'reseñas'})`
}

/** `{{items}}`: los obligatorios y, aparte, los opcionales con su precio. */
function itemsValue(entry: QuoteMessageEntry): string {
  const required = entry.items.filter((it) => !it.optional)
  const optional = entry.items.filter((it) => it.optional)
  const lines: Array<string> = []
  for (const it of required) lines.push(`   • ${it.label}: ${formatItemAmount(it.amount, entry.currency)}`)
  if (optional.length > 0) {
    lines.push('➕ Opcionales:')
    for (const it of optional) lines.push(`   • ${it.label}: ${formatItemAmount(it.amount, entry.currency)}`)
  }
  return lines.join('\n')
}

/**
 * Las variables de UNA propuesta. El contacto del taller va como link
 * `wa.me` (normalizado por `toWhatsAppAR`, el mismo del resto del panel); si
 * el número no se puede normalizar, `{{whatsapp_taller}}` queda vacío y el
 * número crudo sale por `{{telefono_taller}}`.
 *
 * La nota interna de la propuesta NO es una variable: es para el operador.
 */
export function proposalTemplateValues(
  entry: QuoteMessageEntry,
  position: number,
  quoteCode: string | null,
): Record<string, string> {
  const contact = quoteEntryContact(entry, quoteCode)
  return {
    numero: String(position),
    taller: entry.name,
    recomendacion: entry.recommendationReason ?? '',
    direccion_taller: entry.address ?? '',
    whatsapp_taller: contact?.kind === 'whatsapp' ? contact.url : '',
    telefono_taller: contact?.kind === 'phone' ? contact.phone : '',
    horario_taller: entry.hours ?? '',
    perfil_taller: entry.partnerSlug ? partnerProfileUrl(entry.partnerSlug) : '',
    calificacion: formatPartnerRating(entry.rating),
    monto: formatQuoteAmount(entry) ?? '',
    items: itemsValue(entry),
    valido_hasta: entry.validUntil ? fullDay(entry.validUntil) : '',
    detalle_propuesta: entry.detail,
  }
}

/** El contenido del «Formato de cada propuesta» de semilla (si nadie lo editó). */
export const DEFAULT_PROPOSAL_ITEM_CONTENT: string = QUOTE_TEMPLATES.find((t) => t.id === PROPOSAL_ITEM_TEMPLATE_ID)!.content

/**
 * `{{presupuestos}}`: cada propuesta ACTIVA y vigente, con el formato de cada
 * propuesta. Una vencida no entra (`splitQuoteMessageEntries`).
 */
function responsesBlock(
  entries: ReadonlyArray<QuoteMessageEntry>,
  quoteCode: string | null,
  itemContent: string,
): string {
  const { included } = splitQuoteMessageEntries(entries)
  if (included.length === 0) return '[todavía no hay propuestas cargadas en el pedido]'
  return included
    .map((entry, i) => applyTemplate(itemContent, proposalTemplateValues(entry, i + 1, quoteCode)).trim())
    .join('\n\n')
}

/**
 * Todas las variables de un pedido, para cualquier audiencia. Quien renderiza
 * filtra por audiencia (`forAudience`).
 */
export function quoteTemplateValues(
  detail: QuoteRequestDetail,
  entries: ReadonlyArray<QuoteMessageEntry> = [],
  itemContent: string = DEFAULT_PROPOSAL_ITEM_CONTENT,
): Record<string, string> {
  const { included } = splitQuoteMessageEntries(entries)
  const code = quotePublicCode(detail.publicNumber)
  return {
    codigo: code,
    nombre: detail.contactName?.trim() ?? '',
    patente: plateValue(detail),
    vehiculo: vehiclePhrase(detail),
    vehiculo_completo: fullVehicleValue(detail),
    vehiculo_taller: workshopVehiclePhrase(detail),
    pedido: detail.description,
    zona: zoneValue(detail),
    localidad: localityValue(detail),
    cuando: quoteTimingValue(detail),
    repuestos: quotePartsValue(detail),
    servicios: detail.templateFacts.serviceNames.join(', '),
    motor: detail.templateFacts.motor ?? '',
    fotos: photosValue(detail.templateFacts.problemPhotoCount),
    intro: introSentence(included.length, vehiclePhrase(detail), detail.description),
    presupuestos: responsesBlock(entries, code, itemContent),
  }
}

/**
 * Una plantilla, completada con los datos DE ESE pedido.
 *
 * `entries` es opcional y por defecto vacío: la plantilla de Apertura no las
 * usa, y así el llamador que sólo quiere ésa no depende de una consulta más.
 * `itemContent` es el «Formato de cada propuesta» vigente (semilla si nadie
 * lo editó). Una plantilla `propuesta` se previsualiza con la primera
 * propuesta del pedido.
 */
export function renderQuoteTemplate(
  template: Pick<QuoteTemplate, 'audience' | 'content'>,
  detail: QuoteRequestDetail,
  entries: ReadonlyArray<QuoteMessageEntry> = [],
  itemContent: string = DEFAULT_PROPOSAL_ITEM_CONTENT,
): string {
  if (template.audience === 'propuesta') {
    const first = splitQuoteMessageEntries(entries).included[0]
    if (!first) return '[este pedido no tiene propuestas activas para mostrar cómo queda]'
    return applyTemplate(template.content, proposalTemplateValues(first, 1, quotePublicCode(detail.publicNumber))).trim()
  }
  return applyTemplate(template.content, forAudience(quoteTemplateValues(detail, entries, itemContent), template.audience))
}

// ── Mandarlo por WhatsApp ───────────────────────────────────────────────────

/**
 * Tope prudente para el `?text=` de `wa.me`.
 *
 * El límite real no es de WhatsApp (un mensaje admite decenas de miles de
 * caracteres) sino del largo de URL que tolera el navegador y el sistema
 * operativo al abrir el link, y no está especificado en ningún lado. Con
 * cuatro talleres el mensaje ronda los 900 caracteres, así que 3.500 deja
 * mucho aire; pasado eso la UI ofrece copiar en vez de abrir un link que
 * podría llegar cortado — y un mensaje cortado a la mitad es peor que un paso
 * manual.
 */
export const WHATSAPP_TEXT_MAX = 3500

/**
 * El link para mandarle ESTE texto a la persona del pedido.
 *
 * Reusa el mismo criterio de teléfono que todo el repo (`quoteWhatsAppUrl` en
 * `~/lib/quote-requests`, que exige `549` + 10 dígitos y no adivina la
 * característica): sin forma canónica no hay link. La diferencia es que acá el
 * texto es el mensaje ya armado y editado, no un saludo fijo.
 *
 * Devuelve `null` —y la UI explica cuál de las dos cosas falta— cuando el
 * teléfono no es canónico o cuando el texto se pasa de `WHATSAPP_TEXT_MAX`.
 */
export function whatsAppMessageUrl(digits: string | null, text: string): string | null {
  if (!digits) return null
  if (text.length > WHATSAPP_TEXT_MAX) return null
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
}
