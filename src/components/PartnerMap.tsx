import { useEffect, useRef, useState } from 'react'
import type { Map as LeafletMap } from 'leaflet'
import { formatKm } from '~/lib/format'

/**
 * Mapa de partners. Lo usan dos pantallas, con la MISMA forma de pin:
 *
 *  - la ficha de un pedido (`<PartnerCandidates/>`): `center` es el pedido y
 *    los pines son los candidatos visibles;
 *  - `/partners/listado` (vista «Mapa»): sin `center`, todo el directorio con
 *    los filtros de la tabla.
 *
 * Si un aliado se viera distinto en los dos mapas, uno estaría mal — por eso
 * es un solo componente.
 *
 * ── Por qué así ─────────────────────────────────────────────────────────────
 *
 * - **Leaflet se importa adentro del efecto**, nunca arriba del módulo: toca
 *   `window` al cargarse, y las dos pantallas son SSR. En el servidor se pinta
 *   el recuadro vacío del mismo alto: sin salto de layout ni mismatch.
 * - **Círculos, no el marcador de imagen de Leaflet.** El pin por defecto es
 *   un PNG con sombra, y el design system no tiene sombras. Los colores salen
 *   de los tokens de `styles.css` (`getComputedStyle`), nunca de un hex acá.
 * - **El texto del popup va por `textContent`.** El nombre de un partner es
 *   texto libre que vino de una planilla; armarlo como HTML sería inyectarlo.
 * - **Tiles de OpenStreetMap**, con su atribución (es condición de uso).
 * - **El efecto depende del CONTENIDO, no de la identidad del array**: los
 *   padres arman la lista en cada render, y rearmar el mapa por identidad lo
 *   reconstruiría al tipear en cualquier otro campo.
 *
 * Un partner sin coordenadas NO tiene pin; quien usa el mapa dice cuántos
 * quedaron afuera — un mapa con menos pines que la lista, sin explicación, se
 * lee como un filtro que no se aplicó.
 */

export interface MapPartnerPin {
  id: string
  name: string
  coverageZone: string
  founding: boolean
  /** Pausado / archivado: pin gris claro. */
  inactive?: boolean
  distanceKm?: number | null
  location: { lat: number; lng: number }
}

export function PartnerMap({
  center,
  pins,
  centerLabel = 'El pedido',
}: {
  center: { lat: number; lng: number } | null
  pins: Array<MapPartnerPin>
  centerLabel?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const [failed, setFailed] = useState(false)
  const latest = useRef({ center, pins })
  latest.current = { center, pins }
  const signature = JSON.stringify([center, pins])
  const hasInactive = pins.some((p) => p.inactive)

  useEffect(() => {
    let cancelled = false
    let resize: ResizeObserver | null = null
    const el = containerRef.current
    if (!el) return

    void import('leaflet')
      .then((mod) => {
        if (cancelled) return
        const { center, pins } = latest.current
        const L = mod.default ?? mod
        const css = getComputedStyle(document.documentElement)
        const token = (name: string) => css.getPropertyValue(name).trim()
        const colors = {
          center: token('--action-dark'),
          founding: token('--brand-500'),
          other: token('--gray-500'),
          inactive: token('--gray-300'),
          surface: token('--surface'),
        }

        const map = L.map(el, { scrollWheelZoom: false, attributionControl: true })
        mapRef.current = map
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(map)

        const points: Array<[number, number]> = []

        for (const p of pins) {
          L.circleMarker([p.location.lat, p.location.lng], {
            radius: 7,
            color: colors.surface,
            weight: 2,
            fillColor: p.inactive ? colors.inactive : p.founding ? colors.founding : colors.other,
            fillOpacity: 1,
          })
            .bindPopup(() => popupContent(p), { closeButton: false })
            .bindTooltip(p.name, { direction: 'top', offset: [0, -6] })
            .addTo(map)
          points.push([p.location.lat, p.location.lng])
        }

        // El centro va último para quedar ARRIBA de un taller en la misma esquina.
        if (center) {
          L.circleMarker([center.lat, center.lng], {
            radius: 10,
            color: colors.surface,
            weight: 3,
            fillColor: colors.center,
            fillOpacity: 1,
          })
            .bindTooltip(centerLabel, { direction: 'top', offset: [0, -8] })
            .addTo(map)
          points.push([center.lat, center.lng])
        }

        if (points.length === 0) {
          // Sin un solo punto: centro de Buenos Aires, para que el mapa no quede gris.
          map.setView([-34.6037, -58.3816], 10)
        } else if (points.length === 1) {
          map.setView(points[0]!, 13)
        } else {
          map.fitBounds(L.latLngBounds(points), { padding: [28, 28], maxZoom: 14 })
        }

        // La tarjeta cambia de ancho con el layout; sin esto quedan tiles grises.
        resize = new ResizeObserver(() => map.invalidateSize())
        resize.observe(el)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
      resize?.disconnect()
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [signature, centerLabel])

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        className="relative z-0 h-[28rem] overflow-hidden rounded-md border border-border bg-surface-2"
        role="region"
        aria-label="Mapa de partners"
      >
        {failed ? <p className="p-4 text-sm text-muted-foreground">No se pudo cargar el mapa.</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {center ? <Legend className="size-3 bg-action" label={centerLabel} /> : null}
        <Legend className="size-2.5 bg-brand" label="Aliado" />
        <Legend className="size-2.5 bg-muted-foreground" label="Otro partner" />
        {hasInactive ? <Legend className="size-2.5 bg-border" label="Pausado / archivado" /> : null}
        {center ? <span>Distancias en línea recta.</span> : null}
      </div>
    </div>
  )
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block rounded-full ${className}`} aria-hidden />
      {label}
    </span>
  )
}

function popupContent(p: MapPartnerPin): HTMLElement {
  const root = document.createElement('div')
  const name = document.createElement('div')
  name.style.fontWeight = '600'
  name.textContent = p.founding ? `${p.name} · Aliado` : p.name
  const zone = document.createElement('div')
  zone.textContent = p.inactive ? `${p.coverageZone} · pausado` : p.coverageZone
  root.append(name, zone)
  if (p.distanceKm !== undefined && p.distanceKm !== null) {
    const km = document.createElement('div')
    km.textContent = `A ${formatKm(p.distanceKm)} del pedido`
    root.append(km)
  }
  // Link a la ficha: el id es un uuid de la base, no texto libre.
  const link = document.createElement('a')
  link.href = `/partners/${encodeURIComponent(p.id)}`
  link.textContent = 'Ver ficha'
  link.style.display = 'inline-block'
  link.style.marginTop = '4px'
  root.append(link)
  return root
}
