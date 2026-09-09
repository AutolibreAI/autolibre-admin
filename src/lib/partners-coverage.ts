import { z } from 'zod'

/**
 * Tablero de cobertura del marketplace (`/partners/cobertura`).
 *
 * Contesta la pregunta de negocio: **qué oferta tengo cubierta y cuál tengo que
 * ir a capturar**, cruzando las 16 `service_categories` ("Rubro" en la UI, ver
 * abajo) contra la zona de cada partner.
 *
 * ── Vocabulario: "Rubro" acá son las CATEGORÍAS ─────────────────────────────
 *
 * En este repo `services` (79) se venía llamando "rubro" y `service_categories`
 * (16) "familia". El dueño de producto llama "rubro" a las 16 categorías
 * (Motor, Transmisión, Climatización…) — que es su ejemplo textual — y
 * "servicio" a los 79. La UI de Partners sigue ESE lenguaje; el código mantiene
 * `serviceCategory` / `service` (regla dura 7: el nombre de la columna manda).
 * → `.claude/rules/partners-coverage.md`
 *
 * ── El eje de zonas es TEXTO CRUDO, a propósito ─────────────────────────────
 *
 * `partners.coverage_zone` es texto libre y sucio (29 valores para 40 partners:
 * "Pacheco" y "General Pacheco" sueltos, "Zona Norte / CABA", "A confirmar").
 * Las coordenadas están 100% vacías. Se decidió mostrarlo tal cual —mismo
 * criterio que el `insurer` de seguros o el `scanner_firmware` de escáneres: si
 * el dato no viene estandarizado, no lo adivinamos— en vez de inventar un mapeo
 * a zonas canónicas. La única normalización es `btrim`.
 *
 * ── Un partner está en EXACTAMENTE una zona ─────────────────────────────────
 *
 * `coverage_zone` es una sola columna de `partners`. Por eso `categoryTotals`
 * puede sumarse celda por celda a lo ancho de las zonas sin doble conteo: un
 * partner que cubre "Motor" aparece en la fila de su zona y en ninguna otra.
 */

// ── Contrato ────────────────────────────────────────────────────────────────

export interface CoverageCategory {
  /** Slug de `service_categories`. */
  slug: string
  /** Nombre legible, tal como viene de la base. */
  name: string
  /** `service_categories.position` — el orden del catálogo. */
  position: number
}

export interface CoverageZoneRow {
  /** `coverage_zone` con `btrim`, o "Sin zona" si estaba vacío. */
  zone: string
  /** Partners activos en esta zona, invisibles incluidos. */
  partnersTotal: number
  /** De esos, cuántos no tienen un solo `partner_services` (invisibles en la app). */
  invisible: number
  /** slug de categoría → partners activos distintos de esta zona que la cubren. */
  byCategory: Record<string, number>
}

export interface PartnerCoverageBoard {
  /** Categorías activas con ≥1 servicio activo, en orden de catálogo. */
  categories: Array<CoverageCategory>
  /** Filas del tablero, ordenadas por `partnersTotal` desc y después por zona. */
  zones: Array<CoverageZoneRow>
  /** slug de categoría → total de partners activos que la cubren (cualquier zona). */
  categoryTotals: Record<string, number>
  /** Categorías sin NINGÚN partner activo en ninguna zona: el hueco absoluto. */
  emptyCategories: Array<CoverageCategory>
  /** Partners activos totales (denominador de todo el tablero). */
  totalActivePartners: number
}

// ── Search params ───────────────────────────────────────────────────────────

export const coverageSearchSchema = z.object({
  /** Filtra las filas por texto de zona. */
  q: z.string().trim().max(80).optional(),
  /**
   * Slugs de rubros a "enfocar": sus columnas se mueven al frente y se
   * resaltan, y las filas se ordenan por la SUMA de esos rubros desc. Es
   * multi-select desde la card de Huecos.
   *
   * Se llama `coverageRubros` y NO `category` a propósito: `/partners/listado`
   * ya usa `category` con tipo `string`, y un mismo search param con tipos
   * distintos (`string` vs `string[]`) rompe el typecheck de la ruta ajena en
   * los updaters `{...prev}` — la trampa de `.claude/rules/notifications.md`.
   *
   * El `preprocess` acepta que llegue un solo valor (`?coverageRubros=motor`,
   * tipeado a mano) y lo envuelve en array — sin eso `z.array` falla y `.catch`
   * lo deja vacío en silencio.
   */
  coverageRubros: z
    .preprocess(
      (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]),
      z.array(z.string().max(60)),
    )
    .catch([])
    .default([]),
  sort: z.enum(['zone', 'total']).catch('total').default('total'),
  dir: z.enum(['asc', 'desc']).catch('desc').default('desc'),
})

export type CoverageSearch = z.infer<typeof coverageSearchSchema>

// ── Derivados de UI ─────────────────────────────────────────────────────────

/** Una celda con un solo partner: si se pausa, esa zona pierde ese rubro. */
export interface SinglePartnerCell {
  zone: string
  categorySlug: string
  categoryName: string
}

/**
 * Recorre el tablero y junta las celdas `= 1` — el "punto único de falla".
 *
 * Se calcula en la UI y no en el repo porque es una lectura directa de `zones`,
 * sin nada que la base pueda contestar mejor.
 */
export function singlePartnerCells(board: PartnerCoverageBoard): Array<SinglePartnerCell> {
  const out: Array<SinglePartnerCell> = []
  for (const zone of board.zones) {
    for (const cat of board.categories) {
      if (zone.byCategory[cat.slug] === 1) {
        out.push({ zone: zone.zone, categorySlug: cat.slug, categoryName: cat.name })
      }
    }
  }
  return out
}
