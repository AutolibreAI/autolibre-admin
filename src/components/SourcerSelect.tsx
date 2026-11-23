import { useRouter } from '@tanstack/react-router'
import { useId, useRef, useState } from 'react'
import { createTeamMemberFn, setApplicationSourcerFn } from '~/fn/team'
import {
  TEAM_ROLES,
  TEAM_ROLE_LABELS,
  readableTeamError,
  sourcerLabel,
  type SourcerRef,
  type TeamMember,
  type TeamRole,
} from '~/lib/team'
import { cn } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog'

/**
 * El selector de "Alta por" (migración 035) — el mismo en la ficha de la
 * solicitud y en cada fila del listado, para que "asignar" se comporte igual
 * en los dos lados.
 *
 * - Ofrece sólo personas ACTIVAS. Si la asignada está inactiva (Lautaro), se
 *   muestra igual como valor actual, con "(inactivo)", pero no como opción
 *   para asignar otras.
 * - Cambiar una que ya está a nombre de otra persona pide confirmación.
 * - "+ Agregar persona" da de alta en el catálogo y asigna en el mismo gesto.
 * - Manda lo que el operador VIO (`expectedMemberId`): si otro la cambió
 *   mientras tanto, el SP contesta `SOURCER_CHANGED` y se relee.
 * - No toca el estado de la solicitud ni bloquea la aprobación.
 */

const ADD = '__add__'
const NONE = ''

export function SourcerSelect({
  applicationId,
  current,
  members,
  compact = false,
  onSaved,
}: {
  applicationId: string
  current: SourcerRef | null
  members: ReadonlyArray<TeamMember>
  compact?: boolean
  onSaved?: () => void
}) {
  const router = useRouter()
  const selectId = useId()
  const inFlight = useRef(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Cambio pendiente de confirmación (había otra persona asignada). */
  const [pending, setPending] = useState<{ memberId: string | null; label: string } | null>(null)
  const [adding, setAdding] = useState(false)

  const active = members.filter((m) => m.active)
  const showCurrentInactive = current && !current.active

  async function save(memberId: string | null) {
    if (inFlight.current) return
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      await setApplicationSourcerFn({
        data: { applicationId, memberId, expectedMemberId: current?.memberId ?? null },
      })
      onSaved?.()
      await router.invalidate()
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause)
      setError(readableTeamError(raw, members.map((m) => ({ id: m.id, name: m.name }))))
      if (raw.startsWith('SOURCER_CHANGED')) await router.invalidate()
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  function choose(memberId: string | null) {
    if (memberId === (current?.memberId ?? null)) return
    if (current) {
      const label = memberId ? (members.find((m) => m.id === memberId)?.name ?? '') : 'Sin asignar'
      setPending({ memberId, label })
      return
    }
    void save(memberId)
  }

  return (
    <div className={cn('min-w-0', compact ? 'w-44' : 'w-full max-w-xs')}>
      <label htmlFor={selectId} className={compact ? 'sr-only' : 'mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground'}>
        Alta por
      </label>
      <select
        id={selectId}
        value={current?.memberId ?? NONE}
        disabled={saving}
        onChange={(e) => {
          const v = e.target.value
          if (v === ADD) {
            setAdding(true)
            return
          }
          choose(v === NONE ? null : v)
        }}
        className={cn(
          'h-8 w-full rounded-md border border-border bg-surface px-2 text-sm text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60',
          !current && 'text-muted-foreground',
        )}
      >
        <option value={NONE}>Sin asignar</option>
        {showCurrentInactive ? (
          <option value={current.memberId}>{sourcerLabel(current)}</option>
        ) : null}
        {active.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
        <option value={ADD}>+ Agregar persona…</option>
      </select>
      {saving ? <p className="mt-1 text-xs text-muted-foreground">Guardando…</p> : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-status-red">
          {error}
        </p>
      ) : null}

      <Dialog open={pending !== null} onOpenChange={(o) => (o ? null : setPending(null))}>
        <DialogContent>
          <DialogTitle>¿Cambiar el alta?</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-foreground">
            Esta alta figura a nombre de <strong>{current ? sourcerLabel(current) : ''}</strong>. ¿Cambiarla a{' '}
            <strong>{pending?.label}</strong>?
          </DialogDescription>
          <p className="mt-2 text-xs text-muted-foreground">Queda en el historial: antes, después, quién y cuándo.</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPending(null)}>
              No
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const next = pending
                setPending(null)
                if (next) void save(next.memberId)
              }}
            >
              Sí, cambiarla
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AddMemberDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={(id) => {
          setAdding(false)
          choose(id)
        }}
      />
    </div>
  )
}

/** Alta rápida de una persona del equipo desde el selector. */
export function AddMemberDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (memberId: string) => void
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState<TeamRole>('comercial')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const nameId = useId()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return
    if (!name.trim()) {
      setError('Escribí el nombre.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const { id } = await createTeamMemberFn({ data: { name: name.trim(), role, userId: null } })
      setName('')
      onCreated(id)
    } catch (cause) {
      setError(readableTeamError(cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent>
        <DialogTitle>Agregar persona del equipo</DialogTitle>
        <DialogDescription className="mt-1">
          No hace falta que tenga cuenta en el panel. Se puede vincular después en Comercial › Equipo.
        </DialogDescription>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <div>
            <label htmlFor={nameId} className="mb-1 block text-xs font-medium text-muted-foreground">
              Nombre
            </label>
            <input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              autoFocus
              className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-muted-foreground">Rol</legend>
            <div className="flex gap-1.5">
              {TEAM_ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={role === r}
                  onClick={() => setRole(r)}
                  className={cn(
                    'h-8 rounded-md border px-3 text-sm',
                    role === r ? 'border-brand bg-brand-soft text-brand' : 'border-border bg-card text-muted-foreground hover:text-foreground',
                  )}
                >
                  {TEAM_ROLE_LABELS[r]}
                </button>
              ))}
            </div>
          </fieldset>
          {error ? (
            <p role="alert" className="text-xs text-status-red">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? 'Agregando…' : 'Agregar'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * "Es mío": un click para asignarse una solicitud SIN asignar. Sólo aparece si
 * el usuario logueado está vinculado a una persona activa del catálogo. Manda
 * `expectedMemberId: null`, así nunca pisa una asignación hecha mientras tanto.
 */
export function ClaimSourcerButton({
  applicationId,
  meMemberId,
  members,
}: {
  applicationId: string
  meMemberId: string
  members: ReadonlyArray<TeamMember>
}) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <span className="inline-flex flex-col">
      <Button
        size="xs"
        variant="outline"
        disabled={saving}
        className="shadow-none"
        onClick={async () => {
          if (saving) return
          setSaving(true)
          setError(null)
          try {
            await setApplicationSourcerFn({ data: { applicationId, memberId: meMemberId, expectedMemberId: null } })
            await router.invalidate()
          } catch (cause) {
            const raw = cause instanceof Error ? cause.message : String(cause)
            setError(readableTeamError(raw, members.map((m) => ({ id: m.id, name: m.name }))))
            if (raw.startsWith('SOURCER_CHANGED')) await router.invalidate()
          } finally {
            setSaving(false)
          }
        }}
      >
        {saving ? '…' : 'Es mío'}
      </Button>
      {error ? <span className="mt-0.5 text-xs text-status-red">{error}</span> : null}
    </span>
  )
}
