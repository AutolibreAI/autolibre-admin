import { createFileRoute } from '@tanstack/react-router'
import { ComingSoonPipeline } from '~/components/ComingSoonPipeline'
import { PageHeader } from '~/components/PageHeader'

/**
 * Financiación de pagos — pestaña "todavía no". El producto no existe.
 * → `.claude/rules/leads.md`
 */
export const Route = createFileRoute('/_authed/leads/financiacion')({
  head: () => ({ meta: [{ title: 'Leads · Financiación — AutoLibre' }] }),
  component: Financiacion,
})

function Financiacion() {
  return (
    <>
      <PageHeader
        title="Financiación de pagos"
        subtitle="Financiar lo que un usuario pague dentro de AutoLibre."
      />
      <ComingSoonPipeline
        what="Ofrecerle a un usuario pagar en cuotas un service, una reparación o cualquier cosa que se pague por la plataforma, y medir cuántos lo piden y cuántos se aprueban."
        blocker="El producto no existe todavía: no hay flujo ni tablas. Cuando exista, es un bounded context nuevo del backend con su propio modelo; esta pestaña recién entonces muestra su pipeline. No se resuelve con SQL desde el panel."
      />
    </>
  )
}
