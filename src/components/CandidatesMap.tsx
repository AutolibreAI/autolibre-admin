import { useEffect, useRef, useState } from 'react'
import type { Map as LeafletMap } from 'leaflet'
import { formatKm } from '~/lib/format'

/**
 * El mapa de "Derivar a un taller": un pin del pedido y uno por candidato,
 * con los MISMOS filtros que la lista (rubros, zona, solo aliados) — recibe
 * los candidatos ya filtrados, no la lista entera.
 *
 * ── Por qué así ─────────────────────────────────────────────────────────────
 *
 * - **Leaflet se importa adentro del efecto**, nunca arriba del módulo: toca
 *   `window` al cargarse, y la ficha es SSR completo. El mapa existe sólo en
 *   el navegador; en el servidor se pinta el recuadro vacío del mismo alto,
 *   así que no hay salto de layout ni mismatch de hidratación.
 * - **Círculos, no el marcador de imagen de Leaflet.** El pin por defecto es
 *   un PNG con sombra que el bundler no resuelve bien, y el design system no
 *   tiene sombras. Los colores salen de los tokens de `styles.css`
 *   (`getComputedStyle`), nunca de un hex escrito acá.
 * - **El texto del popup va por `textContent`.** El nombre de un partner es
 *   texto libre que vino de una planilla; armarlo como HTML sería inyectarlo.
 * - **Tiles de OpenStreetMap**, con su atribución (es condición de uso). Para
 *   el volumen de un panel interno está dentro de su política.
 *
 * Un candidato sin coordenadas NO aparece en el mapa, y la pantalla dice
 * cuántos quedaron afuera — un mapa con menos pines que la lista, sin
 * explicación, se lee como un filtro que no se aplicó.
 */

export interface MapCandidate {
  id: string
  name: string
  coverageZone: string
  founding: boolean
  distanceKm: number | null
  location: { lat: number; lng: number }
}

export function CandidatesMap({
  pedido,
  candidates,
}: {
  pedido: { lat: number; lng: number } | null
  candidates: Array<MapCandidate>
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const [failed, setFailed] = useState(false)
  // El padre arma `candidates` en cada render. Rearmar el mapa por identidad
  // del array lo reconstruiría con cualquier cambio de estado ajeno (tipear
  // una nota): el efecto depende del CONTENIDO y lee la lista por ref.
  const latest = useRef({ pedido, candidates })
  latest.current = { pedido, candidates }
  const signature = JSON.stringify([pedido, candidates])

  useEffect(() => {
    let cancelled = false
    let resize: ResizeObserver | null = null
    const el = containerRef.current
    if (!el) return

    void import('leaflet')
      .then((mod) => {
        if (cancelled) return
        const { pedido, candidates } = latest.current
        const L = mod.default ?? mod
        const css = getComputedStyle(document.documentElement)
        const token = (name: string) => css.getPropertyValue(name).trim()
        const colors = {
          pedido: token('--action-dark'),
          founding: token('--brand-500'),
          other: token('--gray-500'),
          surface: token('--surface'),
        }

        const map = L.map(el, { scrollWheelZoom: false, attributionControl: true })
        mapRef.current = map
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(map)

        const points: Array<[number, number]> = []

        for (const c of candidates) {
          const marker = L.circleMarker([c.location.lat, c.location.lng], {
            radius: 7,
            color: colors.surface,
            weight: 2,
            fillColor: c.founding ? colors.founding : colors.other,
            fillOpacity: 1,
          })
          marker.bindPopup(() => popupContent(c), { closeButton: false })
          marker.bindTooltip(c.name, { direction: 'top', offset: [0, -6] })
          marker.addTo(map)
          points.push([c.location.lat, c.location.lng])
        }

        // El pedido va último para quedar ARRIBA de un taller en la misma esquina.
        if (pedido) {
          L.circleMarker([pedido.lat, pedido.lng], {
            radius: 10,
            color: colors.surface,
            weight: 3,
            fillColor: colors.pedido,
            fillOpacity: 1,
          })
            .bindTooltip('El pedido', { direction: 'top', offset: [0, -8], permanent: false })
            .addTo(map)
          points.push([pedido.lat, pedido.lng])
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
    // Se rearma entero cuando cambia el conjunto: con decenas de pines es
    // instantáneo, y evita sincronizar marcadores a mano.
  }, [signature])

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        className="relative z-0 h-[26rem] overflow-hidden rounded-md border border-border bg-surface-2"
        role="region"
        aria-label="Mapa del pedido y los talleres candidatos"
      >
        {failed ? (
          <p className="p-4 text-sm text-muted-foreground">No se pudo cargar el mapa.</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <Legend className="size-3 bg-action" label="El pedido" />
        <Legend className="size-2.5 bg-brand" label="Aliado" />
        <Legend className="size-2.5 bg-muted-foreground" label="Otro partner" />
        <span>Distancias en línea recta.</span>
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

function popupContent(c: MapCandidate): HTMLElement {
  const root = document.createElement('div')
  root.style.fontFamily = 'inherit'
  const name = document.createElement('div')
  name.style.fontWeight = '600'
  name.textContent = c.founding ? `${c.name} · Aliado` : c.name
  const zone = document.createElement('div')
  zone.textContent = c.coverageZone
  root.append(name, zone)
  if (c.distanceKm !== null) {
    const km = document.createElement('div')
    km.textContent = `A ${formatKm(c.distanceKm)} del pedido`
    root.append(km)
  }
  return root
}
