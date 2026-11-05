import { useRef, useState } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { revokePartnerMemberFn } from '~/fn/partner-members'
import {
  memberRoleLabel,
  readablePartnerMemberError,
  verificationLabel,
  type PartnerMember,
  type PartnerMembersResult,
} from '~/lib/partner-members'
import { formatDate } from '~/lib/format'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { PartnerClaimCodesSection } from '~/components/PartnerClaimCodesSection'
import type { PartnerClaimCodesResult } from '~/lib/partner-claim-codes'
import { cn } from '~/lib/utils'

/**
 * «Miembros» — las cuentas de la app vinculadas a este taller
 * (`partner_members`, 0141 del backend). Lee por SQL, revoca por HTTP.
 *
 * Después de un 204 NO se asume nada: `router.invalidate()` vuelve a leer de
 * la base, que es la única que sabe cómo quedó (el endpoint es idempotente y
 * otro admin pudo haber revocado antes). → `.claude/rules/partner-members.md`
 */
export function PartnerMembersCard({
  partnerId,
  partnerName,
  partnerStatus,
  partnerWhatsapp,
  result,
  claimCodes,
}: {
  partnerId: string
  partnerName: string
  partnerStatus: string
  partnerWhatsapp: string | null
  result: PartnerMembersResult
  claimCodes: PartnerClaimCodesResult
}) {
  const router = useRouter()
  const inFlight = useRef(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function revoke(memberId: string, wasActiveOwner: boolean) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await revokePartnerMemberFn({ data: { partnerId, memberId } })
      setConfirming(null)
      await router.invalidate()
      if (wasActiveOwner) {
        // Revocar al DUEÑO hace que el backend invalide en segundo plano los
        // códigos pendientes del taller (`superseded_at`, desde 884332bb). Es
        // asincrónico: la relectura de recién puede todavía verlos pendientes,
        // así que se relee una vez más un rato después.
        setNotice(
          'Los códigos pendientes de este taller quedaron sin efecto. Emití uno nuevo para el próximo dueño.',
        )
        setTimeout(() => void router.invalidate(), 1500)
      }
    } catch (cause) {
      setError(readablePartnerMemberError(cause))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Miembros</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!result.available ? (
          <p className="text-sm text-muted-foreground">
            Falta desplegar la migración 0141 del backend (partner_members). Hasta entonces no hay
            miembros que mostrar ni revocar.
          </p>
        ) : result.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nadie reclamó este taller todavía: ninguna cuenta de la app está vinculada. Para que
            alguien lo reclame, emitile un código (abajo).
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {result.members.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                busy={busy}
                confirming={confirming === m.id}
                onAsk={() => {
                  setError(null)
                  setConfirming(m.id)
                }}
                onCancel={() => setConfirming(null)}
                onConfirm={() => void revoke(m.id, m.memberRole === 'owner' && m.revokedAt === null)}
              />
            ))}
          </ul>
        )}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {notice ? (
          <p role="status" className="text-sm text-status-yellow">
            {notice}
          </p>
        ) : null}

        <PartnerClaimCodesSection
          partnerId={partnerId}
          partnerName={partnerName}
          partnerStatus={partnerStatus}
          partnerWhatsapp={partnerWhatsapp}
          // La decisión de ofrecer «Emitir» sale de lo YA leído: si la 0141
          // falta no hay dueño que mirar (el handler re-chequea igual).
          hasActiveOwner={
            result.available && result.members.some((m) => m.memberRole === 'owner' && m.revokedAt === null)
          }
          result={claimCodes}
        />
      </CardContent>
    </Card>
  )
}

function MemberRow({
  member: m,
  busy,
  confirming,
  onAsk,
  onCancel,
  onConfirm,
}: {
  member: PartnerMember
  busy: boolean
  confirming: boolean
  onAsk: () => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const revoked = m.revokedAt !== null
  const isOwner = m.memberRole === 'owner'

  return (
    <li className={cn('py-2.5 first:pt-0 last:pb-0', revoked && 'text-muted-foreground')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/usuarios/$userId"
              params={{ userId: m.userId }}
              className={cn('truncate text-sm font-medium hover:underline', !revoked && 'text-foreground')}
            >
              {m.userEmail}
            </Link>
            <span
              className={cn(
                'rounded-md border px-1.5 py-0.5 text-xs',
                isOwner && !revoked
                  ? 'border-brand/30 bg-brand-soft text-brand'
                  : 'border-border bg-secondary text-muted-foreground',
              )}
            >
              {memberRoleLabel(m.memberRole)}
            </span>
          </div>
          {m.userName ? <p className="text-xs">{m.userName}</p> : null}
          <p className="text-xs text-muted-foreground">
            Verificado por {verificationLabel(m.verifiedVia)} · desde {formatDate(m.createdAt)}
          </p>
          {revoked && m.revokedAt ? (
            <p className="text-xs text-muted-foreground">
              Revocado el {formatDate(m.revokedAt)} por {m.revokedByEmail ?? 'admin borrado'}
            </p>
          ) : null}
        </div>

        {!revoked && !confirming ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={onAsk}>
            Revocar
          </Button>
        ) : null}
      </div>

      {!revoked && confirming ? (
        <div className="mt-2 space-y-2 rounded-md border border-status-red/25 bg-status-red-bg p-3">
          <p className="text-xs leading-relaxed text-foreground">
            {m.userEmail} deja de poder operar este taller desde la app.
            {isOwner
              ? ' El taller queda sin dueño; para pasárselo a otra persona, después emitile un código nuevo (sección «Códigos para reclamar»).'
              : ''}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={busy} onClick={onConfirm}>
              {busy ? 'Revocando…' : 'Sí, revocar'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
              No
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
