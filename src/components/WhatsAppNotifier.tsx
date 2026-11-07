import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { listWhatsAppConversationsFn, whatsappConversationChangesFn } from '~/fn/whatsapp-inbox'
import type { WhatsAppConversation } from '~/lib/whatsapp-inbox'
import { usePolling } from '~/components/WhatsAppInbox'

/**
 * El «llegó un mensaje» de la bandeja de WhatsApp, fuera de `/whatsapp`:
 * el puntito del ítem del menú y el sonido.
 *
 * Un solo estado de módulo (`useSyncExternalStore`) que alimentan DOS
 * sondeos que nunca corren juntos:
 *   - en `/whatsapp`, el del `WhatsAppInboxProvider` (que ya sondea);
 *   - en cualquier otra pantalla, `useWhatsAppBackgroundPoll` desde el shell.
 * Así no se duplican pedidos contra el rate limit del backend.
 *
 * Qué es «mensaje nuevo»: una conversación no leída cuyo último mensaje es
 * ENTRANTE y cuyo id no habíamos visto. La primera carga sólo siembra lo visto
 * (sin sonar): abrir el panel con 3 no leídas no es que te llegaron 3 recién.
 *
 * ⚠ PII: acá no se loguea nada. Ni el número ni el texto pasan por este módulo
 * más allá de los ids.
 */

// ── Estado ──────────────────────────────────────────────────────────────────

const SOUND_KEY = 'autolibre.whatsapp.sound'

let unread: number | null = null
let soundOn = readSoundPref()
const listeners = new Set<() => void>()
/** conversationId → id del último entrante ya visto. */
const seen = new Map<string, string>()

function emit() {
  for (const l of listeners) l()
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

function readSoundPref(): boolean {
  try {
    return typeof window === 'undefined' || window.localStorage.getItem(SOUND_KEY) !== 'off'
  } catch {
    return true
  }
}

export function reportWhatsAppUnread(n: number) {
  if (unread === n) return
  unread = n
  emit()
}

/** Conversaciones no leídas; `null` mientras no se sepa (no se pinta nada). */
export function useWhatsAppUnread(): number | null {
  return useSyncExternalStore(subscribe, () => unread, () => null)
}

export function useWhatsAppSound(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, () => soundOn, () => true)
  const set = useCallback((next: boolean) => {
    soundOn = next
    try {
      window.localStorage.setItem(SOUND_KEY, next ? 'on' : 'off')
    } catch {
      // Sin storage (modo privado): vale para esta pestaña y nada más.
    }
    if (next) void playPing() // suena al activarlo: es la prueba de que anda.
    emit()
  }, [])
  return [on, set]
}

/**
 * Registra lo que trajo un lote y suena si hay un entrante nuevo.
 * `silent` para la primera carga; `openConversationId` no suena si ese hilo
 * está abierto y la pestaña a la vista (ya lo estás mirando).
 */
export function noteWhatsAppConversations(
  items: ReadonlyArray<WhatsAppConversation>,
  opts: { silent?: boolean; openConversationId?: string } = {},
) {
  let fresh = false
  for (const c of items) {
    const last = c.lastMessage
    if (!last || last.direction !== 'inbound' || !c.unread) continue
    if (seen.get(c.id) === last.id) continue
    seen.set(c.id, last.id)
    const watching = c.id === opts.openConversationId && typeof document !== 'undefined' && !document.hidden
    if (!watching) fresh = true
  }
  if (fresh && !opts.silent && soundOn) void playPing()
}

// ── Sonido ──────────────────────────────────────────────────────────────────

/**
 * Sintetizado con Web Audio: sin archivo que servir ni licencia que cuidar.
 * El navegador no deja sonar hasta que la persona interactúa con la página
 * (autoplay policy): `unlockAudio` se engancha al primer click o tecla.
 */
let audio: AudioContext | null = null

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!audio) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    audio = new Ctor()
  }
  return audio
}

function unlockAudio() {
  const ctx = context()
  if (ctx && ctx.state === 'suspended') void ctx.resume()
}

async function playPing() {
  const ctx = context()
  if (!ctx) return
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume()
    } catch {
      return
    }
    if ((ctx.state as AudioContextState) !== 'running') return // todavía sin interacción: no se puede.
  }
  const t0 = ctx.currentTime
  // Dos notas cortas, ascendentes, suaves.
  for (const [freq, at] of [
    [880, 0],
    [1320, 0.12],
  ] as const) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0.0001, t0 + at)
    gain.gain.exponentialRampToValueAtTime(0.18, t0 + at + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.22)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t0 + at)
    osc.stop(t0 + at + 0.25)
  }
}

/** En el shell: desbloquea el audio con la primera interacción. */
export function useUnlockAudioOnInteraction() {
  useEffect(() => {
    const onFirst = () => {
      unlockAudio()
      window.removeEventListener('pointerdown', onFirst)
      window.removeEventListener('keydown', onFirst)
    }
    window.addEventListener('pointerdown', onFirst)
    window.addEventListener('keydown', onFirst)
    return () => {
      window.removeEventListener('pointerdown', onFirst)
      window.removeEventListener('keydown', onFirst)
    }
  }, [])
}

// ── Sondeo de fondo (fuera de /whatsapp) ────────────────────────────────────

/**
 * Más lento que el de la bandeja: acá sólo importa enterarse. Sigue con la
 * pestaña OCULTA — es justo cuando sirve el sonido (el navegador igual frena
 * los timers de una pestaña en segundo plano).
 */
const BACKGROUND_POLL_MS = 20_000

export function useWhatsAppBackgroundPoll(enabled: boolean) {
  const cursor = useRef<string | null>(null)

  const run = useCallback(async (signal: AbortSignal) => {
    if (cursor.current === null) {
      const page = await listWhatsAppConversationsFn({ data: {}, signal })
      noteWhatsAppConversations(page.items, { silent: true })
      reportWhatsAppUnread(page.unreadConversations)
      cursor.current = page.changesAfter
      return
    }
    let more = true
    while (more) {
      const res = await whatsappConversationChangesFn({ data: { after: cursor.current }, signal })
      noteWhatsAppConversations(res.items)
      reportWhatsAppUnread(res.unreadConversations)
      cursor.current = res.nextAfter
      more = res.hasMore
    }
  }, [])

  // Al volver de /whatsapp se arranca con una carga fresca (el cursor viejo puede haber vencido).
  useEffect(() => {
    if (enabled) cursor.current = null
  }, [enabled])

  const wrapped = useCallback(
    async (signal: AbortSignal) => {
      try {
        await run(signal)
      } catch (cause) {
        // Cursor vencido o cualquier error: la próxima vuelta recarga desde cero.
        cursor.current = null
        throw cause
      }
    },
    [run],
  )

  const poke = usePolling(wrapped, BACKGROUND_POLL_MS, enabled, { whileHidden: true })
  // Primera carga inmediata, no a los 20 s.
  useEffect(() => {
    if (enabled) poke()
  }, [enabled, poke])
}
