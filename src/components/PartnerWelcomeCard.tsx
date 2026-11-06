import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Textarea } from '~/components/ui/textarea'
import { PARTNER_WELCOME_IS_DRAFT, renderPartnerWelcome } from '~/lib/partner-welcome'

/**
 * El mensaje de bienvenida de una solicitud, ya completo con el nombre y el
 * link al perfil público. Se copia y se manda a mano: el panel no envía nada.
 *
 * El cuadro es editable como borrador de un solo uso (mismo criterio que
 * `QuoteTemplates`): lo que se copia es lo que se ve. Recargar lo vuelve al
 * texto completado. Si falta un dato, el copiado queda deshabilitado y el
 * aviso dice qué falta — nunca sale una llave literal ni un hueco.
 */
export function PartnerWelcomeCard({
  businessName,
  partner,
}: {
  businessName: string
  partner: { name: string; status: string; publicSlug: string | null } | null
}) {
  const rendered = renderPartnerWelcome({ businessName, partner })
  const [text, setText] = useState(rendered.text)
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const ready = rendered.missing.length === 0

  async function onCopy() {
    try {
      if (!navigator.clipboard) throw new Error('sin portapapeles')
      await navigator.clipboard.writeText(text)
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Mensaje de bienvenida</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {PARTNER_WELCOME_IS_DRAFT ? (
          <p className="text-xs italic text-muted-foreground">
            Texto de ejemplo: no encontré el template oficial en el repo. Las variables sí se completan solas.
          </p>
        ) : null}

        {!ready ? (
          <div className="rounded-md border border-status-yellow/30 bg-status-yellow-bg px-3 py-2 text-xs text-status-yellow">
            <p className="font-medium">Todavía no se puede copiar:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {rendered.missing.map((m) => (
                <li key={m.variable}>
                  {m.variable === 'link_perfil' ? 'Link del perfil' : 'Nombre del taller'}: {m.reason}.
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.currentTarget.value)
            setCopy('idle')
          }}
          rows={12}
          aria-label="Mensaje de bienvenida"
          className="text-sm"
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onCopy} disabled={!ready || text.trim() === ''}>
            {copy === 'copied' ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
            {copy === 'copied' ? 'Copiado' : 'Copiar mensaje'}
          </Button>
          {copy === 'failed' ? (
            <span className="text-xs text-status-red">No se pudo copiar: seleccioná el texto y copialo a mano.</span>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">El envío es manual: copialo y mandalo por WhatsApp.</p>
      </CardContent>
    </Card>
  )
}
