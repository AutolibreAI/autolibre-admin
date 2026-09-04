import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Link as LinkIcon, MapPin, MapPinOff, Phone, Plus, Save, Trash2 } from 'lucide-react'
import {
  setPartnerContactFn,
  setPartnerLinksFn,
  setPartnerLocationFn,
  setPartnerProfileFn,
  setPartnerStatusFn,
} from '~/fn/partners'
import {
  DESCRIPTION_IDEAL_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  PARTNER_LINK_LABELS,
  PARTNER_STATUSES,
  PARTNER_STATUS_LABELS,
  PARTNER_TIER_LABELS,
  PARTNER_TIERS,
  SINGLE_LINK_KINDS,
  isMapsUrl,
  type PartnerServicesView,
  type PartnerStatus,
  type PartnerTier,
  type SingleLinkKind,
} from '~/lib/catalog'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
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
 * un único "Guardar" que mande todo. No es indecisión: son operaciones con
 * consecuencias distintas —pausar saca al taller del marketplace, cargar
 * coordenadas lo hace ordenable, completar el contacto lo hace contactable— y
 * cada una queda como una entrada distinta en `ops.action_log`. Un guardado
 * único produciría un solo registro de auditoría que dice "cambió algo".
 *
 * ── Y por qué Perfil agrupa TRES campos, entonces ───────────────────────────
 *
 * Porque el criterio es la consecuencia, no la cantidad. Zona, descripción y
 * badge de aliado son tres caras de una sola cosa —cómo se ve la tarjeta en el
 * marketplace— y se editan en la misma sentada. Separarlas daría tres entradas
 * de auditoría para un solo acto de edición, que es tan inútil como una sola
 * entrada que dice "cambió algo".
 *
 * ── El orden de las tarjetas ────────────────────────────────────────────────
 *
 * De mayor a menor consecuencia: Estado saca al taller de la app; Perfil y
 * Ubicación deciden si lo encuentran; Contacto y Links, si lo pueden alcanzar.
 */
export function PartnerFicha({ partner }: { partner: Partner }) {
  return (
    <div className="mb-4 grid gap-4 lg:grid-cols-3">
      <StatusCard partner={partner} />
      <ProfileCard partner={partner} />
      <LocationCard partner={partner} />
      <ContactCard partner={partner} />
      <LinksCard partner={partner} />
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

  // ── Migración 008 ──
  if (raw.includes('COVERAGE_ZONE_REQUIRED'))
    return 'La zona de cobertura no puede quedar vacía: la columna es NOT NULL en el backend.'
  if (raw.includes('INVALID_TIER'))
    return 'Ese valor de tier no existe. Los únicos son Aliado (founding) y Estándar.'
  if (raw.includes('LINKS_NOT_AN_ARRAY'))
    return 'Los links viajaron con una forma que el servidor no reconoce. Recargá y probá de nuevo.'
  /**
   * El SP devuelve los kinds inválidos separados por coma, y se muestran.
   * Un "hay un link mal" sin decir CUÁL manda al operador a revisar los ocho
   * campos de a uno.
   */
  if (raw.includes('INVALID_LINK_KIND')) {
    const kinds = raw.split('INVALID_LINK_KIND:')[1]?.trim()
    return kinds
      ? `Tipo de link desconocido: ${kinds}. Recargá la pantalla.`
      : 'Uno de los links tiene un tipo que la base no conoce. Recargá la pantalla.'
  }
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

// ── Perfil ───────────────────────────────────────────────────────────────────

/**
 * Cómo se PRESENTA el partner en la tarjeta del marketplace: zona, descripción
 * y badge de aliado.
 *
 * Los tres en un solo formulario y un solo guardado, a diferencia de las tres
 * tarjetas de la 007. No es una excepción a aquel criterio, es el mismo
 * aplicado: allá eran tres decisiones con consecuencias distintas; acá son tres
 * caras de una sola —cómo se ve la ficha— que se editan en la misma sentada.
 * Tres guardados producirían tres entradas de `ops.action_log` para un acto.
 */
function ProfileCard({ partner }: { partner: Partner }) {
  const { busy, error, saved, run } = useAction()
  const [coverageZone, setCoverageZone] = useState(partner.coverageZone)
  const [description, setDescription] = useState(partner.description ?? '')
  const [tier, setTier] = useState<PartnerTier>(
    // Un valor que el front no conoce cae en `standard` para el CONTROL, pero
    // no se guarda solo: hasta que alguien apriete Guardar, la base sigue
    // teniendo lo suyo. Renderizar un toggle en blanco sería peor.
    PARTNER_TIERS.includes(partner.tier as PartnerTier)
      ? (partner.tier as PartnerTier)
      : 'standard',
  )

  const length = description.trim().length
  const overIdeal = length > DESCRIPTION_IDEAL_LENGTH
  const emptyZone = coverageZone.trim() === ''

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Perfil en el marketplace</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void run(() =>
              setPartnerProfileFn({
                data: { partnerId: partner.id, coverageZone, description, tier },
              }),
            )
          }}
        >
          <div className="space-y-1">
            <label htmlFor="coverageZone" className="block text-xs text-muted-foreground">
              Zona de cobertura
            </label>
            <Input
              id="coverageZone"
              value={coverageZone}
              onChange={(e) => {
                // El valor se lee sincrónicamente, ANTES del updater. Ver el
                // comentario largo en ContactCard: leerlo adentro del updater
                // tira sobre `currentTarget` en null y se cae la pantalla entera.
                const value = e.currentTarget.value
                setCoverageZone(value)
              }}
              placeholder="CABA y GBA norte"
              className="text-xs"
              aria-invalid={emptyZone}
              autoComplete="off"
            />
            {emptyZone ? (
              <p className="text-xs text-destructive">
                No puede quedar vacía: la columna es NOT NULL en el schema del backend.
              </p>
            ) : null}
          </div>

          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor="description" className="block text-xs text-muted-foreground">
                Descripción
              </label>
              {/*
                El contador AVISA y no impide, y esa decisión tiene un número
                atrás: 25 de los 34 partners con descripción ya pasan los 90.
                Un límite duro haría imposible corregirle la zona a tres cuartos
                del directorio. Por eso pasarse pinta ámbar, no rojo: rojo dice
                "esto está mal", ámbar dice "se va a cortar en la tarjeta".
              */}
              <span
                className={cn(
                  'text-xs tabular-nums',
                  overIdeal ? 'text-status-yellow' : 'text-muted-foreground',
                )}
              >
                {length} / {DESCRIPTION_IDEAL_LENGTH}
              </span>
            </div>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => {
                const value = e.currentTarget.value
                setDescription(value)
              }}
              maxLength={DESCRIPTION_MAX_LENGTH}
              rows={3}
              placeholder="Taller mecánico integral en Villa Urquiza."
              className="text-xs"
            />
            {overIdeal ? (
              <p className="text-xs leading-relaxed text-status-yellow">
                Pasa el largo ideal de {DESCRIPTION_IDEAL_LENGTH}: en la tarjeta del marketplace se
                va a ver cortada. Se guarda igual.
              </p>
            ) : null}
          </div>

          <div className="space-y-1">
            <span className="block text-xs text-muted-foreground">Badge de aliado</span>
            <div className="flex flex-wrap gap-1.5">
              {PARTNER_TIERS.map((t) => (
                <button
                  key={t}
                  type="button"
                  disabled={busy}
                  aria-pressed={tier === t}
                  onClick={() => setTier(t)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-50',
                    tier === t
                      ? 'border-transparent bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground',
                  )}
                >
                  {PARTNER_TIER_LABELS[t]}
                </button>
              ))}
            </div>
            {/*
              Se dice en voz alta a qué columna escribe. El equipo lo llama
              "aliado" y la base lo llama `tier`: quien abra DBeaver buscando
              una columna `aliado` no la va a encontrar nunca.
            */}
            <p className="text-xs leading-relaxed text-muted-foreground">
              Escribe <code>partners.tier</code>: Aliado es <code>founding</code>.
            </p>
          </div>

          <Button type="submit" size="sm" disabled={busy || emptyZone} className="gap-1.5">
            <Save className="size-3.5" aria-hidden />
            {busy ? 'Guardando…' : 'Guardar perfil'}
          </Button>
        </form>

        <Feedback error={error} saved={saved} />
      </CardContent>
    </Card>
  )
}

// ── Links ────────────────────────────────────────────────────────────────────

/** Le antepone `https://` a lo que alguien pegó sin protocolo. */
function normalizeUrl(raw: string): string {
  const url = raw.trim()
  if (url === '') return ''
  if (/^https?:\/\//i.test(url)) return url
  return `https://${url}`
}

/**
 * Los links del partner.
 *
 * ── CÓMO SE REPARTEN LOS SIETE KINDS EN LA UI ───────────────────────────────
 *
 * `idx_partner_links_kind_unique` es UNIQUE parcial sobre `(partner_id, kind)`
 * WHERE `kind <> 'other'`. O sea: un Instagram por partner, un Facebook, un
 * TikTok — pero muchos `other`. La UI espeja exactamente eso: campo único para
 * los seis primeros, lista para el resto.
 *
 * ── MAPS ES UN CAMPO PROPIO Y SE GUARDA COMO `other` ────────────────────────
 *
 * El enum del backend no tiene `maps`, y este repo no migra `public`. Pero al
 * 2026-09-04 **10 de los 11 links guardados como `other` son de
 * `maps.app.goo.gl`**: el cajón ya venía siendo el de maps sin que nadie lo
 * dijera. Se le da su campo, y `isMapsUrl()` decide cuál de los `other` va ahí
 * al leer.
 *
 * ── POR QUÉ MERCADO LIBRE ESTÁ, SI NADIE LO PIDIÓ ──────────────────────────
 *
 * Porque el guardado deja la tabla IGUAL al formulario. Un kind que la UI no
 * renderice se borra en el primer guardado, y hoy hay un link de
 * `mercado_libre` en producción que desaparecería sin que nadie lo note. La
 * regla que sale de esto: **si aparece un kind nuevo en el enum, hay que
 * agregarlo acá el mismo día.**
 */
function LinksCard({ partner }: { partner: Partner }) {
  const { busy, error, saved, run } = useAction()

  const [single, setSingle] = useState<Record<SingleLinkKind, string>>(() => {
    const seed = Object.fromEntries(SINGLE_LINK_KINDS.map((k) => [k, ''])) as Record<
      SingleLinkKind,
      string
    >
    for (const link of partner.links) {
      if ((SINGLE_LINK_KINDS as ReadonlyArray<string>).includes(link.kind)) {
        seed[link.kind as SingleLinkKind] = link.url
      }
    }
    return seed
  })

  // Al leer, el primer `other` que parezca de maps sube al campo Maps y el
  // resto queda en la lista. `find` y no `filter`: si alguien cargó dos links
  // de maps, el segundo se queda abajo en "otros" en vez de desaparecer.
  const mapsSeed = partner.links.find((l) => l.kind === 'other' && isMapsUrl(l.url))?.url ?? ''
  const [maps, setMaps] = useState(mapsSeed)

  const [others, setOthers] = useState<Array<string>>(() =>
    partner.links
      .filter((l) => l.kind === 'other' && l.url !== mapsSeed)
      .map((l) => l.url),
  )

  function submit() {
    const links = [
      ...SINGLE_LINK_KINDS.map((kind) => ({ kind, url: normalizeUrl(single[kind]) })),
      { kind: 'other' as const, url: normalizeUrl(maps) },
      ...others.map((url) => ({ kind: 'other' as const, url: normalizeUrl(url) })),
    ].filter((l) => l.url !== '')

    void run(() => setPartnerLinksFn({ data: { partnerId: partner.id, links } }))
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-sm">Links y redes</CardTitle>
        <LinkIcon className="size-4 text-muted-foreground" aria-hidden />
      </CardHeader>
      <CardContent>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {SINGLE_LINK_KINDS.map((kind) => (
              <div key={kind} className="space-y-1">
                <label htmlFor={`link-${kind}`} className="block text-xs text-muted-foreground">
                  {PARTNER_LINK_LABELS[kind]}
                </label>
                <Input
                  id={`link-${kind}`}
                  value={single[kind]}
                  onChange={(e) => {
                    const value = e.currentTarget.value
                    setSingle((prev) => ({ ...prev, [kind]: value }))
                  }}
                  placeholder="https://…"
                  className="text-xs"
                  autoComplete="off"
                />
              </div>
            ))}

            <div className="space-y-1">
              <label htmlFor="link-maps" className="block text-xs text-muted-foreground">
                Maps
              </label>
              <Input
                id="link-maps"
                value={maps}
                onChange={(e) => {
                  const value = e.currentTarget.value
                  setMaps(value)
                }}
                placeholder="https://maps.app.goo.gl/…"
                className="text-xs"
                autoComplete="off"
              />
            </div>
          </div>

          <div className="space-y-1 pt-1">
            <span className="block text-xs text-muted-foreground">Otros links</span>

            {others.map((url, index) => (
              <div key={index} className="flex gap-2">
                <Input
                  value={url}
                  onChange={(e) => {
                    const value = e.currentTarget.value
                    setOthers((prev) => prev.map((u, i) => (i === index ? value : u)))
                  }}
                  placeholder="https://…"
                  className="text-xs"
                  aria-label={`Otro link ${index + 1}`}
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setOthers((prev) => prev.filter((_, i) => i !== index))}
                  aria-label={`Quitar el link ${index + 1}`}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </div>
            ))}

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOthers((prev) => [...prev, ''])}
              className="gap-1.5"
            >
              <Plus className="size-3.5" aria-hidden />
              Agregar otro link
            </Button>
          </div>

          <Button type="submit" size="sm" disabled={busy} className="gap-1.5">
            <Save className="size-3.5" aria-hidden />
            {busy ? 'Guardando…' : 'Guardar links'}
          </Button>
        </form>

        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Un campo vacío BORRA el link. Lo que ves acá es exactamente lo que queda guardado. Si
          pegás una dirección sin <code>https://</code>, se agrega sola.
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Maps se guarda como “otro”: el enum del backend todavía no tiene un tipo propio para
          Google Maps.
        </p>
        <Feedback error={error} saved={saved} />
      </CardContent>
    </Card>
  )
}
