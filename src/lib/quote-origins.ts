import { QUOTE_REQUEST_ORIGIN_LABELS, quoteChannelLabel } from '~/lib/quote-requests'

/** Pedidos por origen y semana (`~/server/quote-origins.repo`). */
export interface QuoteOriginWeekly {
  available: boolean
  /** ¿Está la 036? Sin ella, todo lo cargado a mano sale «sin origen». */
  originAvailable: boolean
  rows: Array<{ week: string; source: string; count: number }>
}

export const QUOTE_ORIGIN_WEEKS = 12

/** Etiqueta de una fuente: `origen:<x>`, `canal:<x>` o `manual_sin_origen`. */
export function quoteSourceLabel(source: string): string {
  if (source === 'manual_sin_origen') return 'A mano, sin origen'
  const [kind, value = ''] = source.split(':')
  if (kind === 'origen') return (QUOTE_REQUEST_ORIGIN_LABELS as Record<string, string>)[value] ?? value
  if (kind === 'canal') return `${quoteChannelLabel(value)} (entró solo)`
  return source
}

/** Orden de columnas: los orígenes del catálogo, después «sin origen», después los canales. */
export function sourceOrder(source: string): number {
  if (source.startsWith('origen:')) {
    const i = Object.keys(QUOTE_REQUEST_ORIGIN_LABELS).indexOf(source.slice(7))
    return i === -1 ? 50 : i
  }
  if (source === 'manual_sin_origen') return 60
  return 70
}
