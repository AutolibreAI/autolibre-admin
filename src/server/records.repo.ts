import '@tanstack/react-start/server-only'

import { delay, source } from './placeholder-data'
import type { ListSearch } from '~/lib/search'
import type {
  CategoryCount,
  Page,
  RecordItem,
  RecordStatus,
  Summary,
} from '~/lib/types'

/**
 * The repository seam.
 *
 * Server functions and route handlers both call through here, never through the
 * data source directly. That means swapping the placeholder in `data.ts` for a
 * real database or upstream API touches this file and nothing above it.
 */

const SORT_ACCESSORS = {
  name: (r: RecordItem) => r.name,
  updatedAt: (r: RecordItem) => r.updatedAt,
} as const

export async function queryRecords(
  search: ListSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Page<RecordItem>> {
  await delay(80, opts.signal)

  const needle = search.q?.toLowerCase()
  const filtered = [...source.records].filter((r) => {
    if (search.status && r.status !== search.status) return false
    if (needle && !`${r.name} ${r.category}`.toLowerCase().includes(needle)) return false
    return true
  })

  const accessor = SORT_ACCESSORS[search.sort]
  const sign = search.dir === 'asc' ? 1 : -1
  const sorted = filtered.toSorted((a, b) =>
    accessor(a) < accessor(b) ? -sign : accessor(a) > accessor(b) ? sign : 0,
  )

  const total = sorted.length
  const pageCount = Math.max(1, Math.ceil(total / search.pageSize))
  // Clamp rather than 404 — a filter change can strand you past the last page.
  const page = Math.min(search.page, pageCount)
  const start = (page - 1) * search.pageSize

  return {
    items: sorted.slice(start, start + search.pageSize),
    total,
    page,
    pageSize: search.pageSize,
    pageCount,
  }
}

export async function findRecord(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<RecordItem | null> {
  await delay(60, opts.signal)
  return source.records.find((r) => r.id === id) ?? null
}

export async function summarize(
  opts: { signal?: AbortSignal } = {},
): Promise<Summary> {
  await delay(60, opts.signal)

  const byStatus: Record<RecordStatus, number> = { active: 0, pending: 0, archived: 0 }
  for (const r of source.records) byStatus[r.status] += 1

  return { total: source.records.length, byStatus }
}

/**
 * Deliberately slower than `summarize`. The dashboard awaits the summary and
 * streams this — see the loader in `routes/_authed/dashboard.tsx`.
 */
export async function countByCategory(
  opts: { signal?: AbortSignal } = {},
): Promise<Array<CategoryCount>> {
  await delay(900, opts.signal)

  const acc = new Map<string, number>()
  for (const r of source.records) {
    acc.set(r.category, (acc.get(r.category) ?? 0) + 1)
  }

  return [...acc.entries()]
    .map(([category, count]) => ({ category, count }))
    .toSorted((a, b) => b.count - a.count)
}
