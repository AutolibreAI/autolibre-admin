import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Chip, FilterGroup } from '~/components/Filters'
import { MockBanner } from '~/components/MockBanner'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent } from '~/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Textarea } from '~/components/ui/textarea'
import {
  listDisputeResolutionsMock,
  listQuoteClosuresMock,
  listSentToProspectsMock,
  resolveDisputeMock,
  sendExternalToProspectsMock,
} from '~/mocks/quote-closures'
import { formatArs, formatDateTime } from '~/lib/format'
import {
  CLOSURE_CODES,
  CLOSURE_CODE_LABELS,
  DISPUTE_DECISIONS,
  DISPUTE_DECISION_LABELS,
  HIRED_WITH_LABELS,
  NEW_CLOSURE_CODES,
  PROVIDER_ANSWER_LABELS,
  WORK_STATUS_LABELS,
  validDisputeNote,
} from '~/lib/quote-closures'
import { quotePublicCode } from '~/lib/quote-requests'
import { cn } from '~/lib/utils'
import type { ClosureCode, DisputeDecision, DisputeResolution, QuoteClosure } from '~/lib/quote-closures'

/**
 * Cierres declarados y cola «En disputa».
 *
 * La disputa nace cuando el proveedor contesta "No reconozco" a un trabajo que
 * la persona declaró. El admin la resuelve: validar / corregir / descartar,
 * siempre con nota. Los proveedores externos que la persona declara van a
 * captación (Comercial) con origen "declarado por usuario".
 *
 * Nada de esto existe en el backend: la pantalla entera corre contra
 * `~/mocks/quote-closures`, con pedidos de ejemplo (AL-90xx) que no linkean a
 * nada. `ssr: false`: el estado es del mock en memoria del navegador.
 */
export const Route = createFileRoute('/_authed/leads/pedidos/cierres')({
  ssr: false,
  head: () => ({ meta: [{ title: 'Pedidos · Cierres y disputas — AutoLibre' }] }),
  component: ClosuresPage,
})

function ClosuresPage() {
  const [closures, setClosures] = useState<Array<QuoteClosure> | null>(null)
  const [resolutions, setResolutions] = useState<Map<string, DisputeResolution>>(new Map())
  const [sent, setSent] = useState<Set<string>>(new Set())
  const [codes, setCodes] = useState<Array<ClosureCode>>([])

  const reload = () => {
    void Promise.all([listQuoteClosuresMock(), listDisputeResolutionsMock(), listSentToProspectsMock()]).then(
      ([c, r, s]) => {
        setClosures(c)
        setResolutions(r)
        setSent(s)
      },
    )
  }
  useEffect(reload, [])

  if (closures === null) return <p className="text-sm text-muted-foreground">Cargando…</p>

  const disputes = closures.filter((c) => c.providerAnswer === 'not_recognized')
  const openDisputes = disputes.filter((c) => !resolutions.has(c.quoteRequestId))
  const externals = closures.filter((c) => c.hiredWith === 'external')
  const visible = codes.length === 0 ? closures : closures.filter((c) => codes.includes(c.closureCode))

  return (
    <>
      <Link
        to="/leads/pedidos"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Pedidos de presupuesto
      </Link>

      <PageHeader
        title="Cierres y disputas"
        subtitle={`${openDisputes.length} en disputa · ${closures.length} cierres declarados`}
        actions={<SsrTag>ssr: false</SsrTag>}
      />

      <MockBanner
        title="Toda esta pantalla es de ejemplo"
        items={[
          'Los pedidos AL-90xx no existen. Hoy la persona sólo declara «contraté / no contraté» y elige una propuesta; el resto espera al backend.',
          'Resolver una disputa o mandar un externo a Comercial no guarda nada: vive en memoria y se pierde al recargar.',
        ]}
      />

      <section className="mb-8">
        <h2 className="mb-3 font-heading text-lg font-semibold">En disputa</h2>
        {openDisputes.length === 0 ? (
          <Empty>No hay disputas abiertas.</Empty>
        ) : (
          <div className="space-y-3">
            {openDisputes.map((c) => (
              <DisputeCard
                key={c.quoteRequestId}
                closure={c}
                onResolved={() => reload()}
              />
            ))}
          </div>
        )}
        {disputes.length > openDisputes.length ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {disputes.length - openDisputes.length} resuelta(s) en esta sesión.
          </p>
        ) : null}
      </section>

      <section className="mb-8">
        <h2 className="mb-1 font-heading text-lg font-semibold">Proveedores externos declarados</h2>
        <p className="mb-3 max-w-3xl text-sm text-muted-foreground">
          Proveedores que no están en AutoLibre y que la persona dijo haber contratado. Van a{' '}
          <Link to="/comercial/contactos" className="underline underline-offset-2">
            Comercial › Contactos
          </Link>{' '}
          con origen «declarado por usuario», para salir a sumarlos.
        </p>
        {externals.length === 0 ? (
          <Empty>Nadie declaró un proveedor externo.</Empty>
        ) : (
          <ul className="space-y-2">
            {externals.map((c) => (
              <li
                key={c.quoteRequestId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm"
              >
                <span>
                  <span className="font-medium">{c.providerName}</span> · {c.externalProviderPhone ?? 'sin teléfono'} ·{' '}
                  <span className="text-muted-foreground">{quotePublicCode(c.publicNumber)}</span>
                </span>
                {sent.has(c.quoteRequestId) ? (
                  <Badge variant="outline" className="border-status-green/40 text-status-green">
                    En Comercial (de ejemplo)
                  </Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void sendExternalToProspectsMock(c.quoteRequestId).then(reload)}
                  >
                    Mandar a Comercial
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 font-heading text-lg font-semibold">Cierres declarados</h2>
        <div className="mb-4">
          <FilterGroup label="Código de cierre" onClear={codes.length > 0 ? () => setCodes([]) : undefined}>
            {CLOSURE_CODES.map((code) => (
              <Chip
                key={code}
                active={codes.includes(code)}
                onClick={() => setCodes((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]))}
              >
                {CLOSURE_CODE_LABELS[code]}
              </Chip>
            ))}
          </FilterGroup>
        </div>
        {visible.length === 0 ? (
          <Empty>Ningún cierre con ese código.</Empty>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Pedido</th>
                  <th className="px-4 py-2 font-medium">Declaró</th>
                  <th className="px-4 py-2 font-medium">Con quién</th>
                  <th className="px-4 py-2 text-right font-medium">Monto final</th>
                  <th className="px-4 py-2 font-medium">Estado del trabajo</th>
                  <th className="px-4 py-2 font-medium">Código</th>
                  <th className="px-4 py-2 font-medium">Motivo de «no contraté»</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <tr key={c.quoteRequestId} className="border-t border-border">
                    <td className="px-4 py-2 whitespace-nowrap">
                      {quotePublicCode(c.publicNumber)}
                      <span className="block text-xs text-muted-foreground">{formatDateTime(c.declaredAt)} UTC</span>
                    </td>
                    <td className="px-4 py-2">{c.hired ? 'Contraté' : 'No contraté'}</td>
                    <td className="px-4 py-2">
                      {c.hiredWith ? `${HIRED_WITH_LABELS[c.hiredWith]}: ${c.providerName ?? '—'}` : '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {c.finalAmount != null ? formatArs(c.finalAmount) : '—'}
                    </td>
                    <td className="px-4 py-2">
                      {WORK_STATUS_LABELS[c.workStatus]}
                      {resolutions.has(c.quoteRequestId) ? (
                        <span className="block text-xs text-muted-foreground">
                          {DISPUTE_DECISION_LABELS[resolutions.get(c.quoteRequestId)!.decision]}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2">
                      <span className={cn(NEW_CLOSURE_CODES.includes(c.closureCode) && 'font-medium')}>
                        {CLOSURE_CODE_LABELS[c.closureCode]}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{c.notHiredReason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

function DisputeCard({ closure: c, onResolved }: { closure: QuoteClosure; onResolved: () => void }) {
  const [decision, setDecision] = useState<DisputeDecision>('validate')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function resolve() {
    if (!validDisputeNote(note)) {
      setError('La nota es obligatoria: contá en un renglón qué se verificó.')
      return
    }
    await resolveDisputeMock(c.quoteRequestId, { decision, note: note.trim() })
    onResolved()
  }

  return (
    <Card>
      <CardContent className="grid gap-4 pt-6 md:grid-cols-3">
        <div className="space-y-1 text-sm">
          <p className="font-heading text-base font-semibold">{quotePublicCode(c.publicNumber)}</p>
          <p className="text-xs text-muted-foreground">Pedido de ejemplo</p>
        </div>
        <div className="space-y-2 text-sm">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">La persona declaró</p>
            <p>
              Contrató a <span className="font-medium">{c.providerName}</span>
              {c.hiredWith ? ` (${HIRED_WITH_LABELS[c.hiredWith].toLowerCase()})` : ''}
              {c.finalAmount != null ? ` por ${formatArs(c.finalAmount)}` : ''}.
            </p>
            <p className="text-xs text-muted-foreground">{formatDateTime(c.declaredAt)} UTC</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">El proveedor respondió</p>
            <p className="text-status-red">{c.providerAnswer ? PROVIDER_ANSWER_LABELS[c.providerAnswer] : '—'}</p>
            {c.providerAnswerNote ? <p className="text-muted-foreground">«{c.providerAnswerNote}»</p> : null}
          </div>
        </div>
        <div className="space-y-2">
          <Select value={decision} onValueChange={(v) => setDecision(v as DisputeDecision)}>
            <SelectTrigger className="w-full" aria-label="Decisión">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DISPUTE_DECISIONS.map((d) => (
                <SelectItem key={d} value={d}>
                  {DISPUTE_DECISION_LABELS[d]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea
            rows={2}
            maxLength={500}
            value={note}
            onChange={(e) => {
              setNote(e.target.value)
              setError(null)
            }}
            placeholder="Nota obligatoria: qué se verificó y con quién"
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <Button size="sm" onClick={() => void resolve()}>
            Resolver (de ejemplo)
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card py-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
