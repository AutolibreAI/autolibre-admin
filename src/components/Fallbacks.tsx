import { Link, type ErrorComponentProps } from '@tanstack/react-router'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'

export function DefaultError({ error, reset }: ErrorComponentProps) {
  const message = error instanceof Error ? error.message : String(error)

  // Server functions surface auth failures as thrown errors; translate the
  // sentinel strings from src/fn/middleware.ts into something a human reads.
  const friendly =
    message === 'UNAUTHENTICATED'
      ? 'Tu sesión expiró. Volvé a iniciar sesión.'
      : message === 'FORBIDDEN'
        ? 'Tu rol no tiene permiso para esta acción.'
        : message.startsWith('NOT_FOUND:')
          ? `No encontramos el registro ${message.slice('NOT_FOUND:'.length)}.`
          : message

  return (
    <div className="rounded-lg border border-destructive/30 bg-status-red-bg p-4">
      <h2 className="mb-1 text-base font-semibold text-destructive">Algo se rompió</h2>
      <p className="mb-3 text-sm text-muted-foreground">{friendly}</p>
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={reset}>
          Reintentar
        </Button>
        <Link to="/dashboard" className="text-sm text-brand hover:underline">
          Ir al inicio
        </Link>
      </div>
    </div>
  )
}

export function DefaultNotFound() {
  return (
    <div className="py-16 text-center">
      <h2 className="text-lg font-semibold">404 — no existe</h2>
      <p className="mt-1 text-sm text-muted-foreground">Esa ruta no existe.</p>
      <Link to="/dashboard" className="mt-3 inline-block text-sm text-brand hover:underline">
        Volver al inicio
      </Link>
    </div>
  )
}

export function RoutePending() {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      <Skeleton className="h-5 w-1/3" />
      <Skeleton className="h-28 w-full" />
    </div>
  )
}

/** Reusable placeholder for a panel that is still streaming in. */
export function PanelSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div className="space-y-2.5" aria-busy="true" aria-live="polite" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-3" style={{ width: `${94 - i * 12}%` }} />
      ))}
    </div>
  )
}
