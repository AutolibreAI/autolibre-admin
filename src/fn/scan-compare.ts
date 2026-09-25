import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { COMPARE_LEVELS } from '~/lib/scan-compare'
import { compareScanSessions, listComparableCatalogs } from '~/server/scan-compare.repo'
import { adminMiddleware } from './middleware'
import type { CompareCatalogOption, CompareView } from '~/lib/scan-compare'

/**
 * El comparador de escaneos — el borde RPC.
 *
 * `adminMiddleware` en los dos: el listado de catálogos es inocuo, pero la
 * comparación trae patente, dueño y los códigos de falla de cada auto — mismo
 * peso que `scan-sessions.ts`. Un server function es un endpoint HTTP público.
 */
export const listComparableCatalogsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<CompareCatalogOption>> => listComparableCatalogs())

export const compareScanSessionsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ catalogId: z.uuid(), level: z.enum(COMPARE_LEVELS) }))
  .handler(async ({ data }): Promise<CompareView> => compareScanSessions(data.catalogId, data.level))
