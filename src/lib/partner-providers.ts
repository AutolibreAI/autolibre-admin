import { z } from 'zod'
import { multiSelectParam } from './catalog'
import type { FeeJob } from './partner-fees'
import type { PackageRow } from './partner-packages'

/**
 * Partners › Proveedores (`/partners/propuestas`, antes «Propuestas») — la
 * vista por proveedor del modelo de cobro del 2026-11-26: sin planes ni tope;
 * propuestas del mes, trabajos confirmados, primer trabajo gratis, paquete
 * vigente y lo que hay por cobrar. → `.claude/rules/partner-fees.md`.
 *
 * Lo que sale de Liquidaciones (trabajos, gratis, paquete, por cobrar) usa la
 * MISMA clasificación (`classifyFeeJobs`): si las dos pantallas dijeran cosas
 * distintas, una estaría mal.
 */

export interface ProviderFacts {
  /** Trabajos confirmados liquidables (sin disputas), no anulados. */
  confirmedTotal: number
  /** Ídem, con día del trabajo en el mes en curso (Buenos Aires). */
  confirmedMonth: number
  /** El primer trabajo gratis ya se usó (tiene un trabajo confirmado). */
  firstJobUsed: boolean
  /** Pendiente cobrable + avisado (Liquidaciones). */
  owed: number
  /** Paquetes vigentes: saldo sumado y el vencimiento más próximo. */
  package: { balance: number; expiresOn: string; daysLeft: number; expiringSoon: boolean; count: number } | null
  sourcer: { memberId: string; name: string } | null
}

export function providerFacts(
  partnerIds: ReadonlyArray<string>,
  jobs: ReadonlyArray<FeeJob>,
  packages: ReadonlyArray<PackageRow>,
  sourcers: ReadonlyMap<string, { memberId: string; name: string }>,
  monthKey: string,
): Map<string, ProviderFacts> {
  const out = new Map<string, ProviderFacts>()
  for (const id of partnerIds) {
    out.set(id, {
      confirmedTotal: 0,
      confirmedMonth: 0,
      firstJobUsed: false,
      owed: 0,
      package: null,
      sourcer: sourcers.get(id) ?? null,
    })
  }
  for (const j of jobs) {
    if (j.kind !== 'liquidable' || !j.partnerId || j.status === 'anulado') continue
    const f = out.get(j.partnerId)
    if (!f) continue
    f.confirmedTotal += 1
    if (j.jobDay.startsWith(monthKey)) f.confirmedMonth += 1
    if (j.isFirstOfPartner) f.firstJobUsed = true
    if ((j.status === 'pendiente' && j.exclusion === null) || j.status === 'avisado') f.owed += j.amount
  }
  for (const p of packages) {
    if (p.status !== 'vigente') continue
    const f = out.get(p.partnerId)
    if (!f) continue
    if (!f.package) {
      f.package = { balance: p.balance, expiresOn: p.expiresOn, daysLeft: p.daysLeft, expiringSoon: p.expiringSoon, count: 1 }
    } else {
      f.package.balance += p.balance
      f.package.count += 1
      if (p.expiresOn < f.package.expiresOn) {
        f.package.expiresOn = p.expiresOn
        f.package.daysLeft = p.daysLeft
      }
      f.package.expiringSoon = f.package.expiringSoon || p.expiringSoon
    }
  }
  return out
}

// ── Search params (calificados `provider*`; `q` se comparte) ─────────────────

export const PROVIDER_SORT_KEYS = [
  'name',
  'zone',
  'status',
  'sourcer',
  'createdAt',
  'monthSent',
  'confirmedTotal',
  'confirmedMonth',
  'package',
  'owed',
] as const
export type ProviderSortKey = (typeof PROVIDER_SORT_KEYS)[number]
export const PROVIDER_TEXT_SORT_KEYS: ReadonlySet<ProviderSortKey> = new Set(['name', 'zone', 'status', 'sourcer'])

export const PROVIDER_STATUSES = ['active', 'paused', 'archived'] as const
export const PROVIDER_STATUS_LABELS: Record<string, string> = {
  active: 'Activo',
  paused: 'Pausado',
  archived: 'Archivado',
}

export const providersSearchSchema = z.object({
  /** `YYYY-MM`. Ausente = el mes en curso (lo resuelve la pantalla). */
  providerMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().catch(undefined),
  q: z.string().trim().max(80).optional(),
  providerRubros: multiSelectParam(z.string().trim().min(1).max(80)),
  providerZones: multiSelectParam(z.string().trim().min(1).max(120)),
  /** id de `ops.team_member`, o `none`. */
  providerSourcer: z.string().max(40).optional().catch(undefined),
  providerStatuses: multiSelectParam(z.enum(PROVIDER_STATUSES)),
  providerWithPackage: z.coerce.boolean().catch(false).default(false),
  providerPackageExpiring: z.coerce.boolean().catch(false).default(false),
  providerOwes: z.coerce.boolean().catch(false).default(false),
  providerSort: z.enum(PROVIDER_SORT_KEYS).catch('monthSent').default('monthSent'),
  providerDir: z.enum(['asc', 'desc']).catch('desc').default('desc'),
})
export type ProvidersSearch = z.infer<typeof providersSearchSchema>

export const PROVIDERS_CSV_HEADER = [
  'Taller',
  'Rubros',
  'Zona',
  'Estado',
  'Alta por',
  'Fecha de alta',
  'Propuestas enviadas en el mes',
  'Trabajos confirmados (total)',
  'Trabajos confirmados (mes)',
  'Primer trabajo gratis',
  'Paquete vigente: saldo',
  'Paquete vigente: vence',
  'Por cobrar',
] as const
