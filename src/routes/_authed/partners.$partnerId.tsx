import { useMemo, useState } from 'react'
import { Link, createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { ArrowLeft, EyeOff, Lightbulb } from 'lucide-react'
import { editPartnerServicesFn, getPartnerServicesView } from '~/fn/partners'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { cn } from '~/lib/utils'
import type { PartnerServicesView, ServiceItem } from '~/lib/catalog'

export const Route = createFileRoute('/_authed/partners/$partnerId')({
  loader: async ({ params, abortController }) => {
    const view = await getPartnerServicesView({
      data: params,
      signal: abortController.signal,
    }).catch((cause: unknown) => {
      if (cause instanceof Error && cause.message.startsWith('NOT_FOUND:')) return null
      throw cause
    })

    if (!view) throw notFound()
    return view
  },

  head: ({ loaderData }) => ({
    meta: [{ title: loaderData ? `${loaderData.partner.name} — Partners` : 'Partner' }],
  }),

  component: PartnerServicesEditor,
})

/**
 * Consultas 7 y 8 del runbook, como una sola pantalla.
 *
 * En DBeaver son dos operaciones opuestas y sueltas: un DELETE para corregir la
 * sobre-declaración y un INSERT para cargar lo que la automática no resolvió.
 * Una corrección típica es las dos a la vez —sacar tres que no hace, agregar uno
 * que sí— así que acá se editan juntas y se guardan en una transacción.
 */
function PartnerServicesEditor() {
  const view = Route.useLoaderData()
  const router = useRouter()

  const initial = useMemo(
    () => new Set(view.assignedServiceIds),
    [view.assignedServiceIds],
  )
  const [selected, setSelected] = useState<Set<string>>(() => new Set(view.assignedServiceIds))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { add, remove } = useMemo(() => {
    const add: Array<string> = []
    const remove: Array<string> = []
    for (const id of selected) if (!initial.has(id)) add.push(id)
    for (const id of initial) if (!selected.has(id)) remove.push(id)
    return { add, remove }
  }, [selected, initial])

  const dirty = add.length > 0 || remove.length > 0
  const wouldBeInvisible = selected.size === 0

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleFamily(services: Array<ServiceItem>, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const s of services) {
        if (on) next.add(s.id)
        else next.delete(s.id)
      }
      return next
    })
  }

  async function onSave() {
    setBusy(true)
    setError(null)
    try {
      await editPartnerServicesFn({
        data: { partnerId: view.partner.id, add, remove },
      })
      await router.invalidate()
    } catch {
      setError('No pudimos guardar los cambios. No se aplicó nada — la operación es transaccional.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Link
        to="/partners"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Partners
      </Link>

      <PageHeader
        title={view.partner.name}
        subtitle={view.partner.coverageZone}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      {wouldBeInvisible ? (
        <Alert className="mb-4 border-status-red/25 bg-status-red-bg">
          <EyeOff className="size-4 text-status-red" />
          <AlertTitle className="text-status-red">Quedaría invisible</AlertTitle>
          <AlertDescription className="text-xs leading-relaxed text-muted-foreground">
            Sin un solo rubro, el partner se sigue listando sin filtro pero no aparece bajo
            ningún chip de la app. Es el modo de falla silencioso de todo este flujo.
          </AlertDescription>
        </Alert>
      ) : null}

      <Suggestions view={view} onApply={(ids) => setSelected((p) => new Set([...p, ...ids]))} />

      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <div className="space-y-3">
          {view.families.map((family) => {
            const total = family.services.length
            const on = family.services.filter((s) => selected.has(s.id)).length
            const allOn = on === total

            return (
              <Card key={family.slug}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                  <CardTitle className="text-sm">
                    {family.name}{' '}
                    <span className="font-normal text-muted-foreground">
                      {on}/{total}
                    </span>
                  </CardTitle>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto px-2 py-1 text-xs"
                    onClick={() => toggleFamily(family.services, !allOn)}
                  >
                    {allOn ? 'Ninguno' : 'Todos'}
                  </Button>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-1.5">
                  {family.services.map((s) => {
                    const isOn = selected.has(s.id)
                    const changed = isOn !== initial.has(s.id)
                    return (
                      <button
                        key={s.id}
                        type="button"
                        aria-pressed={isOn}
                        onClick={() => toggle(s.id)}
                        className={cn(
                          'rounded-md border px-2.5 py-1 text-xs transition-colors',
                          isOn
                            ? 'border-brand bg-brand-soft text-brand'
                            : 'border-border bg-card text-muted-foreground hover:text-foreground',
                          // Un anillo marca lo tocado en esta edición, para que
                          // se vea qué se está por guardar antes de guardarlo.
                          changed && 'ring-2 ring-ring ring-offset-1',
                        )}
                      >
                        {s.name}
                      </button>
                    )
                  })}
                </CardContent>
              </Card>
            )
          })}
        </div>

        <div className="space-y-4">
          <Card className="lg:sticky lg:top-6">
            <CardHeader>
              <CardTitle className="text-base">Cambios</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-muted-foreground">Rubros ahora</span>
                <span className="font-heading text-lg font-bold">{selected.size}</span>
              </div>

              {dirty ? (
                <ul className="space-y-1 text-sm">
                  {add.length > 0 ? (
                    <li className="text-status-green">+{add.length} para agregar</li>
                  ) : null}
                  {remove.length > 0 ? (
                    <li className="text-status-red">−{remove.length} para sacar</li>
                  ) : null}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Sin cambios pendientes.</p>
              )}

              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}

              <Button className="w-full" disabled={!dirty || busy} onClick={onSave}>
                {busy ? 'Guardando…' : 'Guardar cambios'}
              </Button>

              {dirty ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  disabled={busy}
                  onClick={() => setSelected(new Set(initial))}
                >
                  Descartar
                </Button>
              ) : null}
            </CardContent>
          </Card>

          {view.partner.declaredServices.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Lo que declaró</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-1.5">
                  {view.partner.declaredServices.map((slug) => (
                    <span
                      key={slug}
                      className="rounded-md border border-border bg-secondary px-2 py-0.5 font-mono text-xs"
                    >
                      {slug}
                    </span>
                  ))}
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  La carga automática mete TODOS los rubros de cada familia declarada, así
                  que sobre-declara a propósito. Si hay alguno que el taller no hace, sacalo
                  acá.
                </p>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  )
}

/**
 * Lo que la carga automática ignoró, resuelto.
 *
 * Caso real: "Batata Taller" declaró `"Chapa y pintura"`. No es una familia, así
 * que la consulta 3 no le cargó nada — pero `chapa-y-pintura` SÍ existe como
 * rubro. El runbook te manda a buscarlo a mano; acá se ofrece con un botón.
 *
 * Se sugiere, no se aplica solo: una coincidencia de texto no es una decisión.
 */
function Suggestions({
  view,
  onApply,
}: {
  view: PartnerServicesView
  onApply: (ids: Array<string>) => void
}) {
  if (view.suggestions.length === 0) return null

  return (
    <Alert className="mb-4 border-brand/25 bg-brand-soft">
      <Lightbulb className="size-4 text-brand" />
      <AlertTitle className="text-brand">Declaró algo que no es una familia</AlertTitle>
      <AlertDescription className="text-muted-foreground">
        <p className="text-xs leading-relaxed">
          La carga automática lo ignoró en silencio porque solo entiende familias. Estos
          rubros del catálogo coinciden con lo que declaró:
        </p>
        <ul className="mt-3 space-y-2">
          {view.suggestions.map((s) => (
            <li key={s.declaredSlug} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-foreground">{s.declaredSlug}</span>
              <span className="text-xs">→</span>
              {s.matches.map((m) => (
                <Button
                  key={m.id}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() => onApply([m.id])}
                >
                  + {m.name}
                </Button>
              ))}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}
