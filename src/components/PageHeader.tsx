import type { ReactNode } from 'react'

/**
 * Shared page header so every route under the app shell keeps the same rhythm:
 * title, optional subtitle, optional actions on the right.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
}) {
  return (
    <header className="mb-6 flex flex-wrap items-baseline justify-between gap-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  )
}

/**
 * Small pill that states which SSR mode a route runs in.
 *
 * It is a development aid, not chrome: seeing `data-only` on screen while a
 * page renders is what makes the per-route SSR decision reviewable instead of
 * buried in a route option nobody reads.
 */
export function SsrTag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  )
}
