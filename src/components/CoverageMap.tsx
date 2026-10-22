import { useEffect, useRef, useState } from 'react'
import type * as Leaflet from 'leaflet'
import { formatDate, formatInt } from '~/lib/format'
import {
  COVERAGE_PRIORITY_LABELS,
  COVERAGE_RUBRO_LABELS,
  COVERED_MIN_PROVIDERS,
} from '~/lib/coverage-map'
import type { CoveragePriority, CoverageRubro, CoverageZone, ZoneStats } from '~/lib/coverage-map'

/**
 * El mapa de `/partners/cobertura`: zonas pintadas por prioridad, pedidos y
 * partners encima.
 *
 * Mismas reglas que `PartnerMap` (y por los mismos motivos, ver su cabecera):
 * Leaflet se importa adentro del efecto, círculos y no el PNG con sombra,
 * colores de los tokens de `styles.css`, texto de tooltips por `textContent`,
 * tiles de OpenStreetMap con atribución.
 *
 * A diferencia de `PartnerMap`, el mapa se arma UNA vez y lo que cambia con
 * los filtros se redibuja en sus capas: cambiar de rubro o de radio no puede
 * mover la vista que el operador eligió.
 */

export interface MapPedido {
  id: string
  numero: number
  rubro: CoverageRubro
  localidad: string | null
  createdAt: string
  aprox: boolean
  lat: number
  lng: number
  near: number
}

export interface MapProveedor {
  id: string
  nombre: string
  zona: string
  rubros: Array<CoverageRubro>
  lat: number
  lng: number
  /** Tiene el rubro elegido (con «Todos», siempre). */
  highlighted: boolean
}

type QuickView = 'amba' | 'conurbano' | 'caba'

export function CoverageMap({
  zones,
  stats,
  pedidos,
  proveedores,
  radiusKm,
  focusZoneId,
  flyNonce,
  onZoneClick,
}: {
  zones: Array<CoverageZone>
  stats: Map<string, ZoneStats>
  pedidos: Array<MapPedido>
  proveedores: Array<MapProveedor>
  radiusKm: number
  focusZoneId: string | undefined
  /** Cambia cuando la vista tiene que ir a `focusZoneId` (clic en el ranking o en la matriz). */
  flyNonce: number
  onZoneClick: (zoneId: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Leaflet.Map | null>(null)
  const libRef = useRef<typeof Leaflet | null>(null)
  const layersRef = useRef<{
    zones: Leaflet.LayerGroup
    proveedores: Leaflet.LayerGroup
    pedidos: Leaflet.LayerGroup
    hover: Leaflet.LayerGroup
  } | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  const latest = useRef({ zones, stats, pedidos, proveedores, radiusKm, focusZoneId, onZoneClick })
  latest.current = { zones, stats, pedidos, proveedores, radiusKm, focusZoneId, onZoneClick }

  // ── Crear el mapa, una vez ──
  useEffect(() => {
    let cancelled = false
    let resize: ResizeObserver | null = null
    const el = containerRef.current
    if (!el) return

    void import('leaflet')
      .then((mod) => {
        if (cancelled) return
        const L = (mod.default ?? mod) as typeof Leaflet
        libRef.current = L
        const map = L.map(el, { scrollWheelZoom: false, attributionControl: true })
        mapRef.current = map
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(map)
        layersRef.current = {
          zones: L.layerGroup().addTo(map),
          proveedores: L.layerGroup().addTo(map),
          pedidos: L.layerGroup().addTo(map),
          hover: L.layerGroup().addTo(map),
        }
        const { zones, focusZoneId } = latest.current
        const focus = focusZoneId ? zones.find((z) => z.id === focusZoneId) : undefined
        map.fitBounds(boundsOf(L, focus ? [focus] : zones), { padding: [16, 16] })
        resize = new ResizeObserver(() => map.invalidateSize())
        resize.observe(el)
        setReady(true)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
      resize?.disconnect()
      mapRef.current?.remove()
      mapRef.current = null
      layersRef.current = null
      libRef.current = null
    }
  }, [])

  // ── Redibujar las capas cuando cambia lo que se muestra ──
  // Depende de una FIRMA del contenido, no de la identidad de los arrays: el
  // padre los arma en cada render (mismo criterio que `PartnerMap`).
  const signature = JSON.stringify([
    [...stats.values()].map((s) => [s.zone.id, s.priority, s.pedidos, s.sinCobertura, s.proveedores]),
    pedidos.map((p) => [p.id, p.near, p.lat, p.lng]),
    proveedores.map((p) => [p.id, p.highlighted]),
    radiusKm,
    focusZoneId,
  ])

  useEffect(() => {
    const L = libRef.current
    const layers = layersRef.current
    if (!ready || !L || !layers) return
    const { zones, stats, pedidos, proveedores, radiusKm, focusZoneId, onZoneClick } = latest.current
    const c = tokens()

    layers.zones.clearLayers()
    layers.proveedores.clearLayers()
    layers.pedidos.clearLayers()
    layers.hover.clearLayers()

    for (const zone of zones) {
      const s = stats.get(zone.id)
      const priority: CoveragePriority = s?.priority ?? 'sin_demanda'
      const focused = zone.id === focusZoneId
      const style = zoneStyle(priority, c)
      const poly = L.polygon(
        zone.rings.map((ring) => ring.map(([lng, lat]) => [lat, lng] as [number, number])),
        {
          ...style,
          fillRule: 'evenodd',
          weight: focused ? 3 : style.weight,
          color: focused ? c.action : style.color,
        },
      )
      poly.bindTooltip(() => zoneTooltip(zone, s), { sticky: true })
      poly.on('click', () => onZoneClick(zone.id))
      poly.addTo(layers.zones)
      if (focused) poly.bringToFront()
    }

    for (const p of proveedores) {
      L.circleMarker([p.lat, p.lng], {
        radius: p.highlighted ? 4 : 3,
        color: c.surface,
        weight: 1,
        fillColor: p.highlighted ? c.action : c.gray300,
        fillOpacity: p.highlighted ? 0.9 : 0.8,
      })
        .bindTooltip(() => proveedorTooltip(p), { direction: 'top', offset: [0, -4] })
        .addTo(layers.proveedores)
    }

    for (const p of pedidos) {
      const covered = p.near >= COVERED_MIN_PROVIDERS
      const marker = L.circleMarker([p.lat, p.lng], {
        radius: 6,
        color: c.surface,
        weight: 2,
        fillColor: covered ? c.green : c.red,
        fillOpacity: 1,
        dashArray: p.aprox ? '2 2' : undefined,
      })
      marker.bindTooltip(() => pedidoTooltip(p, radiusKm), { direction: 'top', offset: [0, -6] })
      marker.bindPopup(() => pedidoPopup(p), { closeButton: false })
      marker.on('mouseover', () => {
        layers.hover.clearLayers()
        L.circle([p.lat, p.lng], {
          radius: radiusKm * 1000,
          color: c.action,
          weight: 1.5,
          dashArray: '4 4',
          fill: false,
          interactive: false,
        }).addTo(layers.hover)
      })
      marker.on('mouseout', () => layers.hover.clearLayers())
      marker.addTo(layers.pedidos)
    }
  }, [ready, signature])

  // ── Ir a la zona elegida desde la tabla ──
  useEffect(() => {
    const L = libRef.current
    const map = mapRef.current
    if (!ready || !L || !map || flyNonce === 0) return
    const { zones, focusZoneId } = latest.current
    const zone = zones.find((z) => z.id === focusZoneId)
    if (zone) map.flyToBounds(boundsOf(L, [zone]), { padding: [40, 40], maxZoom: 13, duration: 0.6 })
  }, [ready, flyNonce])

  const goTo = (view: QuickView) => {
    const L = libRef.current
    const map = mapRef.current
    if (!L || !map) return
    const pick =
      view === 'caba'
        ? zones.filter((z) => z.area === 'CABA')
        : view === 'conurbano'
          ? zones.filter((z) => z.area !== 'CABA')
          : zones
    map.flyToBounds(boundsOf(L, pick), { padding: [16, 16], duration: 0.6 })
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Ver</span>
        {(
          [
            ['amba', 'AMBA'],
            ['conurbano', 'Conurbano'],
            ['caba', 'CABA'],
          ] as const
        ).map(([view, label]) => (
          <button
            key={view}
            type="button"
            onClick={() => goTo(view)}
            disabled={!ready}
            className="h-7 rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {label}
          </button>
        ))}
      </div>
      <div
        ref={containerRef}
        className="relative z-0 h-[34rem] overflow-hidden rounded-md border border-border bg-surface-2"
        role="region"
        aria-label="Mapa de cobertura"
      >
        {failed ? <p className="p-4 text-sm text-muted-foreground">No se pudo cargar el mapa.</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <Swatch className="border-status-red bg-status-red/35" label="Salir ya" />
        <Swatch className="border-status-yellow bg-status-yellow/30" label="Reforzar" />
        <Swatch className="border-dashed border-status-yellow bg-status-yellow/10" label="Demanda latente" />
        <Swatch className="border-status-green bg-status-green/15" label="Cubierta" />
        <Swatch className="border-border bg-transparent" label="Sin demanda" />
        <Dot className="size-3 bg-status-red" label="Pedido sin 3 opciones" />
        <Dot className="size-3 bg-status-green" label="Pedido cubierto" />
        <Dot className="size-2 bg-action" label="Partner del rubro" />
        <Dot className="size-2 bg-border" label="Partner de otro rubro" />
        <span>Pedido con borde punteado = ubicación aproximada (centro de localidad).</span>
      </div>
    </div>
  )
}

function Swatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block size-3 rounded-sm border ${className}`} aria-hidden />
      {label}
    </span>
  )
}

function Dot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block rounded-full ${className}`} aria-hidden />
      {label}
    </span>
  )
}

function tokens() {
  const css = getComputedStyle(document.documentElement)
  const t = (name: string) => css.getPropertyValue(name).trim()
  return {
    action: t('--action-dark'),
    surface: t('--surface'),
    gray300: t('--gray-300'),
    gray400: t('--gray-400'),
    red: t('--status-red'),
    yellow: t('--status-yellow'),
    green: t('--status-green'),
  }
}

function zoneStyle(priority: CoveragePriority, c: ReturnType<typeof tokens>): Leaflet.PathOptions {
  switch (priority) {
    case 'salir':
      return { color: c.red, weight: 1.5, fillColor: c.red, fillOpacity: 0.35 }
    case 'reforzar':
      return { color: c.yellow, weight: 1.5, fillColor: c.yellow, fillOpacity: 0.3 }
    case 'latente':
      return { color: c.yellow, weight: 1.5, dashArray: '4 4', fillColor: c.yellow, fillOpacity: 0.1 }
    case 'cubierta':
      return { color: c.green, weight: 1, fillColor: c.green, fillOpacity: 0.15 }
    case 'sin_demanda':
      // Relleno transparente pero presente: sin él la zona no recibe el clic.
      return { color: c.gray400, weight: 0.75, fillColor: c.surface, fillOpacity: 0 }
  }
}

function boundsOf(L: typeof Leaflet, zones: Array<CoverageZone>): Leaflet.LatLngBounds {
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  for (const z of zones) {
    minLng = Math.min(minLng, z.bbox[0])
    minLat = Math.min(minLat, z.bbox[1])
    maxLng = Math.max(maxLng, z.bbox[2])
    maxLat = Math.max(maxLat, z.bbox[3])
  }
  if (!Number.isFinite(minLng)) return L.latLngBounds([-34.9, -58.7], [-34.4, -58.2])
  return L.latLngBounds([minLat, minLng], [maxLat, maxLng])
}

// ── Tooltips: armados con `textContent`, nunca como HTML ──

function box(lines: Array<[string, boolean?]>): HTMLElement {
  const root = document.createElement('div')
  for (const [text, strong] of lines) {
    const line = document.createElement('div')
    if (strong) line.style.fontWeight = '600'
    line.textContent = text
    root.append(line)
  }
  return root
}

function zoneTooltip(zone: CoverageZone, s: ZoneStats | undefined): HTMLElement {
  if (!s) return box([[zone.nombre, true], [zone.area]])
  return box([
    [zone.nombre, true],
    [`${zone.area} · ${COVERAGE_PRIORITY_LABELS[s.priority]}`],
    [`${formatInt(s.pedidos)} pedidos · ${formatInt(s.sinCobertura)} sin 3 opciones`],
    [`${formatInt(s.proveedores)} partners en la zona`],
  ])
}

function pedidoTooltip(p: MapPedido, radiusKm: number): HTMLElement {
  return box([
    [`AL-${p.numero}`, true],
    [COVERAGE_RUBRO_LABELS[p.rubro]],
    [`${p.localidad ?? 'Sin localidad'}${p.aprox ? ' (aproximada)' : ''} · ${formatDate(p.createdAt)}`],
    [`${formatInt(p.near)} partners a ≤ ${radiusKm} km`],
  ])
}

function pedidoPopup(p: MapPedido): HTMLElement {
  const root = box([[`AL-${p.numero}`, true], [COVERAGE_RUBRO_LABELS[p.rubro]]])
  // El id es un uuid de la base, no texto libre.
  const link = document.createElement('a')
  link.href = `/leads/pedidos/${encodeURIComponent(p.id)}`
  link.textContent = 'Ver pedido'
  link.style.display = 'inline-block'
  link.style.marginTop = '4px'
  root.append(link)
  return root
}

function proveedorTooltip(p: MapProveedor): HTMLElement {
  return box([
    [p.nombre, true],
    [p.zona],
    [p.rubros.length ? p.rubros.map((r) => COVERAGE_RUBRO_LABELS[r]).join(' · ') : 'Sin rubro de los 10'],
  ])
}
