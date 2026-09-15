import { useEffect, useState } from 'react'
import { Check, Copy, RotateCcw } from 'lucide-react'
import { QUOTE_TEMPLATES, renderQuoteTemplate } from '~/lib/quote-templates'
import type { QuoteRequestDetail } from '~/lib/quote-requests'
import { Button } from '~/components/ui/button'
import { Textarea } from '~/components/ui/textarea'
import { Card, CardContent } from '~/components/ui/card'
import { cn } from '~/lib/utils'

/**
 * Plantillas de mensajes de un pedido (`/leads/pedidos/:id`) — texto pre
 * armado, ya completado con los datos de ESTE pedido, para copiar y pegar al
 * hablar con la persona o el taller.
 *
 * ── El render sale de `detail`, no de la plantilla cruda ───────────────────
 *
 * `renderQuoteTemplate(template, detail)` reemplaza los `{{placeholders}}` con
 * el código público, la patente, el vehículo, la descripción y la zona de ESTE
 * pedido. Un dato que el pedido no tiene (por ejemplo la zona en uno por
 * WhatsApp) sale como aviso entre corchetes, no como un vacío silencioso.
 *
 * ── Editar acá NO toca la plantilla ─────────────────────────────────────────
 *
 * El operador puede corregir el texto YA RENDERIZADO para este envío puntual
 * antes de copiarlo. Eso se guarda en `edits`, un mapa por `id` de plantilla
 * que vive sólo en el estado de este componente — nunca escribe
 * `QUOTE_TEMPLATES`. Cambiar de pedido (este componente se remonta con la
 * ficha) o recargar la página pierde la edición y vuelve al render original;
 * es lo esperado, no un bug: la plantilla es la fuente de verdad, esto es un
 * borrador de un solo uso.
 *
 * "Restablecer" descarta la edición de la pestaña activa y vuelve al render
 * original de este pedido.
 */
export function QuoteTemplates({ detail }: { detail: QuoteRequestDetail }) {
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

  const original = renderQuoteTemplate(active, detail)
  const text = edits[active.id] ?? original
  const edited = edits[active.id] !== undefined && edits[active.id] !== original

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
            <h2 className="font-heading text-base font-semibold">Plantillas de mensajes</h2>
            <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">
              Lo que sale de este pedido ya viene completo. Completá lo que quede entre{' '}
              <code className="font-mono">[corchetes]</code> antes de mandarlo — se puede editar acá
              sin tocar la plantilla.
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

        <Textarea
          value={text}
          onChange={(e) => setEdits((prev) => ({ ...prev, [active.id]: e.currentTarget.value }))}
          rows={7}
          className="font-mono text-sm"
          aria-label={`Texto de la plantilla ${active.title}`}
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={copy}>
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
        </div>
      </CardContent>
    </Card>
  )
}
