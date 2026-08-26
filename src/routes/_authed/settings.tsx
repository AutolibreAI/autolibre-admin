import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Card, CardContent } from '~/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'

const STORAGE_KEY = 'autolibre.admin.prefs.v1'

interface Prefs {
  density: 'comfortable' | 'compact'
  defaultPageSize: number
}

const DEFAULT_PREFS: Prefs = { density: 'comfortable', defaultPageSize: 25 }

export const Route = createFileRoute('/_authed/settings')({
  /**
   * SSR MODE: false.
   *
   * This route renders entirely in the browser. It has no loader and no server
   * data — its state lives in `localStorage`, which does not exist during SSR.
   * Server-rendering it would emit markup built from `DEFAULT_PREFS` that is
   * guaranteed to differ from what the browser renders a tick later: a
   * hydration mismatch by construction, plus a visible flash of wrong values.
   *
   * `ssr: false` is the honest answer for browser-owned state. Rendering a
   * placeholder and swapping it in an effect is the same thing with extra steps
   * and a worse first paint.
   *
   * The shell, the document and `_authed`'s guard are unaffected — an
   * unauthenticated request to /settings is still redirected server-side,
   * before any of this ships.
   */
  ssr: false,

  head: () => ({ meta: [{ title: 'Preferencias — AutoLibre' }] }),
  component: Settings,
})

function Settings() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [loaded, setLoaded] = useState(false)

  // Even with ssr:false this stays in an effect rather than in render —
  // reading `localStorage` during render breaks concurrent React.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) setPrefs({ ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) })
    } catch {
      // Corrupt or unavailable storage (private mode, quota) — fall back to
      // defaults rather than blowing up the route.
    }
    setLoaded(true)
  }, [])

  function update(patch: Partial<Prefs>) {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // Non-fatal: preferences simply will not persist this session.
      }
      return next
    })
  }

  return (
    <>
      <PageHeader
        title="Preferencias"
        subtitle="Se guardan en este navegador, no en la cuenta."
        actions={<SsrTag>ssr: false</SsrTag>}
      />

      <Card>
        <CardContent className="space-y-5 pt-6" aria-busy={!loaded}>
          <div className="space-y-1.5">
            <label
              htmlFor="density"
              className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              Densidad de la tabla
            </label>
            <Select
              value={prefs.density}
              onValueChange={(value) => update({ density: value as Prefs['density'] })}
            >
              <SelectTrigger id="density" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="comfortable">Cómoda</SelectItem>
                <SelectItem value="compact">Compacta</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="pageSize"
              className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              Filas por página
            </label>
            <Select
              value={String(prefs.defaultPageSize)}
              onValueChange={(value) => update({ defaultPageSize: Number(value) })}
            >
              <SelectTrigger id="pageSize" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 25, 50, 100].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
    </>
  )
}
