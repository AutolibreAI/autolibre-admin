import { useEffect, useState } from 'react'
import { Check, Copy, MessageCircle, RotateCcw } from 'lucide-react'
import {
  QUOTE_TEMPLATES,
  WHATSAPP_TEXT_MAX,
  renderQuoteTemplate,
  splitQuoteResponsesForMessage,
  whatsAppMessageUrl,
} from '~/lib/quote-templates'
import { canonicalWhatsAppDigits } from '~/lib/partners'
import type { QuoteRequestDetail } from '~/lib/quote-requests'
import type { QuoteResponse } from '~/lib/quote-responses'
import { Button } from '~/components/ui/button'
import { Textarea } from '~/components/ui/textarea'
import { Card, CardContent } from '~/components/ui/card'
import { cn } from '~/lib/utils'

/**
 * Plantillas de mensajes de un pedido (`/leads/pedidos/:id`) — texto pre
 * armado, ya completado con los datos de ESTE pedido, para mandar por WhatsApp
 * o copiar.
 *
 * ── El render sale de `detail` + `responses`, no de la plantilla cruda ─────
 *
 * `renderQuoteTemplate(template, detail, responses)` reemplaza los
 * `{{placeholders}}`. La plantilla «Presupuestos» arma el bloque numerado con
 * lo que contestó cada taller: nombre, dirección, teléfono, horarios, precio
 * si hay, y el párrafo. Un dato que no está no deja un renglón vacío — no
 * aparece.
 *
 * ── `responses` entra como PROP, no se pide acá ────────────────────────────
 *
 * Las trae el loader de la ficha, que ya las necesita para `<QuoteResponses/>`.
 * Pedirlas de nuevo desde acá sería una segunda consulta con otro snapshot, y
 * el texto que se manda podría no ser la lista que se ve dos tarjetas más
 * abajo.
 *
 * ── Editar acá NO toca la plantilla ────────────────────────────────────────
 *
 * El operador corrige el texto YA RENDERIZADO para este envío puntual antes de
 * mandarlo — sobre todo el renglón de la recomendación, que es juicio suyo y
 * viene entre corchetes. Eso vive en `edits`, un mapa por `id` de plantilla en
 * el estado de este componente, y nunca escribe `QUOTE_TEMPLATES`. Cambiar de
 * pedido o recargar lo pierde a propósito: la plantilla es la fuente de
 * verdad, esto es un borrador de un solo uso.
 *
 * **El botón de WhatsApp manda lo EDITADO**, no el render original: si mandara
 * el original, el operador editaría el cuadro y se preguntaría por qué llegó
 * otra cosa.
 */
export function QuoteTemplates({
  detail,
  responses,
}: {
  detail: QuoteRequestDetail
  responses: Array<QuoteResponse>
}) {
  const [activeId, setActiveId] = useState(QUOTE_TEMPLATES[0]?.id)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(id)
  }, [copied])

  const active = QUOTE_TEMPLATES.find((t) => t.id === activeId)
  if (!active) return null

  const original = renderQuoteTemplate(active, detail, responses)
  const text = edits[active.id] ?? original
  const edited = edits[active.id] !== undefined && edits[active.id] !== original

  // El teléfono del PEDIDO es el de la persona. Para una plantilla que va al
  // taller (`audience: 'taller'`) mandarla ahí sería escribirle a quien no
  // corresponde — ese envío se resuelve por taller elegido, desde
  // `PartnerCandidates`. Acá sólo queda copiar.
  const isForPerson = active.audience === 'persona'
  // Mismo criterio de teléfono que todo el repo: `549` + 10 dígitos, sin
  // adivinar la característica — adivinarla mal le escribe a otra persona.
  const digits = isForPerson ? canonicalWhatsAppDigits(detail.contactPhone) : null
  const waUrl = isForPerson ? whatsAppMessageUrl(digits, text) : null
  const { expired } = splitQuoteResponsesForMessage(responses)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // Mismo criterio que `CopyableId`: sin permiso de portapapeles, no
      // fingimos que se copió. El texto sigue completo en el textarea para
      // seleccionarlo a mano.
    }
  }

  return (
    <Card className="mb-4">
      <CardContent className="pt-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-heading text-base font-semibold">Mensajes</h2>
            <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">
              Lo que sale de este pedido ya viene completo. Completá o borrá lo que quede entre{' '}
              <code className="font-mono">[corchetes]</code> antes de mandarlo — se puede editar acá sin tocar la
              plantilla.
            </p>
          </div>
        </div>

        {QUOTE_TEMPLATES.length > 1 ? (
          <nav aria-label="Plantillas" className="mb-3 flex flex-wrap gap-1 border-b border-border">
            {QUOTE_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveId(t.id)}
                aria-current={t.id === active.id ? 'page' : undefined}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-sm font-medium outline-none transition-colors',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  t.id === active.id
                    ? 'border-brand text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t.title}
              </button>
            ))}
          </nav>
        ) : null}

        {active.id === 'presupuestos' && expired.length > 0 ? (
          <p className="mb-3 rounded-md border border-status-yellow/30 bg-status-yellow-bg px-3 py-2 text-xs leading-relaxed text-status-yellow">
            {expired.length === 1
              ? 'Un presupuesto venció y no entra en el mensaje.'
              : `${expired.length} presupuestos vencieron y no entran en el mensaje.`}{' '}
            Mandar un precio caducado es peor que mandar uno menos.
          </p>
        ) : null}

        <Textarea
          value={text}
          onChange={(e) => setEdits((prev) => ({ ...prev, [active.id]: e.currentTarget.value }))}
          rows={14}
          className="font-mono text-sm"
          aria-label={`Texto del mensaje ${active.title}`}
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {waUrl ? (
            <Button asChild size="sm">
              <a href={waUrl} target="_blank" rel="noreferrer">
                <MessageCircle className="size-3.5" aria-hidden />
                Mandar por WhatsApp
              </a>
            </Button>
          ) : null}

          <Button type="button" size="sm" variant={waUrl ? 'outline' : 'default'} onClick={copy}>
            {copied ? (
              <>
                <Check className="size-3.5" aria-hidden />
                Copiado
              </>
            ) : (
              <>
                <Copy className="size-3.5" aria-hidden />
                Copiar
              </>
            )}
          </Button>

          {edited ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                setEdits((prev) => {
                  const next = { ...prev }
                  delete next[active.id]
                  return next
                })
              }
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Restablecer
            </Button>
          ) : null}

          {/*
            Las razones por las que no hay botón de WhatsApp se explican por
            separado: una se arregla corrigiendo el teléfono del pedido, otra
            acortando el mensaje, y la de "taller" no es un problema — es que
            el envío va por taller elegido, no por acá. Un solo "no se puede"
            mandaría a buscar mal.
          */}
          {!waUrl ? (
            <span className="text-xs leading-relaxed text-muted-foreground">
              {!isForPerson
                ? 'Este mensaje es para el taller: mandalo con el botón "Pedir cotización" del candidato elegido, o copialo y pegalo en tu WhatsApp.'
                : !digits
                  ? 'Sin botón de WhatsApp: el teléfono del pedido no está en la forma 549 + 10 dígitos, y completar una característica sería adivinarla. Copiá el texto y mandalo desde tu WhatsApp.'
                  : `Sin botón de WhatsApp: el mensaje tiene ${text.length} caracteres y el link soporta hasta ${WHATSAPP_TEXT_MAX}. Copialo, o acortá alguna respuesta.`}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
