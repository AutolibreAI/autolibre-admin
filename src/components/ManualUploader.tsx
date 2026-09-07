import { useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { FileUp, RotateCcw, Upload } from 'lucide-react'
import {
  MANUAL_LANGUAGES,
  MANUAL_LANGUAGE_LABELS,
  MANUAL_MIME_TYPE,
  MAX_MANUAL_FILE_SIZE_BYTES,
  MAX_MANUAL_FILE_SIZE_MB,
  type ManualLanguage,
} from '~/lib/manuals'
import {
  finishManualUpload,
  orphanFileId,
  readableManualError,
  requestManualUploadUrl,
} from '~/fn/manuals'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { formatBytes } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * Cargar el manual de un modelo.
 *
 * ── El PDF NO pasa por ningún servidor nuestro ──────────────────────────────
 *
 * Es la única pantalla del panel que sube un archivo, y lo hace en tres pasos:
 *
 *   1. `requestManualUploadUrl` → server fn, JSON de doscientos bytes
 *   2. **`PUT` del navegador a DigitalOcean Spaces** ← el archivo va POR ACÁ
 *   3. `finishManualUpload` → server fn, JSON: confirma y asocia al catálogo
 *
 * El paso 2 es el punto entero. Hasta el 2026-09-04 este componente mandaba el
 * PDF a un server function que lo reenviaba al backend, y producción devolvía
 * `FUNCTION_PAYLOAD_TOO_LARGE`: Vercel corta el cuerpo de una Serverless
 * Function en 4.5MB, límite de plataforma que no se configura. El archivo ni
 * llegaba al backend.
 *
 * Subir los límites no era el arreglo — un manual de 300 páginas tampoco
 * entraba en los 10MB del backend. Lo que estaba mal era proxear el archivo.
 * → `.claude/rules/vehicle-manuals.md`
 *
 * ── Sigue sin comprimirse ni trocearse, y por los mismos motivos ────────────
 *
 * Comprimir un PDF en el browser degrada un manual escaneado hasta volverlo
 * ilegible, y trocear necesitaría multipart upload, que el backend no expone.
 * Con el techo en 100MB ninguna de las dos hace falta.
 */
export function ManualUploader({
  catalogId,
  catalogName,
}: {
  catalogId: string
  catalogName: string
}) {
  const router = useRouter()

  const [file, setFile] = useState<File | null>(null)
  const [version, setVersion] = useState('')
  const [language, setLanguage] = useState<ManualLanguage | ''>('es')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * El `fileId` de un PDF que YA está en storage y sólo falta terminar de
   * registrar o asociar.
   *
   * Es lo que hace que un fallo del paso 3 no obligue a volver a subir 80MB.
   * Se limpia en cuanto el operador elige otro archivo: reintentar el paso 3
   * con un id que no corresponde al archivo elegido asociaría el PDF
   * equivocado.
   */
  const [uploaded, setUploaded] = useState<string | null>(null)

  /**
   * El `<input type="file">` es NO CONTROLADO — React no puede setear su value
   * por seguridad del navegador. Así que para vaciarlo después de una carga
   * exitosa hace falta la ref: sin esto el nombre del PDF ya subido queda en
   * pantalla, y el operador vuelve a apretar "Subir" creyendo que no pasó nada.
   * Como no hay UNIQUE del otro lado, eso crea el duplicado en silencio.
   */
  const fileInput = useRef<HTMLInputElement>(null)

  function reset() {
    setFile(null)
    setVersion('')
    setUploaded(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  /**
   * El chequeo local del tamaño.
   *
   * El techo ahora lo pone SÓLO el backend, en su constante del flujo directo
   * (`MAX_DIRECT_UPLOAD_FILE_SIZE_BYTES`), porque el archivo ya no atraviesa
   * Vercel. Este chequeo sigue valiendo igual: sin él el operador transfiere el
   * PDF entero a Spaces para que el `confirm` lo rechace después.
   */
  const tooLarge = file !== null && file.size > MAX_MANUAL_FILE_SIZE_BYTES

  async function submit() {
    if (!file) return

    setBusy(true)
    setError(null)

    try {
      /**
       * Si ya hay un PDF subido para este archivo, se saltea el paso caro.
       * Pasa cuando el paso 3 falló y el operador reintenta: el objeto sigue
       * en storage y la URL firmada ya se consumió.
       */
      const fileId = uploaded ?? (await uploadToStorage(file))
      setUploaded(fileId)

      await finishManualUpload({
        data: { catalogId, fileId, originalName: file.name, version, language },
      })

      // Lo que quedó guardado lo sabe Postgres, no el cliente: el `created_at`,
      // el `size_bytes` real del objeto, el `id`. Recargar es preguntar;
      // agregar una fila optimista sería inventar un dato que puede no
      // coincidir con el que la base grabó.
      await router.invalidate()
      reset()
    } catch (cause) {
      setError(readableManualError(cause))
      // Si el fallo fue después de registrar el archivo, el id viaja en el
      // error y sirve igual para reintentar sin volver a subir.
      setUploaded((prev) => orphanFileId(cause) ?? prev)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Los pasos 1 y 2. Devuelve el `fileId` del objeto ya subido.
   *
   * El `PUT` sale del NAVEGADOR, no de un server function, y ese es el motivo
   * de ser de todo este flujo. `fetch` con el `File` como body manda el binario
   * tal cual — nada de `FormData`, que lo envolvería en un multipart y le
   * cambiaría el `Content-Length`, invalidando la firma.
   *
   * ── `Content-Length` NO se setea acá, y no se puede ─────────────────────────
   *
   * La primera versión lo mandaba explícitamente, razonando que el backend lo
   * firma dentro de la URL y por lo tanto había que reproducirlo exacto. Es
   * inútil: **`Content-Length` es un *forbidden header name* de la Fetch API**,
   * así que el navegador descarta lo que uno ponga y calcula el suyo a partir
   * del body. La línea era código muerto que además mentía sobre el contrato.
   *
   * La firma valida igual, y por eso mismo: el `Content-Length` que el
   * navegador pone es el tamaño real del `File`, que es exactamente el
   * `sizeBytes` con el que se pidió la URL. No hay nada que sincronizar a mano.
   *
   * Consecuencia práctica para el CORS del bucket: el preflight pide sólo
   * `content-type` en `Access-Control-Request-Headers`. `content-length` nunca
   * aparece ahí, porque el navegador ya lo filtró.
   */
  async function uploadToStorage(pdf: File): Promise<string> {
    const { fileId, uploadUrl } = await requestManualUploadUrl({
      data: {
        originalName: pdf.name,
        mimeType: MANUAL_MIME_TYPE,
        sizeBytes: pdf.size,
      },
    })

    let response: Response
    try {
      response = await fetch(uploadUrl, {
        method: 'PUT',
        // El único header que hace falta declarar. Va en minúscula porque así
        // es como el navegador lo manda en el preflight, y así tiene que estar
        // en la config de CORS del bucket.
        headers: { 'content-type': MANUAL_MIME_TYPE },
        body: pdf,
      })
    } catch (cause) {
      /**
       * Un `fetch` que TIRA (en vez de devolver un status feo) contra un origen
       * cruzado es, casi siempre, CORS. Se distingue del error de red porque el
       * navegador no da detalle a propósito — así que el mensaje nombra la causa
       * probable en vez de decir "Failed to fetch", que no le sirve a nadie.
       */
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`STORAGE_PUT_FAILED:${detail}`)
    }

    if (!response.ok) {
      throw new Error(`STORAGE_PUT_FAILED:HTTP ${response.status}`)
    }

    return fileId
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Cargar manual</CardTitle>
      </CardHeader>

      <CardContent>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="space-y-1">
            <label htmlFor="manual-file" className="block text-xs text-muted-foreground">
              PDF del manual
            </label>
            <Input
              id="manual-file"
              ref={fileInput}
              type="file"
              // `accept` es una ayuda del selector de archivos, no una
              // validación: el usuario puede elegir "todos los archivos" y
              // pasar cualquier cosa. Por eso el tipo se vuelve a mirar en el
              // server function, y los magic bytes en el backend.
              accept={MANUAL_MIME_TYPE}
              disabled={busy}
              onChange={(e) => {
                const picked = e.currentTarget.files?.[0] ?? null
                setFile(picked)
                setError(null)
                // Otro archivo invalida el PDF ya subido: reintentar con ese id
                // asociaría el manual equivocado.
                setUploaded(null)
              }}
              className="text-xs file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-xs file:text-foreground"
            />
            {file ? (
              <p
                className={cn(
                  'text-xs',
                  tooLarge ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {file.name} — {formatBytes(file.size)}
                {tooLarge ? ` · supera los ${MAX_MANUAL_FILE_SIZE_MB}MB` : null}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Sólo PDF, hasta {MAX_MANUAL_FILE_SIZE_MB}MB.
              </p>
            )}

            {/*
              El techo se explica cuando el archivo NO entra, no siempre.
              Decir de quién es el límite cambia a quién hay que reclamarle.
              Hasta el 2026-09-04 acá había una rama para Vercel, con su límite
              de 4.5MB: se borró porque el archivo ya no pasa por Vercel.
            */}
            {tooLarge ? (
              <p className="text-xs leading-relaxed text-destructive">
                El techo lo pone el backend, en{' '}
                <code className="font-mono">MAX_DIRECT_UPLOAD_FILE_SIZE_BYTES</code>.
                Un manual que no entra en {MAX_MANUAL_FILE_SIZE_MB}MB es un caso
                que nadie previó: avisá antes de comprimirlo.
              </p>
            ) : null}
          </div>

          <div className="space-y-1">
            <label htmlFor="manual-version" className="block text-xs text-muted-foreground">
              Versión <span className="text-muted-foreground/60">(opcional)</span>
            </label>
            <Input
              id="manual-version"
              value={version}
              disabled={busy}
              onChange={(e) => {
                const value = e.currentTarget.value
                setVersion(value)
              }}
              placeholder="2021 rev. B"
              className="text-xs"
              autoComplete="off"
            />
          </div>

          <div className="space-y-1.5">
            <span className="block text-xs text-muted-foreground">Idioma</span>
            {/*
              Lista cerrada y no input libre. La columna es `text NULL` y el
              backend no valida nada, así que un campo abierto se llenaría de
              "Español", "español", "ES" y "castellano" — el mismo desorden que
              dejó el import del `legacy_sheet` en `partners`. Elegir de una
              lista no inventa dominio: impone una convención en el único lugar
              donde hoy se escribe esa columna. → `~/lib/manuals`
            */}
            <div className="flex flex-wrap gap-1.5">
              {MANUAL_LANGUAGES.map((code) => (
                <LanguageChip
                  key={code}
                  active={language === code}
                  disabled={busy}
                  onClick={() => setLanguage(code)}
                >
                  {MANUAL_LANGUAGE_LABELS[code]}
                </LanguageChip>
              ))}
              {/*
                "Sin especificar" existe y guarda NULL, no `''`. Un manual cuyo
                idioma nadie sabe es un dato honesto; un string vacío es el dato
                roto que obliga a escribir `coalesce(x,'') = ''` en todo el repo.
              */}
              <LanguageChip
                active={language === ''}
                disabled={busy}
                onClick={() => setLanguage('')}
              >
                Sin especificar
              </LanguageChip>
            </div>
          </div>

          <Button
            type="submit"
            size="sm"
            disabled={busy || !file || tooLarge}
            className="gap-1.5"
          >
            {busy ? (
              <FileUp className="size-3.5 animate-pulse" aria-hidden />
            ) : (
              <Upload className="size-3.5" aria-hidden />
            )}
            {busy ? 'Subiendo…' : 'Subir manual'}
          </Button>

          {busy ? (
            <p className="text-xs text-muted-foreground" role="status">
              El PDF viaja entero antes de que el backend conteste. Con archivos
              grandes puede tardar; no cierres la pestaña.
            </p>
          ) : null}
        </form>

        {error ? (
          <div className="mt-3 rounded-md border border-destructive/30 bg-status-red-bg p-3">
            <p role="alert" className="text-xs leading-relaxed text-destructive">
              {error}
            </p>

            {/*
              El reintento aparece SÓLO cuando el PDF ya está en storage.

              Reintenta el submit ENTERO, no un endpoint especial: `submit()`
              ve `uploaded` seteado y saltea los pasos 1 y 2. Cuando el panel
              proxeaba el archivo esto necesitaba su propio server function
              (`retryLinkCatalogManual`), porque re-subir costaba la
              transferencia; ahora el ahorro es el mismo y el código es uno solo.
            */}
            {uploaded ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void submit()}
                className="mt-2 gap-1.5"
              >
                <RotateCcw className="size-3.5" aria-hidden />
                Reintentar sin volver a subir el PDF
              </Button>
            ) : null}
          </div>
        ) : null}

        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          El manual queda asociado a <strong className="text-foreground">{catalogName}</strong>{' '}
          completo, no a una variante de motor. El backend no impide cargar dos
          veces el mismo: mirá la lista de al lado antes de subir.
        </p>
      </CardContent>
    </Card>
  )
}

/** Mismo botón-chip que `StatusCard` en `PartnerFicha`, para no divergir. */
function LanguageChip({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-50',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        active
          ? 'border-transparent bg-primary text-primary-foreground'
          : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
