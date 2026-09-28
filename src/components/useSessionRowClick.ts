import { useNavigate } from '@tanstack/react-router'
import type { MouseEvent } from 'react'

/**
 * Hace que TODA la fila de un escaneo abra su ficha (`/escaneres/sesiones/:id`),
 * no sólo la fecha. Pedido del 2026-09-25: "cuando presiono uno quiero entrar".
 *
 * Lo usan las tres listas de escaneos (`/escaneres/sesiones`, el panel de la
 * matriz de compatibilidad y el de detecciones) — un solo lugar para el mismo
 * gesto, mismo criterio que `SortHeader`.
 *
 * El `<Link>` de la fecha SE QUEDA: es lo que funciona con teclado, con el botón
 * del medio y con "abrir en pestaña nueva". Una fila con `onClick` sola no es
 * accesible. Por eso el click se ignora cuando cae en cualquier control propio
 * de la fila (el link del usuario, el botón de copiar el id…) o cuando la
 * persona está seleccionando texto para copiarlo.
 */
export function useSessionRowClick(sessionId: string) {
  const navigate = useNavigate()
  return {
    onClick: (e: MouseEvent<HTMLElement>) => {
      const target = e.target as HTMLElement
      if (target.closest('a, button, input, select, textarea, summary, [role="button"]')) return
      if (typeof window !== 'undefined' && window.getSelection()?.toString()) return
      void navigate({ to: '/escaneres/sesiones/$sessionId', params: { sessionId } })
    },
    className: 'cursor-pointer hover:bg-secondary/50',
  }
}
