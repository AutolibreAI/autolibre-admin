import type { Automation, AutomationInput } from '~/lib/notification-automations'

/**
 * ⚠ MOCK — las automatizaciones por evento no tienen dónde guardarse ni motor
 * que las ejecute.
 *
 * Reemplaza a: `POST/PUT /admin/notification-rules` y
 * `POST /admin/notification-rules/:id/activate|pause` (un solo modelo de regla
 * del backend, pedido abierto desde el 2026-10-03), más el motor. Tarjeta
 * "Configurar notificaciones desde el admin (puntuales y recurrentes)".
 *
 * En memoria del navegador: se pierde al recargar, a propósito (ver
 * `service-other-review.ts`). Activar una acá no le manda nada a nadie.
 */
const store = new Map<string, Automation>()
let seq = 0

export async function listAutomationsMock(): Promise<Array<Automation>> {
  return [...store.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'))
}

export async function saveAutomationMock(
  input: AutomationInput,
  id: string | null,
  fromTemplate: string | null = null,
): Promise<Automation> {
  const prev = id ? store.get(id) : undefined
  const saved: Automation = {
    ...input,
    id: prev?.id ?? `ejemplo-${++seq}`,
    active: prev?.active ?? false,
    fromTemplate: prev?.fromTemplate ?? fromTemplate,
    updatedAt: new Date().toISOString(),
  }
  store.set(saved.id, saved)
  return saved
}

export async function setAutomationActiveMock(id: string, active: boolean): Promise<void> {
  const prev = store.get(id)
  if (prev) store.set(id, { ...prev, active, updatedAt: new Date().toISOString() })
}

export async function deleteAutomationMock(id: string): Promise<void> {
  store.delete(id)
}
