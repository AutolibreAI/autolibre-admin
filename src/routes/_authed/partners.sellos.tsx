import { Link, createFileRoute } from '@tanstack/react-router'
import { Upload } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getPartnerServicesView, listMarketplacePartners } from '~/fn/partners'
import { findPhoneMatchesFn } from '~/fn/partner-prospects'
import { MockBanner } from '~/components/MockBanner'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { SealStateBadge } from '~/components/PartnerSeals'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { formatDate, formatInt } from '~/lib/format'
import { normalizeArPhone, parseCsv } from '~/lib/partner-prospects'
import {
  MATCH_KEY_LABELS,
  SEAL_CSV_COLUMNS,
  SEAL_CSV_COLUMN_LABELS,
  SEAL_IMPORT_MAX,
  SEAL_KIND_LABELS,
  SEAL_ROW_VERDICT_LABELS,
  buildSealMatchIndex,
  detectSealCsvColumns,
  matchSealRow,
  sealState,
  todayBuenosAires,
  validateSealGrant,
} from '~/lib/partner-seals'
import { cn } from '~/lib/utils'
import {
  fetchAllPartnerSealsMock,
  fetchSealCatalogMock,
  importSealRowsMock,
} from '~/mocks/partner-seals'
import type {
  PartnerSeal,
  Seal,
  SealCsvColumn,
  SealCsvRow,
  SealMatchPartner,
  SealRowMatch,
  SealRowVerdict,
  StoredSealStatus,
} from '~/lib/partner-seals'

/**
 * Partners › Sellos: importar el listado de una red o aseguradora y cruzarlo
 * contra el directorio.
 *
 * El cruce es en el NAVEGADOR y con reglas fijas (`~/lib/partner-seals`):
 * teléfono normalizado como Comercial (contra la base, una llamada con todos
 * los números: `findPhoneMatchesFn`), CUIT (los proveedores no tienen: sin dato),
 * dirección normalizada (opcional: pide la ficha de cada proveedor) y nombre
 * exacto normalizado. Nunca "parecido". Sólo se preseleccionan las filas que
 * cruzan con UN proveedor; los conflictos los decide una persona.
 *
 * Asignar es de ejemplo (`~/mocks/partner-seals`): no se guarda nada.
 *
 * `ssr: 'data-only'`: el listado de proveedores viene del loader, pero los
 * sellos de ejemplo viven en la memoria del navegador; renderizarlos en el
 * servidor daría siempre una lista vacía distinta de la del cliente.
 */
export const Route = createFileRoute('/_authed/partners/sellos')({
  ssr: 'data-only',
  loader: async ({ abortController }) => {
    const partners = await listMarketplacePartners({ data: {}, signal: abortController.signal })
    return {
      partners: partners.map((p) => ({ id: p.id, name: p.name, status: p.status, tier: p.tier })),
    }
  },
  head: () => ({ meta: [{ title: 'Partners · Sellos — AutoLibre' }] }),
  component: PartnerSealsImport,
})

const FIELD_LABEL = 'block text-xs font-medium uppercase tracking-wider text-muted-foreground'
const NO_COLUMN = '__none__'
const ADDRESS_CONCURRENCY = 4

const VERDICT_CLASSES: Record<SealRowVerdict, string> = {
  match: 'border-status-green/30 bg-status-green-bg text-status-green',
  conflict: 'border-status-yellow/40 bg-status-yellow-bg text-status-yellow',
  ambiguous: 'border-status-yellow/40 bg-status-yellow-bg text-status-yellow',
  none: 'border-border bg-secondary text-muted-foreground',
}

function PartnerSealsImport() {
  const { partners } = Route.useLoaderData()
  const { user } = Route.useRouteContext()
  const partnerById = useMemo(() => new Map(partners.map((p) => [p.id, p])), [partners])
  const today = todayBuenosAires()

  const [catalog, setCatalog] = useState<ReadonlyArray<Seal>>([])
  const [assigned, setAssigned] = useState<Array<PartnerSeal>>([])
  useEffect(() => {
    void Promise.all([fetchSealCatalogMock(), fetchAllPartnerSealsMock()]).then(([c, a]) => {
      setCatalog(c)
      setAssigned(a)
    })
  }, [])

  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [table, setTable] = useState<Array<Array<string>> | null>(null)
  const [columns, setColumns] = useState<Record<SealCsvColumn, number | null> | null>(null)
  const [phoneById, setPhoneById] = useState<Map<string, string> | null>(null)
  const [phoneError, setPhoneError] = useState<string | null>(null)
  const [addressById, setAddressById] = useState<Map<string, string | null> | null>(null)
  const [addressProgress, setAddressProgress] = useState<number | null>(null)
  const [sealId, setSealId] = useState('')
  const [status, setStatus] = useState<Exclude<StoredSealStatus, 'revoked'>>('pending')
  const [source, setSource] = useState('')
  const [defaultExpiry, setDefaultExpiry] = useState('')
  /** Fila → proveedor elegido. Ausente = no se asigna. */
  const [chosen, setChosen] = useState<Map<number, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function loadFile(file: File) {
    setError(null)
    setDone(null)
    setChosen(new Map())
    setPhoneById(null)
    setPhoneError(null)
    setFileName(file.name)
    setSource((prev) => prev || `Listado ${file.name}`)
    const rows = parseCsv(await file.text())
    if (rows.length < 2) {
      setTable(null)
      setError('El archivo no tiene filas debajo del encabezado.')
      return
    }
    if (rows.length - 1 > SEAL_IMPORT_MAX) {
      setTable(null)
      setError(`El archivo tiene ${formatInt(rows.length - 1)} filas; el máximo es ${formatInt(SEAL_IMPORT_MAX)}. Partilo.`)
      return
    }
    const cols = detectSealCsvColumns(rows[0] ?? [])
    setTable(rows)
    setColumns(cols)
    await lookupPhones(rows, cols)
  }

  async function lookupPhones(rows: Array<Array<string>>, cols: Record<SealCsvColumn, number | null>) {
    setPhoneById(null)
    setPhoneError(null)
    if (cols.phone === null) {
      setPhoneById(new Map())
      return
    }
    const phones = [
      ...new Set(rows.slice(1).map((r) => normalizeArPhone(r[cols.phone ?? -1])).filter((d): d is string => d !== null)),
    ]
    try {
      const found = phones.length > 0 ? await findPhoneMatchesFn({ data: { phones } }) : { prospects: [], partners: [] }
      setPhoneById(new Map(found.partners.map((p) => [p.id, p.phoneDigits])))
    } catch {
      setPhoneById(new Map())
      setPhoneError('No se pudo cruzar por teléfono (la consulta de Comercial falló). El resto del cruce sigue.')
    }
  }

  /** Opt-in: la dirección no viene en el listado, se pide la ficha de cada uno. */
  async function loadAddresses() {
    setAddressProgress(0)
    const out = new Map<string, string | null>()
    const queue = [...partners]
    let doneCount = 0
    async function worker() {
      while (queue.length > 0) {
        const p = queue.shift()!
        try {
          const view = await getPartnerServicesView({ data: { partnerId: p.id } })
          out.set(p.id, view.partner.address)
        } catch {
          out.set(p.id, null)
        }
        doneCount += 1
        setAddressProgress(doneCount)
      }
    }
    await Promise.all(Array.from({ length: ADDRESS_CONCURRENCY }, worker))
    setAddressById(out)
    setAddressProgress(null)
  }

  const csvRows = useMemo<Array<SealCsvRow>>(() => {
    if (!table || !columns) return []
    const cell = (r: Array<string>, c: SealCsvColumn) => (columns[c] === null ? '' : (r[columns[c]!] ?? '').trim())
    return table.slice(1).map((r, i) => ({
      index: i + 2,
      name: cell(r, 'name'),
      phone: cell(r, 'phone'),
      cuit: cell(r, 'cuit'),
      address: cell(r, 'address'),
      expiresAt: cell(r, 'expiresAt'),
    }))
  }, [table, columns])

  const matches = useMemo<Array<SealRowMatch>>(() => {
    if (!phoneById) return []
    const matchPartners: Array<SealMatchPartner> = partners.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      phoneDigits: phoneById.get(p.id) ?? null,
      cuit: null,
      address: addressById?.get(p.id) ?? null,
    }))
    const index = buildSealMatchIndex(matchPartners)
    return csvRows.map((row) => matchSealRow(row, index))
  }, [csvRows, partners, phoneById, addressById])

  // Sólo lo inequívoco arranca tildado. Se recalcula al cambiar el cruce.
  useEffect(() => {
    const next = new Map<number, string>()
    for (const m of matches) if (m.verdict === 'match') next.set(m.row.index, m.candidates[0]!.partnerId)
    setChosen(next)
  }, [matches])

  const counts = useMemo(() => {
    const c: Record<SealRowVerdict, number> = { match: 0, conflict: 0, ambiguous: 0, none: 0 }
    for (const m of matches) c[m.verdict] += 1
    return c
  }, [matches])

  const seal = catalog.find((s) => s.id === sealId)

  /** Lo que viaja, ya validado fila por fila con la MISMA regla que la ficha. */
  const plan = useMemo(() => {
    const rows: Array<{ partnerId: string; expiresAt: string | null; rowIndex: number }> = []
    const problems: Array<string> = []
    const seen = new Set<string>()
    for (const m of matches) {
      const partnerId = chosen.get(m.row.index)
      if (!partnerId) continue
      if (seen.has(partnerId)) {
        problems.push(`Fila ${m.row.index}: ${partnerById.get(partnerId)?.name ?? 'el proveedor'} ya está elegido en otra fila.`)
        continue
      }
      seen.add(partnerId)
      const expiresAt = m.expiresAt ?? (defaultExpiry || null)
      const err = validateSealGrant(seal, { status, source, expiresAt: expiresAt ?? '' }, today)
      if (err) problems.push(`Fila ${m.row.index}: ${err}`)
      else rows.push({ partnerId, expiresAt, rowIndex: m.row.index })
    }
    return { rows, problems }
  }, [matches, chosen, seal, status, source, defaultExpiry, today, partnerById])

  async function confirm() {
    setError(null)
    if (!seal) {
      setError('Elegí el sello que da este listado.')
      return
    }
    if (plan.problems.length > 0) {
      setError('Corregí las filas marcadas antes de asignar.')
      return
    }
    const res = await importSealRowsMock(
      plan.rows.map((r) => ({ partnerId: r.partnerId, sealId: seal.id, status, source, expiresAt: r.expiresAt })),
      user.email,
    )
    setAssigned(await fetchAllPartnerSealsMock())
    setDone(`Se asignó «${seal.name}» a ${formatInt(res.granted)} proveedores (de ejemplo: no se guardó en la base).`)
    setChosen(new Map())
  }

  return (
    <>
      <PageHeader
        title="Sellos de proveedores"
        subtitle="Importar el listado de una red o aseguradora y cruzarlo con el directorio"
        actions={<SsrTag>ssr: data-only</SsrTag>}
      />

      <MockBanner
        items={[
          'El catálogo de sellos (redes y aseguradoras) es de ejemplo.',
          'Asignar no guarda nada en la base: lo asignado vive en esta pestaña y se pierde al recargar.',
          'Los proveedores y el cruce por teléfono son reales. El cruce por CUIT no tiene dato: partners.cuit no existe.',
        ]}
      />

      <Card className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">1 · Qué sello da este listado</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1">
            <label className={FIELD_LABEL}>Sello</label>
            <Select value={sealId} onValueChange={setSealId}>
              <SelectTrigger>
                <SelectValue placeholder="Elegí uno" />
              </SelectTrigger>
              <SelectContent>
                {catalog.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} · {SEAL_KIND_LABELS[s.kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className={FIELD_LABEL}>Estado al asignar</label>
            <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pendiente (falta validar)</SelectItem>
                <SelectItem value="verified">Verificado (el listado es oficial)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className={FIELD_LABEL} htmlFor="seal-import-source">
              Fuente
            </label>
            <Input id="seal-import-source" value={source} maxLength={200} onChange={(e) => setSource(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className={FIELD_LABEL} htmlFor="seal-import-expiry">
              Vence {seal?.requiresExpiry ? '(obligatorio)' : '(opcional)'}
            </label>
            <Input
              id="seal-import-expiry"
              type="date"
              value={defaultExpiry}
              onChange={(e) => setDefaultExpiry(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Para las filas que no traen fecha propia.</p>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">2 · El archivo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              <Upload className="size-4" aria-hidden />
              {fileName ? 'Elegir otro CSV' : 'Elegir CSV'}
            </Button>
            {fileName ? <span className="text-sm text-muted-foreground">{fileName}</span> : null}
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void loadFile(f)
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Columnas que se reconocen: nombre, teléfono, CUIT, dirección y vencimiento. Separador «,» o «;».
          </p>

          {table && columns ? (
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {SEAL_CSV_COLUMNS.map((col) => (
                <div key={col} className="space-y-1">
                  <label className={FIELD_LABEL} htmlFor={`seal-col-${col}`}>
                    {SEAL_CSV_COLUMN_LABELS[col]}
                  </label>
                  <Select
                    value={columns[col] === null ? NO_COLUMN : String(columns[col])}
                    onValueChange={(v) => {
                      const next = { ...columns, [col]: v === NO_COLUMN ? null : Number(v) }
                      setColumns(next)
                      if (col === 'phone') void lookupPhones(table, next)
                    }}
                  >
                    <SelectTrigger id={`seal-col-${col}`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_COLUMN}>— no está —</SelectItem>
                      {(table[0] ?? []).map((h, i) => (
                        <SelectItem key={i} value={String(i)}>
                          {h || `Columna ${i + 1}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          ) : null}

          {table && columns ? (
            <div className="space-y-1 text-xs text-muted-foreground">
              {columns.cuit !== null ? (
                <p>
                  CUIT: <span className="text-status-yellow">sin dato · falta backend</span> — los proveedores no
                  tienen CUIT cargado (<code>partners.cuit</code> no existe), así que esa columna no cruza con nadie.
                </p>
              ) : null}
              {columns.address !== null ? (
                addressById ? (
                  <p>Dirección: cruzando contra la dirección de la ficha de {formatInt(addressById.size)} proveedores.</p>
                ) : addressProgress !== null ? (
                  <p>
                    Pidiendo la dirección de cada proveedor… {formatInt(addressProgress)} de {formatInt(partners.length)}
                  </p>
                ) : (
                  <p className="flex flex-wrap items-center gap-2">
                    Dirección: el listado de proveedores no la trae.
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void loadAddresses()}>
                      Cruzar también por dirección ({formatInt(partners.length)} fichas)
                    </Button>
                  </p>
                )
              ) : null}
              {phoneError ? <p className="text-status-yellow">{phoneError}</p> : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {error ? (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {done ? <p className="mb-4 text-sm text-status-green">{done}</p> : null}

      {table && phoneById ? (
        <Card className="mb-4">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0 pb-3">
            <CardTitle className="text-base">3 · El cruce</CardTitle>
            <div className="flex flex-wrap gap-2 text-xs">
              {(Object.keys(counts) as Array<SealRowVerdict>).map((v) => (
                <span key={v} className={cn('rounded-md border px-2 py-0.5', VERDICT_CLASSES[v])}>
                  {SEAL_ROW_VERDICT_LABELS[v]}: {formatInt(counts[v])}
                </span>
              ))}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Arrancan tildadas sólo las filas que cruzan con un único proveedor. Cuando dos claves llevan a
              proveedores distintos, o una clave a varios, elegí a mano. No hay cruce por parecido.
            </p>
            <div className="max-h-[560px] overflow-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>Fila</TableHead>
                    <TableHead>En el listado</TableHead>
                    <TableHead>Cruce</TableHead>
                    <TableHead>Proveedor</TableHead>
                    <TableHead>Vence</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matches.map((m) => (
                    <MatchRow
                      key={m.row.index}
                      match={m}
                      chosen={chosen.get(m.row.index) ?? null}
                      partnerById={partnerById}
                      defaultExpiry={defaultExpiry || null}
                      onChoose={(id) =>
                        setChosen((prev) => {
                          const next = new Map(prev)
                          if (id === null) next.delete(m.row.index)
                          else next.set(m.row.index, id)
                          return next
                        })
                      }
                    />
                  ))}
                </TableBody>
              </Table>
            </div>

            {plan.problems.length > 0 ? (
              <ul className="space-y-0.5 text-xs text-destructive">
                {plan.problems.slice(0, 10).map((p) => (
                  <li key={p}>{p}</li>
                ))}
                {plan.problems.length > 10 ? <li>…y {plan.problems.length - 10} más.</li> : null}
              </ul>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={plan.rows.length === 0 || !seal} onClick={() => void confirm()}>
                Asignar a {formatInt(plan.rows.length)} proveedores
              </Button>
              {!seal ? <span className="text-xs text-muted-foreground">Falta elegir el sello (paso 1).</span> : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <AssignedList assigned={assigned} catalog={catalog} partnerById={partnerById} today={today} />
    </>
  )
}

function MatchRow({
  match,
  chosen,
  partnerById,
  defaultExpiry,
  onChoose,
}: {
  match: SealRowMatch
  chosen: string | null
  partnerById: Map<string, { id: string; name: string; status: string }>
  defaultExpiry: string | null
  onChoose: (partnerId: string | null) => void
}) {
  const { row, verdict, candidates, usableKeys } = match
  const expiry = match.expiresAt ?? defaultExpiry
  return (
    <TableRow>
      <TableCell>
        <Checkbox
          checked={chosen !== null}
          disabled={candidates.length === 0}
          aria-label={`Asignar fila ${row.index}`}
          onCheckedChange={(on) =>
            onChoose(on === true ? (chosen ?? (candidates.length === 1 ? candidates[0]!.partnerId : null)) : null)
          }
        />
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{row.index}</TableCell>
      <TableCell className="max-w-[260px] text-xs">
        <p className="font-medium text-foreground">{row.name || '— sin nombre —'}</p>
        {row.phone ? <p>{row.phone}</p> : null}
        {row.cuit ? <p>CUIT {row.cuit}</p> : null}
        {row.address ? <p className="truncate">{row.address}</p> : null}
        {usableKeys.length === 0 ? <p className="text-status-yellow">Ninguna clave legible para cruzar.</p> : null}
      </TableCell>
      <TableCell>
        <span className={cn('rounded-md border px-2 py-0.5 text-xs', VERDICT_CLASSES[verdict])}>
          {SEAL_ROW_VERDICT_LABELS[verdict]}
        </span>
      </TableCell>
      <TableCell className="text-xs">
        {candidates.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : candidates.length === 1 ? (
          <CandidateLabel c={candidates[0]!} partnerById={partnerById} />
        ) : (
          <div className="space-y-1">
            {candidates.map((c) => (
              <label key={c.partnerId} className="flex items-start gap-2">
                <input
                  type="radio"
                  name={`seal-row-${row.index}`}
                  className="mt-0.5"
                  checked={chosen === c.partnerId}
                  onChange={() => onChoose(c.partnerId)}
                />
                <CandidateLabel c={c} partnerById={partnerById} />
              </label>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell className="text-xs">
        {expiry ? formatDate(expiry) : row.expiresAt ? <span className="text-status-yellow">«{row.expiresAt}» no se entiende</span> : '—'}
      </TableCell>
    </TableRow>
  )
}

function CandidateLabel({
  c,
  partnerById,
}: {
  c: { partnerId: string; keys: Array<keyof typeof MATCH_KEY_LABELS> }
  partnerById: Map<string, { id: string; name: string; status: string }>
}) {
  const p = partnerById.get(c.partnerId)
  return (
    <span>
      <Link
        to="/partners/$partnerId"
        params={{ partnerId: c.partnerId }}
        className="font-medium text-foreground hover:underline"
      >
        {p?.name ?? c.partnerId}
      </Link>
      {p && p.status !== 'active' ? <span className="text-muted-foreground"> · {p.status}</span> : null}
      <span className="block text-muted-foreground">por {c.keys.map((k) => MATCH_KEY_LABELS[k].toLowerCase()).join(' y ')}</span>
    </span>
  )
}

function AssignedList({
  assigned,
  catalog,
  partnerById,
  today,
}: {
  assigned: ReadonlyArray<PartnerSeal>
  catalog: ReadonlyArray<Seal>
  partnerById: Map<string, { id: string; name: string }>
  today: string
}) {
  const sealName = new Map(catalog.map((s) => [s.id, s.name]))
  const live = assigned.filter((s) => s.status !== 'revoked')
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Sellos asignados en esta sesión ({formatInt(live.length)})</CardTitle>
      </CardHeader>
      <CardContent>
        {live.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Ninguno. Se asignan desde este importador o desde la ficha de cada proveedor.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Proveedor</TableHead>
                <TableHead>Sello</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Vence</TableHead>
                <TableHead>Fuente</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {live.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <Link to="/partners/$partnerId" params={{ partnerId: s.partnerId }} className="hover:underline">
                      {partnerById.get(s.partnerId)?.name ?? s.partnerId}
                    </Link>
                  </TableCell>
                  <TableCell>{sealName.get(s.sealId) ?? s.sealId}</TableCell>
                  <TableCell>
                    <SealStateBadge state={sealState(s, today)} />
                  </TableCell>
                  <TableCell className="text-xs">{s.expiresAt ? formatDate(s.expiresAt) : '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.source}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
