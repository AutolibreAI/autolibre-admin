import { z } from 'zod'

/**
 * Códigos para reclamar un taller — `public.partner_claim_codes`, migración
 * 0144 del backend. El equipo le emite un código a quien va a ser dueño; esa
 * persona lo canjea desde la app y queda como `owner` en `partner_members`.
 *
 * Lee por SQL (`~/server/partner-members.repo`), emite SÓLO por HTTP
 * (`POST /admin/partners/:id/claim-codes`, `~/server/backend`). Nunca un
 * `INSERT`/`UPDATE` a `partner_claim_codes` desde el panel.
 *
 * **El código es un secreto al portador**: un solo uso, 7 días. La base guarda
 * sólo su hash (`code_hash`, que el panel NUNCA selecciona). El texto en claro
 * existe una sola vez: en la respuesta del POST → estado del componente. Nunca
 * en el loader, la URL, localStorage, ni un log. → `.claude/rules/partner-members.md`
 */

/** Sin la 0144 en la base: la sección lo dice y no ofrece «Emitir código». */
export const PARTNER_CLAIM_CODES_UNAVAILABLE = 'PARTNER_CLAIM_CODES_UNAVAILABLE'
/** El partner no existe (por SQL, antes de llamar al backend). */
export const CLAIM_CODE_PARTNER_NOT_FOUND = 'CLAIM_CODE_PARTNER_NOT_FOUND'
/** El partner está archivado: no se le emite código (el backend daría 409). */
export const CLAIM_CODE_PARTNER_ARCHIVED = 'CLAIM_CODE_PARTNER_ARCHIVED'
/** El partner ya tiene un dueño activo (el backend daría 409). */
export const CLAIM_CODE_PARTNER_HAS_OWNER = 'CLAIM_CODE_PARTNER_HAS_OWNER'

/**
 * Estado DERIVADO, calculado en Postgres (`now()` del servidor de base): la
 * ficha es SSR y comparar `expires_at` contra el reloj del navegador daría un
 * mismatch de hidratación. Los tres eventos terminales son excluyentes por
 * CHECK del backend; `vencido` es deducción del reloj.
 */
export const CLAIM_CODE_STATES = ['pendiente', 'canjeado', 'revocado', 'invalidado', 'vencido'] as const
export type ClaimCodeState = (typeof CLAIM_CODE_STATES)[number]

export const CLAIM_CODE_STATE_LABELS: Record<ClaimCodeState, string> = {
  pendiente: 'pendiente',
  canjeado: 'canjeado',
  revocado: 'revocado',
  invalidado: 'invalidado (el taller consiguió dueño)',
  vencido: 'vencido',
}

/** Un estado que el SQL no conoce (no debería pasar) se muestra crudo. */
export const claimCodeStateLabel = (state: string): string =>
  (CLAIM_CODE_STATE_LABELS as Record<string, string>)[state] ?? state

export interface PartnerClaimCode {
  id: string
  /** `pendiente` | `canjeado` | `revocado` | `invalidado` | `vencido` — de Postgres. */
  state: string
  createdAt: string
  expiresAt: string
  /** Horas enteras hasta el vencimiento, redondeadas hacia arriba. Sólo con `state = 'pendiente'`. */
  hoursLeft: number | null
  createdById: string | null
  /** `null` con `createdById` null = el admin que lo emitió se borró (FK `ON DELETE SET NULL`). */
  createdByEmail: string | null
  redeemedAt: string | null
  redeemedById: string | null
  redeemedByEmail: string | null
  revokedAt: string | null
  supersededAt: string | null
}

export type PartnerClaimCodesResult =
  | { available: false }
  | { available: true; codes: Array<PartnerClaimCode> }

export const issuePartnerClaimCodeSchema = z.object({ partnerId: z.uuid() })

/** Crockford base32 (sin I, L, O, U), dos bloques de 5. */
export const CLAIM_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/

/** La respuesta del 201 del backend. Se valida: el código va a terminar en el WhatsApp de alguien. */
export const issuedClaimCodeSchema = z.object({
  id: z.uuid(),
  partnerId: z.uuid(),
  code: z.string().regex(CLAIM_CODE_PATTERN),
  expiresAt: z.iso.datetime({ offset: true }),
})

export type IssuedClaimCode = z.infer<typeof issuedClaimCodeSchema>

/** "vence en 5 días" / "vence en 3 h". El número viene de Postgres. */
export function hoursLeftLabel(hours: number): string {
  if (hours <= 1) return 'vence en menos de 1 h'
  if (hours < 48) return `vence en ${hours} h`
  return `vence en ${Math.floor(hours / 24)} días`
}

export function readableClaimCodeError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)

  if (raw === PARTNER_CLAIM_CODES_UNAVAILABLE)
    return 'Falta desplegar la migración 0144 del backend (partner_claim_codes) en esta base.'
  if (raw === CLAIM_CODE_PARTNER_NOT_FOUND) return 'Este taller ya no existe. Recargá la pantalla.'
  if (raw === CLAIM_CODE_PARTNER_ARCHIVED)
    return 'El taller está archivado: no se le emiten códigos. Recargá la pantalla.'
  if (raw === CLAIM_CODE_PARTNER_HAS_OWNER)
    return 'El taller ya tiene un dueño activo. Para pasárselo a otra persona, primero revocá al dueño.'
  if (raw === 'BACKEND_UNAUTHENTICATED' || raw === 'UNAUTHENTICATED')
    return 'Tu sesión expiró o el backend no la aceptó. Cerrá sesión y volvé a entrar.'
  if (raw === 'BACKEND_FORBIDDEN') return 'Tu usuario no es admin en el backend.'
  if (raw === 'FORBIDDEN') return 'Tu rol no tiene permiso para esta acción.'
  if (raw === 'CLAIM_CODE_BAD_RESPONSE')
    return 'El backend contestó algo que no es un código válido. No se muestra nada; probá de nuevo o avisá al equipo del backend.'
  if (raw.startsWith('BACKEND_UNREACHABLE:')) {
    const url = raw.slice('BACKEND_UNREACHABLE:'.length)
    return `El panel no llega al backend en ${url}. En producción es la variable AUTOLIBRE_BACKEND_URL de Vercel; en desarrollo, si no está en el .env, el panel usa localhost:3005 y el backend tiene que estar corriendo ahí.`
  }
  if (raw.startsWith('BACKEND_NOT_FOUND:')) {
    const detail = raw.slice('BACKEND_NOT_FOUND:'.length)
    // Nest contesta "Cannot POST …" cuando la RUTA no existe.
    if (detail.includes('Cannot POST'))
      return 'El backend al que le habla el panel no tiene `/admin/partners/:id/claim-codes` todavía — falta desplegarlo.'
    return 'El backend no encuentra este taller. Recargá la pantalla.'
  }
  // 409 con code CONFLICT significa DOS cosas (archivado o con dueño) y sólo
  // cambia el mensaje: no se ramifica por el texto, que no es contrato.
  if (raw.startsWith('BACKEND_CONFLICT:'))
    return 'Otro admin cambió el taller mientras tanto: ya tiene dueño o fue archivado. Recargá.'
  if (raw.startsWith('BACKEND_BAD_REQUEST:')) {
    const detail = raw.split(':').slice(2).join(':')
    return `El backend rechazó el pedido: «${detail}».`
  }
  if (raw.startsWith('BACKEND_ERROR:')) {
    const [, status, ...rest] = raw.split(':')
    return `El backend respondió ${status}: ${rest.join(':')}. Probá emitir de nuevo.`
  }
  if (raw.includes('AUTOLIBRE_BACKEND_URL')) return 'Falta configurar AUTOLIBRE_BACKEND_URL.'
  if (raw.includes('timed out') || raw.includes('TimeoutError'))
    return 'El backend tardó demasiado. Recargá antes de reintentar: puede haber emitido el código igual (el anterior seguiría pendiente).'
  return raw
}
