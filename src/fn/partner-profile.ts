import { createServerFn } from '@tanstack/react-start'
import { listPartnerProfileFacts } from '~/server/partner-profile.repo'
import { adminMiddleware } from './middleware'
import type { PartnerProfileFacts } from '~/lib/partner-profile-tips'

/** Banderas del perfil de cada partner (qué tiene cargado). Sólo booleanos y conteos. */
export const listPartnerProfileFactsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<PartnerProfileFacts>> => listPartnerProfileFacts())
