import { useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Check, Copy, History, MessageCircle, Pencil, Plus, RotateCcw } from 'lucide-react'
import {
  TEMPLATE_VARIABLES,
  WHATSAPP_TEXT_MAX,
  readableQuoteMessageTemplateError,
  renderQuoteTemplate,
  saveQuoteMessageTemplateSchema,
  splitQuoteResponsesForMessage,
  whatsAppMessageUrl,
  type QuoteMessageTemplate,
  type QuoteMessageTemplateVersion,
  type QuoteTemplateAudience,
} from '~/lib/quote-templates'
import { canonicalWhatsAppDigits } from '~/lib/partners'
import { listQuoteMessageTemplateVersionsFn, saveQuoteMessageTemplateFn } from '~/fn/quote-message-templates'
import type { QuoteRequestDetail } from '~/lib/quote-requests'
import type { QuoteResponse } from '~/lib/quote-responses'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Card, CardContent } from '~/components/ui/card'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '~/components/ui/sheet'
import { Badge } from '~/components/ui/badge'
import { formatDateTime } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * Plantillas de mensajes de un pedido (`/leads/pedidos/:id`) — texto pre
 * armado, ya completado con los datos de ESTE pedido, para mandar por
 * WhatsApp o copiar.
 *
 * ── Editables desde el 2026-09-25 ──────────────────────────────────────────
 *
 * `templates` llega del LOADER de la ficha (`listQuoteMessageTemplatesFn`),
 * ya resuelto: la semilla de código (`QUOTE_TEMPLATES`) para las claves que
 * nadie editó, la versión vigente de `ops` para las que sí. Este componente
 * ya no importa `QUOTE_TEMPLATES` directo — mismo motivo por el que
 * `PartnerCandidates` tampoco lo hace: el botón "Pedir cotización" tiene que
 * usar la MISMA plantilla `cotizacion_red` que se ve acá, editada o no.
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
 * el estado de este componente, y nunca escribe la plantilla. Cambiar de
 * pedido o recargar lo pierde a propósito: la plantilla es la fuente de
 * verdad, esto es un borrador de un solo uso. Editar la PLANTILLA en sí
 * —el texto crudo con `{{llaves}}`, vigente para todos los pedidos— es el
 * Sheet de «Editar plantilla» / «Nueva plantilla», que sí escribe.
 *
 * **El botón de WhatsApp manda lo EDITADO**, no el render original: si mandara
 * el original, el operador editaría el cuadro y se preguntaría por qué llegó
 * otra cosa.
 */
export function QuoteTemplates({
  detail,
  responses,
  templates,
}: {
  detail: QuoteRequestDetail
  responses: Array<QuoteResponse>
  templates: Array<QuoteMessageTemplate>
}) {
  const router = useRouter()
  const [activeId, setActiveId] = useState(templates[0]?.id)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState<'active' | 'new' | null>(null)

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(id)
  }, [copied])

  const active = templates.find((t) => t.id === activeId) ?? templates[0]
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
          <div className="flex shrink-0 gap-1.5">
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing('active')} className="gap-1.5">
              <Pencil className="size-3.5" aria-hidden />
              Editar plantilla
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing('new')} className="gap-1.5">
              <Plus className="size-3.5" aria-hidden />
              Nueva plantilla
            </Button>
          </div>
        </div>

        {templates.length > 1 ? (
          <nav aria-label="Plantillas" className="mb-3 flex flex-wrap gap-1 border-b border-border">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveId(t.id)}
                aria-current={t.id === active.id ? 'page' : undefined}
                className={cn(
                  '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium outline-none transition-colors',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  t.id === active.id
                    ? 'border-brand text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t.title}
                {t.isCustomized ? <span className="size-1.5 rounded-full bg-brand" aria-label="editada" /> : null}
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

      <TemplateEditorSheet
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
        mode={editing === 'new' ? 'create' : 'edit'}
        template={editing === 'active' ? active : null}
        detail={detail}
        responses={responses}
        onSaved={(saved) => {
          setEditing(null)
          setActiveId(saved.id)
          void router.invalidate()
        }}
      />
    </Card>
  )
}

// ── El editor: Sheet con título, audiencia, texto crudo, variables, vista previa, historial ──

function TemplateEditorSheet({
  open,
  onOpenChange,
  mode,
  template,
  detail,
  responses,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'edit' | 'create'
  /** La plantilla siendo editada. `null` en modo `create`. */
  template: QuoteMessageTemplate | null
  detail: QuoteRequestDetail
  responses: Array<QuoteResponse>
  onSaved: (template: QuoteMessageTemplate) => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [title, setTitle] = useState('')
  const [audience, setAudience] = useState<QuoteTemplateAudience>('persona')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<Array<QuoteMessageTemplateVersion> | null>(null)

  // Sembrar el form al abrir — no en cada render, para no pisar lo que el
  // operador está tipeando si `template` cambia de referencia sin que el
  // Sheet se haya cerrado y vuelto a abrir.
  useEffect(() => {
    if (!open) return
    setError(null)
    if (mode === 'edit' && template) {
      setTitle(template.title)
      setAudience(template.audience)
      setContent(template.content)
    } else {
      setTitle('')
      setAudience('persona')
      setContent('')
    }
  }, [open, mode, template])

  // Historial: sólo en modo edición, y sólo la clave activa — una plantilla
  // nueva todavía no tiene ninguna versión que listar.
  useEffect(() => {
    if (!open || mode !== 'edit' || !template) {
      setHistory(null)
      return
    }
    let cancelled = false
    void listQuoteMessageTemplateVersionsFn({ data: { templateKey: template.id } }).then((rows) => {
      if (!cancelled) setHistory(rows)
    })
    return () => {
      cancelled = true
    }
  }, [open, mode, template])

  function insertVariable(key: string) {
    const token = `{{${key}}}`
    const el = textareaRef.current
    if (!el) {
      setContent((c) => c + token)
      return
    }
    const start = el.selectionStart ?? content.length
    const end = el.selectionEnd ?? content.length
    const next = content.slice(0, start) + token + content.slice(end)
    setContent(next)
    const cursor = start + token.length
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(cursor, cursor)
    })
  }

  const preview = renderQuoteTemplate({ id: template?.id ?? 'preview', title, audience, content }, detail, responses)

  async function submit() {
    const parsed = saveQuoteMessageTemplateSchema.safeParse({
      templateKey: mode === 'edit' ? template?.id : undefined,
      title,
      audience,
      content,
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Revisá el formulario.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const saved = await saveQuoteMessageTemplateFn({ data: parsed.data })
      onSaved(saved)
    } catch (cause) {
      setError(readableQuoteMessageTemplateError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-full bg-card sm:w-[38rem]">
        <form
          className="flex h-full min-h-0 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="border-b border-border px-5 py-4 pr-10">
            <SheetTitle>{mode === 'create' ? 'Nueva plantilla' : `Editar «${template?.title}»`}</SheetTitle>
            <SheetDescription className="mt-0.5 leading-relaxed">
              {mode === 'create'
                ? 'Guardar crea la versión 1. Va a estar disponible en la ficha de cualquier pedido.'
                : 'Guardar crea una versión nueva — vigente para todos los pedidos desde ahora. El historial de abajo queda intacto.'}
            </SheetDescription>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {error ? (
              <p role="alert" className="rounded-md border border-destructive/30 bg-status-red-bg p-3 text-xs leading-relaxed text-destructive">
                {error}
              </p>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Título
                </label>
                <Input value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={120} className="text-sm" />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  A quién va
                </label>
                <div className="flex gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant={audience === 'persona' ? 'default' : 'outline'}
                    onClick={() => setAudience('persona')}
                  >
                    A la persona
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={audience === 'taller' ? 'default' : 'outline'}
                    onClick={() => setAudience('taller')}
                  >
                    Al taller
                  </Button>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Texto (con variables)
                </label>
                <span className="text-xs text-muted-foreground">Tiene que incluir {'{{codigo}}'}</span>
              </div>
              <Textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => setContent(e.currentTarget.value)}
                rows={10}
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Variables — click para insertar
              </span>
              <div className="flex flex-wrap gap-1.5">
                {TEMPLATE_VARIABLES[audience].map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    title={v.label}
                    onClick={() => insertVariable(v.key)}
                    className="rounded border border-border bg-secondary px-2 py-1 font-mono text-xs text-foreground outline-none hover:border-brand/40 hover:text-brand focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {`{{${v.key}}}`}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Vista previa — con ESTE pedido
              </span>
              <pre className="whitespace-pre-wrap rounded-md border border-border bg-secondary p-3 font-mono text-xs leading-relaxed">
                {preview}
              </pre>
            </div>

            {mode === 'edit' && template ? (
              <div className="space-y-1.5 border-t border-border pt-4">
                <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <History className="size-3.5" aria-hidden />
                  Historial
                </span>
                {history === null ? (
                  <p className="text-xs text-muted-foreground">Cargando…</p>
                ) : history.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {template.isCustomized ? 'Sin versiones anteriores.' : 'Todavía es la semilla de código — nadie la editó.'}
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {history.map((v) => (
                      <li
                        key={v.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
                      >
                        <span className="text-muted-foreground">
                          {formatDateTime(v.createdAt)} UTC{v.actorEmail ? ` · ${v.actorEmail}` : ''}
                          {v.archived ? (
                            <Badge variant="outline" className="ml-1.5 border-border text-muted-foreground">
                              archivada
                            </Badge>
                          ) : null}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setTitle(v.title)
                            setAudience(v.audience)
                            setContent(v.content)
                          }}
                          className="rounded text-brand underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          usar esta versión
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" size="sm" disabled={busy} className="gap-1.5">
              <Check className="size-3.5" aria-hidden />
              {busy ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
