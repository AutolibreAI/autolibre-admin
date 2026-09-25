import { ChevronDown } from 'lucide-react'
import { MaintenanceTasks } from '~/components/MaintenanceTasks'
import { Badge } from '~/components/ui/badge'
import { Card, CardContent } from '~/components/ui/card'
import { formatDateTime, formatInt } from '~/lib/format'
import type { QuoteVehicleProfile } from '~/lib/quote-vehicle-profile'
import type { ReactNode } from 'react'

const ENGINE_SOURCE_LABELS: Record<NonNullable<QuoteVehicleProfile['engineNumberSource']>, string> = {
  vehicle: 'del auto',
  registration_card: 'de la cédula',
  insurance: 'del seguro',
}

/**
 * El vehículo de un pedido de presupuesto — sólo lectura, sin escrituras.
 * `.claude/plans/pedidos-ficha-2026-09-25.md`, Fase 4.
 *
 * Contesta lo que el operador necesita SIN abrir otra pantalla mientras tiene
 * a la persona al teléfono: VIN, número de motor (con de dónde salió — no es
 * lo mismo que lo cargó el auto a que lo trajo un documento), kilometraje, los
 * DTCs del último escaneo, y las tareas de mantenimiento.
 */
export function QuoteVehicleProfileCard({ profile }: { profile: QuoteVehicleProfile }) {
  const pending = profile.tasks.filter((t) => t.state !== 'done').length
  const done = profile.tasks.length - pending

  return (
    <Card className="mb-4">
      <CardContent className="space-y-4 pt-6">
        <h2 className="font-heading text-base font-semibold">Vehículo — lo que sabemos hoy</h2>

        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="VIN">
            {profile.vin ? (
              <span className="font-mono text-sm tracking-wide">{profile.vin}</span>
            ) : (
              <Missing>sin VIN cargado</Missing>
            )}
          </Field>

          <Field label="Nº de motor">
            {profile.engineNumber ? (
              <>
                <span className="font-mono text-sm tracking-wide">{profile.engineNumber}</span>
                {profile.engineNumberSource ? (
                  <div className="text-xs text-muted-foreground">
                    {ENGINE_SOURCE_LABELS[profile.engineNumberSource]}
                  </div>
                ) : null}
              </>
            ) : (
              <Missing>sin cargar, ni en el auto ni en sus documentos</Missing>
            )}
          </Field>

          <Field label="Kilometraje">
            {profile.odometerKm === null ? (
              <Missing>sin cargar</Missing>
            ) : (
              <span className="text-sm tabular-nums">{formatInt(profile.odometerKm)} km</span>
            )}
          </Field>

          <Field label="Códigos DTC (último escaneo)">
            {profile.dtcScannedAt === null ? (
              <Missing>nunca se escaneó este auto</Missing>
            ) : profile.dtcCodes.length === 0 ? (
              <>
                <span className="text-sm text-status-green">sin códigos</span>
                <div className="text-xs text-muted-foreground">escaneado {formatDateTime(profile.dtcScannedAt)} UTC</div>
              </>
            ) : (
              <>
                <div className="flex flex-wrap gap-1">
                  {profile.dtcCodes.map((d) => (
                    <Badge
                      key={d.code}
                      variant="outline"
                      title={d.title ?? 'sin título cargado'}
                      className="border-status-yellow/30 bg-status-yellow-bg font-mono text-status-yellow"
                    >
                      {d.code}
                    </Badge>
                  ))}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  escaneado {formatDateTime(profile.dtcScannedAt)} UTC
                </div>
              </>
            )}
          </Field>
        </div>

        <details className="group rounded-md border border-border">
          <summary className="flex cursor-pointer select-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span>
              Tareas ({formatInt(done)} hechas / {formatInt(pending)} pendientes)
            </span>
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <div className="border-t border-border p-3">
            <MaintenanceTasks tasks={profile.tasks} title="Tareas de este vehículo" />
          </div>
        </details>
      </CardContent>
    </Card>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  )
}

function Missing({ children }: { children: ReactNode }) {
  return <span className="text-sm text-muted-foreground/70">{children}</span>
}
