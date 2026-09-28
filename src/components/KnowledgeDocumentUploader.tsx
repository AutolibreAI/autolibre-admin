import { useRef, useState, type ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { FileUp, Upload } from 'lucide-react'
import {
  KNOWLEDGE_MARKDOWN_EXTENSIONS,
  MAX_KNOWLEDGE_MARKDOWN_BYTES,
  MAX_KNOWLEDGE_TITLE_LENGTH,
  hasMarkdownExtension,
} from '~/lib/knowledge-documents'
import { readableKnowledgeError, uploadKnowledgeDocumentFn } from '~/fn/knowledge-documents'
import { Button } from '~/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { formatBytes } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * Alta de un documento público del RAG, o de una versión nueva de uno.
 *
 * ── Cómo viaja el archivo ───────────────────────────────────────────────────
 *
 *   `<input type="file">` → `FormData` → `uploadKnowledgeDocumentFn` (server
 *   fn, POST con `FormData` como `data`) → `uploadMarkdownKnowledgeDocument`
 *   (multipart con `fetch`) → `POST /knowledge-documents/markdown`
 *
 * A diferencia de los manuales, el archivo SÍ pasa por el server function: el
 * backend corta en 1MB y el techo de Vercel (4.5MB) no llega a morder. Ver
 * `src/server/backend.ts` y `.claude/rules/knowledge-documents.md`.
 *
 * ── Lo que pasa después del 201 ─────────────────────────────────────────────
 *
 * Nada que este componente sepa: el backend responde con el documento
 * `pending` y la ingesta corre del otro lado. La pantalla se entera
 * refrescando (`router.invalidate()` acá y el sondeo de la ruta mientras haya
 * algo pendiente). No se agrega una fila optimista: el estado real lo sabe
 * Postgres.
 */
export function KnowledgeDocumentUploader({
  supersedes,
  trigger,
}: {
  /**
   * Presente = versión nueva de ese documento. El título se precarga con el
   * de la versión en uso, y el id viaja oculto.
   */
  supersedes?: { documentId: string; title: string }
  trigger: (open: () => void) => ReactNode
}) {
  const router = useRouter()

  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(supersedes?.title ?? '')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** No controlado (el navegador no deja setear su value): se vacía por ref. */
  const fileInput = useRef<HTMLInputElement>(null)

  function reset() {
    setTitle(supersedes?.title ?? '')
    setFile(null)
    setError(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  /**
   * Los mismos chequeos que el server function, antes del round trip. No son
   * la autoridad —el server fn y el backend los repiten—, son para no hacer
   * esperar al operador por un error que se ve a simple vista.
   */
  const trimmedTitle = title.trim()
  const fileProblem: string | null = !file
    ? null
    : !hasMarkdownExtension(file.name)
      ? 'No es un markdown: tiene que terminar en .md o .markdown.'
      : file.size === 0
        ? 'El archivo está vacío.'
        : file.size > MAX_KNOWLEDGE_MARKDOWN_BYTES
          ? `Pesa ${formatBytes(file.size)}: el backend acepta hasta 1 MB.`
          : null
  const titleProblem =
    trimmedTitle.length > MAX_KNOWLEDGE_TITLE_LENGTH
      ? `El título no puede pasar de ${MAX_KNOWLEDGE_TITLE_LENGTH} caracteres.`
      : null
  const canSubmit = !busy && file !== null && !fileProblem && trimmedTitle.length > 0 && !titleProblem

  async function submit() {
    if (!file || !canSubmit) return

    setBusy(true)
    setError(null)

    try {
      const form = new FormData()
      form.append('title', trimmedTitle)
      if (supersedes) form.append('supersedesDocumentId', supersedes.documentId)
      form.append('file', file, file.name)

      await uploadKnowledgeDocumentFn({ data: form })

      await router.invalidate()
      reset()
      setOpen(false)
    } catch (cause) {
      setError(readableKnowledgeError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {trigger(() => setOpen(true))}

      <Dialog
        open={open}
        onOpenChange={(next) => {
          // Mientras sube, cerrar no cancela nada del lado del backend: se
          // bloquea para que el operador no crea que lo abortó.
          if (busy) return
          setOpen(next)
          if (!next) reset()
        }}
      >
        <DialogContent>
          <DialogTitle>{supersedes ? 'Subir nueva versión' : 'Subir documento'}</DialogTitle>
          <DialogDescription className="mt-1">
            {supersedes
              ? 'La versión en uso sigue sirviendo mientras la nueva se procesa. Recién cuando la nueva queda lista, la anterior pasa a reemplazada; si la nueva falla, la anterior queda como estaba.'
              : 'Un documento público: el asistente lo puede citar al contestarle a cualquier usuario. Se procesa en segundo plano después de subirlo.'}
          </DialogDescription>

          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <div className="space-y-1">
              <label htmlFor="knowledge-title" className="block text-xs text-muted-foreground">
                Título
              </label>
              <Input
                id="knowledge-title"
                value={title}
                disabled={busy}
                maxLength={MAX_KNOWLEDGE_TITLE_LENGTH + 20}
                onChange={(e) => setTitle(e.currentTarget.value)}
                placeholder="Códigos de falla OBD2 más comunes"
                className="text-sm"
                autoComplete="off"
              />
              {titleProblem ? <p className="text-xs text-destructive">{titleProblem}</p> : null}
            </div>

            <div className="space-y-1">
              <label htmlFor="knowledge-file" className="block text-xs text-muted-foreground">
                Archivo markdown
              </label>
              <Input
                id="knowledge-file"
                ref={fileInput}
                type="file"
                // Ayuda del selector, no validación: se vuelve a mirar en el
                // server function y en el backend.
                accept={[...KNOWLEDGE_MARKDOWN_EXTENSIONS, 'text/markdown'].join(',')}
                disabled={busy}
                onChange={(e) => {
                  setFile(e.currentTarget.files?.[0] ?? null)
                  setError(null)
                }}
                className="text-xs file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-xs file:text-foreground"
              />
              <p className={cn('text-xs', fileProblem ? 'text-destructive' : 'text-muted-foreground')}>
                {file
                  ? `${file.name} — ${formatBytes(file.size)}${fileProblem ? ` · ${fileProblem}` : ''}`
                  : '.md o .markdown, en UTF-8, hasta 1 MB.'}
              </p>
            </div>

            {/*
              La marca rag:skip es lo único del formato que no es markdown
              estándar, y el error más probable del alta: fuera de su lugar el
              backend rechaza el documento entero (400, con el número de línea).
            */}
            <div className="rounded-md border border-border bg-surface-2 p-3 text-xs leading-relaxed text-muted-foreground">
              <p>
                El backend trocea el documento por sección (cada <code className="font-mono">###</code>, más la
                intro de cada <code className="font-mono">##</code>). Para dejar una sección AFUERA del
                asistente —notas internas, un índice—, poné{' '}
                <code className="font-mono text-foreground">{'<!-- rag:skip -->'}</code> como primera línea no
                vacía debajo de su título.
              </p>
              <p className="mt-1.5">
                En cualquier otro lugar la marca es un error, igual que un comentario HTML sin cerrar o un
                documento que queda sin nada indexable: el backend rechaza el archivo y dice en qué línea.
              </p>
            </div>

            {error ? (
              <div className="rounded-md border border-destructive/30 bg-status-red-bg p-3">
                <p role="alert" className="whitespace-pre-wrap break-words text-xs leading-relaxed text-destructive">
                  {error}
                </p>
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setOpen(false)
                  reset()
                }}
              >
                Cancelar
              </Button>
              <Button type="submit" size="sm" disabled={!canSubmit} className="gap-1.5">
                {busy ? (
                  <FileUp className="size-3.5 animate-pulse" aria-hidden />
                ) : (
                  <Upload className="size-3.5" aria-hidden />
                )}
                {busy ? 'Subiendo…' : supersedes ? 'Subir versión' : 'Subir'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
