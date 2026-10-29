import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * `/comercial` no tiene pantalla propia: es el layout de pestañas. Entrar
 * manda a Hoy — los seguimientos vencidos y del día son lo primero que se ve.
 */
export const Route = createFileRoute('/_authed/comercial/')({
  beforeLoad: () => {
    throw redirect({ to: '/comercial/hoy' })
  },
})
