import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { ArrowLeft, FileText } from 'lucide-react'
import {
  DOC_FIELDS,
  DOC_STATUS_LABELS,
  DOC_TYPE_LABELS,
  DOC_TYPES,
  crossCheck,
  expiryState,
  isMismatch,
  type DocType,
  type DocumentDetail,
} from '~/lib/documents'
import { getAppDocument } from '~/fn/documents'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Badge } from '~/components/ui/badge'
import { formatBytes, formatDate, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { ReactNode } from 'react'

const isDocType = (v: string): v is DocType => (DOC_TYPES as ReadonlyArray<string>).includes(v)

export const Route = createFileRoute('/_authed/documentos/$docType/$docId')({
  loader: async ({ params, abortController }) => {
    if (!isDocType(params.docType)) throw notFound()

    const doc = await getAppDocument({
      data: { docType: params.docType, docId: params.docId },
      signal: abortController.signal,
    }).catch((cause: unknown) => {
      if (cause instanceof Error && cause.message.startsWith('NOT_FOUND:')) return null
      throw cause
    })

    if (!doc) throw notFound()
    return doc
  },

  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `${primaryLabel(loaderData) ?? DOC_TYPE_LABELS[loaderData.docType]} — Documentos`
          : 'Documento',
      },
    ],
  }),

  component: DocumentDetailScreen,
})

/** El `primaryLabel` no viaja en el detalle — se deriva del tipo, igual que en el listado. */
function primaryLabel(d: DocumentDetail): string | null {
  switch (d.docType) {
    case 'seguro':
      return d.insurer
    case 'cedula':
      return d.holderName
    case 'registro':
      return [d.firstName, d.lastName].filter(Boolean).join(' ') || null
    case 'vtv':
      return d.facility
  }
}

function DocumentDetailScreen() {
  const d = Route.useLoaderData()
  const label = primaryLabel(d)
  const checks = crossCheck(d)

  return (
    <>
      <Link
        to="/documentos"
        className="mb-3 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Documentos
      </Link>

      <PageHeader
        title={label ?? DOC_TYPE_LABELS[d.docType]}
        subtitle={`${DOC_TYPE_LABELS[d.docType]} · ${d.userName ?? d.userEmail}${d.archived ? ' · archivado' : ''}`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <OcrCard doc={d} />
          {checks.length > 0 ? <CrossCheckCard doc={d} /> : null}
        </div>

        <div className="space-y-4">
          <FileCard doc={d} />
          <OriginCard doc={d} />
        </div>
      </div>
    </>
  )
}

// ── Lo que extrajo el OCR ────────────────────────────────────────────────────

function OcrCard({ doc: d }: { doc: DocumentDetail }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Lo que extrajo el OCR</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {DOC_FIELDS[d.docType].map(({ key, label }) => {
            const raw = d[key] as string | null
            const value = renderFieldValue(key, raw)
            return (
              <div key={key} className="min-w-0">
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {label}
                </dt>
                <dd className="mt-0.5 text-sm">
                  {value ?? <span className="text-status-yellow">sin extraer</span>}
                </dd>
              </div>
            )
          })}
        </dl>
      </CardContent>
    </Card>
  )
}

/** Fechas se formatean; `status` se traduce; el resto va crudo (es lo que hay que revisar). */
function renderFieldValue(key: string, raw: string | null): ReactNode {
  if (raw === null || raw.trim() === '') return null
  if (key === 'issueDate' || key === 'expirationDate') return formatDate(raw)
  if (key === 'status') return DOC_STATUS_LABELS[raw] ?? raw
  if (key === 'plate' || key === 'vin') {
    return <span className="font-mono tracking-wide">{raw}</span>
  }
  return raw
}

// ── Contraste con el vehículo ────────────────────────────────────────────────

function CrossCheckCard({ doc: d }: { doc: DocumentDetail }) {
  const rows = crossCheck(d)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Contraste con el vehículo</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <th className="py-1.5 pr-4 text-left font-medium">Campo</th>
                <th className="px-4 py-1.5 text-left font-medium">Del documento (OCR)</th>
                <th className="px-4 py-1.5 text-left font-medium">Del vehículo</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const bad = isMismatch(r)
                return (
                  <tr key={r.label} className="border-b border-border/50 last:border-b-0">
                    <td className="py-2 pr-4 text-muted-foreground">{r.label}</td>
                    <td className={cn('px-4 py-2 font-mono tracking-wide', bad && 'text-status-yellow')}>
                      {r.ocr ?? <span className="font-sans text-muted-foreground/50">—</span>}
                    </td>
                    <td className="px-4 py-2 font-mono tracking-wide text-muted-foreground">
                      {r.real ?? <span className="font-sans text-muted-foreground/50">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Un valor en ámbar contradice al vehículo cargado — probablemente un
          error de OCR. Un guión es un campo que el OCR no sacó.
        </p>
      </CardContent>
    </Card>
  )
}

// ── Archivo original ────────────────────────────────────────────────────────

function FileCard({ doc: d }: { doc: DocumentDetail }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Archivo original</CardTitle>
      </CardHeader>
      <CardContent>
        {d.fileId ? (
          <>
            <dl className="space-y-2 text-sm">
              <Row label="Tipo">{fileKind(d.fileMimeType)}</Row>
              <Row label="Tamaño">
                {d.fileSizeBytes !== null ? formatBytes(d.fileSizeBytes) : '—'}
              </Row>
              <Row label="Subido">
                {d.fileUploadedAt ? formatDate(d.fileUploadedAt) : '—'}
              </Row>
              <Row label="Por">{d.uploaderEmail ?? '—'}</Row>
            </dl>
            <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-secondary/50 p-2.5 text-xs leading-relaxed text-muted-foreground">
              <FileText className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                El backend sólo firma un archivo para quien lo subió, así que el
                panel todavía no puede mostrar la imagen. Se agrega cuando haya
                acceso de admin a archivos.
              </span>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Sin archivo. Este documento no debería estar en esta lista — todos los
            que lista `/documentos` tienen un archivo subido.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function fileKind(mime: string | null): string {
  if (!mime) return 'archivo'
  if (mime === 'application/pdf') return 'PDF'
  if (mime.startsWith('image/')) return `Imagen (${mime.slice(6).toUpperCase()})`
  return mime
}

// ── Origen ──────────────────────────────────────────────────────────────────

function OriginCard({ doc: d }: { doc: DocumentDetail }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Origen</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-2 text-sm">
          <Row label="Usuario">
            <Link
              to="/usuarios/$userId"
              params={{ userId: d.userId }}
              className="rounded outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {d.userName ?? d.userEmail}
            </Link>
          </Row>
          {d.vehiclePlate ? (
            <Row label="Vehículo">
              <span className="font-mono tracking-wide">{d.vehiclePlate}</span>
              {d.vehicleBrand ? (
                <span className="text-muted-foreground">
                  {' '}
                  {d.vehicleBrand} {d.vehicleModel}
                  {d.vehicleYear ? ` ${formatInt(d.vehicleYear)}` : ''}
                </span>
              ) : null}
            </Row>
          ) : null}
          <Row label="Cargado">{formatDate(d.createdAt)}</Row>
          <Row label="Última modificación">{formatDate(d.updatedAt)}</Row>
          {d.archived ? (
            <Row label="Estado">
              <Badge variant="outline" className="border-border bg-secondary text-muted-foreground">
                Archivado
              </Badge>
            </Row>
          ) : null}
          {d.daysUntilExpiration !== null ? (
            <Row label="Vencimiento">
              <span
                className={cn(
                  expiryState(d.daysUntilExpiration) !== 'vigente' && 'text-status-yellow',
                )}
              >
                {d.expirationDate ? formatDate(d.expirationDate) : '—'}
              </span>
            </Row>
          ) : null}
        </dl>
      </CardContent>
    </Card>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  )
}
