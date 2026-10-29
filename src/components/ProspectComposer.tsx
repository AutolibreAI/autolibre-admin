import { useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { normalizeArPhone, readableProspectError } from '~/lib/partner-prospects'
import { addProspectOriginFn, createProspectFn, findPhoneMatchesFn } from '~/fn/partner-prospects'
import { MultiSelect } from '~/components/MultiSelect'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '~/components/ui/sheet'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import type { PhoneMatches, ProspectFacets, ProspectOrigin } from '~/lib/partner-prospects'

const FIELD_LABEL = 'block text-xs font-medium uppercase tracking-wider text-muted-foreground'
const NO_OWNER = '__none__'
const NEW_ORIGIN = '__new__'

/**
 * El selector de origen, con "Nuevo origen…" al final: la lista se amplía
 * desde acá, sin tocar código (`ops.add_partner_prospect_origin`).
 */
export function OriginPicker({
  id,
  origins,
  value,
  onChange,
}: {
  id: string
  origins: ReadonlyArray<ProspectOrigin>
  value: string
  onChange: (slug: string, created?: ProspectOrigin) => void
}) {
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    if (label.trim() === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      const origin = await addProspectOriginFn({ data: { label: label.trim() } })
      onChange(origin.slug, origin)
      setAdding(false)
      setLabel('')
    } catch (cause) {
      setError(readableProspectError(cause))
    } finally {
      setBusy(false)
    }
  }

  if (adding) {
    return (
      <div className="space-y-1.5">
        <div className="flex gap-2">
          <Input
            id={id}
            autoFocus
            placeholder="Ej.: Feria de autopartes"
            className="shadow-none"
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void create()
              }
            }}
          />
          <Button type="button" size="sm" disabled={busy || label.trim() === ''} onClick={() => void create()}>
            Agregar
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Cancelar
          </Button>
        </div>
        {error ? <p className="text-xs text-status-red">{error}</p> : null}
      </div>
    )
  }

  return (
    <Select
      value={value === '' ? undefined : value}
      onValueChange={(v) => (v === NEW_ORIGIN ? setAdding(true) : onChange(v))}
    >
      <SelectTrigger id={id} className="w-full shadow-none">
        <SelectValue placeholder="Elegí de dónde salió" />
      </SelectTrigger>
      <SelectContent>
        {origins.map((o) => (
          <SelectItem key={o.slug} value={o.slug}>
            {o.label}
          </SelectItem>
        ))}
        <SelectItem value={NEW_ORIGIN}>+ Nuevo origen…</SelectItem>
      </SelectContent>
    </Select>
  )
}

/** El selector de comercial, compartido por el alta y la importación. */
export function OwnerPicker({
  id,
  facets,
  value,
  onChange,
}: {
  id: string
  facets: ProspectFacets
  value: string | null
  onChange: (ownerId: string | null) => void
}) {
  return (
    <Select value={value ?? NO_OWNER} onValueChange={(v) => onChange(v === NO_OWNER ? null : v)}>
      <SelectTrigger id={id} className="w-full shadow-none">
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
  )
}

/**
 * Alta manual de un contacto.
 *
 * El duplicado por teléfono se avisa MIENTRAS se tipea y bloquea el botón: el
 * índice único de la 024 lo rechazaría igual, pero acá se puede decir con
 * quién choca. Que el teléfono ya sea de un proveedor del marketplace se avisa
 * y no bloquea: puede ser otra sucursal, y lo decide quien carga.
 */
export function ProspectComposer({ facets, currentUserId }: { facets: ProspectFacets; currentUserId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [origins, setOrigins] = useState(facets.origins)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [locality, setLocality] = useState('')
  const [shortNote, setShortNote] = useState('')
  const [originSlug, setOriginSlug] = useState('')
  const [categorySlugs, setCategorySlugs] = useState<Array<string>>([])
  const [ownerId, setOwnerId] = useState<string | null>(currentUserId)
  const [matches, setMatches] = useState<PhoneMatches | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  useEffect(() => setOrigins(facets.origins), [facets.origins])

  const digits = normalizeArPhone(phone)
  useEffect(() => {
    setMatches(null)
    if (!digits) return
    let alive = true
    const t = setTimeout(() => {
      findPhoneMatchesFn({ data: { phones: [digits] } })
        .then((m) => {
          if (alive) setMatches(m)
        })
        .catch(() => undefined)
    }, 300)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [digits])

  const duplicate = matches?.prospects[0] ?? null
  const canSubmit = name.trim() !== '' && originSlug !== '' && duplicate === null

  function reset() {
    setName('')
    setPhone('')
    setLocality('')
    setShortNote('')
    setOriginSlug('')
    setCategorySlugs([])
    setOwnerId(currentUserId)
    setMatches(null)
    setError(null)
  }

  async function submit() {
    if (!canSubmit || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await createProspectFn({
        data: { name: name.trim(), phone, locality, shortNote, originSlug, categorySlugs, ownerId },
      })
      setOpen(false)
      reset()
      void router.invalidate()
    } catch (cause) {
      setError(readableProspectError(cause))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <SheetTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <Plus className="size-3.5" aria-hidden /> Nuevo contacto
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full max-w-full bg-card sm:w-[28rem]">
        <form
          className="flex h-full min-h-0 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="border-b border-border px-5 py-4 pr-10">
            <SheetTitle>Nuevo contacto</SheetTitle>
            <SheetDescription className="mt-0.5 leading-relaxed">
              Un proveedor al que salimos a buscar: taller, gomería, lavadero, gestoría, grúa…
            </SheetDescription>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
            <div className="space-y-1">
              <label htmlFor="pc-name" className={FIELD_LABEL}>Nombre *</label>
              <Input id="pc-name" className="shadow-none" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="pc-phone" className={FIELD_LABEL}>Teléfono</label>
              <Input
                id="pc-phone"
                className="shadow-none"
                placeholder="11 2512-0472"
                value={phone}
                maxLength={60}
                onChange={(e) => setPhone(e.target.value)}
              />
              {phone.trim() !== '' && !digits ? (
                <p className="text-xs text-status-yellow">
                  No es un celular reconocible (con código de área): se guarda, pero sin WhatsApp ni chequeo de duplicado.
                </p>
              ) : null}
              {duplicate ? (
                <p className="text-xs text-status-red" role="alert">
                  Ya hay un contacto con ese teléfono: <strong>{duplicate.name}</strong>.
                </p>
              ) : null}
              {matches && matches.partners.length > 0 ? (
                <p className="text-xs text-status-yellow">
                  Ese teléfono ya es de un proveedor del marketplace:{' '}
                  <strong>{matches.partners.map((m) => m.name).join(', ')}</strong>.
                </p>
              ) : null}
            </div>
            <div className="space-y-1">
              <label htmlFor="pc-loc" className={FIELD_LABEL}>Localidad / ubicación</label>
              <Input id="pc-loc" className="shadow-none" value={locality} maxLength={200} onChange={(e) => setLocality(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="pc-origin" className={FIELD_LABEL}>Origen *</label>
              <OriginPicker
                id="pc-origin"
                origins={origins}
                value={originSlug}
                onChange={(slug, created) => {
                  if (created) {
                    setOrigins((prev) => (prev.some((o) => o.slug === created.slug) ? prev : [...prev, created]))
                    void router.invalidate()
                  }
                  setOriginSlug(slug)
                }}
              />
            </div>
            <div className="space-y-1">
              <span className={FIELD_LABEL}>Rubros</span>
              <MultiSelect
                label="Rubros"
                options={facets.categories.map((c) => ({ value: c.slug, label: c.name }))}
                selected={categorySlugs}
                onChange={setCategorySlugs}
                placeholder="Sin rubro"
                className="w-full"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="pc-owner" className={FIELD_LABEL}>Comercial</label>
              <OwnerPicker id="pc-owner" facets={facets} value={ownerId} onChange={setOwnerId} />
            </div>
            <div className="space-y-1">
              <label htmlFor="pc-note" className={FIELD_LABEL}>Nota corta</label>
              <Input id="pc-note" className="shadow-none" value={shortNote} maxLength={280} onChange={(e) => setShortNote(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2 border-t border-border px-5 py-4">
            {error ? <p className="text-sm text-status-red" role="alert">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={!canSubmit || busy}>
              {busy ? 'Guardando…' : 'Cargar contacto'}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
