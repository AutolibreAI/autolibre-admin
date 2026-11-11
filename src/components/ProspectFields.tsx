import { useEffect, useState } from 'react'
import { BadgeCheck } from 'lucide-react'
import {
  PROSPECT_FRONTS,
  PROSPECT_FRONT_LABELS,
  PROSPECT_STATUS_CLASSES,
  PROSPECT_STATUS_LABELS,
  parseQuoteCode,
  readableProspectError,
} from '~/lib/partner-prospects'
import { findQuoteByCodeFn } from '~/fn/partner-prospects'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { cn } from '~/lib/utils'
import type { ProspectFront, ProspectStatus } from '~/lib/partner-prospects'

/**
 * Controles chicos del seguimiento comercial, pensados para el celular:
 * botones de un toque en vez de selects, con área táctil de 40 px.
 * → `.claude/rules/partner-prospects.md`
 */

export const FIELD_LABEL = 'block text-xs font-medium uppercase tracking-wider text-muted-foreground'

/** Una opción entre pocas, a un toque. `value = null` = nada elegido. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  allowClear = false,
  columns,
  optionClass,
}: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T | null
  onChange: (next: T | null) => void
  ariaLabel: string
  /** Tocar la elegida la deselecciona (para los opcionales). */
  allowClear?: boolean
  /** Columnas fijas en vez de fila que se acomoda (`grid-cols-2`, …). */
  columns?: string
  /** Clases de la opción ELEGIDA, por valor (los estados tienen su color). */
  optionClass?: (value: T) => string
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn(columns ? `grid gap-1.5 ${columns}` : 'flex flex-wrap gap-1.5')}>
      {options.map((o) => {
        const active = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(active && allowClear ? null : o.value)}
            className={cn(
              'inline-flex min-h-10 items-center justify-center rounded-md border px-3 text-sm transition-colors',
              'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              active
                ? (optionClass?.(o.value) ?? 'border-action bg-action text-primary-foreground')
                : 'border-border bg-card text-foreground hover:border-foreground/30',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Sí / No, con "no se sabe" = nada elegido (se vuelve a tocar para limpiar). */
export function YesNo({
  value,
  onChange,
  ariaLabel,
}: {
  value: boolean | null
  onChange: (next: boolean | null) => void
  ariaLabel: string
}) {
  return (
    <Segmented
      ariaLabel={ariaLabel}
      allowClear
      options={[
        { value: 'yes', label: 'Sí' },
        { value: 'no', label: 'No' },
      ]}
      value={value === null ? null : value ? 'yes' : 'no'}
      onChange={(v) => onChange(v === null ? null : v === 'yes')}
    />
  )
}

/** Un check que se toca entero (no una casilla de 16 px). */
export function ToggleCheck({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex min-h-10 w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        checked ? 'border-status-green/40 bg-status-green-bg text-status-green' : 'border-border bg-card text-foreground',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-sm border text-[10px] leading-none',
          checked ? 'border-status-green bg-status-green text-primary-foreground' : 'border-foreground/30',
        )}
      >
        {checked ? '✓' : ''}
      </span>
      {children}
    </button>
  )
}

export function ProspectStatusBadge({ status }: { status: ProspectStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium',
        PROSPECT_STATUS_CLASSES[status],
      )}
    >
      {PROSPECT_STATUS_LABELS[status]}
    </span>
  )
}

export function VerifiedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-status-green/30 bg-status-green-bg px-2 py-0.5 text-xs font-medium text-status-green">
      <BadgeCheck className="size-3.5" aria-hidden /> Verificado
    </span>
  )
}

export function FrontBadge({ front, quoteCode }: { front: ProspectFront; quoteCode: string | null }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium text-foreground">
      {PROSPECT_FRONT_LABELS[front]}
      {front === 'por-pedido' && quoteCode ? ` · ${quoteCode}` : ''}
    </span>
  )
}

/**
 * El frente: Ruta 2 · Corredor Norte · Por pedido (con el N° de pedido). Con
 * "Por pedido", el número se busca por su `AL-n` y viaja el uuid: nunca un
 * id tipeado.
 */
export function FrontPicker({
  value,
  quoteCode,
  onChange,
}: {
  value: ProspectFront | null
  quoteCode: string | null
  onChange: (front: ProspectFront | null, quote: { id: string; code: string } | null) => void
}) {
  const [code, setCode] = useState(quoteCode ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setCode(quoteCode ?? ''), [quoteCode])

  async function lookup() {
    if (busy) return
    if (parseQuoteCode(code) === null) {
      setError('Escribí el número del pedido, por ejemplo AL-1234.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const found = await findQuoteByCodeFn({ data: { code } })
      if (!found) setError('No encontré ese pedido.')
      else onChange('por-pedido', found)
    } catch (cause) {
      setError(readableProspectError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <Segmented
        ariaLabel="Frente"
        allowClear
        options={PROSPECT_FRONTS.map((f) => ({ value: f, label: PROSPECT_FRONT_LABELS[f] }))}
        value={value}
        onChange={(f) => onChange(f, null)}
      />
      {value === 'por-pedido' ? (
        <div className="space-y-1">
          <div className="flex gap-2">
            <Input
              aria-label="Número de pedido"
              placeholder="AL-1234"
              inputMode="text"
              className="h-10 shadow-none"
              value={code}
              maxLength={20}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void lookup()
                }
              }}
            />
            <Button type="button" variant="outline" className="h-10 shadow-none" disabled={busy} onClick={() => void lookup()}>
              {busy ? 'Buscando…' : quoteCode && code === quoteCode ? 'Guardado' : 'Usar'}
            </Button>
          </div>
          {error ? <p className="text-xs text-status-red">{error}</p> : null}
          {!quoteCode && !error ? <p className="text-xs text-muted-foreground">Sin número de pedido todavía.</p> : null}
        </div>
      ) : null}
    </div>
  )
}

// ── Fechas en Buenos Aires, para los atajos ───────────────────────────────

/**
 * Hoy en Buenos Aires + `days`, como `YYYY-MM-DD`. Sólo en handlers y en
 * componentes que nacen de un click (el formulario de charla): en el render
 * de SSR daría un mismatch de hidratación.
 */
export function baDayPlus(days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  const d = new Date(`${today}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
