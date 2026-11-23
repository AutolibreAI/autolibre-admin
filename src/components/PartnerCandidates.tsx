import { useState } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { Check, List, Map as MapIcon, MapPin, MessageCircle, Save, Send, Sparkles } from 'lucide-react'
import { addQuoteRequestInternalNoteFn } from '~/fn/quote-requests'
import { correctQuoteRequestServicesFn } from '~/fn/quote-services'
import { readableQuoteServicesError, sameServiceSet } from '~/lib/quote-services'
import {
  canonicalWhatsAppDigits,
  isRemoteModality,
  partnerWhatsAppUrl,
  type PartnerCandidate,
} from '~/lib/partners'
import {
  AI_SERVICE_LOW_SCORE,
  isDirectedQuote,
  quoteMapLocation,
  quotePublicCode,
  readableQuoteRequestError,
  requestedPartnerNames,
  type QuoteRequestDetail,
} from '~/lib/quote-requests'
import { renderQuoteTemplate, whatsAppMessageUrl, type QuoteMessageTemplate } from '~/lib/quote-templates'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent } from '~/components/ui/card'
import { Chip, FilterGroup } from '~/components/Filters'
import { MultiSelect } from '~/components/MultiSelect'
import { cn } from '~/lib/utils'
import { formatKm } from '~/lib/format'
import { PartnerMap, type MapPartnerPin } from '~/components/PartnerMap'
import type { ServiceFamily } from '~/lib/catalog'

/**
 * "Me entró este pedido: ¿a qué taller se lo mando?" —
 * `.claude/plans/partners-derivacion.md`, Fase 2. Multiselect de rubros desde
 * la 016 (`.claude/plans/pedidos-ficha-2026-09-25.md`): un pedido puede pedir
 * más de una cosa, y el candidato correcto es el que cubre el MÁXIMO de
 * rubros pedidos — `listPartnerCandidates` ya ordena por eso.
 *
 * Dos escrituras separadas, y son a propósito distintas en forma:
 *
 *  - **Clasificar** es DATO, y desde el 2026-11-19 son SERVICIOS, no rubros:
 *    «Guardar clasificación» manda los servicios elegidos al BACKEND
 *    (`PUT /admin/quote-requests/:id/services`, 0155), que es lo que lee el
 *    despacho por WhatsApp (candidatos y el `{{2}}` del template). Antes
 *    guardaba familias en `ops.set_quote_request_rubros` (016), que el backend
 *    nunca leyó: corregir no cambiaba nada del despacho. La 016 se sigue
 *    escribiendo como espejo (familias derivadas de los servicios) porque la
 *    leen esta ficha y `/partners/estudio`. → `~/fn/quote-services`
 *  - **Registrar la derivación** es NOTA INTERNA:
 *    `ops.add_quote_request_internal_note` (011), la misma escritura que ya
 *    usa el hilo de notas de la ficha. NO hay una tabla de derivaciones — el
 *    costo de esa decisión (no se puede saber "cuánto le mandamos a cada
 *    taller" con una consulta) está anotado en el plan, §2.
 *
 * Elegir rubros en el selector sólo cambia qué se está MIRANDO (viaja en el
 * search param `quoteRubros`, vía `onChangeCategories`) — no persiste nada
 * hasta que se aprieta "Guardar clasificación". Filtrar para mirar no es
 * clasificar.
 *
 * ── Zona y "solo aliados" — filtros de CLIENTE, sin search param ────────────
 *
 * `.claude/plans/cambios-2026-09-17.md`, punto C. A diferencia de
 * `quoteRubros`, que cambia la CONSULTA (el loader vuelve a pedir candidatos),
 * zona y aliado sólo PODAN lo que ya vino — como mucho 46 filas. Van en
 * `useState`, no en la URL: cero round-trips, cero search param nuevo (cero
 * riesgo de colisión en `FullSearchSchema`), y el filtro es de trabajo dentro
 * de una ficha que ya se abrió — que un link pegado no lo reproduzca no cuesta
 * nada. Zona usa el mismo `MultiSelect` que el selector de rubros (antes eran
 * chips sueltas, que no escalaban a las ~30 zonas del directorio).
 *
 * ── Orden y mapa — desde el 2026-10-03 ──────────────────────────────────────
 *
 * El orden por default es la DISTANCIA (del más cercano al más lejano, en
 * línea recta entre las coordenadas del pedido y las del taller); "sin
 * ubicación" va al final, nunca se lee como "lejos". Con más de un rubro
 * pedido queda a un click el orden anterior —más rubros cubiertos primero—,
 * que sigue siendo el criterio correcto cuando se quiere UN solo taller para
 * todo. Los dos son del cliente: la lista ya vino entera.
 *
 * "Mapa" muestra el pedido y los candidatos VISIBLES (mismos filtros que la
 * lista). Vista y orden van en `useState` por el mismo motivo que zona.
 *
 * ── Servicios dentro de los rubros — desde el 2026-10-21 ────────────────────
 *
 * Un rubro es ancho ("Motor" son una docena de servicios) y el pedido suele
 * ser uno puntual. El segundo selector ofrece los `services` del CATÁLOGO de
 * los rubros elegidos —no sólo los que algún candidato cubre: uno que no cubre
 * nadie es un dato, y sale con "(0)"— y poda contra `matchedServices`, que ya
 * viene en cada candidato. Dentro del selector es O (cubre alguno de los
 * elegidos), igual que los multiselect de `/partners/listado`. Filtro de
 * cliente, en `useState`, por el mismo motivo que zona. Si se saca un rubro,
 * sus servicios dejan de filtrar solos (se intersecan con las opciones), en
 * vez de dejar un filtro invisible que vacía la lista.
 */

type CandidateOrder = 'distance' | 'coverage'
type CandidateView = 'list' | 'map'

/** Distancia ascendente, sin ubicación al final; desempata por rubros cubiertos y aliado. */
function byDistance(a: PartnerCandidate, b: PartnerCandidate): number {
  if (a.distanceKm !== b.distanceKm) {
    if (a.distanceKm === null) return 1
    if (b.distanceKm === null) return -1
    return a.distanceKm - b.distanceKm
  }
  return byCoverage(a, b)
}

/** Más rubros pedidos cubiertos primero; desempata por distancia, aliado y nombre. */
function byCoverage(a: PartnerCandidate, b: PartnerCandidate): number {
  const cov = b.matchedCategories.length - a.matchedCategories.length
  if (cov !== 0) return cov
  if (a.distanceKm !== b.distanceKm) {
    if (a.distanceKm === null) return 1
    if (b.distanceKm === null) return -1
    return a.distanceKm - b.distanceKm
  }
  if ((a.tier === 'founding') !== (b.tier === 'founding')) return a.tier === 'founding' ? -1 : 1
  return a.name.localeCompare(b.name, 'es')
}

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
  /** Las plantillas vigentes (semilla o editadas) — de acá sale `cotizacion_red`. */
  templates: Array<QuoteMessageTemplate>
  /** El pedido tiene un punto en el mapa: GPS, geocode del backend o el punto viejo del panel (`quoteMapLocation`). */
  pedidoHasLocation: boolean
  catalog: Array<ServiceFamily>
  /** Las zonas que hoy declaran los partners, para el selector de zona. */
  zones: Array<string>
  /** Lo que hay guardado en `ops.quote_request_rubro`, si algo. */
  savedCategorySlugs: Array<string>
  /** La corrección de servicios que lee el backend (0155). `null` = la base no la tiene. */
  savedServiceSlugs: Array<string> | null
  /** Los rubros efectivos que se están mirando: `quoteRubros` de la URL, o los guardados. */
  selectedCategorySlugs: Array<string>
  candidates: Array<PartnerCandidate>
  onChangeCategories: (slugs: Array<string>) => void
}

export function PartnerCandidates({
  quoteRequestId,
  publicNumber,
  detail,
  templates,
  pedidoHasLocation,
  catalog,
  zones,
  savedCategorySlugs,
  savedServiceSlugs,
  selectedCategorySlugs,
  candidates,
  onChangeCategories,
}: PartnerCandidatesProps) {
  const router = useRouter()
  const [savingRubro, setSavingRubro] = useState(false)
  const [rubroError, setRubroError] = useState<string | null>(null)
  const [rubroWarning, setRubroWarning] = useState<string | null>(null)
  const [zoneFilter, setZoneFilter] = useState<Array<string>>([])
  // Arrancan tildados los servicios de la corrección guardada en el backend;
  // si no hay, los que sugirió la IA (0124). Es sólo el valor inicial: el
  // operador los cambia, y fuera de los rubros elegidos dejan de contar solos
  // (`activeServiceFilter` interseca con las opciones). El componente se monta
  // con `key` por pedido, así que no arrastra la sugerencia de otro.
  const ai = detail.aiClassification
  const aiServices = ai.available ? ai.services : []
  const savedServices = savedServiceSlugs ?? []
  const [serviceFilter, setServiceFilter] = useState<Array<string>>(() =>
    savedServices.length > 0 ? savedServices : aiServices.map((s) => s.serviceSlug),
  )
  const [onlyFounding, setOnlyFounding] = useState(false)
  const [order, setOrder] = useState<CandidateOrder>('distance')
  const [view, setView] = useState<CandidateView>('list')

  const categories = catalog.map((f) => ({ slug: f.slug, name: f.name }))
  const selectedSet = new Set(selectedCategorySlugs)

  // Los servicios de los rubros elegidos, en orden de catálogo. Con más de un
  // rubro, el nombre lleva el rubro adelante: "Frenos" de dos familias distintas
  // no se distinguirían en el selector.
  const serviceCoverage = new Map<string, number>()
  for (const c of candidates) {
    for (const s of c.matchedServices) serviceCoverage.set(s.slug, (serviceCoverage.get(s.slug) ?? 0) + 1)
  }
  const selectedFamilies = catalog.filter((f) => selectedSet.has(f.slug))
  const serviceOptions = selectedFamilies.flatMap((f) =>
    f.services.map((s) => ({
      value: s.slug,
      label: `${selectedFamilies.length > 1 ? `${f.name} · ` : ''}${s.name} (${serviceCoverage.get(s.slug) ?? 0})`,
    })),
  )
  const serviceOptionSet = new Set(serviceOptions.map((o) => o.value))
  const activeServiceFilter = serviceFilter.filter((slug) => serviceOptionSet.has(slug))
  // Lo que se guarda son los SERVICIOS elegidos (el backend los exige: al menos
  // uno). Cambió si difiere de la corrección guardada, como conjunto.
  const dirty = activeServiceFilter.length > 0 && !sameServiceSet(activeServiceFilter, savedServices)

  // Mismo texto para todos los candidatos — sólo cambia el destinatario. Se
  // arma una vez acá, no por fila, y sin `responses`: la plantilla «red» no
  // usa presupuestos, así que pedirlos de nuevo sería una consulta de más.
  // Si la plantilla todavía no llegó del loader (no debería pasar: la semilla
  // siempre está), no hay mensaje que armar y el botón "Pedir cotización" no
  // se ofrece — ver `CandidateRow`.
  const cotizacionRedTemplate = templates.find((t) => t.id === 'cotizacion_red') ?? null
  const quoteMessage = cotizacionRedTemplate ? renderQuoteTemplate(cotizacionRedTemplate, detail) : null

  /**
   * Zona por CONTENCIÓN, igual que el filtro del listado y el tablero de
   * cobertura: con igualdad exacta, un partner que declara dos zonas en el
   * mismo campo de texto (`"CABA, Zona Norte"`) desaparecería justo cuando el
   * operador busca una de las suyas.
   */
  const requestedIds = new Set((detail.requestedPartners ?? []).map((p) => p.id.toLowerCase()))
  const directed = isDirectedQuote(detail)
  // ¿Alguno de los elegidos quedó fuera de los candidatos de estos rubros?
  const requestedOutside = (detail.requestedPartners ?? []).filter(
    (p) => !candidates.some((c) => c.id.toLowerCase() === p.id.toLowerCase()),
  )
  const visibleCandidates = candidates
    .filter((c) => {
      if (onlyFounding && c.tier !== 'founding') return false
      if (
        activeServiceFilter.length > 0 &&
        !c.matchedServices.some((s) => activeServiceFilter.includes(s.slug))
      ) {
        return false
      }
      if (zoneFilter.length === 0) return true
      const zone = c.coverageZone.toLowerCase()
      return zoneFilter.some((z) => zone.includes(z.toLowerCase()))
    })
    .sort((a, b) => {
      // El taller que eligió la persona desde la app va PRIMERO, sea cual sea
      // el orden: en un pedido dirigido es a quien hay que mandárselo.
      const ra = requestedIds.has(a.id.toLowerCase())
      if (ra !== requestedIds.has(b.id.toLowerCase())) return ra ? -1 : 1
      return (order === 'distance' || selectedCategorySlugs.length < 2 ? byDistance : byCoverage)(a, b)
    })

  // GPS; si no, el geocode del backend; si no, el punto viejo del panel (021,
  // sólo lectura). El MISMO punto con el que el loader pidió los candidatos.
  const pedidoPoint = quoteMapLocation(detail)
  const pedidoLocation = pedidoPoint ? { lat: pedidoPoint.lat, lng: pedidoPoint.lng } : null
  const fromTypedAddress = pedidoPoint !== null && detail.locationLatitude === null
  const mapCandidates: Array<MapPartnerPin> = visibleCandidates.flatMap((c) =>
    c.location
      ? [
          {
            id: c.id,
            name: c.name,
            coverageZone: c.coverageZone,
            founding: c.tier === 'founding',
            distanceKm: c.distanceKm,
            location: c.location,
          },
        ]
      : [],
  )
  const offMap = visibleCandidates.length - mapCandidates.length

  async function saveRubro() {
    setSavingRubro(true)
    setRubroError(null)
    setRubroWarning(null)
    try {
      const result = await correctQuoteRequestServicesFn({
        data: { quoteRequestId, serviceSlugs: activeServiceFilter },
      })
      if (!result.legacySynced)
        setRubroWarning(
          'Se guardó para el despacho, pero no el registro de rubros del panel (la lista de rubros de esta ficha y el Estudio pueden quedar viejos).',
        )
      // Relee la ficha: el borrador del despacho se recalcula con la corrección.
      await router.invalidate()
    } catch (cause) {
      setRubroError(readableQuoteServicesError(cause).text)
    } finally {
      setSavingRubro(false)
    }
  }

  const located = visibleCandidates.filter((c) => c.distanceKm !== null).length
  const locatedShare = visibleCandidates.length > 0 ? located / visibleCandidates.length : 1

  const remote = visibleCandidates.filter((c) => isRemoteModality(c.modality))
  const local = visibleCandidates.filter((c) => !isRemoteModality(c.modality))

  const filterActive = zoneFilter.length > 0 || onlyFounding || activeServiceFilter.length > 0

  return (
    <Card className="mb-4">
      <CardContent className="space-y-4 pt-6">
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-base font-semibold">Derivar a un taller</h2>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Rubros del pedido
            </span>
            <MultiSelect
              label="Rubros del pedido"
              options={categories.map((c) => ({ value: c.slug, label: c.name }))}
              selected={selectedCategorySlugs}
              onChange={onChangeCategories}
              placeholder="Elegí uno o más rubros…"
              searchPlaceholder="Buscar rubro…"
              className="w-64"
            />
          </div>

          {serviceOptions.length > 0 ? (
            <div className="space-y-1.5">
              <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Servicios del pedido
              </span>
              <MultiSelect
                label="Servicios del pedido"
                options={serviceOptions}
                selected={activeServiceFilter}
                onChange={setServiceFilter}
                placeholder="Elegí los servicios…"
                searchPlaceholder="Buscar servicio…"
                className="w-64"
              />
            </div>
          ) : null}

          {dirty ? (
            <Button size="sm" variant="outline" disabled={savingRubro} onClick={() => void saveRubro()} className="gap-1.5">
              <Save className="size-3.5" aria-hidden />
              {savingRubro ? 'Guardando…' : 'Guardar clasificación'}
            </Button>
          ) : activeServiceFilter.length > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Check className="size-3.5 text-status-green" aria-hidden />
              clasificación guardada
            </span>
          ) : selectedCategorySlugs.length > 0 ? (
            <span className="text-xs text-muted-foreground">Elegí al menos un servicio para guardar la clasificación.</span>
          ) : null}
        </div>

        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
          «Guardar clasificación» guarda los SERVICIOS en el backend: el despacho por WhatsApp sugiere a quien cubra al
          menos uno y se los nombra al taller en este orden. Los rubros sólo acotan la lista de servicios.
        </p>

        {rubroError ? (
          <p role="alert" className="text-sm text-destructive">
            {rubroError}
          </p>
        ) : null}
        {rubroWarning ? (
          <p role="status" className="text-sm text-status-yellow">
            {rubroWarning}
          </p>
        ) : null}

        <AiSuggestion classification={ai} usedForRubros={savedCategorySlugs.length === 0 && savedServices.length === 0} />


        {selectedCategorySlugs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Elegí uno o más rubros para ver qué partners activos los cubren.
          </p>
        ) : (
          <div className="space-y-4">
            {candidates.length > 0 ? (
              <div className="flex flex-wrap items-end gap-4">
                <div className="space-y-1.5">
                  <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Zona
                  </span>
                  <MultiSelect
                    label="Zona"
                    options={zones.map((z) => ({ value: z, label: z }))}
                    selected={zoneFilter}
                    onChange={setZoneFilter}
                    placeholder="Todas"
                    searchPlaceholder="Buscar zona…"
                    className="w-48"
                  />
                </div>

                <FilterGroup label="Aliado">
                  <Chip active={onlyFounding} onClick={() => setOnlyFounding(!onlyFounding)}>
                    Solo aliados
                  </Chip>
                </FilterGroup>

                {selectedCategorySlugs.length > 1 && view === 'list' ? (
                  <FilterGroup label="Orden">
                    <Chip active={order === 'distance'} onClick={() => setOrder('distance')}>
                      Más cerca primero
                    </Chip>
                    <Chip active={order === 'coverage'} onClick={() => setOrder('coverage')}>
                      Más rubros cubiertos
                    </Chip>
                  </FilterGroup>
                ) : null}

                <FilterGroup label="Vista">
                  <Chip active={view === 'list'} onClick={() => setView('list')}>
                    <List className="size-3.5" aria-hidden /> Lista
                  </Chip>
                  <Chip active={view === 'map'} onClick={() => setView('map')}>
                    <MapIcon className="size-3.5" aria-hidden /> Mapa
                  </Chip>
                </FilterGroup>
              </div>
            ) : null}

            {directed ? (
              <p className="rounded-md border border-brand/30 bg-brand-soft px-3 py-2 text-xs leading-relaxed text-brand">
                La persona eligió {requestedPartnerNames(detail)} desde la app
                {requestedOutside.length === 0
                  ? ': está primero en la lista, marcado «Elegido por la persona».'
                  : `. ${requestedOutside.map((p) => p.name).join(', ')} no cubre los rubros elegidos acá: abrí su ficha desde la tarjeta Pedido para escribirle.`}
                {detail.geocode.status === 'no_location'
                  ? ' Que el pedido no tenga ubicación es normal en este caso (la app no la pide): sólo hace falta para buscar otros talleres.'
                  : ''}
              </p>
            ) : null}

            {!pedidoHasLocation ? (
              // Dirigido y sin ubicación: ya lo explica el aviso de arriba.
              directed && detail.geocode.status === 'no_location' ? null : (
              <p className="rounded-md border border-status-yellow/30 bg-status-yellow-bg px-3 py-2 text-xs leading-relaxed text-status-yellow">
                {detail.geocode.status === 'no_location'
                  ? 'Este pedido no tiene ubicación: no hay distancia que calcular. Cargala con «Corregir ubicación», en la tarjeta Pedido.'
                  : detail.geocode.status === 'not_found'
                    ? 'No se pudo ubicar la dirección del pedido: corregila con «Corregir ubicación», en la tarjeta Pedido.'
                    : 'La dirección del pedido todavía no está ubicada en el mapa: mirá «Geocodificar» en la tarjeta Pedido.'}
              </p>
              )
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

            {fromTypedAddress ? (
              <p className="text-xs text-muted-foreground">
                {pedidoPoint?.source === 'legacy'
                  ? 'La ubicación del pedido es la aproximada del panel (anterior al geocodificador del backend): las distancias son aproximadas.'
                  : 'La ubicación del pedido sale de la dirección tipeada, geocodificada por el backend — no del GPS del teléfono.'}
              </p>
            ) : null}

            {candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No hay partners activos con {selectedCategorySlugs.length === 1 ? 'este rubro' : 'estos rubros'}.
              </p>
            ) : visibleCandidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Ningún candidato con {filterActive ? 'estos filtros de servicio / zona / aliado' : 'este filtro'}.
              </p>
            ) : view === 'map' ? (
              <div className="space-y-2">
                <PartnerMap
                  center={pedidoLocation}
                  pins={mapCandidates}
                  centerLabel={pedidoPoint?.approximate ? 'El pedido (ubicación aproximada)' : 'El pedido'}
                />
                {offMap > 0 || !pedidoLocation ? (
                  <p className="text-xs text-muted-foreground">
                    {[
                      !pedidoLocation ? 'el pedido no tiene coordenadas, así que no tiene pin' : null,
                      offMap > 0
                        ? `${offMap} de ${visibleCandidates.length} candidatos no tienen ubicación cargada y no aparecen`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                      .replace(/^./, (ch) => ch.toUpperCase())}
                    .
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="space-y-2">
                {local.map((c) => (
                  <CandidateRow
                    key={c.id}
                    candidate={c}
                    quoteRequestId={quoteRequestId}
                    publicNumber={publicNumber}
                    quoteMessage={quoteMessage}
                    requested={requestedIds.has(c.id.toLowerCase())}
                  />
                ))}
              </div>
            )}

            {remote.length > 0 && view === 'list' ? (
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
                    requested={requestedIds.has(c.id.toLowerCase())}
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
  requested,
}: {
  candidate: PartnerCandidate
  quoteRequestId: string
  publicNumber: number
  /** La persona eligió este taller desde su ficha en la app. */
  requested: boolean
  /**
   * El texto de la plantilla «Pedir cotización — red», ya renderizado para
   * este pedido. `null` si la plantilla todavía no llegó del loader (no
   * debería pasar: la semilla siempre está) — sin texto no hay botón.
   */
  quoteMessage: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const whatsAppUrl = c.whatsapp ? partnerWhatsAppUrl(c.whatsapp, c.name, quotePublicCode(publicNumber)) : null
  // Mismo criterio de teléfono que el resto del repo: sin la forma canónica
  // (`549` + 10 dígitos) no hay link — adivinar la característica le
  // escribiría a otra persona.
  const quoteUrl =
    quoteMessage !== null ? whatsAppMessageUrl(canonicalWhatsAppDigits(c.whatsapp ?? ''), quoteMessage) : null

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
            {/* La ficha del proveedor en el admin, en el mismo lugar donde se decide a quién derivar. */}
            <Link
              to="/partners/$partnerId"
              params={{ partnerId: c.id }}
              className="font-medium text-brand hover:underline"
            >
              {c.name}
            </Link>
            {requested ? (
              <Badge className="border-transparent bg-brand text-white">Elegido por la persona</Badge>
            ) : null}
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
          {c.matchedCategories.length > 0 ? (
            <div className="flex flex-wrap gap-1 pt-1">
              {c.matchedCategories.map((cat) => (
                <Badge key={cat.slug} variant="outline" className="border-brand/30 bg-brand-soft text-brand">
                  {cat.name}
                </Badge>
              ))}
            </div>
          ) : null}
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
              {c.distanceKm === null ? 'sin ubicación' : formatKm(c.distanceKm)}
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

/**
 * Lo que sugirió el clasificador del backend (0124), a la vista: qué servicios,
 * de qué rubro y con qué score. Los scores no están calibrados (2026-10-27): lo
 * que queda por debajo de `AI_SERVICE_LOW_SCORE` se marca en ámbar como dudoso,
 * no se esconde. Sin la 0124 en la base no se dice nada.
 */
function AiSuggestion({
  classification,
  usedForRubros,
}: {
  classification: QuoteRequestDetail['aiClassification']
  /** Sin rubros guardados por el operador, los rubros de arriba salieron de acá. */
  usedForRubros: boolean
}) {
  if (!classification.available) return null

  if (classification.classifiedAt === null) {
    return (
      <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Sparkles className="size-3.5" aria-hidden />
        Sin clasificación automática (todavía clasificando, o es un pedido anterior al clasificador).
      </p>
    )
  }

  if (classification.services.length === 0) {
    return (
      <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Sparkles className="size-3.5" aria-hidden />
        La clasificación automática no encontró ningún servicio para este pedido.
      </p>
    )
  }

  return (
    <div className="space-y-1.5 rounded-md border border-border px-3 py-2">
      <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Sparkles className="size-3.5" aria-hidden />
        Sugerido por la clasificación automática
        {usedForRubros ? ' — los rubros y servicios de arriba arrancan tildados con esto' : ' — los servicios arrancan tildados'}
        . Es una sugerencia: cambiala si no corresponde.
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {classification.services.map((s) => {
          const low = s.score < AI_SERVICE_LOW_SCORE
          return (
            <li key={s.serviceSlug}>
              <Badge
                variant="outline"
                className={cn('gap-1 font-normal', low && 'border-status-yellow/30 bg-status-yellow-bg text-status-yellow')}
                title={low ? 'Score bajo: puede ser un falso positivo' : undefined}
              >
                {s.categoryName} · {s.serviceName}
                <span className="tabular-nums text-muted-foreground">{s.score.toFixed(2)}</span>
                {low ? <span>· dudoso</span> : null}
              </Badge>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
