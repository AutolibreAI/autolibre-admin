import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, Users } from 'lucide-react'
import {
  AUDIENCE_FIELDS,
  AUDIENCE_FIELD_KEYS,
  AUDIENCE_GROUPS,
  AUDIENCE_MAX_CONDITIONS,
  AUDIENCE_OPERATOR_LABELS,
  AUDIENCE_OPERATOR_SUFFIX,
  AUDIENCE_RECIPIENT_LIMIT,
  AUDIENCE_VALUE_MAX,
  operatorNeedsValue,
  operatorsFor,
  type AudienceCondition,
  type AudienceFieldKey,
  type AudienceOperator,
  type AudiencePreview,
} from '~/lib/audience'
import { previewNotificationAudience, readableBroadcastError } from '~/fn/notifications'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * Armar a mano el grupo al que va una notificación.
 *
 * ── Qué reemplaza ───────────────────────────────────────────────────────────
 *
 * Correr un `select` en DBeaver y pegar los uuid de a uno en el buscador del
 * compositor. Con 48 usuarios sin vehículo cargado eso no se hace: se manda de a
 * uno, o no se manda.
 *
 * ── Lo que viaja NO es SQL ──────────────────────────────────────────────────
 *
 * Cada condición es `{field, op, value}` con `field` y `op` de enums cerrados.
 * El catálogo, los operadores válidos por campo y la validación viven en
 * `~/lib/audience`; el SQL, en `~/server/audience.repo`. Este componente sólo
 * arma el array.
 *
 * ── Resuelve a destinatarios EXPLÍCITOS, y no es un detalle ─────────────────
 *
 * "Usar estos N" no guarda la condición en ningún lado: trae la lista de
 * usuarios y la vuelca en los mismos chips que el buscador a mano. Después de
 * eso el envío es exactamente el de siempre — un `POST /notifications/broadcast`
 * con una lista de `userIds`.
 *
 * Es lo que tiene que pasar, por dos motivos: el backend recibe ids y no
 * condiciones (y un solo id inválido le tira el lote entero), y sobre todo
 * **quien manda ve a quién le manda antes de apretar Enviar**. Una audiencia que
 * se resuelve del lado del servidor en el momento del envío le manda un push a
 * un grupo que nadie miró.
 *
 * ── El modo `schedule`, para `.claude/plans/notificaciones-automaticas.md` ──
 *
 * Una regla recurrente no puede resolver a destinatarios explícitos: la
 * audiencia de "dentro de dos días a las 19" todavía no existe. En ese modo no
 * hay botón "Usar N como destinatarios" — el componente expone `conditions` al
 * padre por `onConditionsChange` cada vez que cambia, para que el formulario
 * de la regla lo guarde tal cual, y la vista previa se muestra igual pero
 * rotulada como "así es HOY" (`.claude/plans/…`, §9).
 */
export function AudienceBuilder({
  disabled,
  mode = 'send',
  initialConditions,
  onUse,
  onConditionsChange,
}: {
  disabled: boolean
  mode?: 'send' | 'schedule'
  initialConditions?: Array<AudienceCondition>
  /** Requerido en modo `send`; ignorado en modo `schedule`. */
  onUse?: (recipients: AudiencePreview['recipients'], conditions: Array<AudienceCondition>) => void
  /** Se llama con la lista completa cada vez que cambia. Sólo en modo `schedule`. */
  onConditionsChange?: (conditions: Array<AudienceCondition>) => void
}) {
  /**
   * El default no es vacío: "vehículos cargados = 0" es la condición que motivó
   * toda esta pantalla, y arrancar con una fila armada muestra cómo se usa el
   * armador sin un párrafo de instrucciones.
   */
  const [conditions, setConditions] = useState<Array<AudienceCondition>>(
    initialConditions && initialConditions.length > 0
      ? initialConditions
      : [{ field: 'vehicles', op: 'eq', value: 0 }],
  )
  const [preview, setPreview] = useState<AudiencePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)

  const complete = conditions.every((c) => !operatorNeedsValue(c.op) || c.value !== undefined)
  const ready = conditions.length > 0 && complete

  /**
   * La vista previa se pide sola, con debounce, y descarta respuestas viejas.
   *
   * Mismo mecanismo que el buscador de destinatarios, por el mismo motivo: subir
   * de 7 a 30 en el campo de días dispara dos consultas y la primera puede volver
   * DESPUÉS de la segunda, dejando en pantalla un conteo que no corresponde a la
   * condición que se está viendo. El contador `latest` es lo que lo corta.
   *
   * La dependencia del efecto es `JSON.stringify(conditions)` y no el array: se
   * recrea en cada tecleo, así que una comparación por referencia dispararía
   * siempre. El array tipado se usa adentro, no el string — es el del mismo
   * render que la huella, así que no hay closure viejo posible.
   */
  const fingerprint = JSON.stringify(conditions)

  useEffect(() => {
    const mine = ++latest.current

    if (!ready) {
      setPreview(null)
      setLoading(false)
      return
    }

    setLoading(true)
    const timer = setTimeout(() => {
      previewNotificationAudience({ data: { conditions } })
        .then((result) => {
          if (latest.current !== mine) return
          setPreview(result)
          setError(null)
        })
        .catch((cause: unknown) => {
          if (latest.current !== mine) return
          setPreview(null)
          setError(readableBroadcastError(cause))
        })
        .finally(() => {
          if (latest.current === mine) setLoading(false)
        })
    }, 400)

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- la huella cubre a `conditions`
  }, [fingerprint, ready])

  /**
   * Modo `schedule`: el padre necesita la lista completa para guardarla, no
   * sólo para previsualizarla — a diferencia del modo `send`, acá no hay un
   * botón "Usar N" que la entregue una sola vez al final.
   */
  useEffect(() => {
    onConditionsChange?.(conditions)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- la huella cubre a `conditions`
  }, [fingerprint])

  function updateCondition(index: number, next: AudienceCondition) {
    setConditions((prev) => prev.map((c, i) => (i === index ? next : c)))
  }

  function removeCondition(index: number) {
    setConditions((prev) => prev.filter((_, i) => i !== index))
  }

  function addCondition() {
    setConditions((prev) =>
      prev.length >= AUDIENCE_MAX_CONDITIONS
        ? prev
        : [...prev, defaultCondition('pushTokens')],
    )
  }

  /**
   * La condición matchea más de lo que entra en un envío. `preview` viaja junto
   * al booleano y no como una constante aparte: `capped` solo no le dice a TS
   * que `preview` no es null, y adentro del JSX eso es un error de tipos, no una
   * sutileza.
   */
  const capped =
    preview !== null && preview.matched > preview.recipients.length ? preview : null

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {conditions.map((c, i) => (
          <li key={i}>
            <ConditionRow
              condition={c}
              disabled={disabled}
              onChange={(next) => updateCondition(i, next)}
              onRemove={conditions.length > 1 ? () => removeCondition(i) : undefined}
            />
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled || conditions.length >= AUDIENCE_MAX_CONDITIONS}
          onClick={addCondition}
          className="border border-border"
        >
          <Plus aria-hidden />
          Agregar condición
        </Button>
        <span className="text-xs text-muted-foreground">
          Se cumplen todas a la vez. No hay «o»: para una unión, son dos envíos.
        </span>
      </div>

      {conditions.length > 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {AUDIENCE_FIELDS[conditions[conditions.length - 1]!.field].hint}
        </p>
      ) : null}

      <div className="rounded-md border border-border bg-secondary/40 p-3">
        {error ? (
          <p role="alert" className="text-xs leading-relaxed text-destructive">
            {error}
          </p>
        ) : !ready ? (
          <p className="text-xs text-muted-foreground">
            Completá las condiciones para ver a cuántos alcanza.
          </p>
        ) : (
          <div className={cn('space-y-2', loading && 'opacity-60')}>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <Users className="size-4 self-center text-muted-foreground" aria-hidden />
              <span className="text-sm font-medium tabular-nums" role="status">
                {loading && preview === null
                  ? 'Contando…'
                  : `${formatInt(preview?.matched ?? 0)} usuario${preview?.matched === 1 ? '' : 's'}`}
              </span>
              {preview && preview.matched > 0 ? (
                <span className="text-xs text-muted-foreground">
                  {formatInt(preview.withoutDevice)} sin dispositivo ·{' '}
                  {formatInt(preview.internalOrAdmin)} interno/admin
                </span>
              ) : null}
            </div>

            {mode === 'schedule' ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Así es HOY. Cada corrida de la regla recalcula la audiencia en su propio momento —
                este número es sólo para orientarte mientras la armás.
              </p>
            ) : null}

            {preview && preview.matched > 0 ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {preview.recipients
                  .slice(0, 4)
                  .map((r) => r.email)
                  .join(', ')}
                {preview.recipients.length > 4
                  ? ` y ${formatInt(preview.recipients.length - 4)} más`
                  : ''}
              </p>
            ) : null}

            {capped ? (
              <p className="text-xs leading-relaxed text-status-yellow">
                El tope del backend es {formatInt(AUDIENCE_RECIPIENT_LIMIT)} por envío. Se van a
                cargar los {formatInt(capped.recipients.length)} más antiguos; los{' '}
                {formatInt(capped.matched - capped.recipients.length)} restantes quedan para un
                segundo envío. El corte es estable: previsualizar de nuevo trae los mismos.
              </p>
            ) : null}

            {preview && preview.withoutDevice > 0 ? (
              <p className="text-xs leading-relaxed text-status-yellow">
                A {formatInt(preview.withoutDevice)} no les va a llegar: no tienen dispositivo
                registrado. Su notificación se crea igual y queda en «Sin token». Para excluirlos,
                agregá «Dispositivos registrados · es al menos · 1».
              </p>
            ) : null}

            {mode === 'send' ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={disabled || loading || !preview || preview.recipients.length === 0}
                onClick={() => {
                  if (preview) onUse?.(preview.recipients, conditions)
                }}
              >
                Usar {formatInt(preview?.recipients.length ?? 0)} como destinatarios
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * La condición por default de un campo: su primer operador, y `0` si ese
 * operador pide número.
 *
 * Existe porque cambiar de campo tiene que dejar la fila VÁLIDA: pasar de
 * «Vehículos cargados · es igual a · 0» a «Última actividad» dejaría un `eq` que
 * ese campo no acepta, y el error recién aparecería al enviar.
 */
function defaultCondition(field: AudienceFieldKey): AudienceCondition {
  const op = operatorsFor(field)[0]!
  return { field, op, value: operatorNeedsValue(op) ? 0 : undefined }
}

function ConditionRow({
  condition: c,
  disabled,
  onChange,
  onRemove,
}: {
  condition: AudienceCondition
  disabled: boolean
  onChange: (next: AudienceCondition) => void
  onRemove?: () => void
}) {
  const ops = operatorsFor(c.field)
  const needsValue = operatorNeedsValue(c.op)
  const suffix = AUDIENCE_OPERATOR_SUFFIX[c.op]

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select
        value={c.field}
        disabled={disabled}
        onValueChange={(v) => onChange(defaultCondition(v as AudienceFieldKey))}
      >
        <SelectTrigger className="h-8 min-w-0 flex-1 basis-48 shadow-none" aria-label="Campo">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AUDIENCE_GROUPS.map((group) => (
            <SelectGroup key={group}>
              <SelectLabel>{group}</SelectLabel>
              {AUDIENCE_FIELD_KEYS.filter((k) => AUDIENCE_FIELDS[k].group === group).map((k) => (
                <SelectItem key={k} value={k}>
                  {AUDIENCE_FIELDS[k].label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={c.op}
        disabled={disabled}
        onValueChange={(v) => {
          const op = v as AudienceOperator
          onChange({ field: c.field, op, value: operatorNeedsValue(op) ? (c.value ?? 0) : undefined })
        }}
      >
        <SelectTrigger className="h-8 w-40 shadow-none" aria-label="Operador">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ops.map((op) => (
            <SelectItem key={op} value={op}>
              {AUDIENCE_OPERATOR_LABELS[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {needsValue ? (
        <div className="flex items-center gap-1">
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={AUDIENCE_VALUE_MAX}
            value={c.value ?? ''}
            disabled={disabled}
            aria-label="Valor"
            onChange={(e) => {
              const raw = e.currentTarget.value
              // Vacío ≠ 0: mientras el campo está vacío la condición queda
              // incompleta y la vista previa se apaga, en vez de contar un
              // grupo que nadie pidió.
              const parsed = raw === '' ? undefined : Number.parseInt(raw, 10)
              onChange({
                field: c.field,
                op: c.op,
                value: parsed === undefined || Number.isNaN(parsed) ? undefined : parsed,
              })
            }}
            className="h-8 w-20 shadow-none"
          />
          {suffix ? <span className="text-xs text-muted-foreground">{suffix}</span> : null}
        </div>
      ) : null}

      {onRemove ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          aria-label="Quitar condición"
          className="rounded p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  )
}
