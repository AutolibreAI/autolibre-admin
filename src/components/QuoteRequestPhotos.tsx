import { useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Camera, Download, ImageOff, Loader2, RefreshCw, Upload } from 'lucide-react'
import {
  finishQuotePhotoUploadFn,
  getQuoteRequestPhotoUrlsFn,
  requestQuotePhotoUploadUrlFn,
} from '~/fn/quote-photos'
import {
  MAX_QUOTE_PHOTO_BYTES,
  QUOTE_FILE_PURPOSE_LABELS,
  QUOTE_PHOTO_MIME_TYPES,
  isQuotePhotoMime,
  readableQuotePhotoError,
  type QuotePhotoUrls,
  type QuoteRequestPhoto,
  type QuoteRequestPhotos as QuoteRequestPhotosData,
} from '~/lib/quote-photos'
import { formatDateTime } from '~/lib/format'
import { Button } from '~/components/ui/button'
import { Card, CardContent } from '~/components/ui/card'

/**
 * Las fotos del pedido, en la ficha. Las que adjuntó la persona desde la app y
 * las que el operador cargó acá (las que le llegan por WhatsApp).
 *
 * - Las miniaturas se piden al MONTAR, no en el loader: son URLs firmadas que
 *   vencen a los minutos, y la ficha no tiene por qué depender del backend
 *   para pintarse. "Recargar" las vuelve a pedir si vencieron.
 * - Un click abre la foto entera en otra pestaña.
 * - Subir son tres pasos por foto, y las fotos van de a una: un error en la
 *   tercera no se lleva puestas las dos primeras, y el mensaje dice cuál falló.
 * - Si una vista previa no carga, el MOTIVO se dice a la vista, una vez por
 *   motivo — no escondido en el tooltip de cada miniatura (2026-10-03: se veía
 *   "sin vista previa" sin saber por qué).
 * - Descargar va por `/api/pedidos/:id/fotos/:fileId` (y `fotos-zip` para
 *   todas), no por la URL firmada: el backend firma sin `attachment` y el
 *   navegador ABRIRÍA la foto en vez de bajarla.
 */
export function QuoteRequestPhotos({
  quoteRequestId,
  data,
}: {
  quoteRequestId: string
  data: QuoteRequestPhotosData
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [urls, setUrls] = useState<QuotePhotoUrls | null>(null)
  const [urlsError, setUrlsError] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  const [progress, setProgress] = useState<string | null>(null)
  const [errors, setErrors] = useState<Array<string>>([])

  const photos = data.available ? data.photos : []
  const signature = photos.map((p) => p.fileId).join(',')

  useEffect(() => {
    if (!data.available || photos.length === 0) return
    let cancelled = false
    setUrls(null)
    setUrlsError(null)
    getQuoteRequestPhotoUrlsFn({ data: { quoteRequestId } })
      .then((r) => {
        if (!cancelled) setUrls(r)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setUrlsError(readableQuotePhotoError(cause))
      })
    return () => {
      cancelled = true
    }
    // `signature` cambia cuando se agrega una foto; `reloadTick`, con "Recargar".
  }, [quoteRequestId, signature, reloadTick])

  if (!data.available) return null

  async function uploadOne(file: File): Promise<void> {
    if (!isQuotePhotoMime(file.type)) throw new Error('NOT_AN_IMAGE')
    if (file.size > MAX_QUOTE_PHOTO_BYTES) throw new Error('TOO_LARGE')

    const { fileId, uploadUrl } = await requestQuotePhotoUploadUrlFn({
      data: { quoteRequestId, originalName: file.name, mimeType: file.type, sizeBytes: file.size },
    })

    let response: Response
    try {
      // Sólo `content-type`: es el único header que firma la URL y que el CORS
      // del bucket permite (`vehicle-manuals.md`).
      response = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': file.type }, body: file })
    } catch (cause) {
      throw new Error(`STORAGE_PUT_FAILED:${cause instanceof Error ? cause.message : String(cause)}`)
    }
    if (!response.ok) throw new Error(`STORAGE_PUT_FAILED:HTTP ${response.status}`)

    await finishQuotePhotoUploadFn({
      data: { quoteRequestId, fileId, originalName: file.name, mimeType: file.type as (typeof QUOTE_PHOTO_MIME_TYPES)[number] },
    })
  }

  async function onFiles(list: FileList | null) {
    const files = list ? Array.from(list) : []
    if (files.length === 0) return
    setErrors([])
    const failed: Array<string> = []
    let ok = 0
    for (const [i, file] of files.entries()) {
      setProgress(`Subiendo ${i + 1} de ${files.length}…`)
      try {
        await uploadOne(file)
        ok++
      } catch (cause) {
        failed.push(`${file.name}: ${readableQuotePhotoError(cause)}`)
      }
    }
    setProgress(null)
    setErrors(failed)
    if (inputRef.current) inputRef.current.value = ''
    if (ok > 0) await router.invalidate()
  }

  const busy = progress !== null

  // Un motivo por renglón, no uno por foto: si el backend no responde, las N
  // fotos fallan por lo mismo.
  const previewErrors = urls
    ? Array.from(
        new Set(
          photos.flatMap((p) => {
            const u = urls[p.fileId]
            if (!u) return ['El backend no devolvió una URL para esta foto.']
            return 'error' in u ? [readableQuotePhotoError(new Error(u.error))] : []
          }),
        ),
      )
    : []

  return (
    <Card className="mb-4">
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="inline-flex items-center gap-2 font-heading text-base font-semibold">
            <Camera className="size-4 text-muted-foreground" aria-hidden />
            Fotos {photos.length > 0 ? <span className="text-muted-foreground">({photos.length})</span> : null}
          </h2>
          <div className="flex items-center gap-2">
            {photos.length > 1 ? (
              <a
                href={`/api/pedidos/${quoteRequestId}/fotos-zip`}
                download
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-surface-2 hover:text-foreground"
              >
                <Download className="size-3.5" aria-hidden /> Descargar todas (.zip)
              </a>
            ) : null}
            {photos.length > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 px-2 text-xs"
                onClick={() => setReloadTick((t) => t + 1)}
                title="Las vistas previas vencen a los pocos minutos"
              >
                <RefreshCw className="size-3.5" aria-hidden /> Recargar
              </Button>
            ) : null}
            {data.canUpload ? (
              <>
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  accept={QUOTE_PHOTO_MIME_TYPES.join(',')}
                  className="hidden"
                  onChange={(e) => void onFiles(e.target.files)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => inputRef.current?.click()}
                  className="gap-1.5"
                >
                  {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Upload className="size-3.5" aria-hidden />}
                  {progress ?? 'Agregar fotos'}
                </Button>
              </>
            ) : null}
          </div>
        </div>

        {!data.canUpload ? (
          <p className="text-xs text-muted-foreground">
            Para cargar fotos desde el panel falta aplicar la migración 020 en esta base.
          </p>
        ) : null}

        {photos.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Este pedido no tiene fotos. Las que la persona manda por WhatsApp se pueden cargar acá.
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {photos.map((p) => (
              <PhotoTile
                key={p.id}
                photo={p}
                url={urls?.[p.fileId] ?? null}
                loading={urls === null && !urlsError}
                downloadHref={`/api/pedidos/${quoteRequestId}/fotos/${p.fileId}`}
              />
            ))}
          </ul>
        )}

        {urlsError ? (
          <p role="alert" className="text-xs text-destructive">
            No se pudieron pedir las vistas previas: {urlsError}
          </p>
        ) : null}
        {previewErrors.length > 0 ? (
          <div role="alert" className="space-y-1 rounded-md border border-status-yellow/30 bg-status-yellow-bg px-3 py-2 text-xs text-status-yellow">
            <div className="font-medium">Por qué no se ve la vista previa:</div>
            {previewErrors.map((e) => (
              <div key={e}>{e}</div>
            ))}
          </div>
        ) : null}
        {errors.length > 0 ? (
          <ul role="alert" className="space-y-1 text-xs text-destructive">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  )
}

function PhotoTile({
  photo: p,
  url,
  loading,
  downloadHref,
}: {
  photo: QuoteRequestPhoto
  url: { url: string } | { error: string } | null
  loading: boolean
  downloadHref: string
}) {
  const origin =
    p.uploadedBy === 'requester'
      ? 'la persona, desde la app'
      : p.uploaderEmail
        ? `cargada por ${p.uploaderEmail}`
        : 'cargada por el equipo'

  return (
    <li className="space-y-1">
      <div className="aspect-square overflow-hidden rounded-md border border-border bg-surface-2">
        {url && 'url' in url ? (
          <a href={url.url} target="_blank" rel="noreferrer" className="block size-full" title="Abrir la foto entera">
            <img src={url.url} alt={`${QUOTE_FILE_PURPOSE_LABELS[p.purpose] ?? p.purpose} — ${origin}`} className="size-full object-cover" loading="lazy" />
          </a>
        ) : loading ? (
          <div className="size-full animate-pulse" aria-label="Cargando vista previa" />
        ) : (
          <div
            className="flex size-full flex-col items-center justify-center gap-1 p-2 text-center text-xs text-muted-foreground"
            title={url && 'error' in url ? readableQuotePhotoError(new Error(url.error)) : undefined}
          >
            <ImageOff className="size-5" aria-hidden />
            sin vista previa
          </div>
        )}
      </div>
      <div className="text-xs leading-snug text-muted-foreground">
        {p.purpose !== 'problem_photo' ? (
          <div className="font-medium text-foreground">{QUOTE_FILE_PURPOSE_LABELS[p.purpose] ?? p.purpose}</div>
        ) : null}
        <div className="truncate" title={origin}>
          {origin}
        </div>
        <div className="tabular-nums">{formatDateTime(p.createdAt)} UTC</div>
        <a
          href={downloadHref}
          download
          className="mt-0.5 inline-flex items-center gap-1 text-brand hover:underline"
        >
          <Download className="size-3" aria-hidden /> Descargar
        </a>
      </div>
    </li>
  )
}
