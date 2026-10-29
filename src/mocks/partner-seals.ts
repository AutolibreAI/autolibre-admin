import type { PartnerSeal, Seal, StoredSealStatus } from '~/lib/partner-seals'

/**
 * ⚠ MOCK — catálogo de sellos y sellos asignados de EJEMPLO.
 *
 * Reemplaza a: las tablas `seals` y `partner_seals`, y a
 * `GET /admin/partners/:id/seals`, `POST /admin/partners/:id/seals`,
 * `POST /admin/partner-seals/:id/revoke` y `POST /admin/seal-imports` (filas ya
 * cruzadas y confirmadas por una persona). Tarjeta "Sellos y validaciones de
 * proveedores (Aliado, redes, aseguradoras) + filtro en catálogo".
 *
 * Aliado NO está acá: es real (`partners.tier = 'founding'`) y se edita en la
 * tarjeta Perfil de la ficha.
 *
 * Las redes y aseguradoras tienen nombres genéricos a propósito: no se sabe
 * todavía cuáles van en el primer listado. Lo asignado vive en memoria del
 * navegador y se pierde al recargar: ningún proveedor tiene un sello en la
 * base. Nunca `localStorage`: lo haría parecer guardado.
 */
const SEALS: ReadonlyArray<Seal> = [
  { id: 'seal-red-a', slug: 'red-a', name: 'Red de talleres A (ejemplo)', kind: 'network', requiresExpiry: true },
  { id: 'seal-red-b', slug: 'red-b', name: 'Red de talleres B (ejemplo)', kind: 'network', requiresExpiry: false },
  { id: 'seal-aseg-a', slug: 'aseguradora-a', name: 'Aseguradora A (ejemplo)', kind: 'insurer', requiresExpiry: true },
  { id: 'seal-aseg-b', slug: 'aseguradora-b', name: 'Aseguradora B (ejemplo)', kind: 'insurer', requiresExpiry: true },
]

const assigned = new Map<string, PartnerSeal>()
let seq = 0

function nextId(): string {
  seq += 1
  return `ejemplo-sello-${seq}`
}

export async function fetchSealCatalogMock(): Promise<ReadonlyArray<Seal>> {
  return SEALS
}

/** Los sellos de un proveedor, revocados incluidos (son historial). */
export async function fetchPartnerSealsMock(partnerId: string): Promise<Array<PartnerSeal>> {
  return [...assigned.values()]
    .filter((s) => s.partnerId === partnerId)
    .sort((a, b) => b.grantedAt.localeCompare(a.grantedAt))
}

/** Todos los asignados, para la lista de la pestaña Sellos. */
export async function fetchAllPartnerSealsMock(): Promise<Array<PartnerSeal>> {
  return [...assigned.values()].sort((a, b) => b.grantedAt.localeCompare(a.grantedAt))
}

export interface GrantSealInput {
  partnerId: string
  sealId: string
  status: Exclude<StoredSealStatus, 'revoked'>
  source: string
  expiresAt: string | null
  grantedBy: string
}

/**
 * Asigna un sello. Un proveedor tiene a lo sumo UN sello vigente (no revocado)
 * de cada tipo: re-asignar reemplaza al anterior, que queda revocado. Es la
 * regla que pedimos para `partner_seals` (índice único parcial).
 */
export async function grantSealMock(input: GrantSealInput): Promise<PartnerSeal> {
  const now = new Date().toISOString()
  for (const s of assigned.values()) {
    if (s.partnerId === input.partnerId && s.sealId === input.sealId && s.status !== 'revoked') {
      assigned.set(s.id, { ...s, status: 'revoked', revokedAt: now })
    }
  }
  const seal: PartnerSeal = {
    id: nextId(),
    partnerId: input.partnerId,
    sealId: input.sealId,
    status: input.status,
    source: input.source.trim(),
    verifiedAt: input.status === 'verified' ? now : null,
    expiresAt: input.expiresAt,
    grantedAt: now,
    grantedBy: input.grantedBy,
    revokedAt: null,
  }
  assigned.set(seal.id, seal)
  return seal
}

/** Pasa un pendiente a verificado. */
export async function verifySealMock(id: string): Promise<PartnerSeal> {
  const s = assigned.get(id)
  if (!s || s.status !== 'pending') throw new Error('SEAL_NOT_PENDING')
  const next = { ...s, status: 'verified' as const, verifiedAt: new Date().toISOString() }
  assigned.set(id, next)
  return next
}

export async function revokeSealMock(id: string): Promise<PartnerSeal> {
  const s = assigned.get(id)
  if (!s || s.status === 'revoked') throw new Error('SEAL_ALREADY_REVOKED')
  const next = { ...s, status: 'revoked' as const, revokedAt: new Date().toISOString() }
  assigned.set(id, next)
  return next
}

/** La importación confirmada: una asignación por fila elegida. */
export async function importSealRowsMock(
  rows: ReadonlyArray<Omit<GrantSealInput, 'grantedBy'>>,
  grantedBy: string,
): Promise<{ granted: number }> {
  for (const r of rows) await grantSealMock({ ...r, grantedBy })
  return { granted: rows.length }
}
