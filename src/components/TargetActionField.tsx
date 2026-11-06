import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { EFFECT_ACTIONS, EFFECT_ACTION_LABELS } from '~/lib/notification-effect'
import type { EffectAction } from '~/lib/notification-effect'

const NONE = 'none'

/**
 * El «Objetivo» de un envío o una regla: la acción que se busca que la persona
 * haga. Las opciones son EXACTAMENTE las que mide la pantalla de efecto
 * (`EFFECT_ACTIONS`): un objetivo que no se puede medir no tiene a dónde ir.
 *
 * Hoy se guarda en memoria (`~/mocks/notification-targets`) y lo dice: no hay
 * columna en el backend todavía.
 */
export function TargetActionField({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string
  value: EffectAction | null
  onChange: (next: EffectAction | null) => void
  disabled?: boolean
}) {
  return (
    <section className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Objetivo <span className="normal-case tracking-normal text-muted-foreground/70">(opcional)</span>
      </label>
      <Select
        value={value ?? NONE}
        onValueChange={(v) => onChange(v === NONE ? null : (v as EffectAction))}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="h-8 w-56 shadow-none" aria-label="Objetivo">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Sin objetivo</SelectItem>
          {EFFECT_ACTIONS.map((a) => (
            <SelectItem key={a} value={a}>
              {EFFECT_ACTION_LABELS[a]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs italic leading-relaxed text-muted-foreground">
        Qué querés que haga la persona. Se mide en «Efecto por envío». Dato de ejemplo: se guarda sólo en esta
        sesión hasta que el backend tenga dónde.
      </p>
    </section>
  )
}
