import { useEffect, useRef, useState } from 'react'
import { searchNotificationRecipients } from '~/fn/notifications'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { fetchQuoteUserLinkMock, linkQuoteUserMock, unlinkQuoteUserMock } from '~/mocks/quote-user-link'
import { RECIPIENT_SEARCH_MIN_CHARS } from '~/lib/notifications'
import type { NotificationRecipient } from '~/lib/notifications'
import type { QuoteUserLink } from '~/mocks/quote-user-link'
import { cn } from '~/lib/utils'

/**
 * Vincular un pedido sin cuenta (los que entran por WhatsApp o se cargan a
 * mano) con una cuenta de la app.
 *
 * La búsqueda es REAL: el mismo `searchNotificationRecipients` del compositor
 * de notificaciones (email y nombre, `adminMiddleware`). El vínculo es de
 * ejemplo (`~/mocks/quote-user-link`) hasta que el backend tenga el endpoint.
 * Por teléfono o patente no se puede buscar: `users.phone` está vacío y el
 * buscador no cruza vehículos.
 */
export function QuoteUserLinker({ quoteRequestId }: { quoteRequestId: string }) {
  const [link, setLink] = useState<QuoteUserLink | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void fetchQuoteUserLinkMock(quoteRequestId).then(setLink)
  }, [quoteRequestId])

  if (link) {
    return (
      <div className="mt-2 rounded-md border border-status-yellow/40 bg-status-yellow-bg px-3 py-2 text-sm text-status-yellow">
        Vinculado a <span className="font-medium">{link.email}</span> — de ejemplo: no se guardó en la base.{' '}
        <button
          type="button"
          className="underline underline-offset-2"
          onClick={() => void unlinkQuoteUserMock(quoteRequestId).then(() => setLink(null))}
        >
          Desvincular
        </button>
      </div>
    )
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" className="mt-2" onClick={() => setOpen(true)}>
        Vincular a un usuario de la app
      </Button>
    )
  }

  return (
    <AppUserSearch
      className="mt-2"
      onCancel={() => setOpen(false)}
      onPick={(u) =>
        void linkQuoteUserMock(quoteRequestId, { userId: u.id, email: u.email, name: u.name }).then(setLink)
      }
    />
  )
}

/**
 * El buscador de cuentas, sin saber de pedidos: lo usan la ficha
 * (`QuoteUserLinker`) y «Cargar pedido» (`QuoteRequestComposer`), que vincula
 * recién después de crear el pedido.
 */
export function AppUserSearch({
  onPick,
  onCancel,
  className,
}: {
  onPick: (user: NotificationRecipient) => void
  onCancel: () => void
  className?: string
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Array<NotificationRecipient> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const term = q.trim()
    if (term.length < RECIPIENT_SEARCH_MIN_CHARS) {
      setResults(null)
      return
    }
    const mine = ++seq.current
    const t = setTimeout(() => {
      searchNotificationRecipients({ data: { q: term } })
        .then((rows) => {
          if (mine === seq.current) setResults(rows)
        })
        .catch(() => {
          if (mine === seq.current) setError('No pudimos buscar. Probá de nuevo.')
        })
    }, 300)
    return () => clearTimeout(t)
  }, [q])

  return (
    <div className={cn('space-y-2 rounded-md border border-border p-3', className)}>
      <Input
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setError(null)
        }}
        // Adentro de «Cargar pedido» esto vive en un <form>: Enter no puede crear el pedido.
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault()
        }}
        placeholder="Email o nombre de la cuenta"
        aria-label="Buscar usuario"
      />
      <p className="text-xs text-muted-foreground">
        Por teléfono o patente todavía no se puede: las cuentas no guardan teléfono y el buscador no cruza
        vehículos. Vincular es de ejemplo (no se guarda).
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {results === null ? null : results.length === 0 ? (
        <p className="text-sm text-muted-foreground">Ninguna cuenta coincide.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {results.slice(0, 8).map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                {u.email}
                {u.name ? <span className="text-muted-foreground"> · {u.name}</span> : null}
              </span>
              <Button type="button" size="xs" variant="outline" onClick={() => onPick(u)}>
                Vincular
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
        Cancelar
      </Button>
    </div>
  )
}
