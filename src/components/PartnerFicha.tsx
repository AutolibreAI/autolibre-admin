import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { MapPin, MapPinOff, Phone, Save } from 'lucide-react'
import { setPartnerContactFn, setPartnerLocationFn, setPartnerStatusFn } from '~/fn/partners'
import {
  PARTNER_STATUSES,
  PARTNER_STATUS_LABELS,
  type PartnerServicesView,
  type PartnerStatus,
} from '~/lib/catalog'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { cn } from '~/lib/utils'

type Partner = PartnerServicesView['partner']

/**
 * La ficha editable de un partner — migración 007.
 *
 * ── Por qué esta pantalla puede escribir `public.partners` ───────────────────
 *
 * Porque nadie más puede. Verificado en el backend: `IPartnerRepository` expone
 * SÓLO `findActive()` y `findActiveById()`, y los únicos casos de uso son
 * `get-partner` y `list-partners`. No existe camino para editar un partner en
 * ningún lado del sistema. → `.claude/rules/ops-metrics.md`
 *
 * ── Tres formularios y no uno ───────────────────────────────────────────────
 *
 * Cada bloque guarda por separado contra su propio stored procedure, en vez de
 * un único "Guardar" que mande todo. No es indecisión: son tres operaciones con
 * consecuencias distintas —pausar saca al taller del marketplace, cargar
 * coordenadas lo hace ordenable, completar el contacto lo hace contactable— y
 * cada una queda como una entrada distinta en `ops.action_log`. Un guardado
 * único produciría un solo registro de auditoría que dice "cambió algo".
 */
export function PartnerFicha({ partner }: { partner: Partner }) {
  return (
    <div className="mb-4 grid gap-4 lg:grid-cols-3">
      <StatusCard partner={partner} />
      <LocationCard partner={partner} />
      <ContactCard partner={partner} />
    </div>
  )
}

/**
 * Traduce las sentinelas de los SP a algo que se pueda leer sin saber SQL.
 *
 * Los SP tiran `RAISE EXCEPTION 'INCOMPLETE_COORDINATES'` y compañía
 * justamente para que este mapeo sea posible: el texto crudo de Postgres trae
 * el nombre de la función y del índice, que no le dicen nada al operador.
 */
function readableError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)

  if (raw.includes('INCOMPLETE_COORDINATES'))
    return 'Cargá las dos coordenadas, o dejá las dos vacías para borrarlas.'
  if (raw.includes('LATITUDE_OUT_OF_RANGE')) return 'La latitud tiene que estar entre -90 y 90.'
  if (raw.includes('LONGITUDE_OUT_OF_RANGE')) return 'La longitud tiene que estar entre -180 y 180.'
  if (raw.includes('PARTNER_NOT_FOUND')) return 'Este partner ya no existe. Recargá la pantalla.'
  if (raw.includes('ACTOR_NOT_FOUND') || raw.includes('ACTOR_REQUIRED'))
    return 'Tu sesión no corresponde a un usuario de AutoLibre. Volvé a iniciar sesión.'
  if (raw === 'FORBIDDEN') return 'Tu rol no tiene permiso para esta acción.'
  if (raw === 'UNAUTHENTICATED') return 'Tu sesión expiró. Volvé a iniciar sesión.'
  return raw
}

/** Estado compartido por los tres bloques: ocupado + error legible. */
function useAction() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await action()
      // El estado nuevo lo calcula Postgres (el trigger de `updated_at`, la
      // normalización de '' a NULL). Recargar es preguntar qué quedó; guardar
      // una copia optimista en el cliente sería inventar un dato que la base
      // ya sabe y que puede no coincidir.
      await router.invalidate()
      setSaved(true)
    } catch (cause) {
      setError(readableError(cause))
    } finally {
      setBusy(false)
    }
  }

  return { busy, error, saved, run }
}

function Feedback({ error, saved }: { error: string | null; saved: boolean }) {
  if (error) {
    return (
      <p role="alert" className="mt-2 text-xs leading-relaxed text-destructive">
        {error}
      </p>
    )
  }
  if (saved) return <p className="mt-2 text-xs text-status-green">Guardado.</p>
  return null
}

// ── Estado ───────────────────────────────────────────────────────────────────

function StatusCard({ partner }: { partner: Partner }) {
  const { busy, error, saved, run } = useAction()

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Estado en el marketplace</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-1.5">
          {PARTNER_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              disabled={busy}
              aria-pressed={partner.status === s}
              onClick={() =>
                run(() => setPartnerStatusFn({ data: { partnerId: partner.id, status: s } }))
              }
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-50',
                partner.status === s
                  ? 'border-transparent bg-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              {PARTNER_STATUS_LABELS[s as PartnerStatus]}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Sólo <strong>Publicado</strong> aparece en la app: el índice del backend es parcial sobre
          ese estado. Pausar lo saca del marketplace sin borrar nada.
        </p>
        <Feedback error={error} saved={saved} />
      </CardContent>
    </Card>
  )
}

// ── Coordenadas ──────────────────────────────────────────────────────────────

/**
 * El caso que motiva esta tarjeta: al 2026-08-30 los 34 partners activos de
 * producción tienen `latitude IS NULL`. El marketplace no puede ordenar por
 * cercanía a nadie — el usuario ve un taller a 400 km arriba de uno a seis
 * cuadras.
 */
function LocationCard({ partner }: { partner: Partner }) {
  const { busy, error, saved, run } = useAction()
  const [lat, setLat] = useState(partner.latitude === null ? '' : String(partner.latitude))
  const [lng, setLng] = useState(partner.longitude === null ? '' : String(partner.longitude))

  const hasGeo = partner.latitude !== null

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-sm">Ubicación</CardTitle>
        {hasGeo ? (
          <MapPin className="size-4 text-status-green" aria-label="Con coordenadas" />
        ) : (
          <MapPinOff className="size-4 text-status-yellow" aria-label="Sin coordenadas" />
        )}
      </CardHeader>
      <CardContent>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            // Los dos vacíos = borrar. Uno solo vacío lo rechaza el schema
            // ANTES del round trip, y el SP igual lo rechaza del otro lado.
            const parsed = {
              latitude: lat.trim() === '' ? null : Number(lat),
              longitude: lng.trim() === '' ? null : Number(lng),
            }
            void run(() =>
              setPartnerLocationFn({ data: { partnerId: partner.id, ...parsed } }),
            )
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label htmlFor="lat" className="block text-xs text-muted-foreground">
                Latitud
              </label>
              <Input
                id="lat"
                inputMode="decimal"
                value={lat}
                onChange={(e) => setLat(e.currentTarget.value)}
                placeholder="-34.6037"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="lng" className="block text-xs text-muted-foreground">
                Longitud
              </label>
              <Input
                id="lng"
                inputMode="decimal"
                value={lng}
                onChange={(e) => setLng(e.currentTarget.value)}
                placeholder="-58.3816"
                className="font-mono text-xs"
              />
            </div>
          </div>

          <Button type="submit" size="sm" disabled={busy} className="gap-1.5">
            <Save className="size-3.5" aria-hidden />
            {busy ? 'Guardando…' : 'Guardar ubicación'}
          </Button>
        </form>

        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Sin coordenadas el taller no se puede ordenar por cercanía. Las dos van juntas o ninguna:
          una sola se lee como un punto en el Golfo de Guinea.
        </p>
        <Feedback error={error} saved={saved} />
      </CardContent>
    </Card>
  )
}

// ── Contacto ─────────────────────────────────────────────────────────────────

function ContactCard({ partner }: { partner: Partner }) {
  const { busy, error, saved, run } = useAction()
  const [form, setForm] = useState({
    whatsapp: partner.whatsapp ?? '',
    email: partner.email ?? '',
    redirectLink: partner.redirectLink ?? '',
    hours: partner.hours ?? '',
    address: partner.address ?? '',
  })

  const reachable =
    form.whatsapp.trim() !== '' || form.email.trim() !== '' || form.redirectLink.trim() !== ''

  /**
   * El valor se LEE acá, sincrónicamente, y recién después entra al updater.
   *
   * La versión corta —`setForm((prev) => ({ ...prev, [k]: e.currentTarget.value }))`—
   * está rota, y de una forma que no se ve leyéndola: ese updater NO corre
   * durante el evento, corre después, durante el render. Para entonces React ya
   * puso `e.currentTarget` en `null` (sólo tiene sentido mientras el evento se
   * propaga), así que tirá `Cannot read properties of null (reading 'value')` al
   * primer carácter tipeado — y como el throw pasa en RENDER, se lo come el
   * `errorComponent` de la ruta y se cae la pantalla entera, no sólo el input.
   *
   * La regla, para cualquier handler de este repo: **nunca leas nada del evento
   * adentro de un updater funcional, de un `setTimeout` ni de un `await`.**
   * Extraé el valor primero; el evento es válido sólo dentro del handler.
   */
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.currentTarget.value
    setForm((prev) => ({ ...prev, [k]: value }))
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-sm">Contacto</CardTitle>
        <Phone
          className={cn('size-4', reachable ? 'text-status-green' : 'text-status-yellow')}
          aria-label={reachable ? 'Contactable' : 'Sin forma de contacto'}
        />
      </CardHeader>
      <CardContent>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            void run(() => setPartnerContactFn({ data: { partnerId: partner.id, ...form } }))
          }}
        >
          {(
            [
              ['whatsapp', 'WhatsApp', '+54 9 11 …'],
              ['email', 'Email', 'taller@ejemplo.com'],
              ['redirectLink', 'Link', 'https://…'],
              ['hours', 'Horarios', 'Lun a Vie 9–18'],
              ['address', 'Dirección', 'Calle 123, CABA'],
            ] as const
          ).map(([key, label, placeholder]) => (
            <div key={key} className="space-y-1">
              <label htmlFor={key} className="block text-xs text-muted-foreground">
                {label}
              </label>
              <Input
                id={key}
                value={form[key]}
                onChange={set(key)}
                placeholder={placeholder}
                className="text-xs"
                autoComplete="off"
              />
            </div>
          ))}

          <Button type="submit" size="sm" disabled={busy} className="gap-1.5">
            <Save className="size-3.5" aria-hidden />
            {busy ? 'Guardando…' : 'Guardar contacto'}
          </Button>
        </form>

        {/*
          Se AVISA, no se impide. Que un partner publicado tenga que ser
          contactable es una regla de negocio, y el stored procedure
          deliberadamente no la decide — la pantalla de Inicio ya cuenta estas
          fichas como pendiente. Si el equipo la quiere obligatoria, el lugar es
          este formulario, donde cambiar de opinión no cuesta una migración.
        */}
        {!reachable ? (
          <p className="mt-2 text-xs leading-relaxed text-status-yellow">
            Sin WhatsApp, sin email y sin link: el usuario llega y no tiene cómo escribir.
          </p>
        ) : null}
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Un campo vacío BORRA el dato. Lo que ves acá es exactamente lo que queda guardado.
        </p>
        <Feedback error={error} saved={saved} />
      </CardContent>
    </Card>
  )
}
