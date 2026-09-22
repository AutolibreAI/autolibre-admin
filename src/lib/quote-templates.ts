import { quotePublicCode, type QuoteRequestDetail } from '~/lib/quote-requests'
import { formatQuoteAmount, type QuoteResponse } from '~/lib/quote-responses'
import { formatDate } from '~/lib/format'

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
 * otros detalles— porque "no había columna de la que sacarlos". Ahora la hay
 * (`ops.quote_request_response`, migración 015) y el bloque se arma solo.
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
 */

export interface QuoteTemplate {
  id: string
  title: string
  /** Cruda, con `{{placeholders}}` — nunca se muestra así, sólo `renderQuoteTemplate()` la usa. */
  content: string
}

export const QUOTE_TEMPLATES: ReadonlyArray<QuoteTemplate> = [
  {
    id: 'apertura',
    title: 'Apertura',
    content: `Hola! Te escribo desde AutoLibre.ai por el pedido {{codigo}}.
Tenemos registrado:

* {{patente}} + {{vehiculo_completo}}
* {{pedido}}
* {{zona}}

Ya estamos trabajando, cualquier duda o correccion avisanos!`,
  },
  {
    id: 'presupuestos',
    title: 'Presupuestos',
    /**
     * `{{intro}}` es el párrafo entero y no `respuesta de {{cantidad}} para
     * {{vehiculo}}` suelto, porque la gramática cambia con la cantidad: con un
     * solo taller "el detalle de cada uno para que elijas" no se sostiene (no
     * hay entre qué elegir), y con cero, "respuesta de cero talleres" se lee
     * como un bug nuestro. Las tres redacciones están en `introSentence()`.
     */
    content: `Hola! {{intro}}

{{presupuestos}}

[recomendación: cuál conviene y por qué — borrá este renglón si no va]

Cualquier otra cosa que necesites avisá y esperamos tu feedback!`,
  },
]

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
      /^[\s-]+$/.test(token) || token.length <= 3
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
 * Cómo se nombra el auto en el mensaje.
 *
 * Con catálogo: `el Nissan Note (PNZ450)`. Sin catálogo —porque el operador no
 * vinculó el vehículo, o el vehículo no resuelve a un modelo— cae en `el auto
 * patente PNZ450`, que es cierto y se lee bien. **No deja un `[corchete]`**: la
 * patente siempre está (es NOT NULL y la tipeó la persona), así que no hay nada
 * que completar a mano.
 */
function vehiclePhrase(detail: QuoteRequestDetail): string {
  const model = detail.catalogShortLabel
  return model ? `el ${titleCaseModel(model)} (${detail.plate})` : `el auto patente ${detail.plate}`
}

/**
 * `vehiculo_completo` es el de la plantilla de Apertura: ahí el mensaje
 * confirma lo que tenemos REGISTRADO, así que la versión y el año son el punto
 * — y si falta el vehículo hay que decirlo, no taparlo con la patente.
 */
function fullVehicleValue(detail: QuoteRequestDetail): string {
  if (!detail.vehicleId) return '[sin vehículo vinculado]'
  return detail.catalogLabel ?? '[vehículo vinculado sin modelo de catálogo]'
}

/** `null` (WhatsApp, o un pedido `typed` sin dirección) → aviso, no un vacío. */
function zoneValue(detail: QuoteRequestDetail): string {
  return detail.locationAddress ?? '[completar zona/dirección — el pedido no la trae cargada]'
}

/**
 * Qué respuestas entran al mensaje y cuáles no.
 *
 * **Una vencida NO entra**: mandar un precio que ya caducó es peor que mandar
 * uno menos. Se devuelven las dos listas en vez de filtrar en silencio, para
 * que la pantalla pueda decir "2 de 3 entran; una venció" — un renglón que
 * desaparece sin explicación es un bug desde el lado del operador.
 *
 * `expired` lo calculó Postgres (ver `~/lib/quote-responses`), así que esta
 * partición da lo mismo en el servidor y en el cliente.
 */
export function splitQuoteResponsesForMessage(responses: ReadonlyArray<QuoteResponse>): {
  included: Array<QuoteResponse>
  expired: Array<QuoteResponse>
} {
  return {
    included: responses.filter((r) => r.expired !== true),
    expired: responses.filter((r) => r.expired === true),
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
function responsesBlock(responses: ReadonlyArray<QuoteResponse>): string {
  const { included } = splitQuoteResponsesForMessage(responses)
  if (included.length === 0) return '[todavía no hay presupuestos cargados en el pedido]'

  return included
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.name}`]
      if (r.address) lines.push(`📍 ${r.address}`)
      if (r.phone) lines.push(`📞 ${r.phone}`)
      if (r.hours) lines.push(`🕘 ${r.hours}`)
      const amount = formatQuoteAmount(r)
      if (amount) lines.push(`💵 ${amount}`)
      // `formatDate` y no el `YYYY-MM-DD` crudo: es un mensaje para una
      // persona, no una celda de tabla. Es el MISMO formateador que el resto
      // del panel (locale y zona pineados), así que la fecha se lee igual en
      // la tarjeta y en el WhatsApp.
      if (r.validUntil) lines.push(`📅 Vigente hasta el ${formatDate(`${r.validUntil}T00:00:00.000Z`)}`)
      lines.push(r.detail)
      return lines.join('\n')
    })
    .join('\n\n')
}

/**
 * Reemplaza los `{{placeholders}}` de una plantilla con los datos DE ESE
 * pedido. Un placeholder sin valor en `values` se deja tal cual entre llaves
 * — visible y buscable — en vez de desaparecer en silencio.
 *
 * `responses` es opcional y por defecto vacío: la plantilla de Apertura no las
 * usa, y así el llamador que sólo quiere ésa no depende de una consulta más.
 */
export function renderQuoteTemplate(
  template: QuoteTemplate,
  detail: QuoteRequestDetail,
  responses: ReadonlyArray<QuoteResponse> = [],
): string {
  const { included } = splitQuoteResponsesForMessage(responses)

  const values: Record<string, string> = {
    codigo: quotePublicCode(detail.publicNumber),
    patente: detail.plate,
    vehiculo: vehiclePhrase(detail),
    vehiculo_completo: fullVehicleValue(detail),
    pedido: detail.description,
    zona: zoneValue(detail),
    intro: introSentence(included.length, vehiclePhrase(detail), detail.description),
    presupuestos: responsesBlock(responses),
  }
  return template.content.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match)
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
