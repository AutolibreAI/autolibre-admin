/**
 * Sin la migración 024 no hay tabla ni SP: la pantalla lo dice en vez de un
 * 500, y sin datos de ejemplo (regla dura 8). La tabla es NUESTRA, así que si
 * falta es que no corrió `pnpm db:migrate` en esta base — no un deploy del
 * backend.
 */
export function ProspectsUnavailable() {
  return (
    <div className="rounded-lg border border-status-yellow/30 bg-status-yellow-bg px-4 py-4 text-sm text-status-yellow">
      <p className="font-medium">Falta aplicar la migración 024 en esta base.</p>
      <p className="mt-1">
        El seguimiento comercial guarda los contactos en <code>ops.partner_prospect</code>. En producción la aplica el
        próximo deploy de <code>main</code>; en desarrollo, <code>pnpm db:migrate</code>.
      </p>
    </div>
  )
}
