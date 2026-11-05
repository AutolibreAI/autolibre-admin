import { z } from 'zod'

/**
 * Aprobar una solicitud de partner — desde el 2026-11-05 lo hace el BACKEND.
 *
 * `POST /admin/partner-applications/:id/approval` (`AdminGuard`, migraciones
 * 0149/0150 del backend, rama `redesign`). En UNA transacción del backend:
 * pasa la solicitud a `verbal_agreement`, crea el partner, le carga los rubros
 * (slug de servicio o de familia, activos) y copia la coordenada de
 * `raw_submission` si es válida. Después del commit asigna el dueño
 * (`verified_via = 'application_approval'`) y da de baja los códigos de reclamo
 * pendientes. Re-aprobar es idempotente: mismo partner, `alreadyApproved`,
 * repara rubros y dueño, ignora la zona.
 *
 * El panel conserva el paso 0 (guardar lo tipeado en el editor por
 * `ops.update_partner_application`, 010) como llamada PREVIA y separada.
 * → `.claude/rules/partner-approval.md`
 */

/**
 * Los valores que el backend documenta. `ownerGrant` se valida como `string`
 * y NO como este enum: un valor nuevo del backend se muestra crudo en vez de
 * tirar abajo una aprobación que ya se commiteó del otro lado.
 */
export const OWNER_GRANTS = ['granted', 'already_granted', 'owner_taken', 'no_submitter', 'failed'] as const
export type OwnerGrant = (typeof OWNER_GRANTS)[number]

/** La respuesta 200 del backend, tal cual viene. */
export const backendApprovalSchema = z.object({
  partnerId: z.uuid(),
  alreadyApproved: z.boolean(),
  /** Filas de `partner_services` insertadas ESTA vez — 0 en un reintento. No sirve para "invisible". */
  servicesLoaded: z.number().int().nonnegative(),
  locationCopied: z.boolean(),
  ownerGrant: z.string(),
  ownerUserId: z.uuid().nullable(),
})

export interface ApprovalResult {
  partnerId: string
  alreadyApproved: boolean
  /** Insertados por ESTA llamada (lo que dice el backend). */
  servicesLoaded: number
  /**
   * `count(*)` de `partner_services` del partner, leído por SQL DESPUÉS de la
   * llamada. Es el que decide "invisible": `servicesLoaded` da 0 en cualquier
   * re-aprobación aunque el partner tenga rubros.
   */
  totalServices: number
  locationCopied: boolean
  /** Crudo: un valor que no está en `OWNER_GRANTS` se muestra tal cual. */
  ownerGrant: string
  ownerUserId: string | null
  /** Email de `ownerUserId`, por SQL. `null` si no hay id o la cuenta ya no existe. */
  ownerEmail: string | null
}

/** El backend contestó 200 con algo que no tiene la forma esperada. */
export const APPROVAL_BAD_RESPONSE = 'APPROVAL_BAD_RESPONSE'

/**
 * Errores de aprobar, en castellano. `savedEdits`: si el paso 0 ya guardó lo
 * tipeado — ya no es una sola transacción con la aprobación, así que un error
 * del backend deja la edición guardada y hay que decirlo.
 */
export function readableApprovalError(cause: unknown, opts: { savedEdits?: boolean } = {}): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const fromBackend = raw.startsWith('BACKEND_') || raw === APPROVAL_BAD_RESPONSE || raw === 'UNAUTHENTICATED'
  const tail =
    opts.savedEdits && fromBackend
      ? ' Los cambios del formulario sí quedaron guardados (se guardan antes de aprobar).'
      : ''

  const msg = (() => {
    if (/_REQUIRED|INVALID_FOLLOW_UP_DATE|too_small/i.test(raw) && !raw.startsWith('BACKEND_'))
      return 'Hay un campo obligatorio vacío o inválido en el formulario (nombre, email, WhatsApp, dirección o fecha). Corregilo y volvé a aprobar. No se guardó ni se aprobó nada.'
    if (raw === 'BACKEND_UNAUTHENTICATED' || raw === 'UNAUTHENTICATED')
      return 'Tu sesión expiró o el backend no la aceptó. Cerrá sesión y volvé a entrar.'
    if (raw === 'BACKEND_FORBIDDEN') return 'Tu usuario no es admin en el backend.'
    if (raw === 'FORBIDDEN') return 'Tu rol no tiene permiso para esta acción.'
    if (raw.startsWith('BACKEND_UNREACHABLE:')) {
      const url = raw.slice('BACKEND_UNREACHABLE:'.length)
      return `El panel no llega al backend en ${url}. En producción es la variable AUTOLIBRE_BACKEND_URL de Vercel; en desarrollo, si no está en el .env, el panel usa localhost:3005 y el backend tiene que estar corriendo ahí. No se aprobó nada.`
    }
    if (raw.startsWith('BACKEND_NOT_FOUND:')) {
      const detail = raw.slice('BACKEND_NOT_FOUND:'.length)
      // Nest contesta "Cannot POST …" cuando la RUTA no existe: backend sin 0149/0150.
      if (detail.includes('Cannot POST'))
        return 'El backend al que le habla el panel todavía no tiene el endpoint de aprobación (`/admin/partner-applications/:id/approval`, migraciones 0149/0150) — falta desplegarlo. No se aprobó nada.'
      return 'Esa solicitud ya no existe. Recargá la pantalla.'
    }
    if (raw.startsWith('BACKEND_CONFLICT:'))
      return 'La solicitud figura aprobada (acuerdo verbal) pero no tiene partner: está trabada. Usá «Destrabar» arriba y volvé a aprobarla.'
    if (raw.startsWith('BACKEND_BAD_REQUEST:')) {
      const detail = raw.split(':').slice(2).join(':')
      return `El backend rechazó el pedido: «${detail}». Revisá la zona de cobertura (1 a 200 caracteres).`
    }
    if (raw.startsWith('BACKEND_ERROR:')) {
      const [, status, ...rest] = raw.split(':')
      return `El backend respondió ${status}: ${rest.join(':')}`
    }
    if (raw === APPROVAL_BAD_RESPONSE)
      return 'El backend contestó algo que el panel no sabe leer. La aprobación pudo haberse hecho: recargá la pantalla antes de reintentar (reintentar es seguro).'
    if (raw.includes('AUTOLIBRE_BACKEND_URL')) return 'Falta configurar AUTOLIBRE_BACKEND_URL. No se aprobó nada.'
    if (raw.includes('timed out') || raw.includes('TimeoutError'))
      return 'El backend tardó demasiado. Puede haber aprobado igual: recargá la pantalla; volver a aprobar es seguro (no duplica el partner).'
    return raw
  })()

  return msg + tail
}
