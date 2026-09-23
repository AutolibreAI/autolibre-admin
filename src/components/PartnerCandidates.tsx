import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Check, MapPin, MessageCircle, Save, Send } from 'lucide-react'
import { listPartnerCandidatesFn } from '~/fn/partners'
import { addQuoteRequestInternalNoteFn, setQuoteRequestRubroFn } from '~/fn/quote-requests'
import {
  canonicalWhatsAppDigits,
  isRemoteModality,
  partnerWhatsAppUrl,
  type PartnerCandidate,
} from '~/lib/partners'
import { quotePublicCode, readableQuoteRequestError, type QuoteRequestDetail } from '~/lib/quote-requests'
import { QUOTE_TEMPLATES, renderQuoteTemplate, whatsAppMessageUrl } from '~/lib/quote-templates'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent } from '~/components/ui/card'
import { Chip, FilterGroup } from '~/components/Filters'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { cn } from '~/lib/utils'
import type { ServiceFamily } from '~/lib/catalog'

/**
 * "Me entró este pedido: ¿a qué taller se lo mando?" —
 * `.claude/plans/partners-derivacion.md`, Fase 2.
 *
 * Dos escrituras separadas, y son a propósito distintas en forma:
 *
 *  - **Clasificar el rubro** es DATO: `ops.set_quote_request_rubro` (013).
 *    Habilita "¿qué rubros nos piden más?" con un `group by`.
 *  - **Registrar la derivación** es NOTA INTERNA:
 *    `ops.add_quote_request_internal_note` (011), la misma escritura que ya
 *    usa el hilo de notas de la ficha. NO hay una tabla de derivaciones — el
 *    costo de esa decisión (no se puede saber "cuánto le mandamos a cada
 *    taller" con una consulta) está anotado en el plan, §2.
 *
 * Elegir un rubro en el selector sólo cambia qué se está MIRANDO (viaja en el
 * search param `quoteRubro`, vía `onSelectCategory`) — no persiste nada hasta
 * que se aprieta "Guardar clasificación". Filtrar para mirar no es clasificar.
 *
 * ── Zona y "solo aliados" — filtros de CLIENTE, sin search param ────────────
 *
 * `.claude/plans/cambios-2026-09-17.md`, punto C. A diferencia de `quoteRubro`,
 * que cambia la CONSULTA (el loader vuelve a pedir candidatos de ese rubro),
 * zona y aliado sólo PODAN lo que ya vino — como mucho 46 filas. Van en
 * `useState`, no en la URL: cero round-trips, cero search param nuevo (cero
 * riesgo de colisión en `FullSearchSchema`), y el filtro es de trabajo dentro
 * de una ficha que ya se abrió — que un link pegado no lo reproduzca no cuesta
 * nada.
 */

const MIN_LOCATED_SHARE = 0.5

interface PartnerCandidatesProps {
  quoteRequestId: string
  publicNumber: number
  /**
   * El pedido entero, para armar el mensaje de "Pedir cotización" —
   * `renderQuoteTemplate` con la plantilla `cotizacion_red` necesita el
   * vehículo, la descripción y la localidad de ESTE pedido.
   */
  detail: QuoteRequestDetail
  /** El pedido tiene coordenadas (`location_source = 'device'`). */
  pedidoHasLocation: boolean
  catalog: Array<ServiceFamily>
  /** Las zonas que hoy declaran los partners, para los chips de zona. */
  zones: Array<string>
  /** Lo que hay guardado en `ops.quote_request_rubro`, si algo. */
  savedCategorySlug: string | null
  /** El rubro efectivo que se está mirando: `quoteRubro` de la URL, o el guardado. */
  selectedCategorySlug: string | null
  candidates: Array<PartnerCandidate>
  onSelectCategory: (slug: string | undefined) => void
}

const COTIZACION_RED_TEMPLATE = QUOTE_TEMPLATES.find((t) => t.id === 'cotizacion_red')!

export function PartnerCandidates({
  quoteRequestId,
  publicNumber,
  detail,
  pedidoHasLocation,
  catalog,
  zones,
  savedCategorySlug,
  selectedCategorySlug,
  candidates,
  onSelectCategory,
}: PartnerCandidatesProps) {
  const router = useRouter()
  const [savingRubro, setSavingRubro] = useState(false)
  const [rubroError, setRubroError] = useState<string | null>(null)
  const [zoneFilter, setZoneFilter] = useState<Array<string>>([])
  const [onlyFounding, setOnlyFounding] = useState(false)

  const categories = catalog.map((f) => ({ slug: f.slug, name: f.name }))
  const dirty = selectedCategorySlug !== null && selectedCategorySlug !== savedCategorySlug

  // Mismo texto para todos los candidatos — sólo cambia el destinatario. Se
  // arma una vez acá, no por fila, y sin `responses`: la plantilla «red» no
  // usa presupuestos, así que pedirlos de nuevo sería una consulta de más.
  const quoteMessage = renderQuoteTemplate(COTIZACION_RED_TEMPLATE, detail)

  /**
   * Zona por CONTENCIÓN, igual que el filtro del listado y el tablero de
   * cobertura: con igualdad exacta, un partner que declara dos zonas en el
   * mismo campo de texto (`"CABA, Zona Norte"`) desaparecería justo cuando el
   * operador busca una de las suyas.
   */
  const visibleCandidates = candidates.filter((c) => {
    if (onlyFounding && c.tier !== 'founding') return false
    if (zoneFilter.length === 0) return true
    const zone = c.coverageZone.toLowerCase()
    return zoneFilter.some((z) => zone.includes(z.toLowerCase()))
  })

  async function saveRubro() {
    if (!selectedCategorySlug) return
    setSavingRubro(true)
    setRubroError(null)
    try {
      await setQuoteRequestRubroFn({
        data: { quoteRequestId, categorySlug: selectedCategorySlug },
      })
      await router.invalidate()
    } catch (cause) {
      setRubroError(readableQuoteRequestError(cause))
    } finally {
      setSavingRubro(false)
    }
  }

  const located = visibleCandidates.filter((c) => c.distanceKm !== null).length
  const locatedShare = visibleCandidates.length > 0 ? located / visibleCandidates.length : 1

  const remote = visibleCandidates.filter((c) => isRemoteModality(c.modality))
  const local = visibleCandidates.filter((c) => !isRemoteModality(c.modality))

  const zoneFilterActive = zoneFilter.length > 0 || onlyFounding

  return (
    <Card className="mb-4">
      <CardContent className="space-y-4 pt-6">
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-base font-semibold">Derivar a un taller</h2>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <label
              htmlFor="quote-rubro"
              className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              Rubro del pedido
            </label>
            <Select
              value={selectedCategorySlug ?? undefined}
              onValueChange={(v) => onSelectCategory(v)}
            >
              <SelectTrigger id="quote-rubro" className="w-64 shadow-none">
                <SelectValue placeholder="Elegí un rubro…" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.slug} value={c.slug}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {dirty ? (
            <Button size="sm" variant="outline" disabled={savingRubro} onClick={() => void saveRubro()} className="gap-1.5">
              <Save className="size-3.5" aria-hidden />
              {savingRubro ? 'Guardando…' : 'Guardar clasificación'}
            </Button>
          ) : selectedCategorySlug && selectedCategorySlug === savedCategorySlug ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Check className="size-3.5 text-status-green" aria-hidden />
              clasificación guardada
            </span>
          ) : null}
        </div>

        {rubroError ? (
          <p role="alert" className="text-sm text-destructive">
            {rubroError}
          </p>
        ) : null}

        {!selectedCategorySlug ? (
          <p className="text-sm text-muted-foreground">
            Elegí un rubro para ver qué partners activos lo cubren.
          </p>
        ) : (
          <div className="space-y-4">
            {candidates.length > 0 ? (
              <div className="flex flex-wrap items-end gap-4">
                <FilterGroup
                  label="Zona"
                  onClear={zoneFilter.length > 0 ? () => setZoneFilter([]) : undefined}
                >
                  {zones.map((zone) => (
                    <Chip
                      key={zone}
                      active={zoneFilter.includes(zone)}
                      onClick={() =>
                        setZoneFilter(
                          zoneFilter.includes(zone)
                            ? zoneFilter.filter((z) => z !== zone)
                            : [...zoneFilter, zone],
                        )
                      }
                    >
                      {zone}
                    </Chip>
                  ))}
                </FilterGroup>

                <FilterGroup label="Aliado">
                  <Chip active={onlyFounding} onClick={() => setOnlyFounding(!onlyFounding)}>
                    Solo aliados
                  </Chip>
                </FilterGroup>
              </div>
            ) : null}

            {!pedidoHasLocation ? (
              <p className="rounded-md border border-status-yellow/30 bg-status-yellow-bg px-3 py-2 text-xs leading-relaxed text-status-yellow">
                Este pedido no tiene coordenadas cargadas (la persona tipeó la dirección en vez de dar
                permiso de ubicación) — no hay distancia que calcular para ningún candidato. Guiate por
                la zona.
              </p>
            ) : visibleCandidates.length > 0 && locatedShare < MIN_LOCATED_SHARE ? (
              <p className="rounded-md border border-status-yellow/30 bg-status-yellow-bg px-3 py-2 text-xs leading-relaxed text-status-yellow">
                Sólo {located} de {visibleCandidates.length} candidatos tienen ubicación cargada — el
                orden por distancia no es confiable todavía.
              </p>
            ) : visibleCandidates.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {located} de {visibleCandidates.length} candidatos tienen ubicación cargada.
              </p>
            ) : null}

            {candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">No hay partners activos con este rubro.</p>
            ) : visibleCandidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Ningún candidato con este filtro{zoneFilterActive ? ' de zona / aliado' : ''}.
              </p>
            ) : (
              <div className="space-y-2">
                {local.map((c) => (
                  <CandidateRow
                    key={c.id}
                    candidate={c}
                    quoteRequestId={quoteRequestId}
                    publicNumber={publicNumber}
                    quoteMessage={quoteMessage}
                  />
                ))}
              </div>
            )}

            {remote.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  A domicilio / a distancia — la distancia no aplica
                </p>
                {remote.map((c) => (
                  <CandidateRow
                    key={c.id}
                    candidate={c}
                    quoteRequestId={quoteRequestId}
                    publicNumber={publicNumber}
                    quoteMessage={quoteMessage}
                  />
                ))}
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function CandidateRow({
  candidate: c,
  quoteRequestId,
  publicNumber,
  quoteMessage,
}: {
  candidate: PartnerCandidate
  quoteRequestId: string
  publicNumber: number
  /** El texto de la plantilla «Pedir cotización — red», ya renderizado para este pedido. */
  quoteMessage: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const whatsAppUrl = c.whatsapp ? partnerWhatsAppUrl(c.whatsapp, c.name, quotePublicCode(publicNumber)) : null
  // Mismo criterio de teléfono que el resto del repo: sin la forma canónica
  // (`549` + 10 dígitos) no hay link — adivinar la característica le
  // escribiría a otra persona.
  const quoteUrl = whatsAppMessageUrl(canonicalWhatsAppDigits(c.whatsapp ?? ''), quoteMessage)

  async function registerReferral() {
    setBusy(true)
    setError(null)
    try {
      await addQuoteRequestInternalNoteFn({
        data: {
          quoteRequestId,
          text: `Derivado a "${c.name}" (${c.coverageZone}) por WhatsApp.`,
        },
      })
      await router.invalidate()
      setDone(true)
    } catch (cause) {
      setError(readableQuoteRequestError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{c.name}</span>
            {c.tier === 'founding' ? (
              <Badge variant="outline" className="border-brand/30 bg-brand-soft text-brand">
                Aliado
              </Badge>
            ) : null}
            {isRemoteModality(c.modality) ? (
              <Badge variant="outline" className="border-border text-muted-foreground">
                {c.modality}
              </Badge>
            ) : null}
          </div>
          <div className="text-xs text-muted-foreground">
            {c.coverageZone}
            {c.hours ? ` · ${c.hours}` : ''}
          </div>
          {c.matchedServices.length > 0 ? (
            <div className="flex flex-wrap gap-1 pt-1">
              {c.matchedServices.map((s) => (
                <span
                  key={s.slug}
                  className="rounded border border-border px-1.5 py-px text-xs text-muted-foreground"
                >
                  {s.name}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {!isRemoteModality(c.modality) ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 text-xs tabular-nums',
                c.distanceKm === null ? 'text-muted-foreground' : 'text-foreground',
              )}
            >
              <MapPin className="size-3" aria-hidden />
              {c.distanceKm === null ? 'sin ubicación' : `${c.distanceKm.toFixed(1)} km`}
            </span>
          ) : null}

          <div className="flex items-center gap-1.5">
            {/*
              "Abrir el chat no escribe nada — ni nota interna, ni derivación.
              Igual que el link a la persona hoy." Si se quiere que quede
              registro de a quién se le pidió cotización, es la nota interna
              de "Registrar derivación", a un click de acá.
            */}
            {quoteUrl ? (
              <a
                href={quoteUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-brand/30 bg-brand-soft px-2.5 text-xs text-brand hover:brightness-95"
              >
                <Send className="size-3.5" aria-hidden />
                Pedir cotización
              </a>
            ) : null}

            {whatsAppUrl ? (
              <a
                href={whatsAppUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-status-green/30 bg-status-green-bg px-2.5 text-xs text-status-green hover:brightness-95"
              >
                <MessageCircle className="size-3.5" aria-hidden />
                WhatsApp
              </a>
            ) : (
              <span className="text-xs text-muted-foreground">sin WhatsApp válido</span>
            )}

            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || done}
              onClick={() => void registerReferral()}
              className="h-7 gap-1.5 px-2.5 text-xs"
            >
              {done ? <Check className="size-3.5 text-status-green" aria-hidden /> : null}
              {done ? 'Registrado' : busy ? 'Registrando…' : 'Registrar derivación'}
            </Button>
          </div>
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
