import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { UserPlus } from 'lucide-react'
import { listTeamMembersFn, updateTeamMemberFn } from '~/fn/team'
import {
  TEAM_ROLES,
  TEAM_ROLE_LABELS,
  readableTeamError,
  teamRoleLabel,
  type PanelUserOption,
  type TeamMember,
  type TeamRole,
} from '~/lib/team'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { AddMemberDialog } from '~/components/SourcerSelect'
import { Button } from '~/components/ui/button'
import { formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * `/comercial/equipo` — el catálogo de personas del equipo (migración 035):
 * quién puede figurar como «Alta por» de una solicitud y, si tiene usuario del
 * panel vinculado, como «Conseguido por» de Comercial (opción A, 2026-11-20).
 *
 * Qué reemplaza: nada que se corriera — hasta acá "quién trajo a este
 * proveedor" no se guardaba en ningún lado.
 *
 * Una persona no se borra: se desactiva. Deja de ofrecerse para asignar, y
 * sigue apareciendo en las altas que ya tiene. → `.claude/rules/team-sourcing.md`
 *
 * SSR completo: tabla chica, nada que streamear.
 */
export const Route = createFileRoute('/_authed/comercial/equipo')({
  loader: () => listTeamMembersFn(),
  head: () => ({ meta: [{ title: 'Equipo · Seguimiento comercial — AutoLibre' }] }),
  component: TeamView,
})

function TeamView() {
  const { available, members, users } = Route.useLoaderData()
  const router = useRouter()
  const [adding, setAdding] = useState(false)

  if (!available) {
    return (
      <>
        <PageHeader title="Equipo" />
        <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          Falta aplicar la migración 035 («Alta por» y el catálogo del equipo) en esta base.
        </div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Equipo"
        subtitle={`${formatInt(members.filter((m) => m.active).length)} activas · ${formatInt(members.length)} en total`}
        actions={
          <>
            <Button size="sm" onClick={() => setAdding(true)}>
              <UserPlus aria-hidden /> Agregar persona
            </Button>
            <SsrTag>ssr: full</SsrTag>
          </>
        }
      />
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        Las personas que pueden figurar como «Alta por» en una solicitud. No hace falta tener cuenta en el panel; si la
        tiene, vinculala para que pueda usar «Es mío» en Solicitudes y aparezca como «Conseguido por» en Contactos.
        Una persona inactiva no se ofrece para altas nuevas, pero sigue en las que ya tiene.
      </p>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Persona</th>
              <th className="px-3 py-2 font-medium">Rol</th>
              <th className="px-3 py-2 font-medium">Usuario del panel</th>
              <th className="px-3 py-2 text-right font-medium">Solicitudes</th>
              <th className="px-3 py-2 font-medium">Estado</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <MemberRow key={`${m.id}:${m.active}:${m.role}:${m.userId ?? ''}`} member={m} users={users} />
            ))}
          </tbody>
        </table>
      </div>

      <AddMemberDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={() => {
          setAdding(false)
          void router.invalidate()
        }}
      />
    </>
  )
}

function MemberRow({ member: m, users }: { member: TeamMember; users: ReadonlyArray<PanelUserOption> }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(patch: { role?: TeamRole; active?: boolean; userId?: string | null }) {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await updateTeamMemberFn({ data: { memberId: m.id, patch } })
      await router.invalidate()
    } catch (cause) {
      setError(readableTeamError(cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setSaving(false)
    }
  }

  // Un usuario ya vinculado a OTRA persona no se ofrece (la base lo rechazaría).
  const userOptions = users.filter((u) => !u.linkedMemberId || u.linkedMemberId === m.id)

  return (
    <tr className={cn('border-b border-border last:border-0', !m.active && 'text-muted-foreground')}>
      <td className="px-3 py-2">
        <div className="font-medium text-foreground">{m.name}</div>
        <div className="text-xs text-muted-foreground">
          desde el {plainDay(m.activeSince)}
          {m.inactiveSince ? ` · inactivo desde el ${plainDay(m.inactiveSince)}` : ''}
        </div>
        {error ? (
          <p role="alert" className="mt-1 text-xs text-status-red">
            {error}
          </p>
        ) : null}
      </td>
      <td className="px-3 py-2">
        <select
          aria-label={`Rol de ${m.name}`}
          value={m.role}
          disabled={saving}
          onChange={(e) => void save({ role: e.target.value as TeamRole })}
          className="h-8 rounded-md border border-border bg-surface px-2 text-sm"
        >
          {TEAM_ROLES.map((r) => (
            <option key={r} value={r}>
              {TEAM_ROLE_LABELS[r]}
            </option>
          ))}
          {(TEAM_ROLES as ReadonlyArray<string>).includes(m.role) ? null : <option value={m.role}>{teamRoleLabel(m.role)}</option>}
        </select>
      </td>
      <td className="px-3 py-2">
        <select
          aria-label={`Usuario del panel de ${m.name}`}
          value={m.userId ?? ''}
          disabled={saving}
          onChange={(e) => void save({ userId: e.target.value || null })}
          className="h-8 max-w-56 rounded-md border border-border bg-surface px-2 text-sm"
        >
          <option value="">Sin cuenta vinculada</option>
          {userOptions.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
          {m.userId && !userOptions.some((u) => u.id === m.userId) ? (
            <option value={m.userId}>{m.userLabel ?? 'usuario que ya no es admin'}</option>
          ) : null}
        </select>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{formatInt(m.applicationCount)}</td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'rounded-md px-2 py-0.5 text-xs font-medium',
              m.active ? 'bg-status-green-bg text-status-green' : 'bg-surface-2 text-muted-foreground',
            )}
          >
            {m.active ? 'Activa' : 'Inactiva'}
          </span>
          <Button size="xs" variant="ghost" disabled={saving} onClick={() => void save({ active: !m.active })}>
            {m.active ? 'Desactivar' : 'Reactivar'}
          </Button>
        </div>
      </td>
    </tr>
  )
}

/** `YYYY-MM-DD` → `DD/MM/YYYY`, como texto (sin `Date`: no corre el día). */
function plainDay(day: string): string {
  const [y, mo, d] = day.split('-')
  return `${d}/${mo}/${y}`
}
