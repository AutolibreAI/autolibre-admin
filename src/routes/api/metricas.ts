import { createFileRoute } from '@tanstack/react-router'
import { opsSearchSchema } from '~/lib/ops'
import {
  adoptionPulse,
  catalogGaps,
  failureReasons,
  leadFunnel,
  marketplaceHealth,
  queueHealth,
} from '~/server/ops.repo'
import { apiSessionMiddleware } from '~/fn/middleware'

/**
 * `GET /api/metricas?window=30d` — el mismo dato que pintan Inicio y Operación,
 * en JSON, para scripts y para el bot de guardia.
 *
 * Por qué existe además de las pantallas: la pregunta "¿hay algo colgado?" no
 * siempre la hace una persona mirando. Un cron que la haga cada diez minutos y
 * avise por WhatsApp vale más que un panel que alguien tiene que acordarse de
 * abrir — y ese cron necesita JSON, no HTML.
 *
 * Tres cosas que valen la pena:
 *
 *  1. Reutiliza `opsSearchSchema`. El contrato de la URL de /operacion y el de
 *     este endpoint son el MISMO objeto, así que no pueden divergir.
 *
 *  2. Llama al repositorio directo, no al server function. Los server functions
 *     existen para que el CLIENTE llame con los tipos intactos; adentro de un
 *     handler ya estamos en el servidor y el salto RPC sería puro overhead.
 *     Los dos caminos convergen en el mismo módulo server-only, que es donde
 *     viven las reglas.
 *
 *  3. Parsea con `safeParse` de zod y no con el helper `getValidatedQuery` de
 *     Start: ese helper no ata su genérico al parámetro, así que resuelve a
 *     `any` y borra en silencio los tipos que este endpoint existe para
 *     garantizar. Yendo por zod directo el resultado queda tipado y podemos
 *     devolver los issues reales en el 400.
 */
export const Route = createFileRoute('/api/metricas')({
  server: {
    middleware: [apiSessionMiddleware],
    handlers: {
      GET: async ({ context, request }) => {
        if (!context.user) {
          return Response.json({ error: 'unauthenticated' }, { status: 401 })
        }
        // Un usuario logueado de la app NO es staff. Este endpoint es
        // alcanzable con cualquier cookie de sesión válida, así que el chequeo
        // de rol va acá y no sólo en el guard de la ruta — que sólo modela lo
        // que la UI ofrece.
        if (context.user.role !== 'admin') {
          return Response.json({ error: 'forbidden' }, { status: 403 })
        }

        const url = new URL(request.url)
        const parsed = opsSearchSchema.safeParse(Object.fromEntries(url.searchParams))
        if (!parsed.success) {
          return Response.json(
            {
              error: 'invalid_query',
              issues: parsed.error.issues.map((i) => ({
                path: i.path.join('.'),
                message: i.message,
              })),
            },
            { status: 400 },
          )
        }

        const { window } = parsed.data
        const signal = request.signal

        const [adoption, marketplace, leads, queues, failures, gaps] = await Promise.all([
          adoptionPulse({ signal }),
          marketplaceHealth({ signal }),
          leadFunnel({ signal }),
          queueHealth({ signal }),
          failureReasons(window, { signal }),
          catalogGaps(window, { signal }),
        ])

        return Response.json(
          { window, adoption, marketplace, leads, queues, failures, gaps },
          // Corto a propósito: un chequeo de guardia que llegue 15 segundos
          // tarde sigue siendo útil; uno que lea una respuesta de hace cinco
          // minutos avisa de una cola que ya se destrabó.
          { headers: { 'cache-control': 'private, max-age=15' } },
        )
      },
    },
  },
})
