import { useEffect, useMemo, useState } from 'react'
import { listQuoteProposalsFn } from '~/fn/quote-proposals'
import type { ProposalFact } from '~/lib/partner-plans'

/**
 * Las propuestas reales de una lista de pedidos, pedido por pedido, desde el
 * navegador — lo comparten Partners › Propuestas y Partners › Estudio.
 *
 * No hay un endpoint que traiga propuestas por proveedor, así que se usa
 * `listQuoteProposalsFn` (el de la ficha), cuatro a la vez, como el GPS del mapa
 * de cobertura. Cache del módulo: cambiar de pestaña, de mes o de período no
 * vuelve a pedir nada. El día que exista `GET /admin/partner-proposal-usage`,
 * este hook se va.
 */
export interface ProposalRequestMeta {
  id: string
  createdAt: string
  channel: string
}

const cache = new Map<string, Array<ProposalFact> | 'error' | 'unavailable'>()
const CONCURRENCY = 4

export function useProposalFacts(requests: ReadonlyArray<ProposalRequestMeta>) {
  const key = requests.map((r) => r.id).join(',')
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    const pending = requests.filter((r) => !cache.has(r.id))
    let next = 0
    let sinceRender = 0
    const worker = async () => {
      while (!cancelled && next < pending.length) {
        const req = pending[next++]!
        try {
          const res = await listQuoteProposalsFn({ data: { quoteRequestId: req.id } })
          if (!res.available) {
            cache.set(req.id, 'unavailable')
          } else {
            cache.set(
              req.id,
              [...res.active, ...res.withdrawn].map((p) => ({
                id: p.id,
                quoteRequestId: req.id,
                partnerId: p.partnerId,
                providerName: p.providerName,
                createdAt: p.createdAt,
                withdrawnAt: p.withdrawnAt,
                selected: p.id === res.selectedProposalId,
                requestCreatedAt: req.createdAt,
                requestChannel: req.channel,
                requestHasSelection: res.selectedProposalId !== null,
              })),
            )
          }
        } catch {
          cache.set(req.id, 'error')
        }
        if (!cancelled && ++sinceRender >= 8) {
          sinceRender = 0
          setVersion((v) => v + 1)
        }
      }
    }
    void Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(() => {
      if (!cancelled) setVersion((v) => v + 1)
    })
    return () => {
      cancelled = true
    }
    // `requests` cambia sólo si cambia `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return useMemo(() => {
    const facts: Array<ProposalFact> = []
    let done = 0
    let failed = 0
    let unavailable = false
    for (const r of requests) {
      const v = cache.get(r.id)
      if (v === undefined) continue
      done += 1
      if (v === 'error') failed += 1
      else if (v === 'unavailable') unavailable = true
      else facts.push(...v)
    }
    return { facts, done, failed, unavailable, total: requests.length, loading: done < requests.length }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version])
}

export type ProposalFactsLoad = ReturnType<typeof useProposalFacts>
