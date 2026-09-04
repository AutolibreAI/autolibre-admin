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
  orphanFileId,
  readableManualError,
  retryLinkCatalogManual,
  uploadCatalogManual,
} from '~/fn/manuals'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { formatBytes } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * Cargar el manual de un modelo.
 *
 * ── Este formulario NO escribe SQL, y es el único del panel ─────────────────
 *
 * Manda un `FormData` a un server function que hace DOS llamadas HTTP contra
 * `autolibre-backend-hex`: `POST /files` (el PDF a DigitalOcean Spaces) y
 * `POST /vehicle-catalog-manuals` (la fila). No hay stored procedure de `ops`
 * acá y no debería haberlo — ver `.claude/rules/vehicle-manuals.md`.
 *
 * ── Por qué el archivo se manda sin comprimir ni trocear ────────────────────
 *
 * Porque el backend corta en 10MB de una y no tiene subida por partes. Trocear
 * del lado del cliente requeriría un endpoint que no existe; comprimir un PDF
 * en el browser degrada un manual escaneado hasta volverlo ilegible. Si el PDF
 * no entra, entra el problema al backend, no un workaround acá.
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
  const [orphan, setOrphan] = useState<string | null>(null)

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
    setOrphan(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  /**
   * El chequeo local del tamaño se hace acá Y en el validator del server
   * function Y en el backend. Tres veces no es paranoia: éste es el único que
   * evita transferir 40MB para escuchar un 413 tres minutos después.
   */
  const tooLarge = file !== null && file.size > MAX_MANUAL_FILE_SIZE_BYTES

  async function submit() {
    if (!file) return

    setBusy(true)
    setError(null)
    setOrphan(null)

    const form = new FormData()
    form.append('file', file, file.name)
    form.append('catalogId', catalogId)
    form.append('version', version)
    form.append('language', language)

    try {
      await uploadCatalogManual({ data: form })
      // Lo que quedó guardado lo sabe Postgres, no el cliente: el `created_at`,
      // el `size_bytes` sniffeado, el `id` generado. Recargar es preguntar;
      // agregar una fila optimista sería inventar un dato que puede no
      // coincidir con el que la base grabó.
      await router.invalidate()
      reset()
    } catch (cause) {
      setError(readableManualError(cause))
      // Si el PDF subió pero no se pudo atar, el id del archivo huérfano es lo
      // único que permite reintentar sin volver a transferirlo.
      setOrphan(orphanFileId(cause))
    } finally {
      setBusy(false)
    }
  }

  async function retry() {
    if (!orphan) return

    setBusy(true)
    setError(null)

    try {
      await retryLinkCatalogManual({
        data: { catalogId, fileId: orphan, version, language },
      })
      await router.invalidate()
      reset()
    } catch (cause) {
      setError(readableManualError(cause))
    } finally {
      setBusy(false)
    }
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
                setOrphan(null)
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
              El reintento aparece SÓLO cuando el PDF ya está en storage. Es la
              mitad recuperable de una falla en dos pasos: el archivo costó una
              transferencia entera y no hay `DELETE /files` para limpiarlo, así
              que reintentar el atado es más barato y deja una fila huérfana
              menos en el bucket.
            */}
            {orphan ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void retry()}
                className="mt-2 gap-1.5"
              >
                <RotateCcw className="size-3.5" aria-hidden />
                Reintentar sin volver a subir
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
