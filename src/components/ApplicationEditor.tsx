import { useMemo, useState, type FormEvent } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Plus, Save, X } from 'lucide-react'
import { updatePartnerApplicationFn } from '~/fn/partners'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { cn } from '~/lib/utils'
import type { ApplicationDetail } from '~/lib/partners'
import type { ServiceFamily } from '~/lib/catalog'

/**
 * El editor de una solicitud — migración 010.
 *
 * ── UN SOLO "GUARDAR" ───────────────────────────────────────────────────────
 *
 * A diferencia de `PartnerFicha` (que parte la edición en tarjetas con guardado
 * propio, una por consecuencia distinta), acá todo va junto: una solicitud es
 * un formulario que el taller mandó de una, y corregirlo es un solo acto. El SP
 * lo registra como una entrada `application.edit` en `ops.action_log` con el
 * `before`/`after` completos.
 *
 * ── MANDA EL JUEGO COMPLETO ─────────────────────────────────────────────────
 *
 * Todos los campos viajan siempre, incluso los vacíos: lo que se ve en pantalla
 * es exactamente lo que queda guardado. Un `''` es "borrá este campo". Mismo
 * criterio que `setPartnerContactSchema`.
 *
 * ── `status` NO SE EDITA ACÁ ────────────────────────────────────────────────
 *
 * Tiene su propio editor (columna derecha) y el lock de `verbal_agreement` de
 * la función de aprobación. `first_contacted_at` / `reviewed_*` tampoco: no son
 * datos que el operador corrija a mano. → `.claude/rules/partner-approval.md`
 */
export function ApplicationEditor({
  app,
  catalog,
}: {
  app: ApplicationDetail
  catalog: Array<ServiceFamily>
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // ── Índices del catálogo para los rubros declarados ────────────────────────
  const { serviceSlugs, familyToServices } = useMemo(() => {
    const serviceSlugs = new Set<string>()
    const familyToServices = new Map<string, Array<string>>()
    for (const fam of catalog) {
      const slugs = fam.services.map((s) => s.slug)
      familyToServices.set(fam.slug, slugs)
      for (const s of slugs) serviceSlugs.add(s)
    }
    return { serviceSlugs, familyToServices }
  }, [catalog])

  // Al sembrar: un slug de servicio entra tal cual; uno de familia se expande a
  // sus servicios (normalización deliberada — `expandDeclaredSlugs` y el INSERT
  // de aprobación dan el MISMO resultado); el resto queda como chip "sin
  // reconocer", removible pero preservado.
  const seed = useMemo(() => {
    const selected = new Set<string>()
    const unknown: Array<string> = []
    for (const slug of app.declaredServices) {
      if (serviceSlugs.has(slug)) selected.add(slug)
      else if (familyToServices.has(slug)) {
        for (const s of familyToServices.get(slug)!) selected.add(s)
      } else unknown.push(slug)
    }
    return { selected, unknown }
  }, [app.declaredServices, serviceSlugs, familyToServices])

  const [selectedServices, setSelectedServices] = useState<Set<string>>(() => new Set(seed.selected))
  const [unknownServices, setUnknownServices] = useState<Array<string>>(() => seed.unknown)

  const [form, setForm] = useState({
    businessName: app.businessName,
    email: app.email,
    whatsapp: app.whatsapp,
    address: app.address,
    brandSpecialized: app.brandSpecialized,
    contactChannel: app.contactChannel ?? '',
    howFound: app.howFound ?? '',
    howFoundOther: app.howFoundOther ?? '',
    serviceOther: app.serviceOther ?? '',
    nextStep: app.nextStep ?? '',
    agreementType: app.agreementType ?? '',
    agreementDetail: app.agreementDetail ?? '',
    internalNotes: app.internalNotes ?? '',
    reviewNote: app.reviewNote ?? '',
    // `follow_up_date` llega como ISO (`2026-10-01` o con hora); el <input
    // type=date> quiere `YYYY-MM-DD`.
    followUpDate: (app.followUpDate ?? '').slice(0, 10),
  })
  const [brands, setBrands] = useState<Array<string>>(app.declaredBrands)
  const [fuelTypes, setFuelTypes] = useState<Array<string>>(app.declaredFuelTypes)
  const [vehicleTypes, setVehicleTypes] = useState<Array<string>>(app.vehicleTypes)

  const set =
    <K extends keyof typeof form>(key: K) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      // El valor se lee sincrónicamente, ANTES del updater. Leerlo adentro tira
      // sobre `currentTarget` en null (ver el comentario largo en PartnerFicha).
      const value = e.currentTarget.value
      setForm((prev) => ({ ...prev, [key]: value }))
    }

  function toggleService(slug: string) {
    setSelectedServices((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }

  function toggleFamily(slugs: Array<string>, on: boolean) {
    setSelectedServices((prev) => {
      const next = new Set(prev)
      for (const s of slugs) {
        if (on) next.add(s)
        else next.delete(s)
      }
      return next
    })
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await updatePartnerApplicationFn({
        data: {
          applicationId: app.id,
          ...form,
          declaredServices: [...selectedServices, ...unknownServices],
          declaredBrands: brands,
          declaredFuelTypes: fuelTypes,
          vehicleTypes: vehicleTypes,
        },
      })
      // El estado nuevo lo calcula el SP (normalización de '' → NULL, arrays sin
      // vacíos) y `resolved` lo recalcula el loader. Recargar es preguntar qué
      // quedó, no inventarlo en el cliente.
      await router.invalidate()
      setSaved(true)
    } catch (cause) {
      setError(readableApplicationError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Contacto</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <TextField label="Nombre del taller" value={form.businessName} onChange={set('businessName')} required />
          <TextField label="Email" value={form.email} onChange={set('email')} required />
          <TextField label="WhatsApp" value={form.whatsapp} onChange={set('whatsapp')} required />
          <TextField label="Canal de contacto" value={form.contactChannel} onChange={set('contactChannel')} placeholder="whatsapp, email…" />
          <TextField label="Dirección" value={form.address} onChange={set('address')} required className="sm:col-span-2" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Negocio</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.brandSpecialized}
              onChange={(e) => {
                const checked = e.currentTarget.checked
                setForm((prev) => ({ ...prev, brandSpecialized: checked }))
              }}
            />
            Especializado en una marca
          </label>
          <TagInput label="Marcas" values={brands} onChange={setBrands} placeholder="Toyota" />
          <TagInput label="Combustibles" values={fuelTypes} onChange={setFuelTypes} placeholder="Nafta" />
          <TagInput label="Tipos de vehículo" values={vehicleTypes} onChange={setVehicleTypes} placeholder="Autos" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Rubros que atiende</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {unknownServices.length > 0 ? (
            <div className="rounded-md border border-status-yellow/30 bg-status-yellow-bg p-3">
              <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
                Declaró esto y no coincide con ningún rubro ni familia del catálogo (etiquetas del
                formulario viejo). Se guarda tal cual salvo que lo quites; la pantalla de aprobación
                sugiere el rubro equivalente.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {unknownServices.map((slug) => (
                  <span
                    key={slug}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 font-mono text-xs"
                  >
                    {slug}
                    <button
                      type="button"
                      onClick={() => setUnknownServices((prev) => prev.filter((s) => s !== slug))}
                      aria-label={`Quitar ${slug}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {catalog.map((fam) => {
            const slugs = familyToServices.get(fam.slug) ?? []
            const on = slugs.filter((s) => selectedServices.has(s)).length
            const allOn = on === slugs.length && slugs.length > 0
            return (
              <div key={fam.slug} className="rounded-md border border-border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium">
                    {fam.name}{' '}
                    <span className="font-normal text-muted-foreground">
                      {on}/{slugs.length}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto px-2 py-1 text-xs"
                    onClick={() => toggleFamily(slugs, !allOn)}
                  >
                    {allOn ? 'Ninguno' : 'Todos'}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {fam.services.map((s) => {
                    const isOn = selectedServices.has(s.slug)
                    return (
                      <button
                        key={s.slug}
                        type="button"
                        aria-pressed={isOn}
                        onClick={() => toggleService(s.slug)}
                        className={cn(
                          'rounded-md border px-2.5 py-1 text-xs transition-colors',
                          isOn
                            ? 'border-brand bg-brand-soft text-brand'
                            : 'border-border bg-card text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {s.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}

          <TextField
            label="Otros servicios (texto libre)"
            value={form.serviceOther}
            onChange={set('serviceOther')}
            placeholder="Tapizados, GNC…"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Seguimiento</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <TextField label="Próximo paso" value={form.nextStep} onChange={set('nextStep')} className="sm:col-span-2" />
          <div className="space-y-1">
            <label className="block text-xs uppercase tracking-wider text-muted-foreground">
              Fecha de seguimiento
            </label>
            <Input type="date" value={form.followUpDate} onChange={set('followUpDate')} className="text-xs" />
          </div>
          <TextField label="Cómo nos encontró" value={form.howFound} onChange={set('howFound')} />
          <TextField label="Cómo nos encontró (otro)" value={form.howFoundOther} onChange={set('howFoundOther')} />
          <TextField label="Tipo de acuerdo" value={form.agreementType} onChange={set('agreementType')} />
          <TextField label="Detalle del acuerdo" value={form.agreementDetail} onChange={set('agreementDetail')} className="sm:col-span-2" />
          <AreaField label="Notas internas" value={form.internalNotes} onChange={set('internalNotes')} />
          <AreaField label="Nota de revisión" value={form.reviewNote} onChange={set('reviewNote')} />
        </CardContent>
      </Card>

      <div className="sticky bottom-0 flex items-center gap-3 border-t border-border bg-canvas/95 py-3 backdrop-blur">
        <Button type="submit" disabled={busy} className="gap-1.5">
          <Save className="size-3.5" aria-hidden />
          {busy ? 'Guardando…' : 'Guardar solicitud'}
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {saved ? <p className="text-sm text-status-green">Guardado.</p> : null}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Un campo de texto vacío BORRA el dato. El estado del embudo se cambia en el panel de la
        derecha, no acá.
      </p>
    </form>
  )
}

/**
 * Traduce las sentinelas de `ops.update_partner_application` a algo legible.
 * Mismo criterio que `readableError` en `PartnerFicha`.
 */
function readableApplicationError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  if (raw.includes('BUSINESS_NAME_REQUIRED')) return 'El nombre del taller no puede quedar vacío.'
  if (raw.includes('EMAIL_REQUIRED')) return 'El email no puede quedar vacío.'
  if (raw.includes('WHATSAPP_REQUIRED')) return 'El WhatsApp no puede quedar vacío.'
  if (raw.includes('ADDRESS_REQUIRED')) return 'La dirección no puede quedar vacía.'
  if (raw.includes('INVALID_FOLLOW_UP_DATE')) return 'La fecha de seguimiento no es válida (usá el selector).'
  if (raw.includes('APPLICATION_NOT_FOUND')) return 'Esta solicitud ya no existe. Recargá la pantalla.'
  if (raw.includes('ACTOR_NOT_FOUND') || raw.includes('ACTOR_REQUIRED'))
    return 'Tu sesión no corresponde a un usuario de AutoLibre. Volvé a iniciar sesión.'
  if (raw === 'FORBIDDEN') return 'Tu rol no tiene permiso para esta acción.'
  if (raw === 'UNAUTHENTICATED') return 'Tu sesión expiró. Volvé a iniciar sesión.'
  return 'No pudimos guardar. No se aplicó nada — la operación es transaccional.'
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  required,
  className,
}: {
  label: string
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string
  required?: boolean
  className?: string
}) {
  const empty = required && value.trim() === ''
  return (
    <div className={cn('space-y-1', className)}>
      <label className="block text-xs uppercase tracking-wider text-muted-foreground">{label}</label>
      <Input
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        aria-invalid={empty}
        autoComplete="off"
        className="text-xs"
      />
      {empty ? <p className="text-xs text-destructive">No puede quedar vacío.</p> : null}
    </div>
  )
}

function AreaField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
}) {
  return (
    <div className="space-y-1 sm:col-span-2">
      <label className="block text-xs uppercase tracking-wider text-muted-foreground">{label}</label>
      <Textarea value={value} onChange={onChange} rows={2} className="text-xs" />
    </div>
  )
}

/**
 * Editor de una lista de etiquetas de texto libre (marcas, combustibles, tipos
 * de vehículo). Son labels del formulario de la landing, no enums — se muestran
 * y editan crudos, mismo criterio que la aseguradora en `leads.md`.
 */
function TagInput({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string
  values: Array<string>
  onChange: (next: Array<string>) => void
  placeholder?: string
}) {
  const [draft, setDraft] = useState('')

  function add() {
    const v = draft.trim()
    if (v === '' || values.some((x) => x.toLowerCase() === v.toLowerCase())) {
      setDraft('')
      return
    }
    onChange([...values, v])
    setDraft('')
  }

  return (
    <div className="space-y-1.5">
      <label className="block text-xs uppercase tracking-wider text-muted-foreground">{label}</label>
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-2 py-0.5 text-xs"
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              aria-label={`Quitar ${v}`}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          placeholder={placeholder}
          className="text-xs"
          autoComplete="off"
        />
        <Button type="button" variant="outline" size="sm" onClick={add} className="gap-1">
          <Plus className="size-3.5" aria-hidden />
          Agregar
        </Button>
      </div>
    </div>
  )
}
