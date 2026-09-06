import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * `/leads` no tiene pantalla propia: es el layout de pestañas. Entrar manda a
 * la primera con datos.
 */
export const Route = createFileRoute('/_authed/leads/')({
  beforeLoad: () => {
    throw redirect({ to: '/leads/talleres' })
  },
})
