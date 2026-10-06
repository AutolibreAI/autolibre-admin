import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * Inicio ya no existe — se sacó el 2026-10-06, a pedido: era una versión
 * reducida de `/metricas` (las mismas 4 cards del pulso más dos tarjetas) y no
 * agregaba nada que Métricas no muestre.
 *
 * La ruta queda como redirect, no se borra: `/dashboard` puede estar en
 * favoritos y en la URL post-login configurada en Clerk, y un 404 ahí se lee
 * como "el panel está caído".
 */
export const Route = createFileRoute('/_authed/dashboard')({
  beforeLoad: () => {
    throw redirect({ to: '/metricas' })
  },
})
