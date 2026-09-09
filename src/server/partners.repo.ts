import '@tanstack/react-start/server-only'

import { sql, sqlOne, withTransaction } from './db'
import { APPLICATION_PATCH_KEYS, type EditApplicationInput } from '~/lib/partners'
import { normalizeForMatch } from '~/lib/catalog'
import type {
  PartnerLink,
  PartnerListItem,
  PartnerListSortKey,
  PartnerSearch,
  PartnerServicesView,
  ServiceFamily,
  ServiceItem,
} from '~/lib/catalog'
import type {
  CoverageCategory,
  PartnerCoverageBoard,
} from '~/lib/partners-coverage'
import type {
  ApplicationDetail,
  ApplicationListItem,
  ApplicationSearch,
  ApplicationStatus,
  ManualStatus,
  PipelineHealth,
  ResolvedServices,
} from '~/lib/partners'

/**
 * Marketplace — el reemplazo del runbook de DBeaver
 * (`autolibre-backend-hex/scripts/sql/aprobar-partner-application.sql`).
 *
 * Ese archivo es la spec. Cada función de acá dice qué consulta reemplaza, para
 * que se puedan comparar fila por fila la primera vez.
 */

// ── Resolución de lo declarado → rubros ──────────────────────────────────────

interface ExpandedRow {
  declared_slug: string
  service_slug: string
  family_slug: string
  family_name: string
  family_position: number
}

/**
 * Expande cada slug declarado a los RUBROS que la aprobación va a cargar.
 *
 * ── Por qué acepta rubro Y familia ──────────────────────────────────────────
 *
 * Porque `declared_services` es un histórico heterogéneo, y no por indecisión:
 * el formulario de la landing declaró familias durante un tramo y hoy declara
 * rubros. Las dos formas están escritas en filas reales que esta pantalla tiene
 * que saber leer.
 *
 * Ojo con la tentación de "unificar el criterio" acá: el backend rechaza con
 * 400 un slug de familia, y hace bien — eso valida ENTRADA NUEVA, donde hay una
 * sola forma correcta. Esto LEE lo ya escrito, donde hay tres. Son problemas
 * distintos y la respuesta correcta es distinta en cada uno. Angostar esto a
 * rubros no "limpiaría" nada: dejaría las solicitudes viejas sin aprobar
 * marcadas como irreconocibles.
 *
 * ── Sigue siendo un JOIN y no un mapa a mano ────────────────────────────────
 *
 * El catálogo ya sabe qué rubro cuelga de qué familia vía `services.category_id`.
 * El archivo original tuvo una tabla de mapeo escrita a mano y se sacó para que
 * un rubro nuevo entre solo. Reintroducirla sería volver a meter esa clase de
 * bug.
 *
 * Un rubro resuelve a sí mismo (una fila); una familia se expande a todos sus
 * rubros activos (N filas). Las dos condiciones exigen familia activa: un rubro
 * activo colgando de una familia retirada no se carga, igual que en el catálogo
 * que ve el formulario.
 */
async function expandDeclaredSlugs(
  slugs: ReadonlyArray<string>,
): Promise<Array<ExpandedRow>> {
  if (slugs.length === 0) return []

  return sql<ExpandedRow>(
    `SELECT d.slug       AS declared_slug,
            s.slug       AS service_slug,
            sc.slug      AS family_slug,
            sc.name      AS family_name,
            sc."position" AS family_position
       FROM unnest($1::text[]) AS d(slug)
       JOIN service_categories sc ON sc.active
       JOIN services s ON s.category_id = sc.id AND s.active
      WHERE s.slug = d.slug OR sc.slug = d.slug`,
    [[...new Set(slugs)]],
  )
}

/**
 * Arma el resumen para UN conjunto de slugs declarados, a partir de filas ya
 * expandidas.
 *
 * Recibe las filas en vez de consultarlas para que la cola pueda resolver N
 * solicitudes con una sola query. Separar el I/O del cálculo es lo que evita el
 * N+1 sin duplicar la lógica en dos lados.
 */
function summarize(
  slugs: ReadonlyArray<string>,
  rows: ReadonlyArray<ExpandedRow>,
): ResolvedServices {
  const declared = new Set(slugs)
  const relevant = rows.filter((r) => declared.has(r.declared_slug))

  /**
   * Se cuentan rubros ÚNICOS, y esto no es una precaución teórica: alguien que
   * declaró la familia `motor` Y el rubro `gnc` —que cuelga de motor— tiene dos
   * slugs que resuelven al mismo rubro. Contando filas, la pantalla prometería
   * cargar un rubro que el `ON CONFLICT DO NOTHING` de la aprobación no va a
   * insertar dos veces, y el número mostrado no coincidiría con la realidad.
   */
  const seen = new Set<string>()
  const byFamily = new Map<
    string,
    { slug: string; name: string; serviceCount: number; position: number }
  >()

  for (const row of relevant) {
    if (seen.has(row.service_slug)) continue
    seen.add(row.service_slug)

    const family = byFamily.get(row.family_slug) ?? {
      slug: row.family_slug,
      name: row.family_name,
      serviceCount: 0,
      position: row.family_position,
    }
    family.serviceCount += 1
    byFamily.set(row.family_slug, family)
  }

  const resolvedSlugs = new Set(relevant.map((r) => r.declared_slug))

  return {
    /**
     * Por `position` y no alfabetico, igual que `loadCatalog()`. Es el orden que
     * definio el equipo y el mismo en el que el taller vio las familias en el
     * formulario: ordenar distinto acá haria que el operador y el taller esten
     * mirando dos listas que no se corresponden.
     */
    matchedFamilies: [...byFamily.values()]
      .sort((a, b) => a.position - b.position)
      .map(({ slug, name, serviceCount }) => ({ slug, name, serviceCount })),
    unknownSlugs: slugs.filter((s) => !resolvedSlugs.has(s)),
    totalServices: seen.size,
  }
}

/**
 * Resolución para una sola solicitud.
 *
 * El caso de cero slugs se responde sin ir a la base, y ademas es el que la
 * consulta 4 del runbook NO detecta: `unnest('{}')` produce cero filas, así que
 * una solicitud que no declaró nada nunca aparece ahí. Igual produce un partner
 * invisible. Acá sí se ve.
 */
async function resolveDeclared(
  slugs: ReadonlyArray<string>,
): Promise<ResolvedServices> {
  return summarize(slugs, await expandDeclaredSlugs(slugs))
}

// ── Consulta 1: la cola ──────────────────────────────────────────────────────

interface QueueRow {
  id: string
  business_name: string
  email: string
  whatsapp: string
  address: string
  status: ApplicationStatus
  next_step: string | null
  follow_up_date: string | null
  declared_services: Array<string>
  how_found: string | null
  created_at: string
  already_published: boolean
}

/**
 * `status IS NULL` ("Todos") excluye `discarded` por default — ver el
 * comentario en `applicationSearchSchema.status`. El primer término de la
 * disyunción es el que decide eso; el segundo (`status = $1`) es el filtro
 * exacto de siempre y no cambió: elegir el chip `Descartado` sigue mostrando
 * sólo descartadas, sin necesidad de un control nuevo.
 */
export async function listApplications(
  search: ApplicationSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<ApplicationListItem>> {
  void opts.signal // `pg` no acepta signal; queda documentado el hueco.

  const rows = await sql<QueueRow>(
    `SELECT id, business_name, email, whatsapp, address, status, next_step,
            follow_up_date, declared_services, how_found, created_at,
            already_published
       FROM v_partner_application_queue
      WHERE (
              ($1::partner_application_status IS NULL AND status <> 'discarded')
              OR status = $1
            )
        AND ($2::boolean OR NOT already_published)
        AND ($3::text IS NULL OR business_name ILIKE '%' || $3 || '%'
                              OR email         ILIKE '%' || $3 || '%')`,
    [search.status ?? null, search.published === 'show', search.q ?? null],
  )

  /**
   * Una sola consulta para TODOS los slugs en juego, y despues el resumen por
   * fila en memoria.
   *
   * Antes esto era un `Map` de slug-declarado -> familia, que funcionaba solo
   * porque lo declarado ERA una familia. Hoy un slug declarado puede expandirse
   * a varios rubros, asi que la relacion dejo de ser 1:1 y el mapa no alcanza:
   * lo que se comparte entre filas son las filas expandidas, no el resultado.
   */
  const expanded = await expandDeclaredSlugs(
    rows.flatMap((r) => r.declared_services),
  )

  return rows.map((r) => {
    return {
      id: r.id,
      businessName: r.business_name,
      email: r.email,
      whatsapp: r.whatsapp,
      address: r.address,
      status: r.status,
      nextStep: r.next_step,
      followUpDate: r.follow_up_date,
      declaredServices: r.declared_services,
      howFound: r.how_found,
      createdAt: r.created_at,
      alreadyPublished: r.already_published,
      resolved: summarize(r.declared_services, expanded),
    }
  })
}

// ── Detalle ──────────────────────────────────────────────────────────────────

interface DetailRow extends QueueRow {
  brand_specialized: boolean
  declared_brands: Array<string>
  declared_fuel_types: Array<string>
  vehicle_types: Array<string>
  service_other: string | null
  how_found_other: string | null
  contact_channel: string | null
  first_contacted_at: string | null
  agreement_type: string | null
  agreement_detail: string | null
  internal_notes: string | null
  review_note: string | null
  reviewed_at: string | null
  partner_id: string | null
  partner_name: string | null
  partner_coverage_zone: string | null
  partner_service_count: number | null
}

export async function findApplication(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ApplicationDetail | null> {
  void opts.signal

  const row = await sqlOne<DetailRow>(
    `SELECT a.id, a.business_name, a.email, a.whatsapp, a.address, a.status,
            a.next_step, a.follow_up_date, a.declared_services, a.how_found,
            a.created_at,
            a.brand_specialized, a.declared_brands, a.declared_fuel_types,
            a.vehicle_types, a.service_other, a.how_found_other, a.contact_channel,
            a.first_contacted_at, a.agreement_type, a.agreement_detail,
            a.internal_notes, a.review_note, a.reviewed_at,
            (p.id IS NOT NULL)                       AS already_published,
            p.id                                     AS partner_id,
            p.name                                   AS partner_name,
            p.coverage_zone                          AS partner_coverage_zone,
            (SELECT count(*)::int FROM partner_services ps
              WHERE ps.partner_id = p.id)            AS partner_service_count
       FROM partner_applications a
       LEFT JOIN partners p ON p.application_id = a.id
      WHERE a.id = $1`,
    [id],
  )

  if (!row) return null

  const resolved = await resolveDeclared(row.declared_services)

  return {
    id: row.id,
    businessName: row.business_name,
    email: row.email,
    whatsapp: row.whatsapp,
    address: row.address,
    status: row.status,
    nextStep: row.next_step,
    followUpDate: row.follow_up_date,
    declaredServices: row.declared_services,
    howFound: row.how_found,
    createdAt: row.created_at,
    alreadyPublished: row.already_published,
    resolved,
    brandSpecialized: row.brand_specialized,
    declaredBrands: row.declared_brands,
    declaredFuelTypes: row.declared_fuel_types,
    vehicleTypes: row.vehicle_types,
    serviceOther: row.service_other,
    howFoundOther: row.how_found_other,
    contactChannel: row.contact_channel,
    firstContactedAt: row.first_contacted_at,
    agreementType: row.agreement_type,
    agreementDetail: row.agreement_detail,
    internalNotes: row.internal_notes,
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at,
    partner: row.partner_id
      ? {
          id: row.partner_id,
          name: row.partner_name ?? '',
          coverageZone: row.partner_coverage_zone ?? '',
          serviceCount: row.partner_service_count ?? 0,
        }
      : null,
  }
}

// ── Consultas 4, 5 y 6: salud del pipeline ───────────────────────────────────

/**
 * Los tres chequeos que el runbook deja como "acordate de correr esto".
 *
 * Acá son un indicador permanente, que es la diferencia entre un panel y una
 * carpeta de SQL.
 */
export async function pipelineHealth(
  opts: { signal?: AbortSignal } = {},
): Promise<PipelineHealth> {
  void opts.signal

  const row = await sqlOne<{
    stuck: number
    invisible: number
  }>(
    `SELECT
       (SELECT count(*)::int
          FROM partner_applications a
         WHERE a.status = 'verbal_agreement'
           AND NOT EXISTS (SELECT 1 FROM partners p WHERE p.application_id = a.id)
       ) AS stuck,
       (SELECT count(*)::int
          FROM partners p
         WHERE NOT EXISTS (SELECT 1 FROM partner_services ps WHERE ps.partner_id = p.id)
       ) AS invisible`,
  )

  /**
   * Solicitudes pendientes que HOY producirían un partner invisible.
   *
   * Cubre dos casos, y el segundo es el que la consulta 4 del runbook no ve:
   *  - declaró slugs que no son familia activa (labels viejos, familias de baja)
   *  - no declaró nada: `unnest('{}')` da cero filas, así que nunca aparece en
   *    la consulta 4, pero igual termina invisible.
   */
  const wouldBeInvisible = await sqlOne<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM partner_applications a
      WHERE NOT EXISTS (SELECT 1 FROM partners p WHERE p.application_id = a.id)
        AND a.status <> 'discarded'
        AND NOT EXISTS (
          SELECT 1
            FROM unnest(a.declared_services) AS decl(slug)
            JOIN service_categories sc ON sc.slug = decl.slug AND sc.active
        )`,
  )

  return {
    stuckApplications: row?.stuck ?? 0,
    invisiblePartners: row?.invisible ?? 0,
    wouldBeInvisible: wouldBeInvisible?.n ?? 0,
  }
}

// ── Consultas 2 + 3: aprobar ─────────────────────────────────────────────────

export interface ApprovalResult {
  partnerId: string
  servicesLoaded: number
}

/**
 * Aprueba una solicitud: crea el partner y le carga los rubros.
 *
 * LOS DOS PASOS VAN EN UNA TRANSACCIÓN, y esa es la mejora real sobre el
 * runbook. En DBeaver son dos consultas separadas y el segundo paso es "el que
 * se olvida": si no corre, el partner queda activo con cero rubros — listado
 * sin filtro e invisible bajo todo chip. Acá o pasan los dos o no pasa ninguno.
 *
 * `approve_partner_application()` NO se toca ni se reimplementa. La condición
 * que le puso el backend sigue vigente: mueve estado y copia datos, no decide
 * nada. Lo que decide es esto de acá.
 */
export async function approveApplication(
  applicationId: string,
  reviewerId: string,
  coverageZone: string,
): Promise<ApprovalResult> {
  return withTransaction(async (client) => {
    const approved = await client.query<{ partner_id: string }>(
      `SELECT approve_partner_application($1::uuid, $2::uuid, $3::text) AS partner_id`,
      [applicationId, reviewerId, coverageZone],
    )

    const partnerId = approved.rows[0]?.partner_id
    if (!partnerId) {
      // La función tira excepción si la solicitud no existe o ya se aprobó, así
      // que llegar acá sin id significa que cambió su contrato.
      throw new Error('APPROVE_NO_PARTNER_ID')
    }

    /**
     * Carga de rubros, acotada a ESTE partner.
     *
     * El runbook usa `WHERE NOT EXISTS (... partner_services ...)` sin id porque
     * en DBeaver se corre suelta y tiene que autolimitarse a los que no tienen
     * nada. Acá tenemos el id, así que se filtra por él: más preciso, y no
     * depende de que ningún otro partner esté a medio cargar.
     *
     * ── El OR del WHERE es lo que evita aprobar partners invisibles ─────────
     *
     * Este JOIN unía `decl.slug` contra `service_categories` y nada más. Cuando
     * el formulario pasó a declarar RUBROS, eso dejó de matchear: cero filas,
     * cero rubros cargados, y un partner activo que no sale bajo ningún chip de
     * la app. El mismo modo de falla silencioso que esta pantalla existe para
     * evitar, reintroducido por la puerta de atrás.
     *
     * Ahora un slug declarado entra si es el rubro (`s.slug`) o si es su familia
     * (`sc.slug`). Debe seguir espejando `expandDeclaredSlugs()` de este mismo
     * archivo: lo que la pantalla PROMETE cargar y lo que este INSERT carga de
     * verdad son la misma pregunta, y el día que se separen la pantalla miente
     * sin que nada falle.
     */
    const loaded = await client.query(
      `INSERT INTO partner_services (partner_id, service_id)
       SELECT p.id, s.id
         FROM partners p
         JOIN partner_applications a ON a.id = p.application_id
         CROSS JOIN LATERAL unnest(a.declared_services) AS decl(slug)
         JOIN service_categories sc ON sc.active
         JOIN services s ON s.category_id = sc.id AND s.active
        WHERE p.id = $1
          AND (s.slug = decl.slug OR sc.slug = decl.slug)
       ON CONFLICT DO NOTHING`,
      [partnerId],
    )

    return { partnerId, servicesLoaded: loaded.rowCount ?? 0 }
  })
}

/**
 * Mueve la solicitud por el embudo.
 *
 * `ManualStatus` excluye `verbal_agreement` a nivel de tipo, y la guarda de
 * abajo lo vuelve a chequear en runtime: el tipo protege a quien escribe código,
 * no a un payload que llega por HTTP.
 */
export async function updateApplicationStatus(
  applicationId: string,
  status: ManualStatus,
): Promise<void> {
  if ((status as ApplicationStatus) === 'verbal_agreement') {
    throw new Error('MANUAL_VERBAL_AGREEMENT_FORBIDDEN')
  }

  await sql(
    `UPDATE partner_applications
        SET status = $2::partner_application_status,
            updated_at = now()
      WHERE id = $1`,
    [applicationId, status],
  )
}

/**
 * Editar los campos del formulario de una solicitud — migración 010.
 *
 * ── POR QUÉ VÍA STORED PROCEDURE Y NO UN UPDATE ACÁ ─────────────────────────
 *
 * `updateApplicationStatus` de arriba es un UPDATE directo, y esta función NO lo
 * es, a propósito. El status es un movimiento de una sola columna por un embudo;
 * esto reescribe todo el formulario del taller —contacto, lo que declaró, notas
 * internas— y eso necesita auditoría. `ops.update_partner_application` graba
 * `before`/`after` completos en `ops.action_log` DENTRO de su transacción. Un
 * UPDATE acá más un INSERT de log serían separables, y el modo de falla es el
 * peor: el cambio queda y el registro de quién lo hizo no.
 *
 * El `actorId` llega de la sesión (ver `src/fn/partners.ts`), nunca del payload.
 *
 * `p_patch` es un jsonb con TODAS las claves editables en snake_case
 * (`APPLICATION_PATCH_KEYS` hace la traducción camelCase → snake_case, explícita
 * — una clave mal mapeada es un campo que no se guarda en silencio). Se manda
 * con `JSON.stringify` explícito, mismo cuidado que `setPartnerLinks`: `pg`
 * serializaría un objeto de JS a algo que `jsonb` no reconoce.
 *
 * Devuelve el `ApplicationDetail` fresco —re-consultado con `findApplication`—
 * porque la UI necesita `resolved` recalculado sobre los `declared_services`
 * nuevos, y eso el SP no lo da.
 */
export async function updatePartnerApplication(
  input: EditApplicationInput,
  actorId: string,
): Promise<ApplicationDetail> {
  const { applicationId, ...fields } = input

  const patch: Record<string, unknown> = {}
  for (const [camel, snake] of Object.entries(APPLICATION_PATCH_KEYS)) {
    patch[snake] = (fields as Record<string, unknown>)[camel]
  }

  const row = await sqlOne<{ id: string }>(
    `SELECT (ops.update_partner_application($1::uuid, $2::uuid, $3::jsonb, $4))->>'id' AS id`,
    [applicationId, actorId, JSON.stringify(patch), null],
  )
  if (!row) throw new Error(`APPLICATION_NOT_FOUND:${applicationId}`)

  const fresh = await findApplication(applicationId)
  if (!fresh) throw new Error(`APPLICATION_NOT_FOUND:${applicationId}`)
  return fresh
}

/**
 * Consulta 5: destraba solicitudes marcadas a mano.
 *
 * El `NOT EXISTS` no es decorativo — sin él le devolvés el estado a partners YA
 * publicados, y al re-aprobarlos los duplicás.
 */
export async function unstickApplication(applicationId: string): Promise<boolean> {
  const rows = await sql<{ id: string }>(
    `UPDATE partner_applications
        SET status = 'in_conversation', updated_at = now()
      WHERE id = $1
        AND status = 'verbal_agreement'
        AND NOT EXISTS (
          SELECT 1 FROM partners p WHERE p.application_id = partner_applications.id
        )
      RETURNING id`,
    [applicationId],
  )
  return rows.length > 0
}

// ── Consulta 7: qué rubros tiene cada partner ────────────────────────────────

interface PartnerRow {
  id: string
  name: string
  status: string
  coverage_zone: string
  service_count: number
  category_count: number
  categories: Array<{ slug: string; name: string; position: number }>
  invisible: boolean
}

/**
 * Mapa cerrado `PartnerListSortKey → columna del SELECT interno`. Seguro de
 * interpolar en el `ORDER BY` porque los tipos obligan a cubrir cada clave —
 * mismo patrón que `SORT_COLUMNS` de `users.repo.ts` / `notifications.repo.ts`.
 * El desempate por `name` va SIEMPRE al final: es lo que preserva el orden
 * histórico "invisibles primero, después alfabético" cuando `sort = services`.
 */
const PARTNER_SORT_COLUMNS: Record<PartnerListSortKey, string> = {
  services: 'service_count',
  categories: 'category_count',
  name: 'name',
  zone: 'coverage_zone',
  status: 'status',
}

/**
 * Consulta 7 del runbook, ampliada: qué rubros (categorías) y cuántos servicios
 * tiene cada partner, filtrable y ordenable por esas columnas.
 *
 * Va envuelta en `select * from (...) t` —igual que `listUsers` y `listChats`—
 * porque `category_count`, `categories` y el flag `invisible` son agregados o
 * subconsultas que el `where`/`order by` del nivel de afuera necesita ver como
 * alias. `q` es la excepción: busca sobre `p.name`, columna cruda, así que acota
 * el barrido en el `where` interno.
 *
 * `invisible` se define como `NOT EXISTS (partner_services)` — SIN filtro de
 * `services.active` — para que coincida exacto con `pipelineHealth.invisible` y
 * con la card de Inicio. Los chips de rubro sí filtran por `s.active`, que es lo
 * que la app usa.
 */
export async function listPartners(
  search: PartnerSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<PartnerListItem>> {
  void opts.signal

  const orderBy = PARTNER_SORT_COLUMNS[search.sort]

  const rows = await sql<PartnerRow>(
    `SELECT * FROM (
       SELECT p.id,
              p.name,
              p.status::text AS status,
              p.coverage_zone,
              count(DISTINCT ps.service_id)::int AS service_count,
              count(DISTINCT sc.id)::int AS category_count,
              coalesce(
                jsonb_agg(DISTINCT jsonb_build_object(
                  'slug', sc.slug, 'name', sc.name, 'position', sc."position"))
                  FILTER (WHERE sc.id IS NOT NULL),
                '[]'::jsonb) AS categories,
              NOT EXISTS (
                SELECT 1 FROM partner_services x WHERE x.partner_id = p.id
              ) AS invisible
         FROM partners p
         LEFT JOIN partner_services ps ON ps.partner_id = p.id
         LEFT JOIN services s ON s.id = ps.service_id AND s.active
         LEFT JOIN service_categories sc ON sc.id = s.category_id AND sc.active
        WHERE ($1::text IS NULL OR p.name ILIKE '%' || $1 || '%')
        GROUP BY p.id, p.name, p.status, p.coverage_zone
     ) t
      WHERE (NOT $2::boolean OR t.invisible)
        AND ($3::text = 'all' OR t.status = $3)
        AND ($4::text IS NULL OR EXISTS (
              SELECT 1
                FROM partner_services ps2
                JOIN services s2 ON s2.id = ps2.service_id AND s2.active
                JOIN service_categories sc2 ON sc2.id = s2.category_id
               WHERE ps2.partner_id = t.id AND sc2.slug = $4))
        AND ($5::text IS NULL OR EXISTS (
              SELECT 1
                FROM partner_services ps3
                JOIN services s3 ON s3.id = ps3.service_id
               WHERE ps3.partner_id = t.id AND s3.slug = $5))
      ORDER BY ${orderBy} ${search.dir} NULLS LAST, t.name ASC`,
    [
      search.q ?? null,
      search.onlyInvisible,
      search.partnerStatus,
      search.category ?? null,
      search.service ?? null,
    ],
  )

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    coverageZone: r.coverage_zone,
    serviceCount: r.service_count,
    categoryCount: r.category_count,
    categories: [...r.categories]
      .sort((a, b) => a.position - b.position)
      .map(({ slug, name }) => ({ slug, name })),
    invisible: r.invisible,
  }))
}

// ── Tablero de cobertura ────────────────────────────────────────────────────

/**
 * El cruce cobertura × zona para `/partners/cobertura`.
 *
 * Son tres consultas y no una porque contestan cosas de grano distinto (la
 * lista de categorías, la matriz, los totales por zona) y unirlas en un
 * `GROUPING SETS` haría el mapper ilegible para 40 partners. El `now()` no
 * entra en juego acá —no hay nada derivado del reloj— así que no hace falta el
 * snapshot único que sí exige `ops.repo.ts`.
 *
 * `coverage_zone` es texto crudo (ver `~/lib/partners-coverage`). La única
 * normalización es `btrim` + fallback a "Sin zona".
 *
 * Como cada partner tiene UNA sola `coverage_zone`, `categoryTotals` se arma
 * sumando las celdas a lo ancho: un partner nunca aparece en dos filas.
 */
export async function partnerCoverageBoard(
  opts: { signal?: AbortSignal } = {},
): Promise<PartnerCoverageBoard> {
  void opts.signal

  const ZONE = `coalesce(nullif(btrim(p.coverage_zone), ''), 'Sin zona')`

  const [categoryRows, matrixRows, zoneRows, totalRow] = await Promise.all([
    sql<{ slug: string; name: string; position: number }>(
      `SELECT sc.slug, sc.name, sc."position"
         FROM service_categories sc
        WHERE sc.active
          AND EXISTS (SELECT 1 FROM services s
                       WHERE s.category_id = sc.id AND s.active)
        ORDER BY sc."position", sc.name`,
    ),
    sql<{ zone: string; category_slug: string; partners: number }>(
      `SELECT ${ZONE} AS zone,
              sc.slug AS category_slug,
              count(DISTINCT p.id)::int AS partners
         FROM partners p
         JOIN partner_services ps ON ps.partner_id = p.id
         JOIN services s ON s.id = ps.service_id AND s.active
         JOIN service_categories sc ON sc.id = s.category_id AND sc.active
        WHERE p.status = 'active'
        GROUP BY 1, 2`,
    ),
    sql<{ zone: string; total: number; invisible: number }>(
      `SELECT ${ZONE} AS zone,
              count(*)::int AS total,
              count(*) FILTER (
                WHERE NOT EXISTS (
                  SELECT 1 FROM partner_services ps WHERE ps.partner_id = p.id
                )
              )::int AS invisible
         FROM partners p
        WHERE p.status = 'active'
        GROUP BY 1`,
    ),
    sqlOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM partners WHERE status = 'active'`,
    ),
  ])

  const categories: Array<CoverageCategory> = categoryRows.map((r) => ({
    slug: r.slug,
    name: r.name,
    position: r.position,
  }))

  const cellByZone = new Map<string, Record<string, number>>()
  for (const m of matrixRows) {
    const byCat = cellByZone.get(m.zone) ?? {}
    byCat[m.category_slug] = m.partners
    cellByZone.set(m.zone, byCat)
  }

  const zones = zoneRows
    .map((z) => ({
      zone: z.zone,
      partnersTotal: z.total,
      invisible: z.invisible,
      byCategory: cellByZone.get(z.zone) ?? {},
    }))
    .sort((a, b) => b.partnersTotal - a.partnersTotal || a.zone.localeCompare(b.zone, 'es'))

  const categoryTotals: Record<string, number> = {}
  for (const cat of categories) {
    categoryTotals[cat.slug] = zones.reduce(
      (acc, z) => acc + (z.byCategory[cat.slug] ?? 0),
      0,
    )
  }

  return {
    categories,
    zones,
    categoryTotals,
    emptyCategories: categories.filter((c) => (categoryTotals[c.slug] ?? 0) === 0),
    totalActivePartners: totalRow?.n ?? 0,
  }
}

// ── El catálogo completo ─────────────────────────────────────────────────────

interface CatalogRow {
  family_slug: string
  family_name: string
  id: string
  slug: string
  name: string
}

/**
 * Las 16 familias con sus 79 rubros, en el orden del catálogo.
 *
 * Se trae entero y no filtrado: el editor tiene que poder agregar CUALQUIER
 * rubro, no solo los de las familias que el taller declaró. Ese es justamente
 * el caso de la consulta 8 — resolver lo que la carga automática no pudo.
 */
export async function loadCatalog(): Promise<Array<ServiceFamily>> {
  const rows = await sql<CatalogRow>(
    `SELECT sc.slug AS family_slug, sc.name AS family_name,
            s.id, s.slug, s.name
       FROM services s
       JOIN service_categories sc ON sc.id = s.category_id
      WHERE s.active AND sc.active
      ORDER BY sc.position, s.position`,
  )

  const families = new Map<string, ServiceFamily>()
  for (const r of rows) {
    const family =
      families.get(r.family_slug) ??
      { slug: r.family_slug, name: r.family_name, services: [] }
    family.services.push({ id: r.id, slug: r.slug, name: r.name })
    families.set(r.family_slug, family)
  }
  return [...families.values()]
}

export async function getPartnerServices(
  partnerId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PartnerServicesView | null> {
  void opts.signal

  const partner = await sqlOne<{
    id: string
    name: string
    status: string
    tier: string
    coverage_zone: string
    description: string | null
    application_id: string | null
    declared_services: Array<string> | null
    whatsapp: string | null
    email: string | null
    redirect_link: string | null
    hours: string | null
    address: string | null
    latitude: number | null
    longitude: number | null
    links: Array<PartnerLink> | null
    name_collisions: number | string
  }>(
    /**
     * Los links vienen por SUBCONSULTA, no por `LEFT JOIN` + `group by`.
     *
     * Con un join, cada fila de `partner_links` multiplicaría la fila del
     * partner y habría que agrupar por sus quince columnas. Es el fan-out, y su
     * modo de falla es el de siempre acá: no rompe, devuelve un número más
     * grande. Mismo criterio que las subconsultas escalares de `listCatalogs`.
     *
     * El `order by` no es cosmético: sin él Postgres puede devolver los links
     * en cualquier orden entre dos requests, y la lista de "otros" del
     * formulario se reordenaría sola mientras alguien la está editando.
     */
    `SELECT p.id, p.name, p.status::text AS status, p.tier::text AS tier,
            p.coverage_zone, p.description, p.application_id, a.declared_services,
            p.whatsapp, p.email, p.redirect_link, p.hours, p.address,
            p.latitude, p.longitude,
            (SELECT coalesce(
                      jsonb_agg(jsonb_build_object('kind', l.kind::text, 'url', l.url)
                                ORDER BY l.kind::text, l.url),
                      '[]'::jsonb)
               FROM partner_links l
              WHERE l.partner_id = p.id) AS links,
            -- Otros partners con el MISMO nombre.
            --
            -- partners.name no tiene índice único, así que un duplicado es
            -- representable y ops.set_partner_profile no lo rechaza. Este
            -- contador es lo que permite avisar en la ficha.
            --
            -- Se normaliza con lower(btrim(...)) de los dos lados: "Taller
            -- Norte" y "taller norte " son el mismo taller para un usuario que
            -- lee la lista, y una comparación exacta no los vería.
            --
            -- (Comentario SQL y no JSDoc: esto vive ADENTRO del template
            -- literal, donde un backtick cierra el string. Ese fue el error.)
            (SELECT count(*)::int
               FROM partners o
              WHERE o.id <> p.id
                AND lower(btrim(o.name)) = lower(btrim(p.name))) AS name_collisions
       FROM partners p
       LEFT JOIN partner_applications a ON a.id = p.application_id
      WHERE p.id = $1`,
    [partnerId],
  )

  if (!partner) return null

  const [families, assigned] = await Promise.all([
    loadCatalog(),
    sql<{ service_id: string }>(
      `SELECT service_id FROM partner_services WHERE partner_id = $1`,
      [partnerId],
    ),
  ])

  const declaredServices = partner.declared_services ?? []

  /**
   * Sugerencias para lo que la carga automática ignoró.
   *
   * Caso real que motivó esto: "Batata Taller" declaró `"Chapa y pintura"` —un
   * label del formulario viejo, con espacios y mayúsculas—, que no resuelve a
   * nada. Pero `chapa-y-pintura` SÍ existe como rubro, bajo "Carrocería y
   * cristales". El runbook te deja buscándolo a mano en la consulta 8; acá se
   * ofrece resuelto.
   *
   * ── El filtro es "no resolvió", no "no es familia" ──────────────────────────
   *
   * Decía `!familySlugs.has(slug)`, que alcanzaba cuando lo declarado eran
   * familias. Con rubros declarados ese filtro deja pasar TODO, y cada rubro
   * perfectamente cargado aparecería igual como una sugerencia pendiente de
   * confirmar — ruido sobre ruido, justo en la pantalla que existe para separar
   * lo que anduvo de lo que no.
   *
   * Ahora se sugiere solo sobre lo que la carga automática realmente ignoró, que
   * es lo mismo que `unknownSlugs`.
   *
   * Se sugiere, no se aplica solo: el operador confirma. Una coincidencia de
   * texto no es una decisión de negocio.
   */
  const allServices: Array<ServiceItem> = families.flatMap((f) => f.services)
  const unresolved = new Set(
    (await resolveDeclared(declaredServices)).unknownSlugs,
  )

  const suggestions = declaredServices
    .filter((slug) => unresolved.has(slug))
    .map((declaredSlug) => {
      const needle = normalizeForMatch(declaredSlug)
      const matches = allServices.filter(
        (s) =>
          normalizeForMatch(s.slug) === needle ||
          normalizeForMatch(s.name) === needle ||
          normalizeForMatch(s.name).includes(needle),
      )
      return { declaredSlug, matches }
    })
    .filter((s) => s.matches.length > 0)

  return {
    partner: {
      id: partner.id,
      name: partner.name,
      status: partner.status,
      tier: partner.tier,
      coverageZone: partner.coverage_zone,
      description: partner.description,
      applicationId: partner.application_id,
      declaredServices,
      whatsapp: partner.whatsapp,
      email: partner.email,
      redirectLink: partner.redirect_link,
      hours: partner.hours,
      address: partner.address,
      // `double precision` sí llega como number desde `pg`; el cast defensivo
      // es por si alguien cambia la columna a `numeric`, que llegaría string.
      latitude: partner.latitude === null ? null : Number(partner.latitude),
      longitude: partner.longitude === null ? null : Number(partner.longitude),
      // `coalesce(..., '[]')` en el SQL garantiza el array; el `?? []` cubre el
      // caso de que alguien saque ese coalesce y no toque este archivo.
      links: partner.links ?? [],
      // `count(*)::int` ya viene como number desde `pg`; el cast es la red doble
      // que este repo usa en todos lados, por si el `::int` se cae del SQL.
      nameCollisions: Number(partner.name_collisions ?? 0),
    },
    families,
    assignedServiceIds: assigned.map((a) => a.service_id),
    suggestions,
  }
}

// ── Consultas 7 y 8: editar los rubros ───────────────────────────────────────

export interface EditServicesResult {
  added: number
  removed: number
  total: number
}

/**
 * Agrega y saca rubros en una sola operación.
 *
 * Reemplaza dos cosas del runbook que allá son consultas sueltas:
 *  - Consulta 8, el INSERT manual, para lo que la carga automática no resolvió
 *    (declaró algo que no es familia activa, o no declaró nada).
 *  - El DELETE de la consulta 7, para corregir la SOBRE-DECLARACIÓN: la carga
 *    automática mete todos los rubros de cada familia declarada, así que un
 *    taller de service básico sale también bajo "rectificación de motores".
 *
 * Van juntos y en una transacción porque una corrección típica es las dos cosas
 * a la vez: sacar tres que no hace y agregar uno que sí. Aplicarlas por separado
 * deja al partner en un estado intermedio que nadie eligió.
 *
 * `ON CONFLICT DO NOTHING` en el insert: la PK es `(partner_id, service_id)`, y
 * reenviar un rubro que ya está no es un error del operador.
 */
export async function editPartnerServices(
  partnerId: string,
  add: ReadonlyArray<string>,
  remove: ReadonlyArray<string>,
): Promise<EditServicesResult> {
  return withTransaction(async (client) => {
    let added = 0
    let removed = 0

    if (remove.length > 0) {
      const res = await client.query(
        `DELETE FROM partner_services
          WHERE partner_id = $1 AND service_id = ANY($2::uuid[])`,
        [partnerId, remove],
      )
      removed = res.rowCount ?? 0
    }

    if (add.length > 0) {
      /**
       * El JOIN contra `services` no es decorativo: filtra ids inexistentes o
       * de rubros dados de baja antes de que la FK tire. Un id inválido en el
       * payload es un 0 en el contador, no un 500.
       */
      const res = await client.query(
        `INSERT INTO partner_services (partner_id, service_id)
         SELECT $1, s.id
           FROM services s
          WHERE s.id = ANY($2::uuid[]) AND s.active
         ON CONFLICT DO NOTHING`,
        [partnerId, add],
      )
      added = res.rowCount ?? 0
    }

    const total = await client.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM partner_services WHERE partner_id = $1`,
      [partnerId],
    )

    return { added, removed, total: Number(total.rows[0]?.n ?? 0) }
  })
}

// ── Acciones sobre la ficha — migración 007 ──────────────────────────────────
//
// Las tres invocan un stored procedure de `ops` y no arman el UPDATE acá, y el
// motivo es la auditoría: `ops.set_partner_*` escribe la fila en
// `ops.action_log` DENTRO de la misma transacción implícita de la función. Un
// UPDATE desde este archivo más un INSERT de log serían dos sentencias que
// pueden separarse, y el modo de falla es el peor posible: el cambio queda y el
// registro de quién lo hizo no.
//
// El `actorId` llega SIEMPRE desde la sesión (ver `src/fn/partners.ts`). Este
// módulo no sabe leer sesiones y no debería aprender.
//
// El error de Postgres se propaga tal cual. Los SP tiran sentinelas legibles
// (`PARTNER_NOT_FOUND:`, `INCOMPLETE_COORDINATES`, `LEAD_ALREADY_OPEN`…) que la
// UI traduce, igual que ya hace con `UNAUTHENTICATED` y `FORBIDDEN` en
// `src/components/Fallbacks.tsx`.

/** El estado nuevo del partner, tal como lo devolvió el SP. */
export interface PartnerWriteResult {
  id: string
  name: string
  status: string
  whatsapp: string | null
  email: string | null
  redirectLink: string | null
  hours: string | null
  address: string | null
  latitude: number | null
  longitude: number | null
}

/** El `jsonb` que devuelven los tres SP es la fila entera de `partners`. */
interface PartnerJson {
  id: string
  name: string
  status: string
  whatsapp: string | null
  email: string | null
  redirect_link: string | null
  hours: string | null
  address: string | null
  latitude: number | null
  longitude: number | null
}

function toWriteResult(row: PartnerJson): PartnerWriteResult {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    whatsapp: row.whatsapp,
    email: row.email,
    redirectLink: row.redirect_link,
    hours: row.hours,
    address: row.address,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
  }
}

export async function setPartnerStatus(
  input: { partnerId: string; status: string; note?: string },
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PartnerWriteResult> {
  void opts.signal

  const row = await sqlOne<{ p: PartnerJson }>(
    'SELECT ops.set_partner_status($1, $2, $3, $4) AS p',
    [input.partnerId, input.status, actorId, input.note ?? null],
  )
  if (!row) throw new Error(`PARTNER_NOT_FOUND:${input.partnerId}`)
  return toWriteResult(row.p)
}

export async function setPartnerLocation(
  input: { partnerId: string; latitude: number | null; longitude: number | null },
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PartnerWriteResult> {
  void opts.signal

  const row = await sqlOne<{ p: PartnerJson }>(
    'SELECT ops.set_partner_location($1, $2, $3, $4) AS p',
    [input.partnerId, input.latitude, input.longitude, actorId],
  )
  if (!row) throw new Error(`PARTNER_NOT_FOUND:${input.partnerId}`)
  return toWriteResult(row.p)
}

/**
 * Los cinco campos van SIEMPRE, como string.
 *
 * El SP interpreta `NULL` como "no toques este campo" y `''` como "borralo".
 * Mandar los cinco desde un formulario que los muestra los cinco significa que
 * lo que se ve en pantalla es exactamente lo que queda guardado — el modo de
 * parche parcial existe para otros llamadores, no para esta pantalla.
 */
export async function setPartnerContact(
  input: {
    partnerId: string
    whatsapp: string
    email: string
    redirectLink: string
    hours: string
    address: string
  },
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PartnerWriteResult> {
  void opts.signal

  const row = await sqlOne<{ p: PartnerJson }>(
    `SELECT ops.set_partner_contact(
       p_partner_id    => $1,
       p_actor_id      => $2,
       p_whatsapp      => $3,
       p_email         => $4,
       p_redirect_link => $5,
       p_hours         => $6,
       p_address       => $7
     ) AS p`,
    [
      input.partnerId,
      actorId,
      input.whatsapp,
      input.email,
      input.redirectLink,
      input.hours,
      input.address,
    ],
  )
  if (!row) throw new Error(`PARTNER_NOT_FOUND:${input.partnerId}`)
  return toWriteResult(row.p)
}

// ── Migración 008: perfil y links ────────────────────────────────────────────

/**
 * Zona de cobertura, descripción y tier.
 *
 * Los tres van SIEMPRE, igual que los cinco de `setPartnerContact` y por el
 * mismo motivo: lo que el operador ve en pantalla es exactamente lo que queda
 * guardado. El SP sabe interpretar `NULL` como "no toques", pero esta pantalla
 * no usa ese modo — un formulario que manda parches parciales es imposible de
 * leer cuando algo sale mal.
 */
export async function setPartnerProfile(
  input: {
    partnerId: string
    name: string
    coverageZone: string
    description: string
    tier: string
  },
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PartnerWriteResult> {
  void opts.signal

  const row = await sqlOne<{ p: PartnerJson }>(
    /**
     * La llamada va por parámetros NOMBRADOS, y con la 009 eso pasó de ser
     * cómodo a ser el motivo por el que esa migración hace `DROP` + `CREATE` en
     * vez de un `CREATE OR REPLACE`: agregarle un parámetro a una función crea
     * una SOBRECARGA, y con las dos firmas vivas una llamada nombrada puede
     * matchear las dos. Postgres responde `function ... is not unique`, en
     * runtime y en el primer guardado de un operador.
     */
    `SELECT ops.set_partner_profile(
       p_partner_id    => $1,
       p_actor_id      => $2,
       p_name          => $3,
       p_coverage_zone => $4,
       p_description   => $5,
       p_tier          => $6
     ) AS p`,
    [
      input.partnerId,
      actorId,
      input.name,
      input.coverageZone,
      input.description,
      input.tier,
    ],
  )
  if (!row) throw new Error(`PARTNER_NOT_FOUND:${input.partnerId}`)
  return toWriteResult(row.p)
}

/**
 * El juego completo de links.
 *
 * Se manda como UN parámetro jsonb y no como N filas, porque el reemplazo tiene
 * que ser atómico: el SP borra lo que sobra y escribe lo que falta adentro de la
 * misma transacción. Partirlo en varias sentencias desde acá dejaría al partner
 * sin links si la segunda falla.
 *
 * `JSON.stringify` explícito: `pg` serializa un array de JS a un array de
 * Postgres (`{...}`), no a jsonb. Sin esto el SP recibe algo que
 * `jsonb_typeof` no reconoce como `'array'` y rebota con `LINKS_NOT_AN_ARRAY` —
 * un error correcto, disparado por la razón equivocada.
 */
export async function setPartnerLinks(
  input: { partnerId: string; links: Array<{ kind: string; url: string }> },
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<{ kind: string; url: string }>> {
  void opts.signal

  const row = await sqlOne<{ links: Array<{ kind: string; url: string }> | null }>(
    `SELECT ops.set_partner_links(
       p_partner_id => $1,
       p_actor_id   => $2,
       p_links      => $3::jsonb
     ) AS links`,
    [input.partnerId, actorId, JSON.stringify(input.links)],
  )
  if (!row) throw new Error(`PARTNER_NOT_FOUND:${input.partnerId}`)
  return row.links ?? []
}
