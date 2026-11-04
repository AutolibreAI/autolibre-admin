import { useEffect, useState } from 'react'
import { Check, Copy, ExternalLink, Globe } from 'lucide-react'
import { publicProfile } from '~/lib/partners'
import { cn } from '~/lib/utils'

/**
 * El link al perfil público del proveedor en la web (`/proveedores/<slug>`).
 *
 * Sirve para soporte, para el alta con Tobías y para pasarle al proveedor la
 * dirección que pone como sitio web en Google Maps. Va arriba de la ficha, al
 * lado del nombre: no escondido en una tarjeta.
 *
 * Sin perfil publicado dice «Sin perfil público» y el motivo, nunca un link
 * roto (`publicProfile()` en `~/lib/partners`).
 *
 * Copiar sigue el criterio de `CopyableId`: el ícono cambia sólo si de verdad
 * se copió; si el portapapeles falla, la URL sigue a la vista para copiarla a
 * mano.
 */
export function PublicProfileLink({
  status,
  slug,
  className,
}: {
  status: string
  slug: string | null
  className?: string
}) {
  const profile = publicProfile(status, slug)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(id)
  }, [copied])

  if (profile.url === null) {
    return (
      <p className={cn('inline-flex items-center gap-1.5 text-sm text-muted-foreground', className)}>
        <Globe className="size-3.5" aria-hidden />
        Sin perfil público <span className="text-xs">({profile.reason})</span>
      </p>
    )
  }

  const url = profile.url
  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // Sin permiso o contexto no seguro: no se miente con un «copiado».
    }
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Globe className="size-3.5 text-muted-foreground" aria-hidden />
      <span className="min-w-0 break-all font-mono text-xs text-foreground">{url.replace(/^https:\/\//, '')}</span>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-secondary"
      >
        <ExternalLink className="size-3" aria-hidden />
        Abrir
      </a>
      <button
        type="button"
        onClick={copy}
        className={cn(
          'inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-secondary',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring',
          copied && 'text-status-green',
        )}
      >
        {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
        {copied ? 'Copiado' : 'Copiar link'}
      </button>
      <span className="sr-only" role="status">
        {copied ? 'Link copiado' : ''}
      </span>
    </div>
  )
}

/**
 * La versión de una fila del listado: un ícono que abre el perfil en otra
 * pestaña. Sin perfil, el ícono sale apagado y el `title` dice por qué.
 */
export function PublicProfileIcon({ status, slug }: { status: string; slug: string | null }) {
  const profile = publicProfile(status, slug)
  if (profile.url === null) {
    return (
      <span title={`Sin perfil público: ${profile.reason}`} className="inline-flex text-muted-foreground/40">
        <Globe className="size-3.5" aria-hidden />
        <span className="sr-only">Sin perfil público</span>
      </span>
    )
  }
  return (
    <a
      href={profile.url}
      target="_blank"
      rel="noopener noreferrer"
      title="Abrir el perfil público"
      className="inline-flex rounded text-muted-foreground hover:text-brand focus-visible:ring-2 focus-visible:ring-ring outline-none"
    >
      <Globe className="size-3.5" aria-hidden />
      <span className="sr-only">Abrir el perfil público</span>
    </a>
  )
}
