import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { apiSessionMiddleware } from '~/fn/middleware'
import { adminFileSignedUrl } from '~/server/backend'
import { quoteRequestDownloads } from '~/server/quote-photos.repo'
import { zipStream } from '~/server/zip'

/**
 * `GET /api/pedidos/:quoteRequestId/fotos-zip` — TODAS las fotos del pedido en
 * un `.zip` (`AL-1068-fotos.zip`). Un click por foto pide permiso de
 * "descargas múltiples" en el navegador; un zip no.
 *
 * Mismo criterio que la descarga de a una (`pedidos.$quoteRequestId.fotos.$fileId.ts`):
 * sólo archivos atados al pedido, chequeo de rol acá, y la respuesta va en
 * STREAMING (`~/server/zip`) — con buffer, tres fotos de teléfono ya pasan el
 * tope de 4.5MB de Vercel.
 *
 * Si una foto no se puede traer, el zip ya empezó a salir y no hay forma de
 * devolver un error HTTP: el stream se corta y el navegador marca la descarga
 * como fallida. Las URLs se piden TODAS antes de empezar, así el caso más
 * común (backend caído, sin permiso) sí vuelve como error legible.
 */
const paramsSchema = z.object({ quoteRequestId: z.uuid() })

export const Route = createFileRoute('/api/pedidos/$quoteRequestId/fotos-zip')({
  server: {
    middleware: [apiSessionMiddleware],
    handlers: {
      GET: async ({ context, params }) => {
        if (!context.user) return Response.json({ error: 'unauthenticated' }, { status: 401 })
        if (context.user.role !== 'admin') return Response.json({ error: 'forbidden' }, { status: 403 })

        const parsed = paramsSchema.safeParse(params)
        if (!parsed.success) return Response.json({ error: 'invalid_params' }, { status: 400 })

        const found = await quoteRequestDownloads(parsed.data.quoteRequestId)
        if (!found || found.files.length === 0) return Response.json({ error: 'not_found' }, { status: 404 })

        let urls: Array<string>
        try {
          urls = await Promise.all(found.files.map(async (f) => (await adminFileSignedUrl(f.fileId)).url))
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          return new Response(`No se pudieron pedir las fotos: ${message}`, { status: 502 })
        }

        const body = zipStream(
          found.files.map((f, i) => ({
            name: f.fileName,
            load: async () => {
              const r = await fetch(urls[i]!)
              if (!r.ok) throw new Error(`Storage respondió ${r.status} para ${f.fileName}`)
              return new Uint8Array(await r.arrayBuffer())
            },
          })),
        )

        return new Response(body, {
          status: 200,
          headers: {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="AL-${found.publicNumber}-fotos.zip"`,
            'cache-control': 'private, no-store',
          },
        })
      },
    },
  },
})
