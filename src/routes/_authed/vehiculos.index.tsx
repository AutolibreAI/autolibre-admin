import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * `/vehiculos` no tiene pantalla propia: es el layout de pestañas. Entrar manda
 * al catálogo, que es lo que estaba en la URL vieja.
 */
export const Route = createFileRoute('/_authed/vehiculos/')({
  beforeLoad: () => {
    throw redirect({ to: '/vehiculos/catalogo' })
  },
})
