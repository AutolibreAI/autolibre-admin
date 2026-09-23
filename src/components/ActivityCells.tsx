import { Link } from '@tanstack/react-router'
import {
  outcomeLabel,
  outcomeTone,
  type ActivityDetailKind,
  type ActivityKind,
} from '~/lib/activity-feed'
import { cn } from '~/lib/utils'
import type { ReactNode } from 'react'

/**
 * El link de una fila del feed: lleva a la pantalla DUEÑA de esa entidad
 * cuando existe, y a la ficha de actividad cuando no.
 *
 * ── Por qué es un `switch` de `<Link>` tipados y no un href armado ──────────
 *
 * `<Link to={unString}>` compila sin que el compilador mire el destino: una
 * ruta mal escrita pasa el `tsc`, pasa el build, y recién falla cuando alguien
 * la clickea. Con `to="/chats/$conversationId"` + `params`, el destino y el
 * nombre del parámetro los verifica TanStack contra `routeTree.gen.ts`.
 *
 * ── El `default` es el guardrail, no el caso perezoso ───────────────────────
 *
 * Asignar el `kind` que sobra a un `ActivityDetailKind` es lo que hace que
 * **agregar un tipo de evento nuevo sin darle destino no compile**: o tiene su
 * `case` acá, o está en `ACTIVITY_DETAIL_KINDS` (y entonces tiene ficha y
 * consulta de detalle, que `DETAIL_QUERIES` también obliga a cubrir). No hay
 * tercera opción, que es exactamente lo que se quiere.
 */
export function ActivityLink({
  kind,
  id,
  userId,
  className,
  children,
}: {
  kind: ActivityKind
  id: string
  /**
   * Sólo la usa `feedback`, que linkea a `/feedback?userId=…` en vez de a una
   * ficha propia (`/feedback` no tiene detalle por fila — un feedback no
   * necesita más pantalla que la que ya lo muestra completo). Puede ser
   * `null` (mismo caso que `login`, trampa 9 de `activity-feed.md`): ahí cae
   * al listado sin filtrar en vez de romper.
   */
  userId?: string | null
  className?: string
  children: ReactNode
}) {
  switch (kind) {
    case 'alta_usuario':
      return (
        <Link to="/usuarios/$userId" params={{ userId: id }} className={className}>
          {children}
        </Link>
      )
    case 'chat':
      return (
        <Link to="/chats/$conversationId" params={{ conversationId: id }} className={className}>
          {children}
        </Link>
      )
    case 'escaneo':
      return (
        <Link
          to="/escaneres/sesiones/$sessionId"
          params={{ sessionId: id }}
          className={className}
        >
          {children}
        </Link>
      )
    case 'seguro':
    case 'cedula':
    case 'registro':
    case 'vtv':
      return (
        <Link
          to="/documentos/$docType/$docId"
          params={{ docType: kind, docId: id }}
          className={className}
        >
          {children}
        </Link>
      )
    case 'pedido':
      return (
        <Link
          to="/leads/pedidos/$quoteRequestId"
          params={{ quoteRequestId: id }}
          className={className}
        >
          {children}
        </Link>
      )
    case 'feedback':
      return (
        <Link to="/feedback" search={userId ? { userId } : {}} className={className}>
          {children}
        </Link>
      )
    default: {
      const detailKind: ActivityDetailKind = kind
      return (
        <Link
          to="/actividad/$activityKind/$activityId"
          params={{ activityKind: detailKind, activityId: id }}
          className={className}
        >
          {children}
        </Link>
      )
    }
  }
}

/**
 * El resultado de un evento de actividad, con tono.
 *
 * Vive acá y no adentro de la ruta del listado porque la ficha
 * (`/actividad/:tipo/:id`) muestra el MISMO chip: si el resultado se viera
 * distinto en las dos pantallas, una estaría mal y no habría forma de saber
 * cuál. Mismo criterio que `Filters.tsx` y `VehicleCells.tsx`.
 *
 * `warn` es la razón de ser de esta columna: es la única forma de barrer el feed
 * buscando lo que salió mal —un escaneo que no trajo nada, una consulta fallada,
 * un pedido sin contactar— sin leer fila por fila. Un código desconocido se
 * muestra CRUDO y en gris, nunca se esconde.
 */
export function OutcomeBadge({ code }: { code: string }) {
  const tone = outcomeTone(code)

  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-xs',
        tone === 'ok' && 'border-status-green/30 bg-status-green-bg text-status-green',
        tone === 'warn' && 'border-status-yellow/30 bg-status-yellow-bg text-status-yellow',
        tone === 'muted' && 'border-border bg-secondary text-muted-foreground',
      )}
    >
      {outcomeLabel(code)}
    </span>
  )
}
