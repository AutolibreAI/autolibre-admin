/**
 * Tableros de las alianzas (`/alianzas`) — tarjeta de Trello «Panel admin:
 * sección de tableros de control de partners». Acá "partner" es la ALIANZA
 * comercial (Sin Fotomultas, Chasis, Moni…), no el `Partner` del marketplace
 * (un taller): por eso en el panel se llama «Alianzas» (regla dura 7).
 *
 * Al 2026-11-25 ninguna alianza tiene API ni export conocido: la sección son
 * ACCESOS. Para sumar métricas hace falta que la alianza exponga algo; si eso
 * pide backend, pasa a Ramiro.
 *
 * Un link que da acceso sin login (Sin Fotomultas) NO va en el código: vive en
 * una variable del SERVIDOR (sin `VITE_`) y se entrega por un server function
 * con `adminMiddleware`, como los tableros de PostHog. Un link a una página con
 * login propio sí puede ir acá.
 *
 * Para sumar una alianza: una entrada más. Sin `url` ni `envVar`, aparece como
 * «sin tablero todavía».
 */
export interface AllianceDashboardDef {
  key: string
  name: string
  what: string
  /** URL pública (página con login propio). */
  url?: string
  /** Variable del servidor con el link (para links que dan acceso sin login). */
  envVar?: string
  access: string
}

export const ALLIANCE_DASHBOARDS: ReadonlyArray<AllianceDashboardDef> = [
  {
    key: 'sinfotomultas',
    name: 'Sin Fotomultas',
    what: 'Reclamos de multas derivados por AutoLibre.',
    envVar: 'ALLIANCE_DASHBOARD_SINFOTOMULTAS_URL',
    access: 'Se abre sólo con el link, sin login. No lo compartas fuera del equipo.',
  },
  {
    key: 'chasis',
    name: 'Chasis',
    what: 'Informes y referidos de la API de datos vehiculares.',
    url: 'https://www.chasis.com.ar/partners',
    access: 'Pide login con la cuenta de AutoLibre.',
  },
  { key: 'asistir24', name: 'Asistir24', what: 'Asistencia mecánica.', access: 'Sin tablero todavía.' },
  { key: 'esquina-neumatico', name: 'La Esquina del Neumático', what: 'Neumáticos.', access: 'Sin tablero todavía.' },
  { key: 'moni', name: 'Moni', what: 'Financiación en cuotas.', access: 'Sin tablero todavía.' },
]

export interface AllianceDashboard {
  key: string
  name: string
  what: string
  access: string
  /** `null` = sin tablero, o falta configurar la variable. */
  url: string | null
  /** La variable que falta configurar, si es el caso. */
  missingEnv: string | null
}
