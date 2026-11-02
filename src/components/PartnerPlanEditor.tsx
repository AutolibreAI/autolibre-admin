import { useId, useMemo, useState } from 'react'
import { Pencil } from 'lucide-react'
import { MockBanner } from '~/components/MockBanner'
import { usePartnerPlans } from '~/components/usePartnerPlans'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { formatDateTime, formatInt } from '~/lib/format'
import {
  PARTNER_PLANS,
  PARTNER_PLAN_CAPS,
  PARTNER_PLAN_LABELS,
  baDay,
  isFounding,
  shortDay,
} from '~/lib/partner-plans'
import { cn } from '~/lib/utils'
import { savePartnerPlanMock } from '~/mocks/partner-plans'
import type { PartnerPlan } from '~/lib/partner-plans'
import type { PartnerPlanAssignment } from '~/mocks/partner-plans'

/**
 * El plan comercial de un proveedor, cargado a mano (decisión 5 del 02/11/26).
 * Lo usan la ficha (`PartnerPlanCard`) y las dos tablas de Partners ›
 * Propuestas (`compact`).
 *
 * Hoy guarda contra `~/mocks/partner-plans` (en memoria): no existe
 * `partners.plan` ni el endpoint de edición lo acepta. El actor sale de la
 * sesión del panel, nunca del formulario — mismo criterio que `p_actor_id` en
 * los SP de `ops`. Cambiar el plan siempre pasa por una confirmación.
 */

const NO_PLAN = ''

const planLabel = (plan: PartnerPlan | null) => (plan ? PARTNER_PLAN_LABELS[plan] : 'sin plan')

const capText = (plan: PartnerPlan) => {
  const cap = PARTNER_PLAN_CAPS[plan]
  return cap === null ? 'sin límite' : `${formatInt(cap)} por mes`
}

export function PartnerPlanEditor({
  partnerId,
  partnerName,
  tier,
  assignment,
  actorEmail,
  compact = false,
}: {
  partnerId: string
  partnerName: string
  tier: string | null
  /** `undefined` mientras carga. */
  assignment: PartnerPlanAssignment | undefined
  actorEmail: string
  /** En una celda de tabla: sin auditoría ni notas, sólo el plan y el lápiz. */
  compact?: boolean
}) {
  const ids = useId()
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm'>('view')
  const [plan, setPlan] = useState<string>(NO_PLAN)
  const [validFrom, setValidFrom] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const current = assignment?.plan ?? null
  const nextPlan = plan === NO_PLAN ? null : (plan as PartnerPlan)
  const nextFrom = nextPlan === null ? null : validFrom || null
  const unchanged = nextPlan === current && nextFrom === (assignment?.validFrom ?? null)
  const missingDate = nextPlan !== null && !nextFrom

  const open = () => {
    // Se siembra al abrir, nunca en el render: la fecha de hoy es del navegador.
    setPlan(current ?? NO_PLAN)
    setValidFrom(assignment?.validFrom ?? baDay(new Date()))
    setError(null)
    setMode('edit')
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await savePartnerPlanMock({ partnerId, plan: nextPlan, validFrom: nextFrom }, actorEmail)
      setMode('view')
    } catch {
      setError('No se pudo guardar el plan. No se cambió nada.')
      setMode('edit')
    } finally {
      setBusy(false)
    }
  }

  if (assignment === undefined) return <span className="text-xs text-muted-foreground">…</span>

  if (mode === 'view') {
    return (
      <div className={cn(compact ? 'flex items-center gap-1' : 'space-y-2')}>
        <div className={cn(compact ? 'text-sm' : 'space-y-0.5')}>
          <span className={cn(current === null && 'text-muted-foreground', !compact && 'text-sm font-medium')}>
            {planLabel(current)}
          </span>
          {!compact && current !== null ? (
            <p className="text-xs text-muted-foreground">
              Tope: {capText(current)}
              {assignment.validFrom ? ` · desde el ${shortDay(assignment.validFrom)}` : ''}
            </p>
          ) : null}
        </div>
        {!compact && isFounding(tier) ? (
          <p className="text-xs text-muted-foreground">
            Aliado · sin límite por ahora: el tope del plan se muestra sólo como referencia.
          </p>
        ) : null}
        {!compact ? <Audit assignment={assignment} /> : null}
        <Button
          type="button"
          size={compact ? 'icon' : 'sm'}
          variant={compact ? 'ghost' : 'outline'}
          className={cn(compact && 'size-6')}
          onClick={open}
          aria-label={`Cambiar el plan de ${partnerName}`}
          title="Cambiar plan"
        >
          <Pencil className="size-3.5" aria-hidden />
          {compact ? null : 'Cambiar plan'}
        </Button>
      </div>
    )
  }

  if (mode === 'confirm') {
    return (
      <div className="space-y-2 rounded-md border border-border bg-surface-2 p-2 text-xs">
        <p>
          ¿Cambiar el plan de <span className="font-medium">{partnerName}</span> de {planLabel(current)} a{' '}
          <span className="font-medium">{planLabel(nextPlan)}</span>
          {nextFrom ? ` desde el ${shortDay(nextFrom)}` : ''}?
        </p>
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={() => void save()} disabled={busy}>
            {busy ? 'Guardando…' : 'Sí, cambiar'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setMode('edit')} disabled={busy}>
            No
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form
      className="space-y-2 rounded-md border border-border p-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (!unchanged && !missingDate) setMode('confirm')
      }}
    >
      <div className="space-y-1">
        <label htmlFor={`${ids}-plan`} className="block text-xs text-muted-foreground">
          Plan
        </label>
        <select
          id={`${ids}-plan`}
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
          className="h-8 w-full rounded-md border border-border bg-card px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {PARTNER_PLANS.map((p) => (
            <option key={p} value={p}>
              {PARTNER_PLAN_LABELS[p]} — {capText(p)}
            </option>
          ))}
          <option value={NO_PLAN}>Sin plan</option>
        </select>
      </div>
      {nextPlan !== null ? (
        <div className="space-y-1">
          <label htmlFor={`${ids}-from`} className="block text-xs text-muted-foreground">
            Fecha de inicio
          </label>
          <input
            id={`${ids}-from`}
            type="date"
            value={validFrom}
            onChange={(e) => setValidFrom(e.target.value)}
            className="h-8 w-full rounded-md border border-border bg-card px-2 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {missingDate ? <p className="text-xs text-status-yellow">Falta la fecha de inicio.</p> : null}
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={unchanged || missingDate}>
          Guardar
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setMode('view')}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}

/** Quién lo cambió y cuándo. Sin cambios desde el panel, lo dice. */
function Audit({ assignment }: { assignment: PartnerPlanAssignment }) {
  return (
    <p className="text-xs text-muted-foreground">
      {assignment.changedBy && assignment.changedAt
        ? `Cambiado por ${assignment.changedBy} el ${formatDateTime(assignment.changedAt)} (UTC).`
        : 'Plan de partida del ejemplo: nadie lo cambió desde el panel.'}
    </p>
  )
}

/** La tarjeta de la ficha del proveedor. */
export function PartnerPlanCard({
  partnerId,
  partnerName,
  tier,
  actorEmail,
}: {
  partnerId: string
  partnerName: string
  tier: string
  actorEmail: string
}) {
  const { assignments } = usePartnerPlans(useMemo(() => [partnerId], [partnerId]))
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Plan</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <MockBanner
          title="Datos de ejemplo"
          items={[
            'Todavía no existe la columna de plan en la base: el plan de partida es inventado y un cambio vive sólo en esta sesión (se pierde al recargar).',
          ]}
        />
        <PartnerPlanEditor
          partnerId={partnerId}
          partnerName={partnerName}
          tier={tier}
          assignment={assignments.get(partnerId)}
          actorEmail={actorEmail}
        />
      </CardContent>
    </Card>
  )
}
