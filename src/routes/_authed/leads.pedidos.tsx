import { createFileRoute } from '@tanstack/react-router'
import { ComingSoonPipeline } from '~/components/ComingSoonPipeline'
import { PageHeader } from '~/components/PageHeader'

/**
 * Pedidos de presupuesto — pestaña "todavía no". El flujo no existe.
 * → `.claude/rules/leads.md`
 */
export const Route = createFileRoute('/_authed/leads/pedidos')({
  head: () => ({ meta: [{ title: 'Leads · Pedidos — AutoLibre' }] }),
  component: Pedidos,
})

function Pedidos() {
  return (
    <>
      <PageHeader
        title="Pedidos de presupuesto"
        subtitle="El usuario publica un pedido y varios partners presupuestan."
      />
      <ComingSoonPipeline
        what="El usuario dice “quiero hacer el service de los 40.000 km” y recibe varias ofertas de partners para comparar. Es el marketplace al revés: en vez de elegir un taller y contactarlo, publica la necesidad y los talleres vienen."
        blocker="No existe el flujo ni las tablas (pedido, presupuesto, oferta). Es un aggregate nuevo del backend, no algo que se resuelva con SQL desde el panel. Se diferencia de la pestaña Talleres en la dirección: acá el usuario no elige el taller de antemano."
      />
    </>
  )
}
