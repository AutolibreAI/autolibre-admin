import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { POSTHOG_DASHBOARD_KEYS, type PosthogEmbedConfig } from '~/lib/posthog-dashboards'
import { readPosthogEmbed } from '~/server/posthog-embeds'
import { adminMiddleware } from './middleware'

/**
 * La URL para embeber UN tablero de PostHog, o por qué no hay.
 *
 * `adminMiddleware` no es opcional: la URL es un link público al tablero, y un
 * server function es un endpoint HTTP que cualquiera con una sesión de la app
 * puede llamar. Sin el guard, cualquier usuario logueado se la baja.
 */
export const getPosthogEmbedFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ key: z.enum(POSTHOG_DASHBOARD_KEYS) }))
  .handler(async ({ data }): Promise<PosthogEmbedConfig> => readPosthogEmbed(data.key))
