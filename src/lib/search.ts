import { z } from 'zod'

/**
 * Search-param schemas live next to the types because they are the public
 * contract of a URL. A route's `validateSearch` is the only place an untrusted
 * query string becomes typed data — every downstream consumer (loader deps,
 * server functions, components, `<Link search={...}>`) receives the parsed
 * output and is checked against it by the compiler.
 *
 * Este archivo quedó con lo TRANSVERSAL. Cada contexto define el suyo junto a
 * sus tipos, y no acá: `applicationSearchSchema` en `~/lib/partners`,
 * `partnerSearchSchema` en `~/lib/catalog`, `aiUsageSearchSchema` en
 * `~/lib/ai-usage`, `opsSearchSchema` en `~/lib/ops`. Un archivo con los
 * schemas de todos los contextos se convierte en el lugar donde el vocabulario
 * de uno se filtra al otro.
 */

export const loginSearchSchema = z.object({
  /** Where to return after signing in. Must be relative — otherwise this is an
   *  open redirect. */
  redirect: z.string().startsWith('/').optional(),
})

/**
 * Nota sobre los dos modos de falla de zod, que aplica a todos los schemas del
 * proyecto y se documenta acá una sola vez:
 *
 *  - `.catch(...)` degrada un valor inválido a un default sano. Un
 *    `?window=banana` guardado en un favorito debería renderizar la ventana por
 *    default, no una pantalla de error.
 *  - Un campo SIN `.catch()` tira, y Router lo muestra por el `errorComponent`
 *    de la ruta.
 *
 * Se elige por campo, según si un valor equivocado es recuperable o no.
 */
