import { Link } from '@tanstack/react-router'
import { Badge } from '~/components/ui/badge'
import {
  describeOffset,
  groupNotificationRules,
  ruleSourceLabel,
  type NotificationRule,
  type NotificationRuleGroup,
} from '~/lib/notification-rules'
import { formatDateTime, formatInt } from '~/lib/format'

/**
 * "Recordatorios de vencimiento": las reglas de `public.notification_rules`,
 * una tarjeta por documento. Sólo lectura — ver `~/lib/notification-rules`.
 *
 * Lo que la pantalla tiene que dejar claro, y por eso está escrito en ella:
 *   - estos avisos los arma y los manda el BACKEND, hoy, cada hora;
 *   - el texto no se edita desde acá (vive en el código del backend);
 *   - pausar o agregar avisos todavía no se puede desde el panel.
 *
 * Una regla con 0 avisos se muestra en 0, en texto apagado, no se esconde:
 * "VTV · 1 día antes: 0" es un dato (mismo criterio que el censo de
 * `/usuarios/:id`).
 */
export function NotificationRuleCards({ rules }: { rules: Array<NotificationRule> }) {
  if (rules.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card px-6 py-10 text-center">
        <p className="text-sm font-medium">No hay reglas de vencimiento en esta base</p>
        <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono text-xs">notification_rules</code> está vacía. Las carga el
          backend; el panel no las crea.
        </p>
      </div>
    )
  }

  const groups = groupNotificationRules(rules)

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {groups.map((g) => (
        <RuleGroupCard key={g.sourceType} group={g} />
      ))}
    </div>
  )
}

function RuleGroupCard({ group: g }: { group: NotificationRuleGroup }) {
  // Canal y dirección no son columnas: hoy todo es `push` · `antes`. Sólo se
  // dicen si alguna fila se sale de eso — mismo criterio que el grupo de canal
  // del Historial, que se esconde mientras haya un solo canal.
  const showChannel = g.rules.some((r) => r.channel !== 'push')

  return (
    <section className="flex flex-col rounded-lg border border-border bg-card">
      <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
        <h3 className="font-heading text-base font-semibold">{ruleSourceLabel(g.sourceType)}</h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatInt(g.notificationCount)} aviso{g.notificationCount === 1 ? '' : 's'} generado
          {g.notificationCount === 1 ? '' : 's'}
        </span>
      </header>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="px-4 pb-1 pt-2 font-normal">Cuándo</th>
            <th className="px-2 pb-1 pt-2 font-normal">Estado</th>
            <th className="px-2 pb-1 pt-2 text-right font-normal">Avisos</th>
            <th className="px-4 pb-1 pt-2 text-right font-normal">Último</th>
          </tr>
        </thead>
        <tbody>
          {g.rules.map((r) => (
            <RuleRow key={r.id} rule={r} showChannel={showChannel} />
          ))}
        </tbody>
      </table>

      <div className="mt-auto border-t border-border px-4 py-3">
        {g.sample ? (
          <>
            <p className="text-xs text-muted-foreground">
              Así se ve el último que salió ({formatDateTime(g.sample.at)}):
            </p>
            <div className="mt-1.5 rounded-md border border-border bg-surface-2 px-3 py-2">
              <p className="text-sm font-medium">{g.sample.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{g.sample.body}</p>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Todavía no sonó ninguno de estos avisos.</p>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">
          El texto lo arma el backend — desde el panel no se edita.
        </p>
      </div>
    </section>
  )
}

function RuleRow({ rule: r, showChannel }: { rule: NotificationRule; showChannel: boolean }) {
  return (
    <tr className="border-t border-border/60">
      <td className="px-4 py-1.5">
        {describeOffset(r)}
        {showChannel ? <span className="ml-1.5 text-xs text-muted-foreground">· {r.channel}</span> : null}
      </td>
      <td className="px-2 py-1.5">
        {r.active ? (
          <Badge
            variant="outline"
            className="border-status-green/20 bg-status-green-bg font-normal text-status-green"
          >
            Activa
          </Badge>
        ) : (
          <Badge variant="outline" className="font-normal text-muted-foreground">
            Pausada
          </Badge>
        )}
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums">
        {r.notificationCount === 0 ? (
          <span className="text-muted-foreground">0</span>
        ) : (
          // Objeto literal, no spread: un `{...prev}` cross-route arrastra el
          // tipo ancho de `FullSearchSchema` (`partners-coverage.md`).
          <Link
            to="/notificaciones"
            search={{ notificationRuleId: r.id }}
            className="rounded underline decoration-dotted outline-none hover:text-brand focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            title="Ver estos avisos en el Historial"
          >
            {formatInt(r.notificationCount)}
          </Link>
        )}
      </td>
      <td className="px-4 py-1.5 text-right text-xs tabular-nums text-muted-foreground">
        {r.lastNotificationAt ? formatDateTime(r.lastNotificationAt) : '—'}
      </td>
    </tr>
  )
}
