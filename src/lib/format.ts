/**
 * Isomorphic formatters. Locale and time zone are pinned so server-rendered
 * markup byte-matches the client's first render — the usual cause of hydration
 * mismatches in a table full of dates and numbers.
 */
const int = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 })

const date = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

export const formatInt = (n: number) => int.format(n)
export const formatDate = (iso: string) => date.format(new Date(iso))
