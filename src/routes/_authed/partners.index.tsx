import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * `/partners` no tiene pantalla propia: es el layout de pestañas. Entrar manda
 * al Listado, que es lo que estaba en la URL vieja.
 */
export const Route = createFileRoute('/_authed/partners/')({
  beforeLoad: () => {
    throw redirect({ to: '/partners/listado' })
  },
})
