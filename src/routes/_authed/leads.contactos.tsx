import { createFileRoute } from '@tanstack/react-router'
import { ComingSoonPipeline } from '~/components/ComingSoonPipeline'
import { PageHeader } from '~/components/PageHeader'

/**
 * Contactos directos a partners — pestaña "todavía no".
 *
 * No se puede arrancar desde este repo: el evento (un usuario abre el WhatsApp
 * de un partner) pasa en la app mobile y hoy no se persiste en ningún lado.
 * → `.claude/rules/leads.md`
 */
export const Route = createFileRoute('/_authed/leads/contactos')({
  head: () => ({ meta: [{ title: 'Leads · Contactos — AutoLibre' }] }),
  component: Contactos,
})

function Contactos() {
  return (
    <>
      <PageHeader
        title="Contactos directos a partners"
        subtitle="Cuántas veces un usuario tocó “contactar por WhatsApp” a un partner."
      />
      <ComingSoonPipeline
        what="Un conteo —total y por fecha— de cada vez que un usuario abre el WhatsApp de un partner desde el marketplace. Es la señal de intención más barata que hay: no exige que el usuario complete nada."
        blocker="Ninguna tabla registra ese tap. El evento pasa en la app mobile y no se guarda (`recommendation_impressions` sólo anota que el partner se mostró en el ranking, no que lo contactaron). Necesita que la app emita el evento y el backend lo persista —una tabla append-only, o un endpoint en `query/`—; recién ahí el panel lo lee y el conteo por fecha es un `group by` trivial. No es un SQL que este repo pueda escribir."
      />
    </>
  )
}
