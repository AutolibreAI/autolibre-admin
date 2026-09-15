import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * `/leads` no tiene pantalla propia: es el layout de pestañas. Entrar manda a
 * Pedidos — es la pestaña default a pedido, primera en `TABS` de `leads.tsx`.
 */
export const Route = createFileRoute('/_authed/leads/')({
  beforeLoad: () => {
    throw redirect({ to: '/leads/pedidos' })
  },
})
