import type { AgenciesMissing } from '~/lib/chasis-agencies'

/**
 * Sin la migración 024 no hay tabla ni SP; sin la 030 el embudo de la base es
 * el viejo (`pending`, `thinking`…) y no hay charlas. La pantalla dice cuál
 * falta en vez de un 500 o de mezclar dos embudos, y sin datos de ejemplo
 * (regla dura 8). Las tablas son NUESTRAS: si falta una es que no corrió
 * `pnpm db:migrate` en esta base, no un deploy del backend.
 */
export function ProspectsUnavailable({ missing }: { missing: AgenciesMissing }) {
  return (
    <div className="rounded-lg border border-status-yellow/30 bg-status-yellow-bg px-4 py-4 text-sm text-status-yellow">
      <p className="font-medium">Falta aplicar la migración {missing} en esta base.</p>
      <p className="mt-1">
        {missing === '024' ? (
          <>
            El seguimiento comercial guarda los contactos en <code>ops.partner_prospect</code>.
          </>
        ) : missing === '031' ? (
          <>
            La 031 trae las agencias de API Chasis (<code>ops.chasis_agency</code>) y sus charlas.
          </>
        ) : (
          <>
            La 030 trae los estados nuevos, la ficha completa y el historial de charlas (
            <code>ops.partner_prospect_interaction</code>).
          </>
        )}{' '}
        En producción la aplica el próximo deploy de <code>main</code>; en desarrollo, <code>pnpm db:migrate</code>.
      </p>
    </div>
  )
}
