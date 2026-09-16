import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { BellPlus, Plus, Send, X } from 'lucide-react'
import {
  BROADCAST_BODY_MAX,
  BROADCAST_MAX_RECIPIENTS,
  BROADCAST_TITLE_MAX,
  NOTIFICATION_STATE_LABELS,
  RECIPIENT_SEARCH_MIN_CHARS,
  type BroadcastResult,
  type NotificationRecipient,
} from '~/lib/notifications'
import { describeAudience, type AudienceCondition, type AudiencePreview } from '~/lib/audience'
import {
  getBroadcastResult,
  readableBroadcastError,
  searchNotificationRecipients,
  sendBroadcastNotification,
} from '~/fn/notifications'
import { AudienceBuilder } from '~/components/AudienceBuilder'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '~/components/ui/sheet'
import { formatDateTime, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * Cuántos chips de destinatario se muestran antes de plegar la lista.
 *
 * Un envío por condición puede traer 500: pintarlos todos hace que el título y
 * el mensaje —que es lo que hay que revisar antes de mandar— queden abajo de
 * una pared de chips. Doce entran en dos renglones y alcanzan para reconocer
 * que la lista es la que se pidió.
 */
const CHIP_PREVIEW_COUNT = 12

/**
 * Mandar una notificación push a usuarios elegidos a mano.
 *
 * ── No escribe Postgres ─────────────────────────────────────────────────────
 *
 * El alta va por HTTP a `POST /notifications/broadcast` del backend hex, con el
 * token del admin logueado. El backend filtra a quien silenció los anuncios y
 * arma cada fila con `Notification.create()`; un `INSERT` desde el panel se
 * saltearía las dos cosas. → `.claude/rules/notifications.md`
 *
 * ── `broadcastId`: uno por campaña, NO uno por click ────────────────────────
 *
 * Es la clave de idempotencia del backend: cada fila queda con
 * `source_id = broadcastId` y un índice único por `(user_id, source_type,
 * source_id)` descarta la segunda. Por eso:
 *
 *  - Se genera al abrir el compositor por primera vez, y se CONSERVA si el envío
 *    falla, si se cierra el panel, o si llega un doble click. Un timeout puede
 *    haber creado las filas igual; reintentar con el mismo id es lo que hace que
 *    esa duda no se convierta en un push repetido a toda la lista.
 *  - Se regenera SÓLO después de un envío exitoso: lo que se escriba a
 *    continuación es otra campaña.
 *
 * La contracara, y hay que saberla: con el mismo id, **cambiar el texto y
 * reenviar no hace nada** para quien ya tenía su fila. Si el primer intento
 * llegó al backend, esas personas se quedan con el texto viejo. La UI lo avisa
 * después de un intento fallido.
 *
 * El id nunca se muestra ni se renderiza en el servidor: se genera en un
 * handler, así que `crypto.randomUUID()` no corre durante SSR.
 */
export function BroadcastComposer() {
  const router = useRouter()

  const [open, setOpen] = useState(false)
  const [broadcastId, setBroadcastId] = useState<string | null>(null)

  const [recipients, setRecipients] = useState<Array<NotificationRecipient>>([])
  /**
   * Cómo se eligen los destinatarios. Los dos caminos terminan en la MISMA lista
   * de `recipients`: la condición resuelve a ids antes de enviar, así que el
   * envío es siempre el mismo `POST` con una lista explícita. → `AudienceBuilder`
   */
  const [mode, setMode] = useState<'manual' | 'conditions'>('manual')
  /**
   * La condición con la que se cargó la lista, en castellano. Es SÓLO para que
   * el operador vea qué cargó — no viaja al backend ni se guarda en ningún lado.
   * Un envío ya hecho no recuerda su audiencia: eso necesitaría una tabla en
   * `ops`, que es una decisión aparte. → `~/lib/campaigns`
   */
  const [audienceNote, setAudienceNote] = useState<string | null>(null)
  /** Con 300 chips en pantalla no se lee nada; se muestran los primeros. */
  const [showAllRecipients, setShowAllRecipients] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [scheduleLocal, setScheduleLocal] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Hubo al menos un intento con el `broadcastId` actual. Ver la contracara arriba. */
  const [attempted, setAttempted] = useState(false)
  const [result, setResult] = useState<SentSummary | null>(null)

  /**
   * `busy` es estado de React y se aplica en el próximo render: dos clicks en el
   * mismo tick verían los dos `busy = false`. El backend los colapsaría igual
   * (mismo id), pero serían dos requests y dos resultados pisándose. La ref corta
   * en el acto.
   */
  const inFlight = useRef(false)

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next && !broadcastId) setBroadcastId(crypto.randomUUID())
  }

  const titleTrim = title.trim()
  const bodyTrim = body.trim()

  const scheduledDate = scheduleLocal ? new Date(scheduleLocal) : null
  const scheduleInvalid = scheduledDate !== null && Number.isNaN(scheduledDate.getTime())
  const scheduleInPast =
    scheduledDate !== null && !scheduleInvalid && scheduledDate.getTime() <= Date.now()

  const withoutDevice = recipients.filter((r) => r.pushTokens === 0).length
  const full = recipients.length >= BROADCAST_MAX_RECIPIENTS

  const canSend =
    broadcastId !== null &&
    !busy &&
    recipients.length > 0 &&
    recipients.length <= BROADCAST_MAX_RECIPIENTS &&
    titleTrim.length > 0 &&
    titleTrim.length <= BROADCAST_TITLE_MAX &&
    bodyTrim.length > 0 &&
    bodyTrim.length <= BROADCAST_BODY_MAX &&
    !scheduleInvalid &&
    !scheduleInPast

  function addRecipient(candidate: NotificationRecipient) {
    setRecipients((prev) =>
      prev.length >= BROADCAST_MAX_RECIPIENTS || prev.some((r) => r.id === candidate.id)
        ? prev
        : [...prev, candidate],
    )
  }

  function removeRecipient(id: string) {
    setRecipients((prev) => prev.filter((r) => r.id !== id))
  }

  function clearRecipients() {
    setRecipients([])
    setAudienceNote(null)
    setShowAllRecipients(false)
  }

  /**
   * Carga el resultado de una condición como destinatarios.
   *
   * **Reemplaza la lista, no la suma**, y es a propósito: sumar dos condiciones
   * sería un `OR` encubierto, que es justo lo que el armador no ofrece. Si hacen
   * falta dos grupos, son dos envíos.
   *
   * El `slice` es una red: el repo ya corta en 500, pero el tope que manda es el
   * del backend y tiene que aplicarse acá también — si los dos números alguna vez
   * divergen, lo que no puede pasar es mandar un lote que el backend rechaza
   * entero.
   */
  function useAudience(
    resolved: AudiencePreview['recipients'],
    conditions: Array<AudienceCondition>,
  ) {
    setRecipients(resolved.slice(0, BROADCAST_MAX_RECIPIENTS))
    setAudienceNote(describeAudience(conditions))
    setShowAllRecipients(false)
  }

  async function submit() {
    if (!canSend || !broadcastId || inFlight.current) return

    inFlight.current = true
    setBusy(true)
    setError(null)
    setAttempted(true)

    const id = broadcastId
    const selected = recipients.length
    /**
     * `datetime-local` no trae zona: `new Date('2026-09-15T09:00')` lo lee como
     * hora LOCAL del navegador y `toISOString()` lo pasa a UTC. Es lo que el
     * operador espera ("mañana a las 9, mi hora"), y por eso el label lo dice.
     */
    const scheduledAt = scheduledDate ? scheduledDate.toISOString() : undefined

    try {
      try {
        await sendBroadcastNotification({
          data: {
            broadcastId: id,
            userIds: recipients.map((r) => r.id),
            title: titleTrim,
            body: bodyTrim,
            scheduledAt,
          },
        })
      } catch (cause) {
        // El id NO se toca: el reintento tiene que ser la misma campaña.
        setError(readableBroadcastError(cause))
        return
      }

      /**
       * El 204 no dice cuántas se crearon, así que se le pregunta a Postgres.
       * Si ESTA lectura falla, el envío igual salió — se informa aparte, sin
       * tratarlo como un error del envío (que invitaría a reenviar).
       */
      let summary: BroadcastResult | null = null
      let readError: string | null = null
      try {
        summary = await getBroadcastResult({ data: { broadcastId: id } })
      } catch (cause) {
        readError = readableBroadcastError(cause)
      }

      setResult({ broadcastId: id, selected, scheduledAt: scheduledAt ?? null, summary, readError })

      // Campaña nueva: borrador limpio e id nuevo.
      clearRecipients()
      setTitle('')
      setBody('')
      setScheduleLocal('')
      setAttempted(false)
      setBroadcastId(crypto.randomUUID())

      // Lo que quedó lo sabe Postgres: recargar el listado es preguntar.
      void router.invalidate()
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <BellPlus className="size-3.5" aria-hidden />
          Nueva notificación
        </Button>
      </SheetTrigger>

      <SheetContent side="right" className="w-full max-w-full bg-card sm:w-[34rem]">
        <form
          className="flex h-full min-h-0 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="border-b border-border px-5 py-4 pr-10">
            <SheetTitle>Nueva notificación</SheetTitle>
            <SheetDescription className="mt-0.5 leading-relaxed">
              Push a usuarios elegidos a mano. Sale como{' '}
              <span className="text-foreground">Anuncio</span>, sin link a ninguna
              pantalla de la app.
            </SheetDescription>
          </div>

          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
            {result ? (
              <SentResult result={result} onNavigate={() => setOpen(false)} onDismiss={() => setResult(null)} />
            ) : null}

            <section className="space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Destinatarios
                </span>
                <span
                  className={cn(
                    'text-xs tabular-nums',
                    full ? 'text-status-yellow' : 'text-muted-foreground',
                  )}
                >
                  {formatInt(recipients.length)} / {formatInt(BROADCAST_MAX_RECIPIENTS)}
                </span>
              </div>

              <div className="flex gap-1.5">
                <ModeTab active={mode === 'manual'} disabled={busy} onClick={() => setMode('manual')}>
                  Buscar a mano
                </ModeTab>
                <ModeTab
                  active={mode === 'conditions'}
                  disabled={busy}
                  onClick={() => setMode('conditions')}
                >
                  Por condición
                </ModeTab>
              </div>

              {mode === 'manual' ? (
                <RecipientSearch
                  selectedIds={recipients.map((r) => r.id)}
                  full={full}
                  disabled={busy}
                  onAdd={addRecipient}
                />
              ) : (
                <AudienceBuilder disabled={busy} onUse={useAudience} />
              )}

              {recipients.length > 0 ? (
                <div className="space-y-2">
                  {audienceNote ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Cargados por condición: <span className="text-foreground">{audienceNote}</span>.
                      Se pueden sacar de a uno con la ✕ del chip.
                    </p>
                  ) : null}

                  <ul className="flex flex-wrap gap-1.5">
                    {(showAllRecipients ? recipients : recipients.slice(0, CHIP_PREVIEW_COUNT)).map(
                      (r) => (
                        <li key={r.id}>
                          <RecipientChip
                            recipient={r}
                            disabled={busy}
                            onRemove={() => removeRecipient(r.id)}
                          />
                        </li>
                      ),
                    )}
                  </ul>

                  {recipients.length > CHIP_PREVIEW_COUNT ? (
                    <button
                      type="button"
                      onClick={() => setShowAllRecipients((v) => !v)}
                      className="rounded text-xs text-muted-foreground underline decoration-dotted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      {showAllRecipients
                        ? 'ver menos'
                        : `ver los ${formatInt(recipients.length)}`}
                    </button>
                  ) : null}

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {withoutDevice > 0 ? (
                      <p className="text-xs leading-relaxed text-status-yellow">
                        {formatInt(withoutDevice)} sin dispositivo registrado: no les va a
                        llegar. Su notificación se crea igual y queda en «Sin token».
                      </p>
                    ) : (
                      <span />
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={clearRecipients}
                      className="rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
                    >
                      quitar todos
                    </button>
                  </div>
                </div>
              ) : null}

              {full ? (
                <p className="text-xs leading-relaxed text-status-yellow">
                  Llegaste al tope de {formatInt(BROADCAST_MAX_RECIPIENTS)} por envío. Es del
                  backend y no se configura: para más, hacé otro envío.
                </p>
              ) : null}
            </section>

            <section className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <label
                  htmlFor="broadcast-title"
                  className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
                >
                  Título
                </label>
                <CharCounter length={titleTrim.length} max={BROADCAST_TITLE_MAX} />
              </div>
              <Input
                id="broadcast-title"
                value={title}
                disabled={busy}
                autoComplete="off"
                placeholder="Cargá la VTV de tu vehículo"
                aria-invalid={titleTrim.length > BROADCAST_TITLE_MAX || undefined}
                onChange={(e) => setTitle(e.currentTarget.value)}
                className="shadow-none"
              />
            </section>

            <section className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <label
                  htmlFor="broadcast-body"
                  className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
                >
                  Mensaje
                </label>
                <CharCounter length={bodyTrim.length} max={BROADCAST_BODY_MAX} />
              </div>
              <Textarea
                id="broadcast-body"
                value={body}
                disabled={busy}
                rows={4}
                placeholder="Todavía no cargaste la VTV. Cargala para que te avisemos antes de que venza."
                aria-invalid={bodyTrim.length > BROADCAST_BODY_MAX || undefined}
                onChange={(e) => setBody(e.currentTarget.value)}
                className="min-h-24 shadow-none"
              />
            </section>

            <section className="space-y-1.5">
              <label
                htmlFor="broadcast-schedule"
                className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                Programar <span className="normal-case tracking-normal text-muted-foreground/70">(opcional)</span>
              </label>
              <Input
                id="broadcast-schedule"
                type="datetime-local"
                value={scheduleLocal}
                disabled={busy}
                aria-invalid={scheduleInvalid || scheduleInPast || undefined}
                onChange={(e) => setScheduleLocal(e.currentTarget.value)}
                className="w-full shadow-none sm:w-64"
              />
              <p
                className={cn(
                  'text-xs leading-relaxed',
                  scheduleInvalid || scheduleInPast ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {scheduleInvalid
                  ? 'Esa fecha no se puede leer.'
                  : scheduleInPast
                    ? 'Esa fecha ya pasó. Dejalo vacío para mandarlo ahora.'
                    : 'Hora local de tu navegador; se guarda en UTC. Vacío = ahora (sale en el próximo minuto).'}
              </p>
            </section>
          </div>

          <div className="space-y-3 border-t border-border px-5 py-4">
            {error ? (
              <div className="rounded-md border border-destructive/30 bg-status-red-bg p-3">
                <p role="alert" className="text-xs leading-relaxed text-destructive">
                  {error}
                </p>
              </div>
            ) : null}

            {attempted && !busy ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Este borrador ya se intentó enviar. Reintentar es seguro: el mismo envío no
                duplica. Pero si el intento anterior llegó al backend, cambiar el texto no
                le cambia el mensaje a quien ya lo tenía.
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground" role={busy ? 'status' : undefined}>
                {busy
                  ? 'Enviando…'
                  : recipients.length > 0
                    ? `${formatInt(recipients.length)} destinatario${recipients.length === 1 ? '' : 's'}`
                    : 'Sin destinatarios todavía'}
              </p>
              <Button type="submit" size="sm" disabled={!canSend} className="gap-1.5">
                <Send className={cn('size-3.5', busy && 'animate-pulse')} aria-hidden />
                {busy ? 'Enviando…' : scheduledDate && !scheduleInvalid ? 'Programar envío' : 'Enviar'}
              </Button>
            </div>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}

/**
 * El selector de cómo se eligen los destinatarios.
 *
 * Es un `<button>` local y no el `<Chip>` de `~/components/Filters`: ese chip
 * modela un FILTRO de listado (con `aria-pressed`, tono `warn` para los filtros
 * problemáticos y el verde de marca para "seleccionado"). Acá son dos modos
 * excluyentes de un formulario, que es otra cosa — y estirarle una tercera
 * semántica al chip compartido es cómo empiezan los componentes que no se pueden
 * cambiar sin romper tres pantallas.
 */
function ModeTab({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        'rounded-md border px-2.5 py-1 text-xs transition-colors',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:opacity-50',
        active
          ? 'border-brand bg-brand-soft text-brand'
          : 'border-border bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

interface SentSummary {
  broadcastId: string
  selected: number
  scheduledAt: string | null
  summary: BroadcastResult | null
  readError: string | null
}

/**
 * El resultado de un envío exitoso.
 *
 * "N creadas de M" y no "enviada a M": el 204 sólo dice que el backend dio de
 * alta lo que correspondía. Quien silenció los anuncios no tiene fila, y la
 * entrega recién pasa en el próximo tick del cron.
 */
function SentResult({
  result,
  onNavigate,
  onDismiss,
}: {
  result: SentSummary
  onNavigate: () => void
  onDismiss: () => void
}) {
  const { summary } = result
  const missing = summary ? result.selected - summary.created : 0

  return (
    <div className="rounded-md border border-status-green/20 bg-status-green-bg p-3 text-xs leading-relaxed">
      <div className="flex items-start gap-2">
        <p className="font-medium text-status-green">
          {summary
            ? `${formatInt(summary.created)} notificaci${summary.created === 1 ? 'ón creada' : 'ones creadas'} de ${formatInt(result.selected)} destinatario${result.selected === 1 ? '' : 's'}.`
            : `Envío aceptado por el backend para ${formatInt(result.selected)} destinatario${result.selected === 1 ? '' : 's'}.`}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Cerrar resultado"
          className="ml-auto rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>

      <div className="mt-1.5 space-y-1.5 text-muted-foreground">
        {summary && summary.byState.length > 0 ? (
          <p>
            {summary.byState
              .map((s) => `${formatInt(s.count)} ${NOTIFICATION_STATE_LABELS[s.state].toLowerCase()}`)
              .join(' · ')}
          </p>
        ) : null}

        {missing > 0 ? (
          <p>
            {formatInt(missing)} no tiene{missing === 1 ? '' : 'n'} fila: lo más probable es que
            haya{missing === 1 ? '' : 'n'} silenciado los anuncios en la app. El backend los saltea
            sin error.
          </p>
        ) : null}

        {result.readError ? (
          <p>No se pudo leer cuántas quedaron creadas ({result.readError}). El envío sí salió.</p>
        ) : null}

        <p>
          {result.scheduledAt
            ? `Programado para ${formatDateTime(result.scheduledAt)} (UTC).`
            : 'Sale en el próximo minuto, cuando corra el cron de entrega.'}{' '}
          Quien no tenga dispositivo queda en «Sin token».
        </p>

        {/* Al detalle del envío, no al listado filtrado: ahí está el estado de
            cada fila Y lo que hizo cada persona después. El listado filtrado
            sigue a un click, desde esa misma pantalla. */}
        <Link
          to="/notificaciones/envios/$broadcastId"
          params={{ broadcastId: result.broadcastId }}
          onClick={onNavigate}
          className="inline-block rounded font-medium text-foreground underline decoration-dotted outline-none hover:text-brand focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Ver el resultado de este envío
        </Link>
      </div>
    </div>
  )
}

/**
 * El buscador de destinatarios. Pregunta al servidor con debounce y descarta
 * respuestas viejas: tipear `juan` rápido dispara hasta cuatro búsquedas, y la
 * de `ju` puede volver DESPUÉS que la de `juan` y pisar la lista buena.
 */
function RecipientSearch({
  selectedIds,
  full,
  disabled,
  onAdd,
}: {
  selectedIds: Array<string>
  full: boolean
  disabled: boolean
  onAdd: (candidate: NotificationRecipient) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<NotificationRecipient>>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const latest = useRef(0)

  const trimmed = query.trim()

  useEffect(() => {
    const mine = ++latest.current

    if (trimmed.length < RECIPIENT_SEARCH_MIN_CHARS) {
      setResults([])
      setSearching(false)
      setSearchError(null)
      return
    }

    setSearching(true)
    const timer = setTimeout(() => {
      searchNotificationRecipients({ data: { q: trimmed } })
        .then((rows) => {
          if (latest.current !== mine) return
          setResults(rows)
          setSearchError(null)
        })
        .catch((cause: unknown) => {
          if (latest.current !== mine) return
          setSearchError(readableBroadcastError(cause))
        })
        .finally(() => {
          if (latest.current === mine) setSearching(false)
        })
    }, 300)

    return () => clearTimeout(timer)
  }, [trimmed])

  const selected = new Set(selectedIds)

  return (
    <div className="space-y-1.5">
      <Input
        type="search"
        value={query}
        disabled={disabled}
        autoComplete="off"
        aria-label="Buscar destinatarios por email o nombre"
        placeholder="Buscar por email o nombre"
        onChange={(e) => setQuery(e.currentTarget.value)}
        className="shadow-none"
      />

      {trimmed.length >= RECIPIENT_SEARCH_MIN_CHARS ? (
        <div className="rounded-md border border-border">
          {searchError ? (
            <p role="alert" className="px-3 py-2 text-xs text-destructive">
              {searchError}
            </p>
          ) : searching && results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground" role="status">
              Buscando…
            </p>
          ) : results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Nadie coincide con «{trimmed}».</p>
          ) : (
            <ul className={cn('max-h-56 divide-y divide-border overflow-y-auto', searching && 'opacity-60')}>
              {results.map((r) => {
                const already = selected.has(r.id)
                return (
                  <li key={r.id} className="flex items-center gap-2 px-3 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{r.name ?? r.email}</div>
                      <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        {r.name ? <span className="truncate">{r.email}</span> : null}
                        {r.pushTokens === 0 ? (
                          <span className="text-status-yellow">sin dispositivo</span>
                        ) : null}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={disabled || already || full}
                      onClick={() => onAdd(r)}
                      className="shrink-0 border border-border"
                    >
                      {already ? (
                        'agregado'
                      ) : (
                        <>
                          <Plus aria-hidden />
                          agregar
                        </>
                      )}
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : trimmed.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Escribí al menos {RECIPIENT_SEARCH_MIN_CHARS} letras.
        </p>
      ) : null}
    </div>
  )
}

function RecipientChip({
  recipient: r,
  disabled,
  onRemove,
}: {
  recipient: NotificationRecipient
  disabled: boolean
  onRemove: () => void
}) {
  const noDevice = r.pushTokens === 0

  return (
    <span
      title={noDevice ? `${r.email} — sin dispositivo registrado: no le va a llegar` : r.email}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-md border py-0.5 pl-2 pr-1 text-xs',
        noDevice
          ? 'border-status-yellow/40 bg-status-yellow-bg text-status-yellow'
          : 'border-border bg-secondary text-foreground',
      )}
    >
      <span className="truncate">{r.name ?? r.email}</span>
      {noDevice ? <span className="shrink-0 opacity-80">· sin dispositivo</span> : null}
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        aria-label={`Quitar a ${r.email}`}
        className="shrink-0 rounded p-0.5 outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  )
}

/**
 * Cuenta sobre el texto TRIMEADO, que es lo que se guarda. Ámbar desde el 90%,
 * rojo pasado el tope — pasarse no se impide tipeando, se impide enviando.
 */
function CharCounter({ length, max }: { length: number; max: number }) {
  return (
    <span
      className={cn(
        'text-xs tabular-nums',
        length > max
          ? 'text-destructive'
          : length >= max * 0.9
            ? 'text-status-yellow'
            : 'text-muted-foreground',
      )}
    >
      {formatInt(length)} / {formatInt(max)}
    </span>
  )
}
