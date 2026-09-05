import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_SOURCE_LABELS,
  OPEN_LEAD_STATUSES,
  leadSearchSchema,
  type LeadListItem,
  type LeadStatus,
} from '~/lib/leads'
import { advanceMarketplaceLead, listMarketplaceLeads } from '~/fn/leads'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatDate, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * El embudo del marketplace: usuario → taller.
 *
 * ── Qué reemplaza ───────────────────────────────────────────────────────────
 *
 * El `UPDATE leads SET status = …` a mano. Y no es una interpretación mía: el
 * propio `lead-status.vo.ts` del backend dice que *"la app solo crea leads en
 * `new`; el resto del recorrido lo mueve el equipo desde SQL"*. Esta pantalla
 * ES ese SQL, con nombre, con auditoría y sin DBeaver.
 *
 * No confundir con `/solicitudes`: ahí el taller viene hacia nosotros, acá el
 * usuario va hacia el taller. Son direcciones opuestas.
 */
export const Route = createFileRoute('/_authed/leads')({
  /**
   * SSR completo (heredado de `defaultSsr: true`), a diferencia de /operacion.
   *
   * Es una pantalla de CONTENIDO —una tabla de casos con nombres y fechas— y es
   * de las que se abren primero en una sesión de trabajo: alguien entra a
   * atender leads. Ahí el markup server-rendered sí mueve el primer pintado, al
   * revés que en un tablero de tarjetas calculadas.
   */
  validateSearch: leadSearchSchema,
  loaderDeps: ({ search }) => search,

  loader: ({ deps, abortController }) =>
    listMarketplaceLeads({ data: deps, signal: abortController.signal }),

  head: () => ({ meta: [{ title: 'Leads — AutoLibre' }] }),
  component: Leads,
})

function Leads() {
  const leads = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const stale = leads.filter((l) => l.stale).length

  return (
    <>
      <PageHeader
        title="Leads"
        subtitle={`${formatInt(leads.length)} en la lista · el usuario pidiendo turno a un taller`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      {stale > 0 ? (
        <div className="mb-4 flex items-start gap-3 rounded-md border border-status-yellow/30 bg-status-yellow-bg p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-yellow" aria-hidden />
          <div>
            <div className="text-sm font-medium">
              {formatInt(stale)} sin contactar hace más de 48 h
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              Un lead es alguien que ya levantó la mano. Cada hora que pasa, vale menos.
            </p>
          </div>
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-full space-y-1.5 sm:w-auto">
          <label
            htmlFor="q"
            className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            Buscar
          </label>
          <Input
            id="q"
            type="search"
            placeholder="Taller, nombre o email"
            defaultValue={search.q ?? ''}
            className="w-full sm:w-56"
            onChange={(e) => {
              const value = e.currentTarget.value.trim()
              navigate({
                search: (prev) => ({ ...prev, q: value === '' ? undefined : value }),
                replace: true,
              })
            }}
          />
        </div>

        <div className="space-y-1.5">
          <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Estado
          </span>
          <div className="flex flex-wrap gap-1.5">
            <Chip
              active={!search.status}
              onClick={() => navigate({ search: (p) => ({ ...p, status: undefined }), replace: true })}
            >
              Todos
            </Chip>
            {LEAD_STATUSES.map((s) => (
              <Chip
                key={s}
                active={search.status === s}
                onClick={() => navigate({ search: (p) => ({ ...p, status: s }), replace: true })}
              >
                {LEAD_STATUS_LABELS[s]}
              </Chip>
            ))}
          </div>
        </div>

        {/*
          Por default se ocultan los cerrados, igual que la cola de solicitudes
          oculta las ya publicadas: esto es una lista de trabajo pendiente, no un
          histórico. El histórico se pide.
        */}
        <Chip
          active={search.closed === 'show'}
          onClick={() =>
            navigate({
              search: (p) => ({ ...p, closed: p.closed === 'show' ? 'hide' : 'show' }),
              replace: true,
            })
          }
        >
          Incluir cerrados
        </Chip>
      </div>

      {leads.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Ningún lead con estos filtros. Cuando un usuario pida turno a un taller desde la app,
          aparece acá.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Taller</TableHead>
              <TableHead>Usuario</TableHead>
              <TableHead>Vehículo</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Espera</TableHead>
              <TableHead className="text-right">Alta</TableHead>
              <TableHead>Mover a</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.map((lead) => (
              <Row key={lead.id} lead={lead} />
            ))}
          </TableBody>
        </Table>
      )}
    </>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-md border px-2.5 py-1 text-xs transition-colors',
        active
          ? 'border-transparent bg-primary text-primary-foreground'
          : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

const STATUS_STYLES: Record<LeadStatus, string> = {
  new: 'bg-status-yellow-bg text-status-yellow border-status-yellow/20',
  contacted: 'bg-secondary text-foreground border-border',
  won: 'bg-status-green-bg text-status-green border-status-green/20',
  lost: 'bg-secondary text-muted-foreground border-border',
}

function Row({ lead }: { lead: LeadListItem }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function move(status: LeadStatus) {
    setBusy(true)
    setError(null)
    try {
      // `lostReason` se pide sólo al cerrar como perdido. Un prompt del browser
      // es feo y es honesto: el motivo se escribe cuando se sabe, y encadenar un
      // modal para un campo de texto opcional sería más UI que problema.
      const lostReason =
        status === 'lost'
          ? (globalThis.prompt('¿Por qué se perdió? (opcional)') ?? undefined)
          : undefined

      await advanceMarketplaceLead({ data: { leadId: lead.id, status, lostReason } })
      await router.invalidate()
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause)
      setError(
        raw.includes('LEAD_ALREADY_OPEN')
          ? 'Ya hay otro lead abierto de este usuario con este taller por el mismo vehículo. Cerrá ese primero.'
          : raw.includes('LEAD_NOT_FOUND')
            ? 'Este lead ya no existe. Recargá la pantalla.'
            : raw,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <TableRow className={cn(lead.stale && 'bg-status-yellow-bg/40')}>
        <TableCell>
          <Link
            to="/partners/$partnerId"
            params={{ partnerId: lead.partnerId }}
            className="text-brand hover:underline"
          >
            {lead.partnerName}
          </Link>
          <div className="text-xs text-muted-foreground">
            {LEAD_SOURCE_LABELS[lead.source] ?? lead.source}
          </div>
        </TableCell>

        <TableCell>
          <div className="truncate">{lead.userName ?? '—'}</div>
          <div className="truncate text-xs text-muted-foreground">{lead.userEmail ?? ''}</div>
        </TableCell>

        <TableCell className="text-muted-foreground">{lead.vehicleLabel ?? '—'}</TableCell>

        <TableCell>
          <Badge variant="outline" className={STATUS_STYLES[lead.status]}>
            {LEAD_STATUS_LABELS[lead.status]}
          </Badge>
          {lead.lostReason ? (
            <div className="mt-0.5 max-w-[14rem] truncate text-xs text-muted-foreground" title={lead.lostReason}>
              {lead.lostReason}
            </div>
          ) : null}
        </TableCell>

        {/*
          Para un lead abierto, "espera" cuenta contra ahora — así el peor caso
          tiene el número más grande en vez de no tener número. Para uno ya
          contactado, es el tiempo que efectivamente tardamos.
        */}
        <TableCell
          className={cn(
            'text-right tabular-nums',
            lead.stale && 'font-medium text-status-yellow',
          )}
        >
          {lead.hoursToContact === null ? '—' : `${lead.hoursToContact.toFixed(0)} h`}
        </TableCell>

        <TableCell className="text-right text-muted-foreground">
          {formatDate(lead.createdAt)}
        </TableCell>

        <TableCell>
          <div className="flex flex-wrap gap-1">
            {LEAD_STATUSES.filter((s) => s !== lead.status).map((s) => {
              /*
                Reabrir un lead cerrado puede chocar
                `idx_leads_open_user_partner_vehicle_unique`. No se esconde el
                botón: esconderlo dejaría al operador sin saber por qué no
                puede, y la colisión depende de OTRAS filas que no están en esta
                pantalla. El SP contesta con un mensaje que explica el choque.
              */
              const reopening =
                !OPEN_LEAD_STATUSES.includes(lead.status) && OPEN_LEAD_STATUSES.includes(s)
              return (
                <Button
                  key={s}
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className="h-auto px-2 py-1 text-xs"
                  title={reopening ? 'Reabrir: puede chocar con otro lead abierto' : undefined}
                  onClick={() => void move(s)}
                >
                  {LEAD_STATUS_LABELS[s]}
                </Button>
              )
            })}
          </div>
        </TableCell>
      </TableRow>

      {error ? (
        <TableRow>
          <TableCell colSpan={7} className="py-2">
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}
