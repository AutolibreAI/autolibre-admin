import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Check, ChevronDown, Link2, LoaderCircle, MessageCircle, Search, TriangleAlert, Unlink } from 'lucide-react'
import {
  PROSPECT_PLANS,
  PROSPECT_PLAN_LABELS,
  PROSPECT_STATUSES,
  PROSPECT_STATUS_CLASSES,
  PROSPECT_STATUS_LABELS,
  prospectWhatsAppUrl,
  readableProspectError,
} from '~/lib/partner-prospects'
import {
  searchPartnersForLinkFn,
  suggestPartnersForProspectFn,
  updateProspectFn,
} from '~/fn/partner-prospects'
import { MultiSelect } from '~/components/MultiSelect'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { cn } from '~/lib/utils'
import { formatDate, formatInt } from '~/lib/format'
import type {
  PartnerMatch,
  PartnerProspect,
  ProspectFacets,
  ProspectPatch,
  ProspectStatus,
  ProspectSummary,
} from '~/lib/partner-prospects'

/**
 * Las piezas de la pantalla de seguimiento comercial (`/comercial`).
 * → `.claude/rules/partner-prospects.md`
 */

/** Radix Select no admite `''` como valor de un ítem. */
const NO_OWNER = '__none__'

const FIELD_LABEL = 'block text-xs font-medium uppercase tracking-wider text-muted-foreground'

// ── Estado ────────────────────────────────────────────────────────────────

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

// ── Contadores ────────────────────────────────────────────────────────────

/**
 * Los contadores de arriba. Están siempre, incluso en cero: es una superficie
 * de monitoreo (mismo criterio que las tarjetas de cola de `/operacion`).
 */
export function ProspectSummaryTiles({ summary }: { summary: ProspectSummary }) {
  const tiles: Array<{ label: string; value: string; hint?: string; tone?: string }> = [
    {
      label: 'Contactados',
      value: `${formatInt(summary.contacted)} de ${formatInt(summary.total)}`,
      hint: 'todo lo que salió de Pendiente',
    },
    { label: 'Interesados', value: formatInt(summary.interested), tone: 'text-status-violet' },
    { label: 'Registrados', value: formatInt(summary.registered), tone: 'text-status-green' },
    { label: 'No les interesa', value: formatInt(summary.notInterested), tone: 'text-status-red' },
  ]
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border border-border bg-card px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t.label}</p>
          <p className={cn('mt-1 font-heading text-2xl font-semibold tabular-nums', t.tone)}>{t.value}</p>
          {t.hint ? <p className="text-xs text-muted-foreground">{t.hint}</p> : null}
        </div>
      ))}
    </div>
  )
}

// ── Seguimiento ───────────────────────────────────────────────────────────

/** "Vencido hace 3 días" en rojo, "Hoy" en ámbar. Los días vienen de Postgres. */
export function FollowUpTag({ days, date }: { days: number | null; date: string | null }) {
  if (days === null || date === null) return <span className="text-xs text-muted-foreground">sin seguimiento</span>
  if (days < 0)
    return (
      <span className="text-xs font-medium text-status-red">
        Vencido hace {formatInt(-days)} {days === -1 ? 'día' : 'días'}
      </span>
    )
  if (days === 0) return <span className="text-xs font-medium text-status-yellow">Hoy</span>
  return (
    <span className="text-xs text-muted-foreground">
      en {formatInt(days)} {days === 1 ? 'día' : 'días'} · {formatDate(`${date}T12:00:00Z`)}
    </span>
  )
}

// ── Autoguardado ──────────────────────────────────────────────────────────

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string }

/**
 * Un contacto que se guarda solo. Cada cambio es un PARCHE de una clave (ver
 * la cabecera de la 024): dos cambios seguidos de campos distintos no se pisan.
 *
 * Los guardados se encolan en orden: si el segundo saliera antes que el
 * primero, la fila quedaría con el valor viejo del primer campo.
 */
function useProspectAutosave(initial: PartnerProspect, onSaved: (patch: ProspectPatch) => void) {
  const [prospect, setProspect] = useState(initial)
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  const queue = useRef<Promise<void>>(Promise.resolve())
  const pending = useRef(0)
  const lastError = useRef<string | null>(null)

  // Una recarga de la lista (otra tarjeta cambió de estado) trae la fila del
  // servidor; se acepta sólo si esta tarjeta no tiene nada en vuelo.
  useEffect(() => {
    if (pending.current === 0) setProspect(initial)
  }, [initial.updatedAt])

  function save(patch: ProspectPatch) {
    // Un error queda a la vista hasta la PRÓXIMA tanda de guardados: si el
    // segundo de dos guardados seguidos sale bien, el primero igual falló.
    if (pending.current === 0) lastError.current = null
    pending.current += 1
    setState({ kind: 'saving' })
    queue.current = queue.current.then(async () => {
      try {
        const next = await updateProspectFn({ data: { id: initial.id, patch } })
        setProspect(next)
        onSaved(patch)
      } catch (cause) {
        lastError.current = readableProspectError(cause)
      } finally {
        pending.current -= 1
        if (pending.current === 0) {
          setState(lastError.current ? { kind: 'error', message: lastError.current } : { kind: 'saved' })
        }
      }
    })
  }

  return { prospect, state, save }
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state.kind === 'idle') return null
  if (state.kind === 'saving')
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" role="status">
        <LoaderCircle className="size-3 animate-spin" aria-hidden /> Guardando…
      </span>
    )
  if (state.kind === 'saved')
    return (
      <span className="inline-flex items-center gap-1 text-xs text-status-green" role="status">
        <Check className="size-3" aria-hidden /> Guardado
      </span>
    )
  return (
    <span className="inline-flex items-center gap-1 text-xs text-status-red" role="alert">
      <TriangleAlert className="size-3" aria-hidden /> {state.message}
    </span>
  )
}

/**
 * Un campo de texto que guarda solo, con debounce. Enviar al salir del campo
 * no espera el debounce. Se re-sincroniza con lo que vuelve del servidor (ya
 * trimeado) sólo si no se siguió tipeando: si no, una respuesta vieja pisaría
 * lo que se está escribiendo.
 */
function AutosaveText({
  id,
  value,
  onCommit,
  multiline = false,
  placeholder,
  maxLength,
}: {
  id: string
  value: string | null
  onCommit: (text: string) => void
  multiline?: boolean
  placeholder?: string
  maxLength?: number
}) {
  const [draft, setDraft] = useState(value ?? '')
  const committed = useRef(value ?? '')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (draft === committed.current) {
      setDraft(value ?? '')
      committed.current = value ?? ''
    }
  }, [value])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  function commit(text: string) {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (text === committed.current) return
    committed.current = text
    onCommit(text)
  }

  function change(text: string) {
    setDraft(text)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => commit(text), 800)
  }

  const common = {
    id,
    value: draft,
    placeholder,
    maxLength,
    onBlur: () => commit(draft),
  }
  return multiline ? (
    <Textarea {...common} rows={3} className="shadow-none" onChange={(e) => change(e.target.value)} />
  ) : (
    <Input {...common} className="shadow-none" onChange={(e) => change(e.target.value)} />
  )
}

// ── La tarjeta ────────────────────────────────────────────────────────────

export function ProspectCard({
  prospect: initial,
  facets,
  onListChanged,
}: {
  prospect: PartnerProspect
  facets: ProspectFacets
  /** Un cambio que mueve la fila de lugar o de contador (estado, próximo seguimiento). */
  onListChanged: () => void
}) {
  const { prospect: p, state, save } = useProspectAutosave(initial, (patch) => {
    if (patch.status !== undefined || patch.nextFollowUpOn !== undefined) onListChanged()
  })
  const [editingFicha, setEditingFicha] = useState(false)
  const [linking, setLinking] = useState(false)

  const waUrl = prospectWhatsAppUrl(p.phoneDigits)
  const originLabel = facets.origins.find((o) => o.slug === p.originSlug)?.label ?? p.originSlug
  const categoryNames = p.categorySlugs.map(
    (slug) => facets.categories.find((c) => c.slug === slug)?.name ?? slug,
  )
  const idp = `pp-${p.id}`
  const showLink = p.status === 'registered' || p.partnerId !== null || linking

  function setStatus(next: ProspectStatus) {
    save({ status: next })
    if (next === 'registered' && p.partnerId === null) setLinking(true)
  }

  return (
    <article className="rounded-lg border border-border bg-card p-4" aria-labelledby={`${idp}-name`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 id={`${idp}-name`} className="font-heading text-base font-semibold leading-tight">
            {p.name}
          </h3>
          <p className="text-sm text-muted-foreground">
            {[p.locality, originLabel, categoryNames.join(', ') || null].filter(Boolean).join(' · ')}
          </p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {p.phone ? <span className="tabular-nums">{p.phone}</span> : <span className="text-muted-foreground">sin teléfono</span>}
            {waUrl ? (
              <Button asChild size="sm" variant="outline" className="h-7 gap-1 px-2 shadow-none">
                <a href={waUrl} target="_blank" rel="noreferrer">
                  <MessageCircle className="size-3.5" aria-hidden /> WhatsApp
                </a>
              </Button>
            ) : p.phone ? (
              <span className="text-xs text-status-yellow">no es un celular reconocible: sin WhatsApp ni chequeo de duplicado</span>
            ) : null}
          </div>
          {p.shortNote ? <p className="text-sm text-foreground/80">{p.shortNote}</p> : null}
        </div>

        <div className="flex flex-col items-end gap-1.5">
          <Select value={p.status} onValueChange={(v) => setStatus(v as ProspectStatus)}>
            <SelectTrigger
              aria-label="Estado"
              className={cn('h-8 w-48 shadow-none', PROSPECT_STATUS_CLASSES[p.status])}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROSPECT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {PROSPECT_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FollowUpTag days={p.followUpInDays} date={p.nextFollowUpOn} />
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <label htmlFor={`${idp}-talked`} className={FIELD_LABEL}>Con quién hablé</label>
          <AutosaveText id={`${idp}-talked`} value={p.talkedTo} maxLength={200} onCommit={(t) => save({ talkedTo: t })} />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${idp}-plan`} className={FIELD_LABEL}>Plan</label>
          <Select value={p.plan} onValueChange={(v) => save({ plan: v as (typeof PROSPECT_PLANS)[number] })}>
            <SelectTrigger id={`${idp}-plan`} className="w-full shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROSPECT_PLANS.map((plan) => (
                <SelectItem key={plan} value={plan}>
                  {PROSPECT_PLAN_LABELS[plan]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${idp}-last`} className={FIELD_LABEL}>Último contacto</label>
          <Input
            id={`${idp}-last`}
            type="date"
            className="shadow-none"
            value={p.lastContactOn ?? ''}
            onChange={(e) => save({ lastContactOn: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${idp}-next`} className={FIELD_LABEL}>Próximo seguimiento</label>
          <Input
            id={`${idp}-next`}
            type="date"
            className="shadow-none"
            value={p.nextFollowUpOn ?? ''}
            onChange={(e) => save({ nextFollowUpOn: e.target.value })}
          />
        </div>
        <div className="space-y-1 sm:col-span-2 lg:col-span-4">
          <label htmlFor={`${idp}-notes`} className={FIELD_LABEL}>Respuesta y notas</label>
          <AutosaveText
            id={`${idp}-notes`}
            multiline
            value={p.notes}
            maxLength={5000}
            onCommit={(t) => save({ notes: t })}
          />
        </div>
      </div>

      {showLink ? (
        <PartnerLinkSection
          prospect={p}
          autoSuggest={linking}
          onLink={(partnerId) => {
            save({ partnerId })
            setLinking(false)
          }}
        />
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>
            Comercial:{' '}
            <span className="text-foreground">
              {facets.owners.find((o) => o.id === p.ownerId)?.name ?? 'sin asignar'}
            </span>
          </span>
          <button
            type="button"
            onClick={() => setEditingFicha((v) => !v)}
            aria-expanded={editingFicha}
            className="inline-flex items-center gap-1 rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Editar ficha
            <ChevronDown className={cn('size-3 transition-transform', editingFicha && 'rotate-180')} aria-hidden />
          </button>
        </div>
        <SaveIndicator state={state} />
      </div>

      {editingFicha ? <FichaEditor prospect={p} facets={facets} save={save} /> : null}
    </article>
  )
}

/** Lo que casi no cambia: nombre, teléfono, localidad, origen, rubros, comercial. */
function FichaEditor({
  prospect: p,
  facets,
  save,
}: {
  prospect: PartnerProspect
  facets: ProspectFacets
  save: (patch: ProspectPatch) => void
}) {
  const idp = `pf-${p.id}`
  return (
    <div className="mt-3 grid gap-3 rounded-md border border-border bg-surface-2/40 p-3 sm:grid-cols-2 lg:grid-cols-3">
      <div className="space-y-1">
        <label htmlFor={`${idp}-name`} className={FIELD_LABEL}>Nombre</label>
        <AutosaveText id={`${idp}-name`} value={p.name} maxLength={200} onCommit={(t) => save({ name: t })} />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${idp}-phone`} className={FIELD_LABEL}>Teléfono</label>
        <AutosaveText
          id={`${idp}-phone`}
          value={p.phone}
          maxLength={60}
          placeholder="11 2512-0472"
          onCommit={(t) => save({ phone: t })}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${idp}-loc`} className={FIELD_LABEL}>Localidad / ubicación</label>
        <AutosaveText id={`${idp}-loc`} value={p.locality} maxLength={200} onCommit={(t) => save({ locality: t })} />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${idp}-origin`} className={FIELD_LABEL}>Origen</label>
        <Select value={p.originSlug} onValueChange={(v) => save({ originSlug: v })}>
          <SelectTrigger id={`${idp}-origin`} className="w-full shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {facets.origins.map((o) => (
              <SelectItem key={o.slug} value={o.slug}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <span className={FIELD_LABEL}>Rubros</span>
        <MultiSelect
          label="Rubros"
          options={facets.categories.map((c) => ({ value: c.slug, label: c.name }))}
          selected={p.categorySlugs}
          onChange={(next) => save({ categorySlugs: next })}
          placeholder="Sin rubro"
          className="w-full"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${idp}-owner`} className={FIELD_LABEL}>Comercial</label>
        <Select
          value={p.ownerId ?? NO_OWNER}
          onValueChange={(v) => save({ ownerId: v === NO_OWNER ? null : v })}
        >
          <SelectTrigger id={`${idp}-owner`} className="w-full shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_OWNER}>Sin asignar</SelectItem>
            {facets.owners.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1 sm:col-span-2 lg:col-span-3">
        <label htmlFor={`${idp}-short`} className={FIELD_LABEL}>Nota corta</label>
        <AutosaveText id={`${idp}-short`} value={p.shortNote} maxLength={280} onCommit={(t) => save({ shortNote: t })} />
      </div>
    </div>
  )
}

// ── Vínculo con el proveedor del marketplace ──────────────────────────────

/**
 * Al pasar a "Registrado": a qué proveedor real corresponde. Si el teléfono
 * del contacto coincide con el de un proveedor (misma normalización que los
 * duplicados), se sugiere solo; si no, buscador por nombre o teléfono.
 *
 * Vincular es una elección explícita, nunca automática: dos proveedores pueden
 * compartir un teléfono (una cadena con varias sucursales).
 */
function PartnerLinkSection({
  prospect: p,
  autoSuggest,
  onLink,
}: {
  prospect: PartnerProspect
  autoSuggest: boolean
  onLink: (partnerId: string | null) => void
}) {
  const [suggestions, setSuggestions] = useState<Array<PartnerMatch> | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<PartnerMatch> | null>(null)
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState(autoSuggest)

  useEffect(() => {
    if (autoSuggest) setOpen(true)
  }, [autoSuggest])

  useEffect(() => {
    if (!open || p.partnerId !== null || p.phoneDigits === null) return
    let alive = true
    suggestPartnersForProspectFn({ data: { id: p.id } })
      .then((rows) => {
        if (alive) setSuggestions(rows)
      })
      .catch(() => {
        if (alive) setSuggestions([])
      })
    return () => {
      alive = false
    }
  }, [open, p.id, p.partnerId, p.phoneDigits])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setResults(null)
      return
    }
    setSearching(true)
    let alive = true
    const t = setTimeout(() => {
      searchPartnersForLinkFn({ data: { q } })
        .then((rows) => {
          if (alive) setResults(rows)
        })
        .catch(() => {
          if (alive) setResults([])
        })
        .finally(() => {
          if (alive) setSearching(false)
        })
    }, 300)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query])

  if (p.partnerId !== null) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-status-green/30 bg-status-green-bg px-3 py-2 text-sm">
        <Link2 className="size-3.5 text-status-green" aria-hidden />
        <span>Proveedor del marketplace:</span>
        <Link
          to="/partners/$partnerId"
          params={{ partnerId: p.partnerId }}
          className="font-medium underline-offset-2 hover:underline"
        >
          {p.partnerName ?? 'proveedor borrado'}
        </Link>
        {p.partnerStatus && p.partnerStatus !== 'active' ? (
          <span className="text-xs text-status-yellow">({p.partnerStatus})</span>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 gap-1 px-2 text-muted-foreground"
          onClick={() => onLink(null)}
        >
          <Unlink className="size-3.5" aria-hidden /> Desvincular
        </Button>
      </div>
    )
  }

  if (!open) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-status-yellow/30 bg-status-yellow-bg px-3 py-2 text-sm text-status-yellow">
        Registrado sin vincular a un proveedor del marketplace.
        <Button size="sm" variant="outline" className="ml-auto h-7 shadow-none" onClick={() => setOpen(true)}>
          Vincular
        </Button>
      </div>
    )
  }

  const pick = (m: PartnerMatch) => (
    <li key={m.id}>
      <button
        type="button"
        onClick={() => onLink(m.id)}
        className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="font-medium">{m.name}</span>
        <span className="text-xs text-muted-foreground">
          {[m.whatsapp, m.coverageZone, m.status !== 'active' ? m.status : null].filter(Boolean).join(' · ')}
        </span>
      </button>
    </li>
  )

  return (
    <div className="mt-3 space-y-2 rounded-md border border-border p-3">
      <p className="text-sm font-medium">¿Qué proveedor del marketplace es?</p>
      {suggestions && suggestions.length > 0 ? (
        <div>
          <p className="text-xs text-muted-foreground">Mismo teléfono que este contacto:</p>
          <ul className="mt-1">{suggestions.map(pick)}</ul>
        </div>
      ) : null}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          aria-label="Buscar proveedor por nombre o teléfono"
          placeholder="Buscar por nombre o teléfono"
          className="pl-8 shadow-none"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {searching ? <p className="text-xs text-muted-foreground">Buscando…</p> : null}
      {results !== null && !searching ? (
        results.length === 0 ? (
          <p className="text-xs text-muted-foreground">Ningún proveedor con ese nombre o teléfono.</p>
        ) : (
          <ul>{results.map(pick)}</ul>
        )
      ) : null}
    </div>
  )
}

