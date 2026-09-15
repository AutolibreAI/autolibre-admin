import { quotePublicCode, type QuoteRequestDetail } from '~/lib/quote-requests'

/**
 * Plantillas de mensajes para la ficha de un pedido (`/leads/pedidos/:id`).
 *
 * Texto fijo para copiar y pegar al hablar con la persona o el taller sobre
 * ESE pedido puntual. No es dato de dominio — es copy que el equipo redactó a
 * mano, mismo estatus que `MANUAL_LANGUAGES` en `~/lib/manuals`: una lista
 * cerrada que vive en el código porque hoy sólo el panel la escribe.
 *
 * ── Dos estilos de placeholder, a propósito ─────────────────────────────────
 *
 * Los `{{con_llaves}}` se completan SOLOS con los datos del pedido abierto —
 * `renderQuoteTemplate()` los reemplaza contra un `QuoteRequestDetail` real, y
 * si ese pedido no tiene el dato deja un aviso `[entre corchetes]` (ver
 * `zoneValue` / `vehicleValue` abajo).
 *
 * Los `[entre corchetes]` en el texto FUENTE de una plantilla (como el
 * proveedor o el precio en "Presupuesto") NO pasan por el reemplazo: no hay
 * columna de la que sacarlos — `autolibre-backend-hex` sacó `quotes` /
 * `quote_messages` del MVP, así que no existe un presupuesto por taller en
 * ningún lado (`.claude/rules/leads.md`, sección Pedidos). Inventar esa
 * columna violaría la regla dura 8. Quedan como texto a completar A MANO,
 * visibles porque el regex de `renderQuoteTemplate` sólo toca `{{llaves}}`.
 *
 * `QuoteTemplates` (en `~/components/QuoteTemplates`) deja editar el texto YA
 * RENDERIZADO antes de copiarlo, para ese envío puntual — esa edición vive en
 * el estado del componente y nunca toca esta lista. Agregar una plantilla
 * nueva es un objeto más acá; la ficha la muestra sola.
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

* {{patente}} + {{vehiculo}}
* {{pedido}}
* {{zona}}

Ya estamos trabajando, cualquier duda o correccion avisanos!`,
  },
  {
    id: 'presupuesto',
    title: 'Presupuesto',
    // Los cinco placeholders son `[corchetes]`, no `{{llaves}}`, a propósito:
    // ningún dato de un presupuesto por taller vive en la base (ver el
    // comentario de arriba). Quedan para completar a mano.
    content: `Ya tenemos cotizaciones para tu trabajo

* [Proveedor]
* [precio]
* [Direccion]
* [horarios]
* [numero de whatsapp]
* [otros detalles]`,
  },
]

/**
 * `vehiculo`: el catálogo (`MARCA MODELO VERSIÓN AÑO`) si el operador ya
 * vinculó un auto y ese auto resuelve a un modelo del catálogo; si no,
 * avisa qué falta en vez de mostrar un placeholder ciego.
 */
function vehicleValue(detail: QuoteRequestDetail): string {
  if (!detail.vehicleId) return '[sin vehículo vinculado]'
  return detail.catalogLabel ?? '[vehículo vinculado sin modelo de catálogo]'
}

/** `null` (WhatsApp, o un pedido `typed` sin dirección) → aviso, no un vacío. */
function zoneValue(detail: QuoteRequestDetail): string {
  return detail.locationAddress ?? '[completar zona/dirección — el pedido no la trae cargada]'
}

/**
 * Reemplaza los `{{placeholders}}` de una plantilla con los datos DE ESE
 * pedido. Un placeholder sin valor en `values` se deja tal cual entre llaves
 * — visible y buscable — en vez de desaparecer en silencio.
 */
export function renderQuoteTemplate(template: QuoteTemplate, detail: QuoteRequestDetail): string {
  const values: Record<string, string> = {
    codigo: quotePublicCode(detail.publicNumber),
    patente: detail.plate,
    vehiculo: vehicleValue(detail),
    pedido: detail.description,
    zona: zoneValue(detail),
  }
  return template.content.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match)
}
