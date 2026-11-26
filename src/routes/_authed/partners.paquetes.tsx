import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { Download } from 'lucide-react'
import { getPackagesViewFn } from '~/fn/partner-fees'
import { listMarketplacePartners } from '~/fn/partners'
import { Chip, FilterGroup } from '~/components/Filters'
import { PackageComposer, PackageLine } from '~/components/PartnerPackages'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { toCsv } from '~/lib/csv'
import { formatArs, formatInt } from '~/lib/format'
import { feeDay, paymentMethodLabel } from '~/lib/partner-fees'
import { PARTNER_FEE_CONFIG } from '~/lib/partner-fees-config'
import {
  PACKAGE_CSV_HEADER,
  PACKAGE_STATUSES,
  PACKAGE_STATUS_LABELS,
  packageCsvRows,
} from '~/lib/partner-packages'

/**
 * Partners › Paquetes (`/partners/paquetes`) — todos los paquetes de trabajos
 * (044) con estado, saldo, vencimiento y monto, y el CSV para el registro de
 * caja. Arriba, los que vencen en `PAQUETE_POR_VENCER_DIAS` días o menos, para
 * ofrecer la renovación. → `.claude/rules/partner-fees.md`, «Paquetes».
 *
 * El uso de cada paquete sale de la MISMA regla que Liquidaciones
 * (`getPackagesViewFn`): imputados guardados + los que propone la regla.
 *
 * SSR completo: pocas filas y "hoy" lo calcula el servidor (Buenos Aires).
 */
const searchSchema = z.object({
  packageStatus: z.enum(['all', ...PACKAGE_STATUSES]).catch('all').default('all'),
  /** uuid de partner (llega desde Liquidaciones, «ver paquete»). */
  packagePartner: z.string().uuid().optional().catch(undefined),
})

export const Route = createFileRoute('/_authed/partners/paquetes')({
  validateSearch: searchSchema,
  loader: async ({ abortController }) => {
    const signal = abortController.signal
    const [view, partners] = await Promise.all([
      getPackagesViewFn({ signal }).catch(() => ({ available: false as const })),
      listMarketplacePartners({ data: {}, signal }),
    ])
    return { view, partners: partners.map((p) => ({ id: p.id, name: p.name, status: p.status })) }
  },
  head: () => ({ meta: [{ title: 'Partners · Paquetes — AutoLibre' }] }),
  component: Packages,
})

function Packages() {
  const { view, partners } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })
  const [newFor, setNewFor] = useState('')

  if (!view.available) {
    return (
      <>
        <PageHeader title="Paquetes de trabajos" actions={<SsrTag>ssr: full</SsrTag>} />
        <Card className="shadow-none">
          <CardContent className="py-6 text-sm">
            Falta aplicar la migración <code>044_ops_paquetes_de_trabajos.sql</code> (y la 038, liquidaciones) en esta
            base. La aplica el deploy de producción; en DEV, <code>pnpm db:migrate</code>.
          </CardContent>
        </Card>
      </>
    )
  }

  const byPartner = search.packagePartner ? view.rows.filter((r) => r.partnerId === search.packagePartner) : view.rows
  const rows = byPartner.filter((r) => search.packageStatus === 'all' || r.status === search.packageStatus)
  const expiring = view.rows.filter((r) => r.expiringSoon).sort((a, b) => a.daysLeft - b.daysLeft)
  const counts = Object.fromEntries(PACKAGE_STATUSES.map((s) => [s, byPartner.filter((r) => r.status === s).length]))
  const paidTotal = view.rows.filter((r) => r.status !== 'anulado').reduce((s, r) => s + r.pricePaid, 0)
  const filterPartner = search.packagePartner ? partners.find((p) => p.id === search.packagePartner) : null

  const downloadCsv = () => {
    const csv = toCsv(PACKAGE_CSV_HEADER, packageCsvRows(rows, paymentMethodLabel, feeDay))
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `paquetes-${view.today}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <PageHeader
        title="Paquetes de trabajos"
        subtitle={`${formatInt(view.rows.length)} paquetes · ${formatArs(paidTotal)} cobrados (sin anulados) · por defecto ${PARTNER_FEE_CONFIG.PAQUETE_TRABAJOS} trabajos y ${PARTNER_FEE_CONFIG.PAQUETE_VIGENCIA_DIAS} días`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <Card className="mb-4 shadow-none">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Por vencer en {PARTNER_FEE_CONFIG.PAQUETE_POR_VENCER_DIAS} días o menos ({expiring.length}) — ofrecer la
            renovación
          </CardTitle>
        </CardHeader>
        <CardContent>
          {expiring.length === 0 ? (
            <p className="text-sm text-muted-foreground">Ningún paquete vigente con saldo vence pronto.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {expiring.map((r) => (
                <PackageLine key={r.id} row={r} showPartner />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="mb-4 flex flex-wrap items-end gap-5">
        <FilterGroup label="Estado">
          <Chip active={search.packageStatus === 'all'} onClick={() => setSearch({ packageStatus: 'all' })}>
            Todos ({byPartner.length})
          </Chip>
          {PACKAGE_STATUSES.map((s) => (
            <Chip key={s} active={search.packageStatus === s} onClick={() => setSearch({ packageStatus: s })}>
              {PACKAGE_STATUS_LABELS[s]} ({counts[s] ?? 0})
            </Chip>
          ))}
        </FilterGroup>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Proveedor</span>
          <select
            value={search.packagePartner ?? ''}
            onChange={(e) => setSearch({ packagePartner: e.target.value || undefined })}
            className="h-9 rounded-md border border-input bg-surface px-2 text-sm"
          >
            <option value="">Todos</option>
            {partners
              .filter((p) => view.rows.some((r) => r.partnerId === p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <Button variant="outline" size="sm" onClick={downloadCsv} disabled={rows.length === 0}>
          <Download className="size-3.5" aria-hidden />
          CSV para la caja
        </Button>
      </div>

      <details className="mb-4 rounded-md border border-border bg-card p-3 text-sm">
        <summary className="cursor-pointer font-medium">Cargar un paquete</summary>
        <div className="mt-2 space-y-2">
          <select
            value={newFor}
            onChange={(e) => setNewFor(e.target.value)}
            className="h-9 rounded-md border border-input bg-surface px-2 text-sm"
          >
            <option value="">Elegí el proveedor…</option>
            {partners
              .filter((p) => p.status !== 'archived')
              .sort((a, b) => a.name.localeCompare(b.name, 'es'))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          {newFor ? (
            <PackageComposer
              key={newFor}
              partnerId={newFor}
              partnerName={partners.find((p) => p.id === newFor)?.name}
              today={view.today}
              onDone={() => setNewFor('')}
            />
          ) : null}
        </div>
      </details>

      {filterPartner ? (
        <p className="mb-2 text-sm text-muted-foreground">Mostrando los paquetes de {filterPartner.name}.</p>
      ) : null}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card py-12 text-center text-sm text-muted-foreground">
          No hay paquetes con este filtro.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-card">
          {rows.map((r) => (
            <PackageLine key={r.id} row={r} showPartner />
          ))}
        </ul>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Saldo = trabajos − imputados (los guardados y los que propone la regla de Liquidaciones). Un paquete vencido con
        saldo queda «Vencido con X sin usar»: el saldo no se traslada. Un paquete no se borra: se anula con motivo, y sólo
        si no tiene trabajos imputados.
      </p>
    </>
  )
}
