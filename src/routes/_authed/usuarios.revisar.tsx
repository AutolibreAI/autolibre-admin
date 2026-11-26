import { useRef, useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { listAccountReviewQueueFn, markAccountReviewedFn } from '~/fn/users'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  ACCOUNT_MATCH_FIELD_LABELS,
  ACCOUNT_REVIEW_KINDS,
  ACCOUNT_REVIEW_KIND_LABELS,
  accountReviewSearchSchema,
  readableAccountReviewError,
  type AccountReviewRow,
} from '~/lib/account-type'
import { USER_ROLE_LABELS } from '~/lib/users'
import { formatDate, formatDateTimeBuenosAires, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * «Revisar cuentas» (`/usuarios/revisar`) — `.claude/rules/account-types.md`.
 *
 * Reemplaza los dos cruces que nadie corría: (a) qué cuentas `user` sin
 * membresía comparten mail o teléfono con un taller (probablemente el dueño, que
 * se registró y nunca quedó vinculado), y (b) qué cuentas vinculadas a un taller
 * tienen el rol viejo.
 *
 * El panel NO vincula ni cambia el rol: el backend no tiene ese camino desde el
 * admin (`docs/pedido-backend-cuentas-partner.md`). Acá sólo se marca que el caso
 * ya se miró (043). Muestra mail y teléfono: es la única pantalla que los pone
 * al lado del taller, y es sólo para admins (`adminMiddleware`).
 *
 * SSR completo: pocas filas, sin nada del navegador.
 */
export const Route = createFileRoute('/_authed/usuarios/revisar')({
  validateSearch: accountReviewSearchSchema,
  loader: () => listAccountReviewQueueFn(),
  head: () => ({ meta: [{ title: 'Revisar cuentas · Usuarios — AutoLibre' }] }),
  component: ReviewQueue,
})

function ReviewQueue() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  const pending = data.rows.filter((r) => !r.review)
  const rows = data.rows.filter(
    (r) => (search.reviewKind === 'all' || r.kind === search.reviewKind) && (search.reviewShowDone || !r.review),
  )
  const countOf = (k: string) => pending.filter((r) => r.kind === k).length

  return (
    <>
      <PageHeader
        title="Revisar cuentas"
        subtitle={`${formatInt(pending.length)} pendientes · ${formatInt(data.rows.length - pending.length)} ya revisadas`}
        actions={
          <div className="flex items-center gap-3">
            <Link to="/usuarios" className="text-sm text-muted-foreground hover:text-foreground">
              ← Usuarios
            </Link>
            <SsrTag>ssr: full</SsrTag>
          </div>
        }
      />

      <div className="mb-4 space-y-1 text-xs leading-relaxed text-muted-foreground">
        <p>
          <strong className="font-medium text-foreground">Posible partner sin vincular</strong>: cuenta con rol
          «usuario», sin membresía en ningún taller, cuyo mail coincide con el de un taller o una solicitud, o cuyo
          teléfono coincide con el WhatsApp de un taller (últimos 10 dígitos). Sigue contando como Usuario hasta que
          se vincule.
        </p>
        <p>
          <strong className="font-medium text-foreground">Rol desactualizado</strong>: cuenta vinculada a un taller
          cuyo rol no es «partner». Ya cuenta como Partner (el tipo sale de la membresía, no del rol).
        </p>
        <p>
          El panel no puede vincular ni cambiar el rol: el backend no tiene ese camino desde el admin (pedido en{' '}
          <code>docs/pedido-backend-cuentas-partner.md</code>). Por ahora se marca como revisado, con nota.
        </p>
      </div>

      {!data.membersAvailable ? (
        <p className="mb-4 rounded-md border border-status-yellow/30 bg-status-yellow-bg px-4 py-2 text-xs text-status-yellow">
          Esta base no tiene <code>partner_members</code> (0141 del backend): no hay cola que armar.
        </p>
      ) : null}
      {data.membersAvailable && !data.reviewsAvailable ? (
        <p className="mb-4 rounded-md border border-status-yellow/30 bg-status-yellow-bg px-4 py-2 text-xs text-status-yellow">
          Falta aplicar la migración 043 (revisión de cuentas): la cola se ve, pero no se puede marcar como revisada.
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap items-end gap-5">
        <FilterGroup label="Caso">
          <Chip active={search.reviewKind === 'all'} onClick={() => setSearch({ reviewKind: 'all' })}>
            Todos ({formatInt(pending.length)})
          </Chip>
          {ACCOUNT_REVIEW_KINDS.map((k) => (
            <Chip key={k} active={search.reviewKind === k} onClick={() => setSearch({ reviewKind: k })}>
              {ACCOUNT_REVIEW_KIND_LABELS[k]} ({formatInt(countOf(k))})
            </Chip>
          ))}
        </FilterGroup>
        <FilterGroup label="Revisadas">
          <Chip active={search.reviewShowDone} onClick={() => setSearch({ reviewShowDone: !search.reviewShowDone })}>
            Incluir las ya revisadas
          </Chip>
        </FilterGroup>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card py-12 text-center text-sm text-muted-foreground">
          No hay cuentas para revisar con este filtro.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <ReviewItem key={`${r.kind}:${r.userId}`} row={r} canMark={data.reviewsAvailable} />
          ))}
        </ul>
      )}
    </>
  )
}

function ReviewItem({ row, canMark }: { row: AccountReviewRow; canMark: boolean }) {
  const router = useRouter()
  const inFlight = useRef(false)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (reviewed: boolean) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await markAccountReviewedFn({
        data: { userId: row.userId, kind: row.kind, reviewed, note: note || undefined },
      })
      setOpen(false)
      setNote('')
      await router.invalidate()
    } catch (e) {
      setError(readableAccountReviewError(e instanceof Error ? e.message : String(e)))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <li className={cn('rounded-lg border border-border bg-card px-4 py-3 text-sm', row.review && 'opacity-70')}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
        <div className="min-w-56">
          <Link to="/usuarios/$userId" params={{ userId: row.userId }} className="font-medium hover:underline">
            {row.name ?? row.email}
          </Link>
          <div className="text-xs text-muted-foreground">{row.email}</div>
          <div className="text-xs text-muted-foreground">{row.phone ?? 'sin teléfono'}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="border-status-yellow/40 bg-status-yellow-bg text-status-yellow">
            {ACCOUNT_REVIEW_KIND_LABELS[row.kind]}
          </Badge>
          <Badge variant="outline" className="text-muted-foreground">
            Rol: {(USER_ROLE_LABELS as Record<string, string>)[row.role] ?? row.role}
          </Badge>
        </div>
        <div className="text-xs text-muted-foreground">
          Alta {formatDate(row.createdAt)} · {formatInt(row.vehicleCount)} auto{row.vehicleCount === 1 ? '' : 's'} ·{' '}
          {formatInt(row.quoteCount)} pedido{row.quoteCount === 1 ? '' : 's'}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {row.review ? (
            <>
              <span className="text-xs text-muted-foreground">
                Revisada el {formatDateTimeBuenosAires(row.review.at)}
                {row.review.byLabel ? ` por ${row.review.byLabel}` : ''}
              </span>
              {canMark ? (
                <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => void save(false)}>
                  Volver a pendiente
                </Button>
              ) : null}
            </>
          ) : canMark ? (
            <Button size="sm" variant="outline" className="h-7 shadow-none" onClick={() => setOpen((v) => !v)}>
              Marcar revisado
            </Button>
          ) : null}
        </div>
      </div>

      <ul className="mt-2 space-y-0.5 text-xs">
        {row.matches.map((m, i) => (
          <li key={i}>
            <span className="text-muted-foreground">{ACCOUNT_MATCH_FIELD_LABELS[m.field] ?? m.field}: </span>
            {m.partnerId ? (
              <Link to="/partners/$partnerId" params={{ partnerId: m.partnerId }} className="font-medium hover:underline">
                {m.partnerName}
              </Link>
            ) : null}
            {m.applicationId ? (
              <>
                {m.partnerId ? ' · ' : ''}
                <Link
                  to="/solicitudes/$applicationId"
                  params={{ applicationId: m.applicationId }}
                  className="hover:underline"
                >
                  solicitud «{m.applicationName}»{m.partnerId ? '' : ' (sin taller todavía)'}
                </Link>
              </>
            ) : null}
          </li>
        ))}
      </ul>

      {row.review?.note ? <p className="mt-1 text-xs text-muted-foreground">«{row.review.note}»</p> : null}

      {open ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex min-w-64 flex-1 flex-col gap-1">
            <span className="text-xs text-muted-foreground">Nota (opcional): qué se vio, a quién se le pidió vincular</span>
            <input
              value={note}
              maxLength={1000}
              onChange={(e) => setNote(e.target.value)}
              className="h-9 rounded-md border border-input bg-surface px-2"
            />
          </label>
          <Button size="sm" className="h-9" disabled={busy} onClick={() => void save(true)}>
            Confirmar revisado
          </Button>
        </div>
      ) : null}
      {error ? <p className="mt-1 text-sm text-destructive">{error}</p> : null}
    </li>
  )
}
