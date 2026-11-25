import { createServerFn } from '@tanstack/react-start'
import type { AllianceDashboard } from '~/lib/alliance-dashboards'
import { readAllianceDashboards } from '~/server/alliance-dashboards'
import { adminMiddleware } from './middleware'

/** `adminMiddleware`: entrega links que dan acceso sin login. */
export const getAllianceDashboardsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<AllianceDashboard>> => readAllianceDashboards())
