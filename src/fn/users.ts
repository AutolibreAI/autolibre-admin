import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { userSearchSchema } from '~/lib/users'
import { findUserDetail, listUserVehicleSummaries, listUsers } from '~/server/users.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { UserDetail, UserListItem, UserVehicleSummary } from '~/lib/users'

/**
 * El borde RPC de Usuarios. Las dos funciones son de LECTURA y las dos pasan por
 * `adminMiddleware` igual.
 *
 * No es simetría por prolijidad, y acá pesa más que en cualquier otra pantalla
 * del panel: esto devuelve el email, el teléfono, las patentes, el número de
 * licencia de conducir y el domicilio de una persona real. Un server function es
 * un endpoint HTTP público — cualquiera con una sesión válida de la app mobile
 * puede llamarlo directo con `fetch`, y el guard de `_authed` no lo cubre porque
 * ese guard sólo modela lo que la UI ofrece.
 *
 * O sea: sin esta línea, cualquier usuario logueado de AutoLibre se baja el
 * padrón entero. Que sea "solo lectura" lo hace MÁS grave, no menos.
 */

export const listAppUsers = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(userSearchSchema)
  .handler(async ({ data }): Promise<Array<UserListItem>> =>
    listUsers(data, { signal: requestSignal() }),
  )

/**
 * El uuid entra por `z.uuid()` y no como string suelto.
 *
 * Va como parámetro `$1` de `pg` río abajo, así que la inyección no es el
 * riesgo. Lo que evita es el otro modo de falla: un id basura llega a Postgres,
 * revienta con `invalid input syntax for type uuid` y la ruta muestra el
 * `errorComponent` en vez del 404 que corresponde.
 */
export const getAppUser = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ userId: z.uuid() }))
  .handler(async ({ data }): Promise<UserDetail> => {
    const found = await findUserDetail(data.userId, { signal: requestSignal() })
    if (!found) throw new Error(`NOT_FOUND:${data.userId}`)
    return found
  })

/**
 * El detalle por vehículo del toggle en `/usuarios`. Deliberadamente NO va en
 * el `loader` de la lista — se pide sólo cuando un operador abre esa fila
 * puntual, nunca para las 500 de golpe. Mismo guard que el resto del
 * archivo y por el mismo motivo: sigue siendo el padrón completo, sólo que
 * agrupado distinto.
 */
export const getUserVehicleSummaries = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ userId: z.uuid() }))
  .handler(async ({ data }): Promise<Array<UserVehicleSummary>> =>
    listUserVehicleSummaries(data.userId, { signal: requestSignal() }),
  )
