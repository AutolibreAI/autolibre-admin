import { useMemo, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Upload } from 'lucide-react'
import {
  CSV_COLUMNS,
  CSV_COLUMN_LABELS,
  PROSPECT_IMPORT_MAX,
  detectCsvColumns,
  matchCategory,
  normalizeArPhone,
  parseCsv,
  readableProspectError,
} from '~/lib/partner-prospects'
import { findPhoneMatchesFn, importProspectsFn } from '~/fn/partner-prospects'
import { OriginPicker, OwnerPicker } from '~/components/ProspectComposer'
import { MultiSelect } from '~/components/MultiSelect'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '~/components/ui/sheet'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { cn } from '~/lib/utils'
import { formatInt } from '~/lib/format'
import type { CsvColumn, ImportResult, PhoneMatches, ProspectFacets, ProspectOrigin } from '~/lib/partner-prospects'

const FIELD_LABEL = 'block text-xs font-medium uppercase tracking-wider text-muted-foreground'
const NO_COLUMN = '__none__'
const PREVIEW_ROWS = 200

type RowVerdict =
  | 'ok'
  | 'no_phone'
  | 'is_partner'
  | 'dup_db'
  | 'dup_file'
  | 'no_name'

const VERDICT_LABELS: Record<RowVerdict, string> = {
  ok: 'Nuevo',
  no_phone: 'Sin celular reconocible',
  is_partner: 'Ya es proveedor',
  dup_db: 'Ya está cargado',
  dup_file: 'Repetido en el archivo',
  no_name: 'Sin nombre',
}

/** Los que no se pueden importar: la base los rechazaría o no hay qué guardar. */
const BLOCKED: ReadonlyArray<RowVerdict> = ['dup_db', 'dup_file', 'no_name']

interface PreviewRow {
  index: number
  name: string
  phone: string
  digits: string | null
  locality: string
  shortNote: string
  rubroRaw: string
  rubroSlug: string | null
  verdict: RowVerdict
  detail: string | null
}

/**
 * Importar contactos desde un CSV (las bases scrapeadas de Toby).
 *
 * Todo se arma en el NAVEGADOR: el archivo se lee, se parsea y se cruza contra
 * la base (una sola llamada con los teléfonos) antes de mandar nada. Lo que
 * viaja al servidor son filas ya elegidas, no el archivo.
 *
 * Los duplicados se detectan dos veces y no es redundancia: la vista previa
 * para mostrarlos y excluirlos, y el SP (índice único) por si alguien cargó el
 * mismo número entre la vista previa y la confirmación — ahí se saltea y se
 * cuenta, no rompe la tanda.
 */
export function ProspectImporter({ facets, currentUserId }: { facets: ProspectFacets; currentUserId: string }) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [origins, setOrigins] = useState<ReadonlyArray<ProspectOrigin>>(facets.origins)
  const [fileName, setFileName] = useState<string | null>(null)
  const [table, setTable] = useState<Array<Array<string>> | null>(null)
  const [columns, setColumns] = useState<Record<CsvColumn, number | null> | null>(null)
  const [matches, setMatches] = useState<PhoneMatches | null>(null)
  const [originSlug, setOriginSlug] = useState('')
  const [ownerId, setOwnerId] = useState<string | null>(currentUserId)
  const [batchCategories, setBatchCategories] = useState<Array<string>>([])
  const [unchecked, setUnchecked] = useState<Set<number>>(new Set())
  const [checkedPartners, setCheckedPartners] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)

  function reset() {
    setFileName(null)
    setTable(null)
    setColumns(null)
    setMatches(null)
    setOriginSlug('')
    setOwnerId(currentUserId)
    setBatchCategories([])
    setUnchecked(new Set())
    setCheckedPartners(new Set())
    setError(null)
    setResult(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function loadFile(file: File) {
    reset()
    setFileName(file.name)
    const rows = parseCsv(await file.text())
    if (rows.length < 2) {
      setError('El archivo no tiene filas debajo del encabezado.')
      return
    }
    if (rows.length - 1 > PROSPECT_IMPORT_MAX) {
      setError(`El archivo tiene ${formatInt(rows.length - 1)} filas; el máximo por importación es ${formatInt(PROSPECT_IMPORT_MAX)}. Partilo.`)
      return
    }
    const detected = detectCsvColumns(rows[0] ?? [])
    setTable(rows)
    setColumns(detected)
    await lookupPhones(rows, detected)
  }

  async function lookupPhones(rows: Array<Array<string>>, cols: Record<CsvColumn, number | null>) {
    setMatches(null)
    if (cols.phone === null) {
      setMatches({ prospects: [], partners: [] })
      return
    }
    const phones = [...new Set(rows.slice(1).map((r) => normalizeArPhone(r[cols.phone ?? -1])).filter((d): d is string => d !== null))]
    try {
      setMatches(phones.length > 0 ? await findPhoneMatchesFn({ data: { phones } }) : { prospects: [], partners: [] })
    } catch (cause) {
      setError(readableProspectError(cause))
    }
  }

  const preview = useMemo<Array<PreviewRow>>(() => {
    if (!table || !columns || !matches) return []
    const prospectByDigits = new Map(matches.prospects.map((m) => [m.phoneDigits, m.name]))
    const partnerByDigits = new Map(matches.partners.map((m) => [m.phoneDigits, m.name]))
    const seen = new Map<string, number>()
    const cell = (r: Array<string>, c: CsvColumn) => (columns[c] === null ? '' : (r[columns[c] ?? -1] ?? '').trim())

    return table.slice(1).map((r, index) => {
      const name = cell(r, 'name')
      const phone = cell(r, 'phone')
      const digits = normalizeArPhone(phone)
      const rubroRaw = cell(r, 'rubro')
      const rubroSlug = rubroRaw === '' ? null : matchCategory(rubroRaw, facets.categories)
      let verdict: RowVerdict = 'ok'
      let detail: string | null = null
      if (name === '') verdict = 'no_name'
      else if (digits && prospectByDigits.has(digits)) {
        verdict = 'dup_db'
        detail = prospectByDigits.get(digits) ?? null
      } else if (digits && seen.has(digits)) {
        verdict = 'dup_file'
        detail = `igual a la fila ${(seen.get(digits) ?? 0) + 2}`
      } else if (digits && partnerByDigits.has(digits)) {
        verdict = 'is_partner'
        detail = partnerByDigits.get(digits) ?? null
      } else if (!digits) verdict = 'no_phone'
      if (digits && !seen.has(digits) && verdict !== 'no_name') seen.set(digits, index)
      return {
        index,
        name,
        phone,
        digits,
        locality: cell(r, 'locality'),
        shortNote: cell(r, 'shortNote'),
        rubroRaw,
        rubroSlug,
        verdict,
        detail,
      }
    })
  }, [table, columns, matches, facets.categories])

  /** Ya es proveedor arranca destildado: no hace falta salir a buscarlo. */
  const isSelected = (row: PreviewRow) =>
    !BLOCKED.includes(row.verdict) &&
    (row.verdict === 'is_partner' ? checkedPartners.has(row.index) : !unchecked.has(row.index))

  const selected = preview.filter(isSelected)
  const counts = preview.reduce<Record<RowVerdict, number>>(
    (acc, r) => ({ ...acc, [r.verdict]: acc[r.verdict] + 1 }),
    { ok: 0, no_phone: 0, is_partner: 0, dup_db: 0, dup_file: 0, no_name: 0 },
  )
  const unmatchedRubros = [...new Set(preview.filter((r) => r.rubroRaw !== '' && !r.rubroSlug).map((r) => r.rubroRaw))]

  function toggle(row: PreviewRow) {
    const flip = (set: Set<number>) => {
      const next = new Set(set)
      if (next.has(row.index)) next.delete(row.index)
      else next.add(row.index)
      return next
    }
    if (row.verdict === 'is_partner') setCheckedPartners(flip)
    else setUnchecked(flip)
  }

  async function submit() {
    if (busy || selected.length === 0 || originSlug === '') return
    setBusy(true)
    setError(null)
    try {
      const res = await importProspectsFn({
        data: {
          rows: selected.map((r) => ({
            name: r.name,
            phone: r.phone,
            locality: r.locality,
            shortNote: r.shortNote,
            originSlug,
            ownerId,
            categorySlugs: r.rubroSlug ? [r.rubroSlug] : batchCategories,
          })),
        },
      })
      setResult(res)
      setTable(null)
      void router.invalidate()
    } catch (cause) {
      setError(readableProspectError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <SheetTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5 shadow-none">
          <Upload className="size-3.5" aria-hidden /> Importar CSV
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full max-w-full bg-card sm:w-[48rem]">
        <div className="flex h-full min-h-0 flex-col">
          <div className="border-b border-border px-5 py-4 pr-10">
            <SheetTitle>Importar contactos desde un CSV</SheetTitle>
            <SheetDescription className="mt-0.5 leading-relaxed">
              Encabezado en la primera fila. Se reconocen columnas de nombre, teléfono, localidad, rubro y nota
              (separador coma o punto y coma). Nada se guarda hasta confirmar.
            </SheetDescription>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {result ? (
              <div className="rounded-md border border-status-green/30 bg-status-green-bg px-4 py-3 text-sm text-status-green" role="status">
                Se importaron <strong>{formatInt(result.created)}</strong> contactos.
                {result.skipped.length > 0
                  ? ` ${formatInt(result.skipped.length)} se saltearon porque alguien cargó el mismo teléfono mientras tanto.`
                  : ''}
              </div>
            ) : null}

            <div className="space-y-1">
              <label htmlFor="pi-file" className={FIELD_LABEL}>Archivo</label>
              <input
                ref={fileRef}
                id="pi-file"
                type="file"
                accept=".csv,text/csv"
                className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void loadFile(file)
                }}
              />
              {fileName && table ? (
                <p className="text-xs text-muted-foreground">
                  {fileName}: {formatInt(table.length - 1)} filas
                </p>
              ) : null}
            </div>

            {table && columns ? (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  {CSV_COLUMNS.map((col) => (
                    <div key={col} className="space-y-1">
                      <label htmlFor={`pi-col-${col}`} className={FIELD_LABEL}>
                        {CSV_COLUMN_LABELS[col]}
                      </label>
                      <Select
                        value={columns[col] === null ? NO_COLUMN : String(columns[col])}
                        onValueChange={(v) => {
                          const next = { ...columns, [col]: v === NO_COLUMN ? null : Number(v) }
                          setColumns(next)
                          if (col === 'phone') void lookupPhones(table, next)
                        }}
                      >
                        <SelectTrigger id={`pi-col-${col}`} className="w-full shadow-none">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_COLUMN}>— no está —</SelectItem>
                          {(table[0] ?? []).map((h, i) => (
                            <SelectItem key={i} value={String(i)}>
                              {h.trim() === '' ? `Columna ${i + 1}` : h}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1">
                    <label htmlFor="pi-origin" className={FIELD_LABEL}>Origen de la tanda *</label>
                    <OriginPicker
                      id="pi-origin"
                      origins={origins}
                      value={originSlug}
                      onChange={(slug, created) => {
                        if (created) {
                          setOrigins((prev) => (prev.some((o) => o.slug === created.slug) ? prev : [...prev, created]))
                          void router.invalidate()
                        }
                        setOriginSlug(slug)
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="pi-owner" className={FIELD_LABEL}>Comercial</label>
                    <OwnerPicker id="pi-owner" facets={facets} value={ownerId} onChange={setOwnerId} />
                  </div>
                  <div className="space-y-1">
                    <span className={FIELD_LABEL}>Rubros (si la fila no trae)</span>
                    <MultiSelect
                      label="Rubros de la tanda"
                      options={facets.categories.map((c) => ({ value: c.slug, label: c.name }))}
                      selected={batchCategories}
                      onChange={setBatchCategories}
                      placeholder="Sin rubro"
                      className="w-full"
                    />
                  </div>
                </div>

                {columns.name === null ? (
                  <p className="text-sm text-status-red">Elegí qué columna es el nombre.</p>
                ) : null}

                {!matches ? (
                  <p className="text-sm text-muted-foreground">Buscando duplicados…</p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {(Object.keys(counts) as Array<RowVerdict>)
                        .filter((v) => counts[v] > 0)
                        .map((v) => (
                          <span key={v} className={cn('rounded-md border px-2 py-0.5', verdictClass(v))}>
                            {VERDICT_LABELS[v]}: {formatInt(counts[v])}
                          </span>
                        ))}
                    </div>
                    {unmatchedRubros.length > 0 ? (
                      <p className="text-xs text-status-yellow">
                        Rubros que no son del marketplace (se ignoran): {unmatchedRubros.slice(0, 8).join(', ')}
                        {unmatchedRubros.length > 8 ? '…' : ''}
                      </p>
                    ) : null}

                    <div className="overflow-x-auto rounded-md border border-border">
                      <table className="w-full text-sm">
                        <thead className="bg-surface-2 text-left text-xs uppercase tracking-wider text-muted-foreground">
                          <tr>
                            <th className="w-8 px-2 py-2" />
                            <th className="px-2 py-2">Nombre</th>
                            <th className="px-2 py-2">Teléfono</th>
                            <th className="px-2 py-2">Localidad</th>
                            <th className="px-2 py-2">Rubro</th>
                            <th className="px-2 py-2">Estado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.slice(0, PREVIEW_ROWS).map((row) => {
                            const blocked = BLOCKED.includes(row.verdict)
                            return (
                              <tr key={row.index} className={cn('border-t border-border', blocked && 'text-muted-foreground')}>
                                <td className="px-2 py-1.5">
                                  <Checkbox
                                    aria-label={`Importar ${row.name || `fila ${row.index + 2}`}`}
                                    checked={isSelected(row)}
                                    disabled={blocked}
                                    onCheckedChange={() => toggle(row)}
                                  />
                                </td>
                                <td className="px-2 py-1.5">{row.name || '—'}</td>
                                <td className="px-2 py-1.5 tabular-nums">{row.phone || '—'}</td>
                                <td className="px-2 py-1.5">{row.locality || '—'}</td>
                                <td className="px-2 py-1.5">
                                  {row.rubroRaw === ''
                                    ? '—'
                                    : row.rubroSlug
                                      ? (facets.categories.find((c) => c.slug === row.rubroSlug)?.name ?? row.rubroSlug)
                                      : <span className="text-status-yellow">{row.rubroRaw} (no reconocido)</span>}
                                </td>
                                <td className="px-2 py-1.5">
                                  <span className={cn('rounded-md border px-1.5 py-0.5 text-xs', verdictClass(row.verdict))}>
                                    {VERDICT_LABELS[row.verdict]}
                                  </span>
                                  {row.detail ? <span className="ml-1 text-xs text-muted-foreground">{row.detail}</span> : null}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    {preview.length > PREVIEW_ROWS ? (
                      <p className="text-xs text-muted-foreground">
                        Se muestran las primeras {formatInt(PREVIEW_ROWS)} filas; la importación usa todas las tildadas.
                      </p>
                    ) : null}
                  </>
                )}
              </>
            ) : null}
          </div>

          <div className="space-y-2 border-t border-border px-5 py-4">
            {error ? <p className="text-sm text-status-red" role="alert">{error}</p> : null}
            {table ? (
              <Button
                className="w-full"
                disabled={busy || selected.length === 0 || originSlug === '' || columns?.name === null || !matches}
                onClick={() => void submit()}
              >
                {busy
                  ? 'Importando…'
                  : originSlug === ''
                    ? 'Elegí el origen de la tanda'
                    : `Importar ${formatInt(selected.length)} contactos`}
              </Button>
            ) : null}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function verdictClass(v: RowVerdict): string {
  switch (v) {
    case 'ok':
      return 'border-status-green/30 bg-status-green-bg text-status-green'
    case 'no_phone':
    case 'is_partner':
      return 'border-status-yellow/30 bg-status-yellow-bg text-status-yellow'
    case 'dup_db':
    case 'dup_file':
    case 'no_name':
      return 'border-border bg-surface-2 text-muted-foreground'
  }
}
