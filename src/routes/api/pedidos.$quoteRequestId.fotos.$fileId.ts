import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { apiSessionMiddleware } from '~/fn/middleware'
import { adminFileSignedUrl } from '~/server/backend'
import { quoteRequestDownloads } from '~/server/quote-photos.repo'

/**
 * `GET /api/pedidos/:quoteRequestId/fotos/:fileId` — DESCARGA una foto del
 * pedido, como adjunto y con nombre (`AL-1068-….jpg`).
 *
 * Por qué pasa por el panel y no es un link a la URL firmada: el backend firma
 * sin `Content-Disposition`, y la URL es de otro dominio (Spaces), así que el
 * navegador ignora el atributo `download` y ABRE la foto en vez de bajarla. El
 * panel la trae y la reenvía en STREAMING (sin buffer), que es lo que la deja
 * pasar el límite de 4.5MB de una respuesta de Vercel. Si el backend algún día
 * firma con `attachment`, esto se reemplaza por un link (pedido en
 * `docs/pedido-backend-2026-10-03.md`).
 *
 * Sólo baja un archivo ATADO a ese pedido (`quoteRequestDownloads`), nunca un
 * id cualquiera. Mismo chequeo de rol que `/api/metricas`: un endpoint HTTP es
 * alcanzable con cualquier sesión de la app.
 */
const paramsSchema = z.object({ quoteRequestId: z.uuid(), fileId: z.uuid() })

export const Route = createFileRoute('/api/pedidos/$quoteRequestId/fotos/$fileId')({
  server: {
    middleware: [apiSessionMiddleware],
    handlers: {
      GET: async ({ context, params }) => {
        if (!context.user) return Response.json({ error: 'unauthenticated' }, { status: 401 })
        if (context.user.role !== 'admin') return Response.json({ error: 'forbidden' }, { status: 403 })

        const parsed = paramsSchema.safeParse(params)
        if (!parsed.success) return Response.json({ error: 'invalid_params' }, { status: 400 })

        const found = await quoteRequestDownloads(parsed.data.quoteRequestId, parsed.data.fileId)
        const file = found?.files[0]
        if (!file) return Response.json({ error: 'not_found' }, { status: 404 })

        let upstream: Response
        try {
          const { url } = await adminFileSignedUrl(file.fileId)
          upstream = await fetch(url)
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          return new Response(`No se pudo traer la foto: ${message}`, { status: 502 })
        }
        if (!upstream.ok || !upstream.body) {
          return new Response(`Storage respondió ${upstream.status}`, { status: 502 })
        }

        const headers = new Headers({
          'content-type': file.mimeType ?? upstream.headers.get('content-type') ?? 'application/octet-stream',
          'content-disposition': `attachment; filename="${file.fileName}"`,
          'cache-control': 'private, no-store',
        })
        const length = upstream.headers.get('content-length')
        if (length) headers.set('content-length', length)
        return new Response(upstream.body, { status: 200, headers })
      },
    },
  },
})
