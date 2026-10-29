import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Card, CardContent } from '~/components/ui/card'
import { fetchQuoteClosureMock } from '~/mocks/quote-closures'
import { formatArs, formatDateTime } from '~/lib/format'
import {
  CLOSURE_CODE_LABELS,
  HIRED_WITH_LABELS,
  WORK_STATUS_LABELS,
} from '~/lib/quote-closures'
import { quoteUserOutcomeLabel } from '~/lib/quote-requests'
import type { ReactNode } from 'react'
import type { QuoteProposalsResult } from '~/lib/quote-proposals'
import type { QuoteClosure } from '~/lib/quote-closures'
import type { QuoteRequestDetail } from '~/lib/quote-requests'

/**
 * "Cierre declarado" en la ficha de un pedido.
 *
 * Arriba lo REAL: lo que la persona declaró en la app (`user_outcome`) y la
 * propuesta que eligió (`selected_proposal_id`). Abajo, lo que todavía no tiene
 * columna — con quién si no fue una propuesta, monto final, estado del trabajo,
 * motivo de "no contraté" — dicho como "sin dato", nunca con un valor de
 * ejemplo: es la ficha de un pedido real. La cola de disputas
 * (`/leads/pedidos/cierres`) es la que muestra ejemplos.
 */
export function QuoteClosureCard({
  detail: d,
  proposals,
}: {
  detail: QuoteRequestDetail
  proposals: QuoteProposalsResult
}) {
  const [closure, setClosure] = useState<QuoteClosure | null>(null)
  useEffect(() => {
    void fetchQuoteClosureMock(d.id).then(setClosure)
  }, [d.id])

  const selected =
    proposals.available && proposals.selectedProposalId
      ? [...proposals.active, ...proposals.withdrawn].find((p) => p.id === proposals.selectedProposalId) ?? null
      : null

  const missing = <span className="text-muted-foreground">sin dato · falta backend</span>

  return (
    <Card className="mb-4">
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-heading text-base font-semibold">Cierre declarado</h2>
          <Link
            to="/leads/pedidos/cierres"
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            Ver cierres y disputas
          </Link>
        </div>

        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Item label="Lo que declaró en la app">
            {d.userOutcome ? quoteUserOutcomeLabel(d.userOutcome) : <span className="text-muted-foreground">no declaró</span>}
            {d.userOutcomeAt ? (
              <span className="block text-xs text-muted-foreground">{formatDateTime(d.userOutcomeAt)} UTC</span>
            ) : null}
          </Item>
          <Item label="Propuesta elegida">
            {selected ? selected.providerName : <span className="text-muted-foreground">ninguna</span>}
          </Item>
          <Item label="Con quién contrató">
            {closure?.hiredWith ? `${HIRED_WITH_LABELS[closure.hiredWith]}: ${closure.providerName ?? '—'}` : missing}
          </Item>
          <Item label="Monto final">
            {closure?.finalAmount != null ? formatArs(closure.finalAmount) : missing}
          </Item>
          <Item label="Estado del trabajo">{closure ? WORK_STATUS_LABELS[closure.workStatus] : missing}</Item>
          <Item label="Código de cierre">{closure ? CLOSURE_CODE_LABELS[closure.closureCode] : missing}</Item>
          <Item label="Motivo de «no contraté»">{closure?.notHiredReason ?? missing}</Item>
        </dl>
        <p className="text-xs text-muted-foreground">
          La persona hoy sólo puede declarar «contraté / no contraté» y elegir una propuesta. Con quién, monto,
          motivo y la confirmación del proveedor esperan al backend.
        </p>
      </CardContent>
    </Card>
  )
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="mb-0.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
