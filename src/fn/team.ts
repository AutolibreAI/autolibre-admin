import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import {
  applicationIdSchema,
  createTeamMemberSchema,
  partnerIdSchema,
  setApplicationSourcerSchema,
  sourcingUnitParam,
  updateTeamMemberSchema,
  type ApplicationSourcing,
  type PanelUserOption,
  type SourcerRef,
  type SourcingContext,
  type SourcingCounts,
  type TeamMember,
} from '~/lib/team'
import {
  createTeamMember,
  findMemberIdForUser,
  getApplicationSourcing,
  listPanelUsers,
  listTeamMembers,
  setApplicationSourcer,
  sourcerForPartner,
  sourcingCounts,
  sourcingProgress,
  teamAvailable,
  updateTeamMember,
} from '~/server/team.repo'
import { adminMiddleware } from './middleware'

/**
 * El equipo y "Alta por" (migración 035) — el borde RPC. Todo SQL sobre `ops`.
 * `adminMiddleware` en todo: el actor de cada escritura sale de la sesión,
 * nunca del payload (guardrail 4).
 */

/** Lo que necesita cualquier selector de "Alta por": las personas y quién soy yo. */
export const getSourcingContextFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async ({ context }): Promise<SourcingContext> => {
    const available = await teamAvailable()
    if (!available) return { available: false, members: [], meMemberId: null, progress: null }
    const [members, meMemberId, progress] = await Promise.all([
      listTeamMembers(),
      findMemberIdForUser(context.user.id),
      sourcingProgress(),
    ])
    return { available, members, meMemberId, progress }
  })

export const listTeamMembersFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<{ available: boolean; members: Array<TeamMember>; users: Array<PanelUserOption> }> => {
    const available = await teamAvailable()
    const [members, users] = await Promise.all([listTeamMembers(), listPanelUsers()])
    return { available, members, users }
  })

export const createTeamMemberFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(createTeamMemberSchema)
  .handler(async ({ data, context }) => createTeamMember(data, context.user.id))

export const updateTeamMemberFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(updateTeamMemberSchema)
  .handler(async ({ data, context }) => {
    await updateTeamMember(data.memberId, data.patch, context.user.id)
    return { ok: true as const }
  })

export const setApplicationSourcerFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(setApplicationSourcerSchema)
  .handler(async ({ data, context }) => setApplicationSourcer(data, context.user.id))

export const getApplicationSourcingFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(applicationIdSchema)
  .handler(async ({ data }): Promise<ApplicationSourcing> => getApplicationSourcing(data.applicationId))

export const getPartnerSourcerFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(partnerIdSchema)
  .handler(async ({ data }): Promise<{ available: boolean; sourcer: SourcerRef | null }> => ({
    available: await teamAvailable(),
    sourcer: await sourcerForPartner(data.partnerId),
  }))

export const getSourcingCountsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ unit: sourcingUnitParam }))
  .handler(async ({ data }): Promise<SourcingCounts> => sourcingCounts(data.unit))
