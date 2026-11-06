import '@tanstack/react-start/server-only'

import { sql } from './db'
import { SHORT_DESCRIPTION } from '~/lib/partner-profile-tips'
import type { PartnerProfileFacts } from '~/lib/partner-profile-tips'

/**
 * Qué tiene cargado el perfil de cada partner, como banderas (para «Cómo
 * mejorar tu perfil» del Reporte). Sólo lectura, sólo booleanos y conteos.
 *
 * - `coalesce(x,'') = ''` y no `IS NULL`: el import del `legacy_sheet` dejó
 *   strings vacíos (convención del repo).
 * - Logo: `partners.logo_url` o, si no, el de la solicitud
 *   (`raw_submission->>'logoUrl'`), que es en lo que cae el perfil público.
 * - Servicios: activos, mismo corte que la app.
 * - Links: subconsulta escalar, no JOIN (no multiplica la fila).
 */
export async function listPartnerProfileFacts(): Promise<Array<PartnerProfileFacts>> {
  const rows = await sql<{
    id: string
    has_logo: boolean
    has_description: boolean
    short_description: boolean
    has_hours: boolean
    has_address: boolean
    has_location: boolean
    has_whatsapp: boolean
    service_count: number
    link_count: number
  }>(
    `select p.id,
            (coalesce(btrim(p.logo_url), '') <> ''
              or coalesce(btrim(a.raw_submission->>'logoUrl'), '') <> '')        as has_logo,
            coalesce(btrim(p.description), '') <> ''                             as has_description,
            coalesce(btrim(p.description), '') <> ''
              and length(btrim(p.description)) < $1                              as short_description,
            coalesce(btrim(p.hours), '') <> ''                                   as has_hours,
            coalesce(btrim(p.address), '') <> ''                                 as has_address,
            (p.latitude is not null and p.longitude is not null)                 as has_location,
            coalesce(btrim(p.whatsapp), '') <> ''                                as has_whatsapp,
            (select count(*)::int from partner_services ps
               join services s on s.id = ps.service_id and s.active
              where ps.partner_id = p.id)                                        as service_count,
            (select count(*)::int from partner_links l where l.partner_id = p.id) as link_count
       from partners p
       left join partner_applications a on a.id = p.application_id`,
    [SHORT_DESCRIPTION],
  )
  return rows.map((r) => ({
    partnerId: r.id,
    hasLogo: r.has_logo,
    hasDescription: r.has_description,
    shortDescription: r.short_description,
    hasHours: r.has_hours,
    hasAddress: r.has_address,
    hasLocation: r.has_location,
    hasWhatsapp: r.has_whatsapp,
    serviceCount: Number(r.service_count),
    linkCount: Number(r.link_count),
  }))
}
