import { useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Copy, KeyRound, MessageCircle } from 'lucide-react'
import { issuePartnerClaimCodeFn } from '~/fn/partner-members'
import {
  claimCodeStateLabel,
  hoursLeftLabel,
  readableClaimCodeError,
  type PartnerClaimCode,
  type PartnerClaimCodesResult,
} from '~/lib/partner-claim-codes'
import { canonicalWhatsAppDigits } from '~/lib/partners'
import { formatDate, formatDateTimeBuenosAires } from '~/lib/format'
import { Button } from '~/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog'
import { cn } from '~/lib/utils'

/**
 * «Códigos para reclamar» — sección de la tarjeta «Miembros».
 *
 * Lista lo emitido (SQL, 0144) y ofrece «Emitir código» (HTTP). Si se puede
 * emitir se decide ANTES de llamar, con lo que ya cargó la ficha: archivado o
 * con dueño activo → sin botón y con el motivo. El handler re-chequea igual.
 *
 * El código en claro vive SÓLO en el estado de este componente, entre la
 * respuesta del POST y el cierre del diálogo. Nunca en el loader, la URL,
 * localStorage ni un `console.*`. → `.claude/rules/partner-members.md`
 */
export function PartnerClaimCodesSection({
  partnerId,
  partnerName,
  partnerStatus,
  partnerWhatsapp,
  hasActiveOwner,
  result,
}: {
  partnerId: string
  partnerName: string
  partnerStatus: string
  partnerWhatsapp: string | null
  hasActiveOwner: boolean
  result: PartnerClaimCodesResult
}) {
  const router = useRouter()
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | null>(null)

  async function issue() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const res = await issuePartnerClaimCodeFn({ data: { partnerId } })
      setIssued(res)
      // La lista se relee ya, para que el código nuevo aparezca como pendiente.
      void router.invalidate()
    } catch (cause) {
      setError(readableClaimCodeError(cause))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  function closeDialog() {
    setIssued(null)
    void router.invalidate()
  }

  const archived = partnerStatus === 'archived'

  return (
    <section className="space-y-2 border-t border-border pt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Códigos para reclamar
      </h3>

      {!result.available ? (
        <p className="text-sm text-muted-foreground">
          Falta desplegar la migración 0144 del backend (partner_claim_codes). Hasta entonces no se
          pueden ver ni emitir códigos.
        </p>
      ) : (
        <>
          {result.codes.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nunca se emitió un código para este taller.</p>
          ) : (
            <ul className="divide-y divide-border">
              {result.codes.map((c) => (
                <CodeRow key={c.id} code={c} />
              ))}
            </ul>
          )}

          {archived ? (
            <p className="text-xs text-muted-foreground">
              El taller está archivado: no se le emiten códigos. Para que alguien lo reclame, primero
              hay que reactivarlo.
            </p>
          ) : hasActiveOwner ? (
            <p className="text-xs text-muted-foreground">
              El taller ya tiene dueño. Para pasárselo a otra persona, primero revocá al dueño.
            </p>
          ) : (
            <div className="space-y-1.5">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void issue()}>
                <KeyRound className="size-3.5" aria-hidden />
                {busy ? 'Emitiendo…' : 'Emitir código'}
              </Button>
              <p className="text-xs text-muted-foreground">
                Un solo uso, vale 7 días. Quien lo canjee en la app queda como dueño del taller, y los
                demás códigos pendientes se invalidan.
              </p>
            </div>
          )}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </>
      )}

      {issued ? (
        <IssuedCodeDialog
          code={issued.code}
          expiresAt={issued.expiresAt}
          partnerName={partnerName}
          partnerWhatsapp={partnerWhatsapp}
          onClose={closeDialog}
        />
      ) : null}
    </section>
  )
}

function CodeRow({ code: c }: { code: PartnerClaimCode }) {
  const pending = c.state === 'pendiente'
  return (
    <li className={cn('py-2 first:pt-0 last:pb-0 text-xs', !pending && 'text-muted-foreground')}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'rounded-md border px-1.5 py-0.5',
            pending
              ? 'border-brand/30 bg-brand-soft text-brand'
              : c.state === 'canjeado'
                ? 'border-status-green/30 bg-status-green-bg text-status-green'
                : 'border-border bg-secondary text-muted-foreground',
          )}
        >
          {claimCodeStateLabel(c.state)}
        </span>
        <span>
          Emitido el {formatDate(c.createdAt)} por {c.createdByEmail ?? 'admin borrado'}
        </span>
        {pending && c.hoursLeft !== null ? <span className="text-foreground">· {hoursLeftLabel(c.hoursLeft)}</span> : null}
        {c.state === 'vencido' ? <span>· venció el {formatDate(c.expiresAt)}</span> : null}
      </div>
      {c.redeemedAt ? (
        <p className="mt-0.5">
          Canjeado el {formatDate(c.redeemedAt)} por {c.redeemedByEmail ?? 'usuario borrado'}
        </p>
      ) : null}
      {c.revokedAt ? <p className="mt-0.5">Revocado el {formatDate(c.revokedAt)}</p> : null}
      {c.supersededAt ? <p className="mt-0.5">Invalidado el {formatDate(c.supersededAt)}</p> : null}
    </li>
  )
}

/**
 * El único lugar donde se ve el código. Sólo se cierra con el botón explícito
 * (no con click afuera ni Escape): cerrar es perderlo para siempre.
 */
function IssuedCodeDialog({
  code,
  expiresAt,
  partnerName,
  partnerWhatsapp,
  onClose,
}: {
  code: string
  expiresAt: string
  partnerName: string
  partnerWhatsapp: string | null
  onClose: () => void
}) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const expires = formatDateTimeBuenosAires(expiresAt)
  const digits = partnerWhatsapp ? canonicalWhatsAppDigits(partnerWhatsapp) : null
  const waUrl = digits
    ? `https://wa.me/${digits}?text=${encodeURIComponent(
        `Hola ${partnerName}, te escribimos de AutoLibre. Tu código para reclamar el taller en la app es ${code}. Sirve una sola vez y vence el ${expires} (hora de Buenos Aires). No lo compartas con nadie.`,
      )}`
    : null

  async function onCopy() {
    try {
      if (!navigator.clipboard) throw new Error('sin portapapeles')
      await navigator.clipboard.writeText(code)
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogTitle>Código para reclamar {partnerName}</DialogTitle>
        <DialogDescription className="mt-1">
          Es un secreto al portador: quien lo tenga puede quedarse con el taller. Un solo uso.
        </DialogDescription>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <code className="select-all rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-2xl font-bold tracking-widest text-foreground">
            {code}
          </code>
          <Button size="sm" variant="outline" onClick={() => void onCopy()}>
            <Copy className="size-3.5" aria-hidden />
            Copiar
          </Button>
        </div>
        <p aria-live="polite" className="mt-1 min-h-4 text-xs">
          {copy === 'copied' ? (
            <span className="text-status-green">Copiado.</span>
          ) : copy === 'failed' ? (
            <span className="text-status-yellow">No se pudo copiar: seleccioná el código y copialo a mano.</span>
          ) : null}
        </p>

        <p className="mt-2 text-sm text-foreground">Vence el {expires} (hora de Buenos Aires).</p>

        <div className="mt-3 space-y-1.5 rounded-md border border-border p-3 text-sm">
          <p>
            WhatsApp registrado del taller:{' '}
            <span className="font-medium tabular-nums">{partnerWhatsapp?.trim() || 'no cargado'}</span>
          </p>
          <p className="font-bold text-foreground">Mandalo SOLO a este número.</p>
          {waUrl ? (
            <>
              <a
                href={waUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline underline-offset-2"
              >
                <MessageCircle className="size-3.5" aria-hidden />
                Abrir WhatsApp
              </a>
              <p className="text-xs text-muted-foreground">
                Abre el chat con el mensaje escrito; no manda nada. El envío lo hacés vos.
              </p>
            </>
          ) : (
            <p className="text-xs text-status-yellow">
              El número no está en forma canónica (549 + 10 dígitos), así que no hay link: no se adivina la
              característica. Corregilo en la ficha o mandalo a mano a un número verificado.
            </p>
          )}
        </div>

        <p className="mt-3 rounded-md border border-status-yellow/30 bg-status-yellow-bg px-3 py-2 text-xs leading-relaxed text-status-yellow">
          Este código no se vuelve a ver: al cerrar esta ventana sólo queda su hash. Si se pierde, emití otro.
        </p>

        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={onClose}>
            Ya lo guardé, cerrar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
