import type { AppOpensCohort, AppOpensData, AppOpensDay } from '~/lib/app-opens'

/**
 * ⚠ MOCK — números inventados. No hay ningún registro de aperturas de la app.
 *
 * Reemplaza a: el evento `app_open` de la app + `GET /admin/app-opens/summary`
 * y `GET /admin/app-opens/retention`. Tarjeta "Medir usuarios activos reales
 * (aperturas de la app)".
 *
 * Generador con semilla fija: los mismos números en cada recarga, para que la
 * pantalla se pueda revisar. No se parecen a nada real a propósito.
 */
function seeded(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export async function fetchAppOpensMock(now: Date = new Date()): Promise<AppOpensData> {
  const rand = seeded(20261029)
  const totalDays = 120
  const dau: Array<number> = []
  for (let i = 0; i < totalDays; i++) {
    const weekend = new Date(now.getTime() - (totalDays - 1 - i) * 86_400_000).getUTCDay() % 6 === 0
    dau.push(Math.round((weekend ? 28 : 42) + i * 0.15 + rand() * 14))
  }

  const days: Array<AppOpensDay> = []
  for (let i = totalDays - 90; i < totalDays; i++) {
    const date = isoDay(new Date(now.getTime() - (totalDays - 1 - i) * 86_400_000))
    const sum = (n: number) => dau.slice(Math.max(0, i - n + 1), i + 1).reduce((a, v) => a + v, 0)
    days.push({
      date,
      dau: dau[i]!,
      // Distintos en la ventana: menos que la suma (la misma persona abre varios días).
      wau: Math.round(sum(7) * 0.55),
      mau: Math.round(sum(30) * 0.28),
      valuable: Math.round(dau[i]! * (0.25 + rand() * 0.15)),
    })
  }

  const cohorts: Array<AppOpensCohort> = []
  const monday = new Date(now)
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
  for (let w = 9; w >= 0; w--) {
    const start = new Date(monday.getTime() - w * 7 * 86_400_000)
    const ageDays = Math.floor((now.getTime() - start.getTime()) / 86_400_000)
    const size = Math.round(18 + rand() * 20)
    const d1 = Math.round(size * (0.45 + rand() * 0.15))
    const d7 = Math.round(size * (0.25 + rand() * 0.12))
    const d30 = Math.round(size * (0.12 + rand() * 0.08))
    cohorts.push({
      cohortWeek: isoDay(start),
      size,
      d1: ageDays >= 7 ? d1 : null,
      d7: ageDays >= 13 ? d7 : null,
      d30: ageDays >= 36 ? d30 : null,
    })
  }

  return { days, cohorts }
}
