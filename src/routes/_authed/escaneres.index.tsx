import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * `/escaneres` no tiene pantalla propia: es el layout de pestañas. Entrar manda
 * a Compatibilidad, que es lo que estaba en la URL vieja.
 */
export const Route = createFileRoute('/_authed/escaneres/')({
  beforeLoad: () => {
    throw redirect({ to: '/escaneres/compatibilidad' })
  },
})
