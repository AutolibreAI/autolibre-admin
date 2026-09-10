import '@tanstack/react-start/server-only'

import rawCatalog from './dtc-codes.json'

/**
 * Catálogo local de códigos DTC — se lee de `src/server/dtc-codes.json`.
 *
 * ── Por qué vive acá, y no se pide al backend ──────────────────────────────
 *
 * El backend NO expone un diccionario de DTC, y su columna
 * `diagnostic_dtcs.standard_description` —el único lugar del schema pensado
 * para el título de un código— está vacía en el 100% de las filas de
 * producción (relevado el 2026-09-09). Sin este archivo, `/escaneres/detecciones`
 * sólo puede mostrar el código crudo.
 *
 * Es una lista de referencia del panel, mismo criterio que `MANUAL_LANGUAGES`
 * en `~/lib/manuals`: no inventa dominio (el código YA está en la base, lo
 * detectó un escaneo real), sólo le pone un título legible en el único lugar
 * donde hoy se puede. Se mantiene a mano — y el bloque "DTCs sin título" de la
 * pantalla existe para saber qué agregar.
 *
 * Server-only y fuera de `~/lib`: son ~1MB / 1100 entradas y no tienen por qué
 * viajar al grafo del cliente. La ruta recibe el título ya resuelto por el
 * loader.
 *
 * → `.claude/rules/scan-detections.md`
 */

interface RawEntry {
  codigo?: string
  nombre_corto?: string
  sistema?: string
  severidad?: string
}

export interface DtcInfo {
  /** `nombre_corto` del archivo. Ej: "Catalizador con eficiencia baja". */
  title: string
  /** `sistema` del archivo ("Control de emisiones"). `null` si falta. */
  system: string | null
  /** `amarillo` | `violeta` | `rojo`, crudo del archivo. `null` si falta. */
  severity: string | null
}

const normalize = (code: string): string => code.trim().toUpperCase()

/**
 * `código normalizado → info`. Se arma una vez al cargar el módulo.
 * Un código repetido (el archivo tiene 3): gana el último, sin ruido.
 */
const CATALOG: Map<string, DtcInfo> = (() => {
  const map = new Map<string, DtcInfo>()
  for (const e of rawCatalog as Array<RawEntry>) {
    const code = (e.codigo ?? '').trim()
    const title = (e.nombre_corto ?? '').trim()
    if (!code || !title) continue
    map.set(normalize(code), {
      title,
      system: (e.sistema ?? '').trim() || null,
      severity: (e.severidad ?? '').trim() || null,
    })
  }
  return map
})()

/** La info del catálogo local para un código, o `null` si no está cargado. */
export function lookupDtc(code: string): DtcInfo | null {
  return CATALOG.get(normalize(code)) ?? null
}
