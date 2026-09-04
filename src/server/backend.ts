// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY MODULE
//
// Mismo marcador y misma protección que `db.ts`: `importProtection` en
// vite.config.ts bloquea todo `src/server/**` para el grafo del cliente, así
// que un import perdido rompe el build en vez de mandarle el token de sesión al
// browser.
// ─────────────────────────────────────────────────────────────────────────────
import '@tanstack/react-start/server-only'

import { auth } from '@clerk/tanstack-react-start/server'

/**
 * El primer —y por ahora único— cliente HTTP del panel contra
 * `autolibre-backend-hex`.
 *
 * ── Por qué existe, si el panel habla Postgres directo ───────────────────────
 *
 * Porque acá no hay alternativa, y por DOS motivos independientes:
 *
 *  1. **El PDF va a DigitalOcean Spaces.** No a Postgres. El panel no tiene ese
 *     adapter, ni las credenciales, ni el sniffing de magic bytes con el que
 *     `UploadFileHandler` rechaza un .zip renombrado a .pdf. Ninguna cantidad
 *     de SQL sube un archivo a un bucket.
 *
 *  2. **El backend SÍ tiene el camino.** Verificado el 2026-09-04 en
 *     `autolibre-backend-hex`: existe el bounded context
 *     `vehicle-management/vehicle-catalog-manual` completo —entity, VO, port,
 *     tres casos de uso, dos repos, controller— con `POST
 *     /vehicle-catalog-manuals` bajo `AdminGuard`.
 *
 * Ese segundo punto es el que decide. La excepción de
 * `.claude/rules/ops-write-actions.md` —escribir `public` desde stored
 * procedures de `ops`— vale SÓLO donde el backend no tiene camino, y esa
 * excepción "se gana con un `grep`, no se asume". Acá el grep da POSITIVO. Se
 * llama al endpoint.
 *
 * ── Cómo autentica ──────────────────────────────────────────────────────────
 *
 * El `AuthGuard` del backend es global (`APP_GUARD`) y lee
 * `Authorization: Bearer <token>`, que verifica con Clerk
 * (`ClerkAuthProvider.verifyToken`). El panel usa la MISMA instancia de Clerk
 * que la app, así que el session token del admin logueado sirve tal cual, sin
 * JWT template: el único claim obligatorio es `sub`.
 *
 * Consecuencia que NO es un detalle: la request viaja con la identidad del
 * admin real, no con una cuenta de servicio. `files.user_id` queda a su nombre
 * y eso es lo que hace auditable quién subió cada manual — el mismo criterio
 * que `p_actor_id` en los SP de `ops`.
 */

const DEFAULT_BASE_URL = 'http://localhost:3005/api/v1'

/**
 * Un solo timeout, y corto, porque por acá ya no viaja ningún archivo.
 *
 * Cuando el panel proxeaba el PDF hacía falta un timeout de dos minutos. Ahora
 * todas las llamadas de este módulo son JSON de pocos cientos de bytes: la
 * transferencia grande la hace el navegador contra Spaces, con su propio
 * tiempo y sin pasar por acá.
 */
const JSON_TIMEOUT_MS = 20_000

/**
 * Falla en el PRIMER USO, nunca al cargar el módulo.
 *
 * Es la misma lección que `db.ts` documenta y que costó un incidente: el entry
 * serverless de Vercel importa todos los handlers de ruta por adelantado, así
 * que un `throw` en scope de módulo se lleva puesto el cold start entero —
 * `/login`, `/api/health` y la página de error incluidas, que son justamente
 * las únicas superficies que podían decirte qué env var falta.
 */
function baseUrl(): string {
  const configured = process.env.AUTOLIBRE_BACKEND_URL?.trim()

  if (!configured) {
    /**
     * En desarrollo el backend corre en `localhost:3005` (ver `main.ts`), así
     * que el default vale y evita una env var más para arrancar. En producción
     * NO hay default posible: adivinar una URL de producción es peor que
     * fallar, porque un typo manda PDFs de usuarios a un host que no controlás.
     */
    if (import.meta.env.DEV) return DEFAULT_BASE_URL

    throw new Error(
      'Falta AUTOLIBRE_BACKEND_URL — el panel no puede subir manuales sin saber ' +
        'a qué backend hablarle. Va con el prefijo incluido, por ejemplo ' +
        'https://api.autolibre.app/api/v1. En Vercel es una env var del proyecto ' +
        'y hay que redeployar después de cargarla.',
    )
  }

  return configured.replace(/\/+$/, '')
}

/**
 * El token de sesión del admin que está usando el panel.
 *
 * `getToken()` devuelve el session token de Clerk sin template. Sirve porque el
 * backend sólo exige el claim `sub`; si el template no trae `email`, el backend
 * paga un round trip a la API de Clerk y loguea un warn UNA vez por proceso.
 * Eso es problema de configuración del dashboard de Clerk, no de este archivo.
 */
async function bearerToken(): Promise<string> {
  const { getToken } = await auth()
  const token = await getToken()

  if (!token) {
    // No es un fallo técnico: es una sesión que venció entre que la pantalla se
    // pintó y el operador apretó "Subir". Se traduce a la misma sentinela que
    // usa `authedMiddleware`, así que `readableError` ya la sabe leer.
    throw new Error('UNAUTHENTICATED')
  }

  return token
}

/** La forma del cuerpo de error del backend — `ApplicationExceptionFilter`. */
interface BackendErrorBody {
  statusCode?: number
  message?: unknown
  code?: unknown
}

/**
 * Traduce una respuesta no-2xx del backend a un `Error` con un mensaje que se
 * pueda leer sin abrir el repo del backend.
 *
 * El cuerpo viene como `{ statusCode, message, code }`, pero SÓLO cuando el
 * error pasó por `ApplicationExceptionFilter`. Un 502 del proxy, un 404 de una
 * ruta mal escrita o un HTML de error de infraestructura no tienen esa forma —
 * por eso el `catch` alrededor del `.json()`, y por eso el fallback incluye el
 * status: sin él, "algo falló" no distingue "el manual ya existe" de "el
 * backend está caído".
 */
async function backendError(response: Response, what: string): Promise<Error> {
  let body: BackendErrorBody | null = null

  try {
    body = (await response.json()) as BackendErrorBody
  } catch {
    body = null
  }

  const message = typeof body?.message === 'string' ? body.message : null

  if (response.status === 401) return new Error('BACKEND_UNAUTHENTICATED')
  if (response.status === 403) return new Error('BACKEND_FORBIDDEN')
  if (response.status === 413) return new Error('BACKEND_PAYLOAD_TOO_LARGE')

  return new Error(
    `BACKEND_ERROR:${response.status}:${message ?? `${what} falló sin explicación`}`,
  )
}

/**
 * Paso 1 — pedir la URL firmada. NO viaja el archivo.
 *
 * ── Por qué el panel dejó de subir el PDF ───────────────────────────────────
 *
 * Porque no podía. El 2026-09-04 esta función mandaba el multipart a
 * `POST /files` y producción devolvía `FUNCTION_PAYLOAD_TOO_LARGE`: Vercel
 * corta el cuerpo de una Serverless Function en 4.5MB, límite de plataforma no
 * configurable. El PDF ni siquiera llegaba al backend.
 *
 * Subir los límites no era el arreglo — un manual de 300 páginas tampoco
 * entraba en los 10MB del backend. Lo que estaba mal era que el archivo pasara
 * por un servidor nuestro. Ahora sólo viajan estos metadatos (un JSON de
 * doscientos bytes) y el PDF va del navegador a Spaces, sin escalas.
 *
 * `sizeBytes` NO es informativo: el backend lo firma dentro de la URL como
 * `ContentLength` exacto, así que un PUT de otro tamaño lo rechaza Spaces. Es
 * lo que impide que una URL pedida para 6MB sirva para subir 5GB.
 */
export async function requestUploadUrl(input: {
  originalName: string
  mimeType: string
  sizeBytes: number
}): Promise<{ fileId: string; uploadUrl: string }> {
  const token = await bearerToken()

  const response = await fetch(`${baseUrl()}/files/upload-url`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })

  if (!response.ok) throw await backendError(response, 'El pedido de URL de subida')

  const body = (await response.json()) as { fileId?: unknown; uploadUrl?: unknown }

  if (typeof body.fileId !== 'string' || typeof body.uploadUrl !== 'string') {
    throw new Error('BACKEND_ERROR:200:El backend no devolvió una URL de subida usable')
  }

  return { fileId: body.fileId, uploadUrl: body.uploadUrl }
}

/**
 * Paso 3 — confirmar que el objeto llegó, y recién ahí registrarlo.
 *
 * Es el paso que hace ACEPTABLE la subida directa, no un trámite. El presigned
 * PUT saltea `UploadFileHandler`, que era el único lugar del sistema donde se
 * sniffeaban los magic bytes: sin este confirm, un `.zip` renombrado a `.pdf`
 * entraría sin que nada lo note. El backend lee los primeros KB del objeto ya
 * subido y exige lo mismo que exigía el otro camino.
 *
 * `originalName` y `mimeType` tienen que ser los MISMOS del paso 1: la key del
 * objeto se deriva de `(fileId, originalName)` y entre los dos pasos el backend
 * no guarda nada. Un nombre distinto apunta a una key que no existe y vuelve
 * como 404.
 *
 * Es idempotente del lado del backend, así que reintentarlo es seguro.
 */
export async function confirmUpload(input: {
  fileId: string
  originalName: string
  mimeType: string
}): Promise<void> {
  const token = await bearerToken()

  const response = await fetch(`${baseUrl()}/files/confirm`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })

  if (!response.ok) throw await backendError(response, 'La confirmación del archivo')
}

/**
 * Paso 2 — atar el archivo ya subido a un catálogo.
 *
 * `POST /vehicle-catalog-manuals` va con `AdminGuard`, así que este es el punto
 * donde el rol del panel se vuelve a chequear del lado del backend. Que el
 * `adminMiddleware` del panel ya lo haya hecho no lo hace redundante: son dos
 * sistemas y cada uno responde por sus propios datos.
 *
 * Devuelve 201 con cuerpo VACÍO — el controller declara `Promise<void>`. Por eso
 * acá no se parsea nada: leer un JSON que no viene tira, y ese throw se leería
 * como "no se guardó" cuando en realidad sí se guardó.
 *
 * ── Dos cosas que este endpoint NO valida, y muerden acá ─────────────────────
 *
 *  - **No chequea que el catálogo exista.** `CreateVehicleCatalogManualHandler`
 *    sólo valida `fileId`. Un `catalogId` inexistente llega hasta la FK de
 *    Postgres y vuelve como error crudo. Por eso el panel manda un `catalogId`
 *    que salió de su propio `SELECT`, nunca uno tipeado.
 *  - **No hay UNIQUE sobre `(catalog_id, …)`.** Se pueden crear diez manuales
 *    idénticos para el mismo catálogo y nada se queja. La pantalla muestra los
 *    que ya hay JUNTO al formulario justamente para que el duplicado se vea
 *    antes de crearlo — es lo único que hay contra eso hoy.
 */
export async function linkManualToCatalog(input: {
  catalogId: string
  fileId: string
  version: string
  language: string
}): Promise<void> {
  const token = await bearerToken()

  const response = await fetch(`${baseUrl()}/vehicle-catalog-manuals`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    /**
     * Los campos vacíos NO se mandan.
     *
     * `version` y `language` son `text NULL` del otro lado. Mandar `""` guarda
     * un string vacío, que es el dato roto que dejó el import del
     * `legacy_sheet` y la razón por la que todo chequeo de "falta este campo"
     * en este repo se escribe `coalesce(x,'') = ''` en vez de `x IS NULL`.
     * Omitir la clave deja el NULL, que es lo que "no sé la versión" significa.
     */
    body: JSON.stringify({
      catalogId: input.catalogId,
      fileId: input.fileId,
      ...(input.version ? { version: input.version } : {}),
      ...(input.language ? { language: input.language } : {}),
    }),
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })

  if (!response.ok) throw await backendError(response, 'El alta del manual')
}

/**
 * Pedir la URL firmada para descargar un PDF ya subido. Dura 15 minutos y no se
 * cachea: pasado ese plazo hay que volver a pedirla.
 *
 * ── LA TRAMPA DE ESTE ENDPOINT ──────────────────────────────────────────────
 *
 * `GetFileSignedUrlHandler` hace `fileRepository.findById(query.id, query.userId)`
 * — está acotado al DUEÑO del archivo. O sea: **el admin que subió el manual es
 * el único que puede después descargarlo desde el panel.** Cualquier otro admin
 * recibe un 404, no un 403, porque el backend no le confirma a un extraño que
 * ese id existe.
 *
 * Con 3 usuarios en producción eso muerde apenas haya dos personas cargando
 * manuales. NO se arregla desde este repo: el arreglo honesto es que el backend
 * deje a un admin leer cualquier `file`, y esa es una decisión de su contexto
 * de permisos, no del panel. Lo que sí hace el panel es MOSTRAR quién subió cada
 * manual, para que el 404 se lea como "pedísela a fulano" y no como "está roto".
 *
 * Ojo con el otro camino tentador: `CreateVehicleCatalogManualHandler` llama a
 * `findById(fileId)` SIN userId, con un comentario que dice que los manuales no
 * tienen dueño. O sea que el backend ya sabe que un manual es dato de
 * referencia — pero esa excepción vive en el alta, no en la descarga.
 */
export async function fileSignedUrl(fileId: string): Promise<{
  url: string
  expiresAt: string
}> {
  const token = await bearerToken()

  const response = await fetch(`${baseUrl()}/files/${fileId}/url`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })

  if (response.status === 404) {
    // El 404 acá casi nunca significa "no existe". Ver el comentario de arriba.
    throw new Error('FILE_NOT_YOURS')
  }

  if (!response.ok) throw await backendError(response, 'La URL de descarga')

  const body = (await response.json()) as { url?: unknown; expiresAt?: unknown }

  if (typeof body.url !== 'string') {
    throw new Error('BACKEND_ERROR:200:El backend no devolvió una URL de descarga')
  }

  return {
    url: body.url,
    expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : '',
  }
}
