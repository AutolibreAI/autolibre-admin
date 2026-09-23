import { createServerFn } from '@tanstack/react-start'
import { feedbackSearchSchema } from '~/lib/feedback'
import {
  listDistinctFeedbackAppVersions,
  listDistinctFeedbackPlatforms,
  listFeedback,
} from '~/server/feedback.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { FeedbackListItem } from '~/lib/feedback'

/**
 * El borde RPC de Feedback. Mismo guard que `chats.ts` y `users.ts`: es texto
 * libre de personas reales, y un server function es un endpoint HTTP público
 * — sin `adminMiddleware` cualquier sesión válida de la app se baja el
 * feedback de cualquiera.
 */

export const listAppFeedback = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(feedbackSearchSchema)
  .handler(async ({ data }): Promise<Array<FeedbackListItem>> =>
    listFeedback(data, { signal: requestSignal() }),
  )

export const listFeedbackPlatforms = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<string>> => listDistinctFeedbackPlatforms())

export const listFeedbackAppVersions = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<string>> => listDistinctFeedbackAppVersions())
