import { useRef, useState } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import {
  RULE_OFFSET_MAX,
  createNotificationRuleSchema,
  describeOffset,
  groupNotificationRules,
  isManageableRuleSource,
  parseNotificationRuleError,
  readableNotificationRuleError,
  ruleSourceLabel,
  unitsForSource,
  type ManageableRuleSource,
  type NotificationRule,
  type NotificationRuleGroup,
  type RuleOffsetUnit,
} from '~/lib/notification-rules'
import { createNotificationRuleFn, setNotificationRuleActiveFn } from '~/fn/notification-rules'
import { formatDateTime, formatInt } from '~/lib/format'

/**
 * "Recordatorios de vencimiento": las reglas de `public.notification_rules`,
 * una tarjeta por documento. Lee por SQL; agregar, pausar y reactivar van por
 * HTTP al backend (`~/lib/notification-rules`).
 *
 * Lo que la pantalla tiene que dejar claro, y por eso está escrito en ella:
 *   - estos avisos los arma y los manda el BACKEND, cada hora — un cambio rige
 *     desde la próxima corrida, no al instante;
 *   - el texto no se edita desde acá (vive en el código del backend);
 *   - "editar" un aviso es pausar el viejo y agregar otro: el historial queda
 *     colgado de la regla que lo generó.
 *
 * Después de cada escritura NO se asume nada: `router.invalidate()` relee de la
 * base (mismo criterio que `PartnerMembersCard`).
 *
 * Una regla con 0 avisos se muestra en 0, en texto apagado, no se esconde:
 * "VTV · 1 día antes: 0" es un dato (mismo criterio que el censo de
 * `/usuarios/:id`).
 */
export function NotificationRuleCards({ rules }: { rules: Array<NotificationRule> }) {
  if (rules.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card px-6 py-10 text-center">
        <p className="text-sm font-medium">No hay reglas de vencimiento en esta base</p>
        <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono text-xs">notification_rules</code> está vacía. Las carga el
          backend con su seed.
        </p>
      </div>
    )
  }

  const groups = groupNotificationRules(rules)

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {groups.map((g) => (
        <RuleGroupCard key={g.sourceType} group={g} />
      ))}
    </div>
  )
}

function RuleGroupCard({ group: g }: { group: NotificationRuleGroup }) {
  // Canal y dirección no son columnas: hoy todo es `push` · `antes`. Sólo se
  // dicen si alguna fila se sale de eso — mismo criterio que el grupo de canal
  // del Historial, que se esconde mientras haya un solo canal.
  const showChannel = g.rules.some((r) => r.channel !== 'push')
  const router = useRouter()
  const inFlight = useRef(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // El aviso y el error viven en la TARJETA, no en la fila: `router.invalidate()`
  // relee y la fila puede cambiar, pero la tarjeta (key = sourceType) queda.
  const setActive = async (ruleId: string, active: boolean) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusyId(ruleId)
    setError(null)
    setNotice(null)
    try {
      await setNotificationRuleActiveFn({ data: { ruleId, active } })
      await router.invalidate()
      setNotice(
        active
          ? 'Reactivado. Vuelve a sonar desde la próxima corrida del backend (cada hora).'
          : 'Pausado. Deja de sonar desde la próxima corrida del backend (cada hora).',
      )
    } catch (cause) {
      setError(readableNotificationRuleError(cause))
    } finally {
      inFlight.current = false
      setBusyId(null)
    }
  }

  const manageable = isManageableRuleSource(g.sourceType)

  return (
    <section className="flex flex-col rounded-lg border border-border bg-card">
      <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
        <h3 className="font-heading text-base font-semibold">{ruleSourceLabel(g.sourceType)}</h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatInt(g.notificationCount)} aviso{g.notificationCount === 1 ? '' : 's'} generado
          {g.notificationCount === 1 ? '' : 's'}
        </span>
      </header>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="px-4 pb-1 pt-2 font-normal">Cuándo</th>
            <th className="px-2 pb-1 pt-2 font-normal">Estado</th>
            <th className="px-2 pb-1 pt-2 text-right font-normal">Avisos</th>
            <th className="px-4 pb-1 pt-2 text-right font-normal">Último</th>
          </tr>
        </thead>
        <tbody>
          {g.rules.map((r) => (
            <RuleRow
              key={r.id}
              rule={r}
              showChannel={showChannel}
              busy={busyId === r.id}
              onToggle={isManageableRuleSource(r.sourceType) ? () => void setActive(r.id, !r.active) : null}
            />
          ))}
        </tbody>
      </table>

      {notice ? (
        <p className="border-t border-border px-4 py-2 text-xs text-status-green" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="border-t border-border px-4 py-2 text-xs text-status-red" role="alert">
          {error}
        </p>
      ) : null}

      {manageable ? (
        <AddRuleForm
          sourceType={g.sourceType as ManageableRuleSource}
          onReactivate={(id) => setActive(id, true)}
          onCreated={() => setNotice('Agregado. Empieza a sonar desde la próxima corrida del backend (cada hora).')}
        />
      ) : (
        <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          Este tipo de aviso ya no lo conoce el backend: no se puede pausar ni agregar desde acá.
        </p>
      )}

      <div className="mt-auto border-t border-border px-4 py-3">
        {g.sample ? (
          <>
            <p className="text-xs text-muted-foreground">
              Así se ve el último que salió ({formatDateTime(g.sample.at)}):
            </p>
            <div className="mt-1.5 rounded-md border border-border bg-surface-2 px-3 py-2">
              <p className="text-sm font-medium">{g.sample.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{g.sample.body}</p>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Todavía no sonó ninguno de estos avisos.</p>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">
          El texto lo arma el backend — desde el panel no se edita. Para cambiar cuándo suena, pausá
          el aviso y agregá otro.
        </p>
      </div>
    </section>
  )
}

function RuleRow({
  rule: r,
  showChannel,
  busy,
  onToggle,
}: {
  rule: NotificationRule
  showChannel: boolean
  busy: boolean
  /** `null` = el backend no deja pausar este tipo (las filas viejas de cédula). */
  onToggle: (() => void) | null
}) {
  return (
    <tr className="border-t border-border/60">
      <td className="px-4 py-1.5">
        {describeOffset(r)}
        {showChannel ? <span className="ml-1.5 text-xs text-muted-foreground">· {r.channel}</span> : null}
      </td>
      <td className="px-2 py-1.5">
        {r.active ? (
          <Badge
            variant="outline"
            className="border-status-green/20 bg-status-green-bg font-normal text-status-green"
          >
            Activa
          </Badge>
        ) : (
          <Badge variant="outline" className="font-normal text-muted-foreground">
            Pausada
          </Badge>
        )}
        {onToggle ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-1 text-muted-foreground"
            disabled={busy}
            onClick={onToggle}
          >
            {busy ? '…' : r.active ? 'Pausar' : 'Reactivar'}
          </Button>
        ) : null}
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums">
        {r.notificationCount === 0 ? (
          <span className="text-muted-foreground">0</span>
        ) : (
          // Objeto literal, no spread: un `{...prev}` cross-route arrastra el
          // tipo ancho de `FullSearchSchema` (`partners-coverage.md`).
          <Link
            to="/notificaciones"
            search={{ notificationRuleId: r.id }}
            className="rounded underline decoration-dotted outline-none hover:text-brand focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            title="Ver estos avisos en el Historial"
          >
            {formatInt(r.notificationCount)}
          </Link>
        )}
      </td>
      <td className="px-4 py-1.5 text-right text-xs tabular-nums text-muted-foreground">
        {r.lastNotificationAt ? formatDateTime(r.lastNotificationAt) : '—'}
      </td>
    </tr>
  )
}

/**
 * «Agregar aviso» de una tarjeta: el documento es el de la tarjeta; se elige
 * cuánto antes (y, sólo para mantenimiento, días o km). Siempre push y "antes":
 * el backend los fija. Con un 409 de una regla PAUSADA se ofrece reactivarla en
 * vez de mostrar un error — es la misma regla, y el backend no deja otra igual.
 */
function AddRuleForm({
  sourceType,
  onReactivate,
  onCreated,
}: {
  sourceType: ManageableRuleSource
  onReactivate: (ruleId: string) => Promise<void>
  onCreated: () => void
}) {
  const router = useRouter()
  const units = unitsForSource(sourceType)
  const inFlight = useRef(false)
  const [open, setOpen] = useState(false)
  const [unit, setUnit] = useState<RuleOffsetUnit>('days')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pausedExisting, setPausedExisting] = useState<string | null>(null)

  const reset = () => {
    setOpen(false)
    setValue('')
    setUnit('days')
    setError(null)
    setPausedExisting(null)
  }

  const submit = async () => {
    if (inFlight.current) return
    setError(null)
    setPausedExisting(null)
    const parsed = createNotificationRuleSchema.safeParse({
      sourceType,
      offsetUnit: unit,
      offsetValue: value.trim() === '' ? Number.NaN : Number(value),
    })
    if (!parsed.success) {
      setError(`Poné un número entero entre 0 y ${formatInt(RULE_OFFSET_MAX)}.`)
      return
    }
    inFlight.current = true
    setBusy(true)
    try {
      await createNotificationRuleFn({ data: parsed.data })
      await router.invalidate()
      reset()
      onCreated()
    } catch (cause) {
      const e = parseNotificationRuleError(cause)
      if (e?.status === 409 && e.existingRuleActive === false && e.existingRuleId) {
        setPausedExisting(e.existingRuleId)
      } else {
        setError(readableNotificationRuleError(cause))
      }
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div className="border-t border-border px-4 py-2">
        <Button type="button" variant="outline" size="xs" onClick={() => setOpen(true)}>
          Agregar aviso
        </Button>
      </div>
    )
  }

  return (
    <form
      className="flex flex-col gap-2 border-t border-border px-4 py-3"
      onSubmit={(ev) => {
        ev.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Avisar</span>
        <Input
          type="number"
          inputMode="numeric"
          min={0}
          max={RULE_OFFSET_MAX}
          step={1}
          value={value}
          onChange={(ev) => setValue(ev.target.value)}
          className="h-8 w-24"
          aria-label="Cuánto antes"
          autoFocus
        />
        {units.length > 1 ? (
          <select
            value={unit}
            onChange={(ev) => setUnit(ev.target.value as RuleOffsetUnit)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            aria-label="Unidad"
          >
            <option value="days">días</option>
            <option value="km">km</option>
          </select>
        ) : (
          <span>días</span>
        )}
        <span className="text-muted-foreground">antes de que venza · por push</span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        0 días = el día que vence. Empieza a sonar desde la próxima corrida del backend (cada hora).
      </p>
      {error ? (
        <p className="text-xs text-status-red" role="alert">
          {error}
        </p>
      ) : null}
      {pausedExisting ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-status-yellow" role="status">
          Ese aviso ya existe y está pausado.
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => {
              const id = pausedExisting
              reset()
              void onReactivate(id)
            }}
          >
            Reactivarlo
          </Button>
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="xs" disabled={busy}>
          {busy ? 'Agregando…' : 'Agregar'}
        </Button>
        <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={reset}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}
