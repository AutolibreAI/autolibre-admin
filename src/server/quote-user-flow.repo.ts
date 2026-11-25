import '@tanstack/react-start/server-only'

import { sqlOne } from './db'
import type { QuoteUserFlowProvenance, QuoteUserFlowSource } from '~/lib/quote-user-flow'

/**
 * La PROCEDENCIA de los dos pasos del flujo de la persona: quién eligió la
 * propuesta y quién declaró si fue (la persona en la app, o el equipo en su
 * nombre). Sólo lectura: las escrituras van por HTTP (`~/server/backend`), y
 * es el backend el que llena estas columnas.
 *
 * ── Los nombres de las columnas viven SÓLO acá ─────────────────────────────
 *
 * Al 2026-11-25 el backend los está escribiendo en paralelo y los nombres son
 * TENTATIVOS. Si cambian, se cambia este objeto y nada más: el SQL de abajo y
 * el guard de disponibilidad se arman desde él.
 *
 * `selected_at` y `user_outcome_at` no están: ya existían (0120–0122 y 0093) y
 * los leen `quote-proposals.repo.ts` y `quote-requests.repo.ts`.
 */
export const QUOTE_USER_FLOW_COLUMNS = {
  selectionSource: 'selection_source',
  selectedBy: 'selected_by',
  outcomeSource: 'user_outcome_source',
  outcomeDeclaredBy: 'user_outcome_declared_by',
  outcomePerformedOn: 'user_outcome_performed_on',
} as const

const COLUMN_NAMES = Object.values(QUOTE_USER_FLOW_COLUMNS)

/**
 * ¿Tiene esta base la migración del backend? Mismo patrón que
 * `quoteProposalsAvailability()`: contar en `information_schema` las columnas
 * que se leen, NO un `select … limit 0` con try/catch (termina tragándose los
 * errores reales). Sin ellas la ficha anda igual y dice que falta la
 * migración: así se puede desarrollar contra una base local que todavía no la
 * tiene, sin flag ni configuración que haya que acordarse de prender.
 */
export async function quoteUserFlowProvenanceAvailable(): Promise<boolean> {
  const row = await sqlOne<{ n: number }>(
    `select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and table_name = 'quote_requests'
        and column_name = any($1::text[])`,
    [COLUMN_NAMES],
  )
  return Number(row?.n ?? 0) === COLUMN_NAMES.length
}

interface ProvenanceRow {
  selection_source: string | null
  selected_by: string | null
  selected_by_name: string | null
  selected_by_email: string | null
  outcome_source: string | null
  outcome_declared_by: string | null
  outcome_declared_by_name: string | null
  outcome_declared_by_email: string | null
  outcome_performed_on: string | null
}

const toSource = (v: string | null): QuoteUserFlowSource | null => (v === 'user' || v === 'operator' ? v : null)

export async function getQuoteUserFlowProvenance(quoteRequestId: string): Promise<QuoteUserFlowProvenance> {
  if (!(await quoteUserFlowProvenanceAvailable())) return { available: false }

  // Los identificadores salen de la constante de arriba (cerrada, nunca del
  // request): interpolarlos es seguro. Los valores van por `$1`.
  const c = QUOTE_USER_FLOW_COLUMNS
  const row = await sqlOne<ProvenanceRow>(
    `select qr.${c.selectionSource}::text as selection_source,
            qr.${c.selectedBy} as selected_by,
            sb.name as selected_by_name, sb.email as selected_by_email,
            qr.${c.outcomeSource}::text as outcome_source,
            qr.${c.outcomeDeclaredBy} as outcome_declared_by,
            ob.name as outcome_declared_by_name, ob.email as outcome_declared_by_email,
            to_char(qr.${c.outcomePerformedOn}, 'YYYY-MM-DD') as outcome_performed_on
       from quote_requests qr
       left join users sb on sb.id = qr.${c.selectedBy}
       left join users ob on ob.id = qr.${c.outcomeDeclaredBy}
      where qr.id = $1`,
    [quoteRequestId],
  )
  if (!row) return { available: false }

  return {
    available: true,
    selection: {
      source: toSource(row.selection_source),
      by: row.selected_by
        ? { id: row.selected_by, name: row.selected_by_name, email: row.selected_by_email }
        : null,
    },
    outcome: {
      source: toSource(row.outcome_source),
      by: row.outcome_declared_by
        ? { id: row.outcome_declared_by, name: row.outcome_declared_by_name, email: row.outcome_declared_by_email }
        : null,
      performedOn: row.outcome_performed_on,
    },
  }
}
