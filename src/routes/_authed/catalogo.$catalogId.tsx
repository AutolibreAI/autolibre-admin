import { useState } from 'react'
import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { AlertTriangle, ArrowLeft, Download, FileWarning } from 'lucide-react'
import {
  MANUAL_LANGUAGE_LABELS,
  VEHICLE_TYPE_LABELS,
  catalogTitle,
  type CatalogManual,
  type CatalogSpec,
  type ManualLanguage,
} from '~/lib/manuals'
import { getManualDownloadUrl, getVehicleCatalog, readableManualError } from '~/fn/manuals'
import { ManualUploader } from '~/components/ManualUploader'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { CopyableId } from '~/components/CopyableId'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { formatBytes, formatDate, formatInt } from '~/lib/format'

export const Route = createFileRoute('/_authed/catalogo/$catalogId')({
  /**
   * SSR completo. Se llega desde el listado, pero también por link pegado — un
   * uuid de catálogo en un mensaje es la forma normal de decir "cargale el
   * manual a este", y ahí es el primer pintado de la sesión.
   */
  loader: async ({ params, abortController }) => {
    const detail = await getVehicleCatalog({
      data: params,
      signal: abortController.signal,
    }).catch((cause: unknown) => {
      // `NOT_FOUND:` se traduce a un 404 de Router; cualquier otro error sube.
      // Tragarlos todos convertiría una caída de Postgres en "este modelo no
      // existe", que es la respuesta equivocada más tranquilizadora posible.
      if (cause instanceof Error && cause.message.startsWith('NOT_FOUND:')) return null
      throw cause
    })

    if (!detail) throw notFound()
    return detail
  },

  head: ({ loaderData }) => ({
    meta: [{ title: loaderData ? `${catalogTitle(loaderData)} — Catálogo` : 'Modelo' }],
  }),

  component: CatalogDetailScreen,
})

/**
 * La ficha de un modelo del catálogo.
 *
 * El orden de la página es el orden de las preguntas: qué modelo es, qué
 * manuales tiene, y recién ahí el formulario para agregar uno. El uploader va
 * AL LADO de la lista y no arriba a propósito — el backend no tiene UNIQUE
 * sobre `(catalog_id, …)`, así que ver los manuales que ya hay antes de subir
 * es lo único que hay contra el duplicado.
 */
function CatalogDetailScreen() {
  const catalog = Route.useLoaderData()
  const name = catalogTitle(catalog)

  return (
    <>
      <Link
        to="/catalogo"
        search={{ q: undefined, onlyWithoutManual: false }}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Catálogo
      </Link>

      <PageHeader
        title={name}
        subtitle={`${VEHICLE_TYPE_LABELS[catalog.vehicleType]} · ${formatInt(catalog.vehicleCount)} vehículo(s) de usuarios · alta ${formatDate(catalog.createdAt)}`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <div className="mb-4 rounded-lg border border-border bg-card p-3">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
          catalog_id
        </span>
        {/* Para todo lo que el panel no cubre, el operador se va a DBeaver. */}
        <CopyableId value={catalog.id} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ManualsCard manuals={catalog.manuals} />
        </div>

        <div className="space-y-4">
          <ManualUploader catalogId={catalog.id} catalogName={name} />
          <SpecsCard specs={catalog.specs} />
        </div>
      </div>
    </>
  )
}

// ── Manuales ─────────────────────────────────────────────────────────────────

function ManualsCard({ manuals }: { manuals: Array<CatalogManual> }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">
          Manuales {manuals.length > 0 ? `(${formatInt(manuals.length)})` : null}
        </CardTitle>
      </CardHeader>

      <CardContent>
        {manuals.length === 0 ? (
          /*
            El vacío se explica, no se deja en blanco. Es el estado de los 83
            catálogos hoy, así que es la pantalla que más se va a ver — y decir
            "todavía no hay" es distinto de que parezca que algo no cargó.
          */
          <p className="text-sm leading-relaxed text-muted-foreground">
            Este modelo todavía no tiene manual. Subí el PDF con el formulario de
            la derecha.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {manuals.map((manual) => (
              <ManualRow key={manual.id} manual={manual} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function ManualRow({ manual }: { manual: CatalogManual }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * La URL firmada se pide al hacer click, no en el loader.
   *
   * Pedirla por adelantado para los N manuales gastaría N llamadas al backend
   * por links que probablemente nadie abra, y encima empezaría a consumir los
   * 15 minutos de vigencia desde el render — un manual abierto veinte minutos
   * después daría 403 del storage sin explicación.
   */
  async function download() {
    if (!manual.fileId) return

    setBusy(true)
    setError(null)

    try {
      const { url } = await getManualDownloadUrl({ data: { fileId: manual.fileId } })
      /**
       * `noopener` no es opcional: sin él la pestaña que se abre puede navegar
       * a la nuestra con `window.opener`. Y `_blank` en vez de descargar
       * directo porque la URL firmada es de otro origen — un `<a download>`
       * cross-origin lo ignora el navegador y termina navegando igual.
       */
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (cause) {
      setError(readableManualError(cause))
    } finally {
      setBusy(false)
    }
  }

  const language = manual.language as ManualLanguage | null
  const languageLabel =
    language && language in MANUAL_LANGUAGE_LABELS
      ? MANUAL_LANGUAGE_LABELS[language]
      : /*
          Un idioma que no está en la lista NO se esconde: se muestra crudo. La
          lista cerrada es una convención del panel, y el día que aparezca un
          `"castellano"` cargado desde otro lado hay que poder VERLO — que es
          justamente el problema que la convención quiere evitar.
        */
        (manual.language ?? null)

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {manual.version ?? 'Sin versión'}
          </span>
          {languageLabel ? (
            <Badge variant="outline" className="text-xs">
              {languageLabel}
            </Badge>
          ) : null}
        </div>

        {manual.file ? (
          <p className="text-xs text-muted-foreground">
            {manual.file.sizeBytes === null
              ? 'Tamaño desconocido'
              : formatBytes(manual.file.sizeBytes)}
            {' · '}
            subido el {formatDate(manual.file.uploadedAt)}
            {/*
              Quién subió NO es adorno: `GET /files/:id/url` está acotado al
              dueño del archivo, así que este email es a quién hay que pedirle
              el PDF cuando la descarga tira 404. Ver `src/server/backend.ts`.
            */}
            {manual.file.uploaderEmail ? ` por ${manual.file.uploaderEmail}` : null}
          </p>
        ) : (
          /*
            `file_id` NULL es representable: el DTO del backend lo declara
            opcional, así que se puede crear un manual anunciado y sin PDF. Es
            un dato roto y se dice así — no se disfraza de "descarga no
            disponible".
          */
          <p className="inline-flex items-center gap-1.5 text-xs text-status-yellow">
            <FileWarning className="size-3.5" aria-hidden />
            Sin archivo: la fila existe pero nunca se le subió un PDF.
          </p>
        )}

        {error ? (
          <p role="alert" className="text-xs leading-relaxed text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      {manual.fileId ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void download()}
          className="shrink-0 gap-1.5"
        >
          <Download className="size-3.5" aria-hidden />
          {busy ? 'Pidiendo…' : 'Descargar'}
        </Button>
      ) : null}
    </li>
  )
}

// ── Variantes de powertrain ──────────────────────────────────────────────────

/**
 * Las specs se muestran para dejar en claro qué NO son.
 *
 * El error que esta tarjeta existe para prevenir es pensar que el manual cuelga
 * de acá. No: `vehicle_catalog_manuals.catalog_id` apunta al CATÁLOGO, y el
 * spec es su hermano, no su padre. Verlas juntas y sin ningún botón de "cargar
 * manual" al lado es lo que hace que esa relación se lea de una.
 */
function SpecsCard({ specs }: { specs: Array<CatalogSpec> }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">
          Variantes {specs.length > 0 ? `(${formatInt(specs.length)})` : null}
        </CardTitle>
      </CardHeader>

      <CardContent>
        {specs.length === 0 ? (
          <p className="inline-flex items-start gap-1.5 text-xs leading-relaxed text-status-yellow">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {/*
              Sin specs, ningún vehículo de usuario puede apuntar a este modelo:
              `vehicles.vehicle_catalog_spec_id` es NOT NULL. O sea que este
              catálogo es inalcanzable desde la app.
            */}
            Sin variantes cargadas. Ningún vehículo de un usuario puede apuntar a
            este modelo hasta que exista al menos una.
          </p>
        ) : (
          <ul className="space-y-2">
            {specs.map((spec) => (
              <li key={spec.id} className="text-xs text-muted-foreground">
                {/*
                  Las cuatro columnas son nullables porque el proveedor de
                  patentes no las devuelve — el backend lo dice en la unique
                  `nullsNotDistinct` de la tabla. Una spec entera vacía es
                  representable, así que hay que poder mostrarla.
                */}
                {[
                  spec.engine,
                  spec.fuelType,
                  spec.transmission,
                  spec.gearCount === null ? null : `${spec.gearCount} marchas`,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'Variante sin datos de powertrain'}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
