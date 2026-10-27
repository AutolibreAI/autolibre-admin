import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Plus, X } from 'lucide-react'
import { normalizeForMatch } from '~/lib/catalog'
import { MAX_QUOTE_ITEMS, formatAmount, quoteItemsTotals } from '~/lib/quote-responses'
import { parseAmount, type ItemDraft } from '~/lib/amounts'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { cn } from '~/lib/utils'
import type { PartnerOption } from '~/lib/partners'

/**
 * Las piezas del formulario de contenido de un presupuesto que comparten
 * `QuoteResponses` (lo que contestó cada taller, en `ops`) y «Propuestas en la
 * app» (lo que se le publica a la persona, por HTTP al backend): el buscador de
 * taller y el desglose por ítems.
 *
 * Salieron de `QuoteResponses.tsx` tal cual, sin cambiar comportamiento. Son
 * UNA sola implementación a propósito: si el combobox o el total de los ítems
 * se vieran distinto en las dos tarjetas de la misma ficha, una estaría mal.
 */

// ── El buscador de taller ───────────────────────────────────────────────────

/** Cuántas opciones se ven sin scrollear. El resto sigue ahí, con scroll. */
const VISIBLE_OPTIONS = 8

/**
 * Un solo campo para las dos clases de taller que admite la tabla.
 *
 * El `<Select>` que había acá era una lista de 50 partners activos en orden
 * fijo, más una opción "otro taller" que recién entonces mostraba un input
 * aparte: dos controles para una decisión, y 50 renglones para scrollear. Acá
 * se tipea el nombre y la lista se filtra.
 *
 * ── El filtrado es en el CLIENTE, no una búsqueda al servidor ──────────────
 *
 * Al 2026-09-22 hay 50 partners activos y ya vienen enteros en el loader de la
 * ficha (`listPartnerOptions`). Filtrar sobre un array de 50 es instantáneo y
 * no tiene estados de carga, de error ni de carrera — a diferencia del picker
 * de destinatarios de `BroadcastComposer`, que SÍ va al servidor con debounce
 * porque su universo son miles de usuarios y no se pueden traer todos. El día
 * que el directorio tenga cientos, esto pasa a ser un `searchPartnersFn` con
 * la misma forma que aquél.
 *
 * `normalizeForMatch` (de `~/lib/catalog`) saca acentos y puntuación, así que
 * "perez" encuentra "Pérez" y "cars service" encuentra "H&G Cars Service". Es
 * el mismo normalizador que usa el matcheo de rubros declarados en la
 * aprobación de partners.
 *
 * ── Tipear NO vincula: vincular es elegir de la lista ──────────────────────
 *
 * Escribir "Autech" deja un taller de AFUERA llamado "Autech", aunque Autech
 * esté en el directorio — `partner_id` sólo se setea eligiendo una opción. Eso
 * puede sorprender, así que el campo dice en qué modo está en todo momento, y
 * si el texto tipeado coincide con un partner real lo avisa y ofrece
 * vincularlo. La alternativa —adivinar el id por nombre— es exactamente lo que
 * `partner-approval.md` ya desaconseja con `nameCollisions`: dos partners se
 * pueden llamar igual.
 */
export function PartnerCombobox({
  inputId,
  partners,
  partnerId,
  providerName,
  selectedLabelFallback,
  onChange,
}: {
  inputId: string
  partners: Array<PartnerOption>
  /** `null` = taller de afuera; el nombre vive en `providerName`. */
  partnerId: string | null
  providerName: string
  /** El nombre del partner cuando NO está en las opciones (p. ej. se pausó). */
  selectedLabelFallback: string | null
  onChange: (next: { partnerId: string | null; providerName: string }) => void
}) {
  const listId = `${inputId}-list`
  const boxRef = useRef<HTMLDivElement>(null)
  const selected = partnerId === null ? null : (partners.find((p) => p.id === partnerId) ?? null)
  const selectedLabel =
    partnerId === null ? null : (selected?.name ?? selectedLabelFallback ?? 'taller del directorio')

  const [query, setQuery] = useState(() => selectedLabel ?? providerName)
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)

  const matches = useMemo(() => {
    const needle = normalizeForMatch(query)
    if (needle === '') return partners
    return partners.filter((p) => normalizeForMatch(`${p.name} ${p.coverageZone}`).includes(needle))
  }, [partners, query])

  // Cerrar al clickear afuera. Sin esto la lista queda abierta tapando el
  // resto del formulario, que en una tarjeta angosta es peor que inútil.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function pickPartner(p: PartnerOption) {
    setQuery(p.name)
    setOpen(false)
    onChange({ partnerId: p.id, providerName: '' })
  }

  const trimmed = query.trim()
  // El partner que se llama EXACTAMENTE como lo tipeado, si hay uno y todavía
  // no se vinculó. Comparación normalizada: "autech" y "Autech" son el mismo.
  const exact =
    partnerId === null && trimmed !== ''
      ? (partners.find((p) => normalizeForMatch(p.name) === normalizeForMatch(trimmed)) ?? null)
      : null

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <Input
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[highlight] ? `${listId}-${highlight}` : undefined}
          autoComplete="off"
          maxLength={200}
          value={query}
          placeholder="Buscar en el directorio, o escribir el nombre"
          onChange={(e) => {
            const v = e.currentTarget.value
            setQuery(v)
            setHighlight(0)
            setOpen(true)
            // Tipear DESVINCULA: el id que había dejaría de corresponderse con
            // lo que se lee en pantalla, y ese desacuerdo es invisible.
            onChange({ partnerId: null, providerName: v })
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              if (!open) {
                setOpen(true)
                return
              }
              if (matches.length === 0) return
              const delta = e.key === 'ArrowDown' ? 1 : -1
              setHighlight((h) => (h + delta + matches.length) % matches.length)
              return
            }
            if (e.key === 'Enter') {
              // Sólo intercepta con la lista abierta y algo resaltado: si no,
              // deja que el Enter mande el formulario, como en cualquier input.
              const candidate = open ? matches[highlight] : undefined
              if (candidate) {
                e.preventDefault()
                pickPartner(candidate)
              }
              return
            }
            if (e.key === 'Escape' && open) {
              e.preventDefault()
              setOpen(false)
            }
          }}
          className="pr-8 text-xs"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={() => setOpen((o) => !o)}
          className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground"
        >
          <ChevronDown className="size-3.5" />
        </button>
      </div>

      {open ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 w-full overflow-y-auto rounded-md border border-border bg-card py-1"
          style={{ maxHeight: `${VISIBLE_OPTIONS * 2.25}rem` }}
        >
          {matches.length === 0 ? (
            <li className="px-3 py-1.5 text-xs text-muted-foreground">
              Ningún taller del directorio coincide con «{trimmed}». Se guarda como taller de afuera.
            </li>
          ) : (
            matches.map((p, i) => (
              <li key={p.id} id={`${listId}-${i}`} role="option" aria-selected={i === highlight}>
                <button
                  type="button"
                  // `onMouseDown` y no `onClick`: el blur del input llega
                  // primero y cerraría la lista antes de que el click resuelva.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickPartner(p)
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(
                    'flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-xs',
                    i === highlight ? 'bg-secondary' : undefined,
                  )}
                >
                  <span className="truncate">{p.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {p.tier === 'founding' ? 'Aliado · ' : ''}
                    {p.coverageZone || 'sin zona'}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}

      {partnerId !== null ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="border-brand/30 bg-brand-soft text-brand">
            del directorio
          </Badge>
          <button
            type="button"
            onClick={() => {
              const text = selectedLabel ?? ''
              setQuery(text)
              setOpen(false)
              onChange({ partnerId: null, providerName: text })
            }}
            className="rounded text-xs text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            desvincular
          </button>
        </div>
      ) : (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="border-border text-muted-foreground">
            taller de afuera
          </Badge>
          {exact ? (
            <button
              type="button"
              onClick={() => pickPartner(exact)}
              className="rounded text-xs text-status-yellow underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              «{exact.name}» está en el directorio — vincularlo
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}

// ── Piezas ──────────────────────────────────────────────────────────────────

export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
}

// ── El desglose por ítems (022) ─────────────────────────────────────────────

/**
 * Filas de ítem con su precio; los opcionales van aparte y no suman al total.
 * El total que se ve es una VISTA PREVIA: el que se guarda lo calcula el SP con
 * la misma regla (`ops._quote_response_items_total`), así que no pueden
 * contradecirse.
 */
export function ItemsEditor({
  items,
  currency,
  totals,
  onChange,
  onAdd,
  onRemove,
}: {
  items: Array<ItemDraft>
  currency: string
  totals: { base: number | null; optional: number; withOptional: number }
  onChange: (key: string, patch: Partial<Omit<ItemDraft, 'key'>>) => void
  onAdd: (optional: boolean) => void
  onRemove: (key: string) => void
}) {
  const required = items.filter((it) => !it.optional)
  const optional = items.filter((it) => it.optional)
  const full = items.length >= MAX_QUOTE_ITEMS

  const renderRow = (it: ItemDraft) => {
    const badAmount = it.amount.trim() !== '' && parseAmount(it.amount.trim()) === null
    return (
      <li key={it.key} className="flex flex-wrap items-center gap-2">
        <Input
          value={it.label}
          onChange={(e) => {
            const v = e.currentTarget.value
            onChange(it.key, { label: v })
          }}
          maxLength={200}
          autoComplete="off"
          placeholder={it.optional ? 'Rectificar discos' : 'Cambio de pastillas'}
          aria-label="Qué es"
          className="h-8 min-w-0 flex-1 text-xs"
        />
        <Input
          value={it.amount}
          onChange={(e) => {
            const v = e.currentTarget.value
            onChange(it.key, { amount: v })
          }}
          inputMode="decimal"
          autoComplete="off"
          placeholder="60.000"
          aria-label="Precio"
          aria-invalid={badAmount}
          className="h-8 w-28 text-right text-xs tabular-nums"
        />
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={it.optional}
            onChange={(e) => {
              const v = e.currentTarget.checked
              onChange(it.key, { optional: v })
            }}
          />
          opcional
        </label>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onRemove(it.key)}
          aria-label="Sacar el ítem"
          className="size-7 p-0"
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      </li>
    )
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">Detalle por ítems (opcional)</span>
        <div className="flex gap-1.5">
          <Button type="button" size="sm" variant="outline" disabled={full} onClick={() => onAdd(false)} className="h-7 gap-1">
            <Plus className="size-3.5" aria-hidden />
            Ítem
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={full} onClick={() => onAdd(true)} className="h-7 gap-1">
            <Plus className="size-3.5" aria-hidden />
            Opcional
          </Button>
        </div>
      </div>

      {items.length === 0 ? (
        <Hint>
          Si el taller pasó el precio desglosado, cargalo por ítems y el total se suma solo. Los opcionales se muestran
          aparte, con su precio, y no suman al total.
        </Hint>
      ) : (
        <>
          {required.length > 0 ? <ul className="space-y-1.5">{required.map(renderRow)}</ul> : null}
          {optional.length > 0 ? (
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Opcionales</span>
              <ul className="space-y-1.5">{optional.map(renderRow)}</ul>
            </div>
          ) : null}

          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 border-t border-border pt-2 text-xs">
            <dt className="text-muted-foreground">Total</dt>
            <dd className="text-right font-semibold tabular-nums">
              {totals.base === null ? '—' : totals.base === 0 ? 'Sin cargo' : formatAmount(totals.base, currency)}
            </dd>
            {totals.optional > 0 || optional.length > 0 ? (
              <>
                <dt className="text-muted-foreground">Opcionales</dt>
                <dd className="text-right tabular-nums">+ {formatAmount(totals.optional, currency)}</dd>
                <dt className="text-muted-foreground">Con todos los opcionales</dt>
                <dd className="text-right tabular-nums">{formatAmount(totals.withOptional, currency)}</dd>
              </>
            ) : null}
          </dl>
        </>
      )}
    </div>
  )
}

/** El desglose de un presupuesto ya cargado, en la fila de la lista. */
export function ItemsSummary({ items, currency }: { items: Array<{ label: string; amount: number; optional: boolean }>; currency: string }) {
  const required = items.filter((it) => !it.optional)
  const optional = items.filter((it) => it.optional)
  const totals = quoteItemsTotals(items)
  const money = (n: number) => (n === 0 ? 'sin cargo' : formatAmount(n, currency))

  return (
    <div className="mt-1.5 rounded border border-border px-2 py-1.5 text-xs">
      {required.length > 0 ? (
        <ul className="space-y-0.5">
          {required.map((it, i) => (
            <li key={`r-${i}`} className="flex justify-between gap-3">
              <span className="min-w-0 truncate">{it.label}</span>
              <span className="shrink-0 tabular-nums">{money(it.amount)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {optional.length > 0 ? (
        <div className={cn(required.length > 0 && 'mt-1 border-t border-border pt-1')}>
          <span className="text-muted-foreground">Opcionales</span>
          <ul className="space-y-0.5">
            {optional.map((it, i) => (
              <li key={`o-${i}`} className="flex justify-between gap-3 text-muted-foreground">
                <span className="min-w-0 truncate">+ {it.label}</span>
                <span className="shrink-0 tabular-nums">{money(it.amount)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-0.5 flex justify-between gap-3 text-muted-foreground">
            <span>Con todos los opcionales</span>
            <span className="tabular-nums">{formatAmount(totals.withOptional, currency)}</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
