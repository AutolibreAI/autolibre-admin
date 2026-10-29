import { useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { BadgeCheck, ShieldCheck } from 'lucide-react'
import { MockBanner } from '~/components/MockBanner'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { formatDate } from '~/lib/format'
import {
  SEAL_EXPIRY_WARN_DAYS,
  SEAL_KIND_LABELS,
  SEAL_STATE_CLASSES,
  SEAL_STATE_LABELS,
  daysToExpiry,
  sealState,
  todayBuenosAires,
  validateSealGrant,
} from '~/lib/partner-seals'
import { cn } from '~/lib/utils'
import {
  fetchPartnerSealsMock,
  fetchSealCatalogMock,
  grantSealMock,
  revokeSealMock,
  verifySealMock,
} from '~/mocks/partner-seals'
import type { PartnerSeal, Seal, StoredSealStatus } from '~/lib/partner-seals'

const FIELD_LABEL = 'block text-xs font-medium uppercase tracking-wider text-muted-foreground'

/**
 * Sellos del proveedor, en la ficha.
 *
 * Aliado es REAL (`tier = 'founding'`) y se muestra arriba, sin botón propio:
 * se cambia en la tarjeta Perfil, que es la que escribe `partners.tier`. Las
 * redes y aseguradoras son de ejemplo (`~/mocks/partner-seals`), en memoria.
 *
 * El estado se deduce, no se elige: "vencido" sale de la fecha contra hoy en
 * Buenos Aires (`sealState`). Re-asignar un sello que ya tiene reemplaza al
 * anterior, que queda revocado en el historial.
 */
export function PartnerSealsCard({
  partnerId,
  tier,
  actorEmail,
}: {
  partnerId: string
  tier: string
  actorEmail: string
}) {
  const [catalog, setCatalog] = useState<ReadonlyArray<Seal>>([])
  const [seals, setSeals] = useState<Array<PartnerSeal> | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const today = todayBuenosAires()

  async function reload() {
    setSeals(await fetchPartnerSealsMock(partnerId))
  }

  useEffect(() => {
    let alive = true
    void Promise.all([fetchSealCatalogMock(), fetchPartnerSealsMock(partnerId)]).then(([c, s]) => {
      if (!alive) return
      setCatalog(c)
      setSeals(s)
    })
    return () => {
      alive = false
    }
  }, [partnerId])

  const byId = useMemo(() => new Map(catalog.map((s) => [s.id, s])), [catalog])
  const current = (seals ?? []).filter((s) => s.status !== 'revoked')
  const history = (seals ?? []).filter((s) => s.status === 'revoked')

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      await reload()
    } catch {
      setError('No se pudo aplicar: el sello cambió de estado. Recargá la ficha.')
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
          Sellos
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <MockBanner
          title="Las redes y aseguradoras son de ejemplo"
          items={[
            'El catálogo de sellos y lo que se asigna acá no se guardan: viven en esta pestaña y se pierden al recargar.',
            'Aliado sí es real: es el tier «Aliado» de la tarjeta Perfil.',
          ]}
        />

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Aliado</span>
          {tier === 'founding' ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-status-green/30 bg-status-green-bg px-2 py-0.5 text-xs text-status-green">
              <BadgeCheck className="size-3.5" aria-hidden />
              Tiene el sello
            </span>
          ) : (
            <span className="rounded-md border border-border bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
              No es Aliado
            </span>
          )}
          <span className="text-xs text-muted-foreground">Real · se cambia en Perfil (tier).</span>
        </div>

        {seals === null ? (
          <p className="text-sm text-muted-foreground">Cargando sellos…</p>
        ) : current.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin sellos de redes ni aseguradoras.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {current.map((s) => (
              <SealRow
                key={s.id}
                seal={s}
                info={byId.get(s.sealId)}
                today={today}
                onVerify={() => act(() => verifySealMock(s.id))}
                onRevoke={() => act(() => revokeSealMock(s.id))}
              />
            ))}
          </ul>
        )}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <GrantForm
          catalog={catalog}
          today={today}
          current={current}
          onGrant={(input) =>
            act(() => grantSealMock({ ...input, partnerId, grantedBy: actorEmail }))
          }
        />

        {history.length > 0 ? (
          <div>
            <button
              type="button"
              className="text-xs font-medium text-brand hover:underline"
              onClick={() => setShowHistory((v) => !v)}
            >
              {showHistory ? 'Ocultar' : 'Ver'} revocados ({history.length})
            </button>
            {showHistory ? (
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {history.map((s) => (
                  <li key={s.id}>
                    {byId.get(s.sealId)?.name ?? s.sealId} · revocado el{' '}
                    {s.revokedAt ? formatDate(s.revokedAt) : '—'} · fuente: {s.source}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          ¿Varios a la vez desde el listado de una red?{' '}
          <Link to="/partners/sellos" className="font-medium text-brand hover:underline">
            Importar CSV →
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}

function SealStateBadge({ state }: { state: ReturnType<typeof sealState> }) {
  return (
    <span className={cn('rounded-md border px-2 py-0.5 text-xs', SEAL_STATE_CLASSES[state])}>
      {SEAL_STATE_LABELS[state]}
    </span>
  )
}

export { SealStateBadge }

function SealRow({
  seal,
  info,
  today,
  onVerify,
  onRevoke,
}: {
  seal: PartnerSeal
  info: Seal | undefined
  today: string
  onVerify: () => void
  onRevoke: () => void
}) {
  const state = sealState(seal, today)
  const days = daysToExpiry(seal.expiresAt, today)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {info?.name ?? seal.sealId}
          <span className="text-xs font-normal text-muted-foreground">
            {info ? SEAL_KIND_LABELS[info.kind] : ''}
          </span>
          <SealStateBadge state={state} />
        </p>
        <p className="text-xs text-muted-foreground">
          Fuente: {seal.source} · asignado por {seal.grantedBy} el {formatDate(seal.grantedAt)}
          {seal.verifiedAt ? ` · verificado el ${formatDate(seal.verifiedAt)}` : ''}
        </p>
        <p
          className={cn(
            'text-xs',
            state === 'expired'
              ? 'text-status-red'
              : state === 'verified' && days !== null && days <= SEAL_EXPIRY_WARN_DAYS
                ? 'text-status-yellow'
                : 'text-muted-foreground',
          )}
        >
          {seal.expiresAt === null
            ? 'Sin vencimiento'
            : days !== null && days < 0
              ? `Venció el ${formatDate(seal.expiresAt)}`
              : `Vence el ${formatDate(seal.expiresAt)}${days === 0 ? ' (hoy)' : days !== null ? ` (en ${days} días)` : ''}`}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        {seal.status === 'pending' ? (
          <Button size="sm" variant="outline" onClick={onVerify}>
            Marcar verificado
          </Button>
        ) : null}
        {confirmRevoke ? (
          <>
            <Button size="sm" variant="destructive" onClick={onRevoke}>
              Sí, revocar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(false)}>
              No
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(true)}>
            Revocar
          </Button>
        )}
      </div>
    </li>
  )
}

function GrantForm({
  catalog,
  today,
  current,
  onGrant,
}: {
  catalog: ReadonlyArray<Seal>
  today: string
  current: ReadonlyArray<PartnerSeal>
  onGrant: (input: {
    sealId: string
    status: Exclude<StoredSealStatus, 'revoked'>
    source: string
    expiresAt: string | null
  }) => Promise<void>
}) {
  const [sealId, setSealId] = useState('')
  const [status, setStatus] = useState<Exclude<StoredSealStatus, 'revoked'>>('pending')
  const [source, setSource] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const seal = catalog.find((s) => s.id === sealId)
  const replaces = current.some((s) => s.sealId === sealId)

  async function submit() {
    const err = validateSealGrant(seal, { status, source, expiresAt }, today)
    setProblem(err)
    if (err) return
    await onGrant({ sealId, status, source, expiresAt: expiresAt || null })
    setSealId('')
    setStatus('pending')
    setSource('')
    setExpiresAt('')
  }

  return (
    <div className="space-y-3 rounded-md border border-dashed border-border p-3">
      <p className="text-sm font-medium">Asignar un sello</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={FIELD_LABEL}>Sello</label>
          <Select value={sealId} onValueChange={setSealId}>
            <SelectTrigger>
              <SelectValue placeholder="Elegí uno" />
            </SelectTrigger>
            <SelectContent>
              {catalog.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name} · {SEAL_KIND_LABELS[s.kind]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className={FIELD_LABEL}>Estado</label>
          <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pendiente (falta validar)</SelectItem>
              <SelectItem value="verified">Verificado</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className={FIELD_LABEL} htmlFor="seal-source">
            Fuente
          </label>
          <Input
            id="seal-source"
            value={source}
            maxLength={200}
            placeholder="Listado de la red, póliza vista, llamada…"
            onChange={(e) => setSource(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className={FIELD_LABEL} htmlFor="seal-expires">
            Vence {seal?.requiresExpiry ? '(obligatorio)' : '(opcional)'}
          </label>
          <Input id="seal-expires" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </div>
      </div>
      {replaces ? (
        <p className="text-xs text-status-yellow">
          Ya tiene este sello: el anterior queda revocado en el historial.
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <Button size="sm" onClick={() => void submit()} disabled={sealId === ''}>
        Asignar
      </Button>
    </div>
  )
}
