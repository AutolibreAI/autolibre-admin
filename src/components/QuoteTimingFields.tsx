import {
  QUOTE_REQUEST_ORIGINS,
  QUOTE_REQUEST_PARTS_SUPPLIES,
  QUOTE_REQUEST_TIMINGS,
  quoteOriginLabel,
  quotePartsSupplyLabel,
  quoteTimingLabel,
  type QuoteRequestOrigin,
  type QuoteRequestPartsSupply,
  type QuoteRequestTiming,
} from '~/lib/quote-requests'
import { Input } from '~/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'

/**
 * «Para cuándo» (con la fecha si elige una), «Repuestos» y «Origen», los
 * campos que la 036 suma al alta a mano y a «Editar datos». Un solo componente
 * para los dos formularios: si se leyeran distinto en uno y otro, uno estaría mal.
 *
 * `''` = "no lo dijo" (viaja como `null`). El SP vuelve a validar la fecha.
 */
export interface QuoteTimingState {
  timing: QuoteRequestTiming | ''
  preferredDate: string
  partsSupply: QuoteRequestPartsSupply | ''
}

export const EMPTY_TIMING: QuoteTimingState = { timing: '', preferredDate: '', partsSupply: '' }

const NONE = '__none__'

/** Lo que viaja al server function. La fecha sólo con «Tiene una fecha». */
export function timingPayload(s: QuoteTimingState): {
  timing: QuoteRequestTiming | null
  preferredDate: string | null
  partsSupply: QuoteRequestPartsSupply | null
} {
  return {
    timing: s.timing === '' ? null : s.timing,
    preferredDate: s.timing === 'date' && s.preferredDate !== '' ? s.preferredDate : null,
    partsSupply: s.partsSupply === '' ? null : s.partsSupply,
  }
}

/** Falta la fecha con «Tiene una fecha». */
export const timingIncomplete = (s: QuoteTimingState) => s.timing === 'date' && s.preferredDate === ''

const labelClass = 'block text-xs font-medium uppercase tracking-wider text-muted-foreground'
const optional = <span className="normal-case tracking-normal text-muted-foreground/70">(opcional)</span>

export function QuoteTimingFields({
  idPrefix,
  value,
  onChange,
  disabled,
}: {
  idPrefix: string
  value: QuoteTimingState
  onChange: (next: QuoteTimingState) => void
  disabled?: boolean
}) {
  return (
    <section className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label htmlFor={`${idPrefix}-timing`} className={labelClass}>
            Para cuándo {optional}
          </label>
          <Select
            value={value.timing === '' ? NONE : value.timing}
            disabled={disabled}
            onValueChange={(v) =>
              onChange({
                ...value,
                timing: v === NONE ? '' : (v as QuoteRequestTiming),
                preferredDate: v === 'date' ? value.preferredDate : '',
              })
            }
          >
            <SelectTrigger id={`${idPrefix}-timing`} className="w-full shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No lo dijo</SelectItem>
              {QUOTE_REQUEST_TIMINGS.map((t) => (
                <SelectItem key={t} value={t}>
                  {quoteTimingLabel(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${idPrefix}-parts`} className={labelClass}>
            Repuestos {optional}
          </label>
          <Select
            value={value.partsSupply === '' ? NONE : value.partsSupply}
            disabled={disabled}
            onValueChange={(v) => onChange({ ...value, partsSupply: v === NONE ? '' : (v as QuoteRequestPartsSupply) })}
          >
            <SelectTrigger id={`${idPrefix}-parts`} className="w-full shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No lo dijo</SelectItem>
              {QUOTE_REQUEST_PARTS_SUPPLIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {quotePartsSupplyLabel(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {value.timing === 'date' ? (
        <div className="space-y-1.5">
          <label htmlFor={`${idPrefix}-date`} className={labelClass}>
            Fecha
          </label>
          <Input
            id={`${idPrefix}-date`}
            type="date"
            value={value.preferredDate}
            disabled={disabled}
            aria-invalid={value.preferredDate === ''}
            onChange={(e) => onChange({ ...value, preferredDate: e.currentTarget.value })}
            className="w-44 shadow-none"
          />
          {value.preferredDate === '' ? <p className="text-xs text-destructive">Falta la fecha.</p> : null}
        </div>
      ) : null}
    </section>
  )
}

export function QuoteOriginField({
  id,
  value,
  onChange,
  disabled,
  required,
}: {
  id: string
  value: QuoteRequestOrigin | ''
  onChange: (next: QuoteRequestOrigin | '') => void
  disabled?: boolean
  /** En el alta a mano es obligatorio; en la edición se puede dejar vacío. */
  required?: boolean
}) {
  return (
    <section className="space-y-1.5">
      <label htmlFor={id} className={labelClass}>
        Origen {required ? null : optional}
      </label>
      <Select
        // Obligatorio y vacío: `''` muestra el placeholder (no hay ítem «Sin dato»).
        value={value === '' ? (required ? '' : NONE) : value}
        disabled={disabled}
        onValueChange={(v) => onChange(v === NONE ? '' : (v as QuoteRequestOrigin))}
      >
        <SelectTrigger id={id} className="w-full shadow-none" aria-required={required} aria-invalid={required && value === ''}>
          <SelectValue placeholder="¿De dónde vino el pedido?" />
        </SelectTrigger>
        <SelectContent>
          {required ? null : <SelectItem value={NONE}>Sin dato</SelectItem>}
          {QUOTE_REQUEST_ORIGINS.map((o) => (
            <SelectItem key={o} value={o}>
              {quoteOriginLabel(o)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </section>
  )
}
