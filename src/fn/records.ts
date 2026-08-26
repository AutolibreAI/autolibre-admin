import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { listSearchSchema } from '~/lib/search'
import {
  countByCategory,
  findRecord,
  queryRecords,
  summarize,
} from '~/server/records.repo'
import { requestSignal } from '~/server/request'
import { authedMiddleware } from './middleware'
import type { CategoryCount, Page, RecordItem, Summary } from '~/lib/types'

/**
 * The typed RPC boundary.
 *
 * Each export is a real HTTP endpoint generated at build time. The client
 * imports the binding and calls it like a function; the argument is validated
 * on the server before the handler body runs. No hand-written fetch, no route
 * string, no `any` in between — and in the client bundle only a call stub
 * survives, never the body or its imports.
 */

/** The same schema that validates the URL also validates the RPC payload, so
 *  the page's search params and this endpoint's input cannot drift apart. */
export const listRecords = createServerFn({ method: 'GET' })
  .middleware([authedMiddleware])
  .validator(listSearchSchema)
  .handler(async ({ data }): Promise<Page<RecordItem>> =>
    queryRecords(data, { signal: requestSignal() }),
  )

const recordIdSchema = z.object({ recordId: z.string().min(1).max(64) })

export const getRecord = createServerFn({ method: 'GET' })
  .middleware([authedMiddleware])
  .validator(recordIdSchema)
  .handler(async ({ data }): Promise<RecordItem> => {
    const record = await findRecord(data.recordId, { signal: requestSignal() })
    if (!record) throw new Error(`NOT_FOUND:${data.recordId}`)
    return record
  })

/** Fast — the dashboard awaits this so the shell renders with real numbers. */
export const getSummary = createServerFn({ method: 'GET' })
  .middleware([authedMiddleware])
  .handler(async (): Promise<Summary> => summarize({ signal: requestSignal() }))

/** Slow — the dashboard streams this behind a Suspense boundary. */
export const getCategoryCounts = createServerFn({ method: 'GET' })
  .middleware([authedMiddleware])
  .handler(async (): Promise<Array<CategoryCount>> =>
    countByCategory({ signal: requestSignal() }),
  )
