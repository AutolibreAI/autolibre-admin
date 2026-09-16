import { z } from 'zod'

/**
 * Audiencias — armar a mano el grupo de usuarios al que va una notificación.
 *
 * ── Qué consulta reemplaza ───────────────────────────────────────────────────
 *
 * El `select u.id, u.email from users u where <condición>` que hoy hay que
 * escribir en DBeaver para después pegar los uuid de a uno en el compositor de
 * `/notificaciones`. Con 48 usuarios sin vehículo cargado eso no se hace: se
 * manda de a uno, o no se manda.
 *
 * ── Por qué un catálogo cerrado y no un armador de SQL ───────────────────────
 *
 * Un server function es un endpoint HTTP público (`.claude/rules/users.md`,
 * trampa 8). Un campo de texto que viaje hasta el `where` es una inyección, y
 * ni siquiera hace falta mala fe: alcanza con un typo para barrer la base.
 *
 * Lo que viaja es `{field, op, value}` con **`field` y `op` de enums cerrados**
 * y `value` un entero validado. La expresión SQL de cada campo vive en
 * `~/server/audience.repo`, en un `Record` que los tipos obligan a cubrir —
 * mismo patrón exacto que `SORT_COLUMNS` en `users.repo.ts`, que es lo único
 * que hace seguro interpolar algo en una consulta.
 *
 * Consecuencia que hay que aceptar: **una condición que no está en este archivo
 * no se puede pedir.** Agregarla son dos líneas (acá y en el repo), no un campo
 * de texto libre.
 *
 * ── Las condiciones se combinan con Y, nunca con O ───────────────────────────
 *
 * Todas las condiciones de una audiencia se cumplen a la vez. No hay `OR` y no
 * es un olvido: un armador con O necesita paréntesis, y un paréntesis mal puesto
 * le manda un push a gente que no corresponde sin que nada lo delate. Si hace
 * falta una unión, son dos envíos.
 */

// ── Campos ───────────────────────────────────────────────────────────────────

/**
 * Qué mide un campo. Decide qué operadores se ofrecen y si el operador pide un
 * número:
 *
 *  - `count`  → un conteo de filas (`= 0`, `>= 1`, `<= 3`).
 *  - `days`   → un timestamp leído como "hace cuántos días"; `null` = nunca.
 *  - `expiry` → la fecha de vencimiento MÁS PRÓXIMA de un documento vigente;
 *               `null` = no tiene ninguno cargado.
 *  - `flag`   → un sí/no sobre la fila de `users`.
 */
export type AudienceFieldKind = 'count' | 'days' | 'expiry' | 'flag'

export const AUDIENCE_FIELD_KEYS = [
  // Uso de la app
  'vehicles',
  'scansOk',
  'scansTotal',
  'chats',
  'maintenanceUpcoming',
  // Documentos cargados
  'insurances',
  'inspections',
  'registrationCards',
  'driverLicenses',
  // Vencimientos
  'vtvExpiry',
  'insuranceExpiry',
  'licenseExpiry',
  'registrationExpiry',
  // Multas
  'pendingFines',
  // Actividad
  'signup',
  'lastActivity',
  'lastScan',
  'lastChat',
  // Cuenta y entrega
  'pushTokens',
  'announcementsReceived',
  'isAdmin',
  'isInternal',
  'isLegacyNative',
] as const
export type AudienceFieldKey = (typeof AUDIENCE_FIELD_KEYS)[number]

export const AUDIENCE_GROUPS = [
  'Uso de la app',
  'Documentos',
  'Vencimientos',
  'Multas',
  'Actividad',
  'Cuenta y entrega',
] as const
export type AudienceGroup = (typeof AUDIENCE_GROUPS)[number]

export interface AudienceFieldDef {
  label: string
  group: AudienceGroup
  kind: AudienceFieldKind
  /** Qué mide exactamente. Se muestra al elegirlo: el corte no se adivina. */
  hint: string
  /**
   * Operadores propios, cuando no son todos los de su `kind`. `signup` no puede
   * ser "nunca": `users.created_at` es NOT NULL.
   */
  ops?: ReadonlyArray<AudienceOperator>
}

/**
 * El catálogo. Cada entrada tiene su expresión SQL en `AUDIENCE_SQL`
 * (`~/server/audience.repo`); los tipos no dejan agregar una sin la otra.
 *
 * Los cortes NO se inventan — cada uno repite un predicado que alguna pantalla
 * del panel ya usa, y el `hint` lo dice para que se pueda verificar:
 *
 *  - `scansOk` es el `completed` + `total_readings > 0` de `scanners.repo.ts`.
 *  - `chats` exige al menos un mensaje, como `usageAdoption` en `ops.repo.ts`
 *    (48 de 70 conversaciones no tienen ninguno → `.claude/rules/chats.md`).
 *  - `pendingFines` es el `status = 'pending'` de `fines.repo.ts`.
 *  - `isInternal` es `INTERNAL_PREDICATE`, el mismo de `ops.v_ai_usage`.
 */
export const AUDIENCE_FIELDS: Record<AudienceFieldKey, AudienceFieldDef> = {
  vehicles: {
    label: 'Vehículos cargados',
    group: 'Uso de la app',
    kind: 'count',
    hint: 'Autos no archivados. Igual a 0 es "se registró y nunca cargó el auto".',
  },
  scansOk: {
    label: 'Escaneos que trajeron datos',
    group: 'Uso de la app',
    kind: 'count',
    hint: 'Sesiones completadas con al menos una lectura — el mismo corte que /escaneres.',
  },
  scansTotal: {
    label: 'Intentos de escaneo',
    group: 'Uso de la app',
    kind: 'count',
    hint: 'Todas las sesiones, hayan traído datos o no.',
  },
  chats: {
    label: 'Chats con el asistente',
    group: 'Uso de la app',
    kind: 'count',
    hint: 'Conversaciones con al menos un mensaje: una vacía no es uso.',
  },
  maintenanceUpcoming: {
    label: 'Mantenimientos pendientes',
    group: 'Uso de la app',
    kind: 'count',
    hint: 'Ocurrencias sin fecha de realizado y no archivadas.',
  },

  insurances: {
    label: 'Seguros cargados',
    group: 'Documentos',
    kind: 'count',
    hint: 'Pólizas no archivadas, las suba el usuario o las extraiga el OCR.',
  },
  inspections: {
    label: 'VTV cargadas',
    group: 'Documentos',
    kind: 'count',
    hint: 'Incluye las que trajo la consulta por patente, no sólo las que subió.',
  },
  registrationCards: {
    label: 'Cédulas cargadas',
    group: 'Documentos',
    kind: 'count',
    hint: 'Cédulas no archivadas.',
  },
  driverLicenses: {
    label: 'Licencias cargadas',
    group: 'Documentos',
    kind: 'count',
    hint: 'Registros de conducir no archivados. Cuelgan del usuario, no del auto.',
  },

  vtvExpiry: {
    label: 'Vencimiento de VTV',
    group: 'Vencimientos',
    kind: 'expiry',
    hint: 'El vencimiento MÁS PRÓXIMO entre sus autos. "No tiene" = ninguna VTV cargada.',
  },
  insuranceExpiry: {
    label: 'Vencimiento del seguro',
    group: 'Vencimientos',
    kind: 'expiry',
    hint: 'El más próximo entre sus pólizas no archivadas.',
  },
  licenseExpiry: {
    label: 'Vencimiento de la licencia',
    group: 'Vencimientos',
    kind: 'expiry',
    hint: 'El más próximo entre sus registros de conducir.',
  },
  registrationExpiry: {
    label: 'Vencimiento de la cédula',
    group: 'Vencimientos',
    kind: 'expiry',
    hint: 'El más próximo entre sus cédulas.',
  },

  pendingFines: {
    label: 'Multas adeudadas',
    group: 'Multas',
    kind: 'count',
    hint: 'Multas pendientes de sus autos — el mismo corte que /leads/multas.',
  },

  signup: {
    label: 'Se registró',
    group: 'Actividad',
    kind: 'days',
    hint: 'La fecha de alta. Sirve para hablarle sólo a los recién llegados.',
    ops: ['moreThan', 'lessThan'],
  },
  lastActivity: {
    label: 'Última señal de actividad',
    group: 'Actividad',
    kind: 'days',
    hint: 'Cargó un auto, habló con el asistente o escaneó. "Nunca" = se registró y nada más.',
  },
  lastScan: {
    label: 'Último escaneo',
    group: 'Actividad',
    kind: 'days',
    hint: 'Cualquier sesión, haya traído datos o no.',
  },
  lastChat: {
    label: 'Último chat',
    group: 'Actividad',
    kind: 'days',
    hint: 'La conversación más reciente, tenga mensajes o no.',
  },

  pushTokens: {
    label: 'Dispositivos registrados',
    group: 'Cuenta y entrega',
    kind: 'count',
    hint: 'Con 0 la notificación se crea igual y queda «Sin token», reintentando para siempre.',
  },
  announcementsReceived: {
    label: 'Anuncios ya recibidos',
    group: 'Cuenta y entrega',
    kind: 'count',
    hint: 'Envíos ad-hoc que ya tiene. Sirve para no repetirle siempre a los mismos.',
  },
  isAdmin: {
    label: 'Es admin',
    group: 'Cuenta y entrega',
    kind: 'flag',
    hint: 'Casi siempre se los quiere excluir de una campaña.',
  },
  isInternal: {
    label: 'Es cuenta interna',
    group: 'Cuenta y entrega',
    kind: 'flag',
    hint: 'Su dominio está en ops.excluded_email_domains — el mismo predicado que las métricas.',
  },
  isLegacyNative: {
    label: 'Es cuenta native heredada',
    group: 'Cuenta y entrega',
    kind: 'flag',
    hint: 'Pre-Clerk. En producción hoy son 0; en desarrollo son cientos. → CLAUDE.md',
  },
}

// ── Operadores ───────────────────────────────────────────────────────────────

export const AUDIENCE_OPERATORS = [
  // count
  'eq',
  'gte',
  'lte',
  // days
  'moreThan',
  'lessThan',
  'never',
  'ever',
  // expiry
  'expired',
  'withinDays',
  'valid',
  'missing',
  // flag
  'yes',
  'no',
] as const
export type AudienceOperator = (typeof AUDIENCE_OPERATORS)[number]

/** Qué operadores ofrece cada tipo de campo, y en qué orden se muestran. */
export const OPERATORS_BY_KIND: Record<AudienceFieldKind, ReadonlyArray<AudienceOperator>> = {
  count: ['eq', 'gte', 'lte'],
  days: ['moreThan', 'lessThan', 'never', 'ever'],
  expiry: ['expired', 'withinDays', 'valid', 'missing'],
  flag: ['yes', 'no'],
}

/**
 * Los operadores que piden un número. Mandar `value` fuera de esta lista es un
 * error de validación y no un campo que se ignora en silencio: un `value` que
 * no se usa es casi siempre un operador elegido mal.
 */
export const OPERATORS_WITH_VALUE: ReadonlyArray<AudienceOperator> = [
  'eq',
  'gte',
  'lte',
  'moreThan',
  'lessThan',
  'withinDays',
]

export const AUDIENCE_OPERATOR_LABELS: Record<AudienceOperator, string> = {
  eq: 'es igual a',
  gte: 'es al menos',
  lte: 'es como mucho',
  moreThan: 'fue hace más de',
  lessThan: 'fue hace menos de',
  never: 'nunca pasó',
  ever: 'pasó alguna vez',
  expired: 'ya venció',
  withinDays: 'vence dentro de',
  valid: 'está vigente',
  missing: 'no tiene ninguno cargado',
  yes: 'sí',
  no: 'no',
}

/** El sufijo del valor, por operador. `null` = el operador no lleva número. */
export const AUDIENCE_OPERATOR_SUFFIX: Record<AudienceOperator, string | null> = {
  eq: null,
  gte: null,
  lte: null,
  moreThan: 'días',
  lessThan: 'días',
  never: null,
  ever: null,
  expired: null,
  withinDays: 'días',
  valid: null,
  missing: null,
  yes: null,
  no: null,
}

export function operatorsFor(field: AudienceFieldKey): ReadonlyArray<AudienceOperator> {
  const def = AUDIENCE_FIELDS[field]
  return def.ops ?? OPERATORS_BY_KIND[def.kind]
}

export function operatorNeedsValue(op: AudienceOperator): boolean {
  return OPERATORS_WITH_VALUE.includes(op)
}

// ── El payload ───────────────────────────────────────────────────────────────

/**
 * Tope de un `value`. 3650 son diez años: cualquier cosa más grande es un dedo
 * apoyado en una tecla, no una condición.
 */
export const AUDIENCE_VALUE_MAX = 3650

/** Tope de condiciones por audiencia. Ocho ya es una consulta que nadie lee. */
export const AUDIENCE_MAX_CONDITIONS = 8

export const audienceConditionSchema = z
  .object({
    field: z.enum(AUDIENCE_FIELD_KEYS),
    op: z.enum(AUDIENCE_OPERATORS),
    value: z.number().int().min(0).max(AUDIENCE_VALUE_MAX).optional(),
  })
  .superRefine((c, ctx) => {
    // El operador tiene que pertenecer al campo. Sin esto, `{field: 'isAdmin',
    // op: 'withinDays'}` armaría un `where` sin sentido en vez de rebotar.
    if (!operatorsFor(c.field).includes(c.op)) {
      ctx.addIssue({
        code: 'custom',
        path: ['op'],
        message: `«${AUDIENCE_OPERATOR_LABELS[c.op]}» no aplica a «${AUDIENCE_FIELDS[c.field].label}».`,
      })
      return
    }

    const needs = operatorNeedsValue(c.op)
    if (needs && c.value === undefined) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Falta el número.' })
    }
    if (!needs && c.value !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Ese operador no lleva número.' })
    }
  })

export type AudienceCondition = z.infer<typeof audienceConditionSchema>

export const audienceSchema = z.object({
  conditions: z
    .array(audienceConditionSchema)
    .min(1, 'Agregá al menos una condición.')
    .max(AUDIENCE_MAX_CONDITIONS, `Hasta ${AUDIENCE_MAX_CONDITIONS} condiciones.`),
})

export type AudienceInput = z.infer<typeof audienceSchema>

// ── Texto ────────────────────────────────────────────────────────────────────

/**
 * Una condición en castellano, para el chip y para el resumen del envío.
 *
 * Se arma acá y no en el componente porque la usan tres lugares (el armador, el
 * resumen del compositor y el aviso de corte): una audiencia descrita distinto
 * en dos pantallas es la misma clase de bug que un chip copiado.
 */
export function describeCondition(c: AudienceCondition): string {
  const field = AUDIENCE_FIELDS[c.field]
  const op = AUDIENCE_OPERATOR_LABELS[c.op]
  const suffix = AUDIENCE_OPERATOR_SUFFIX[c.op]

  if (c.value === undefined) return `${field.label}: ${op}`
  return `${field.label}: ${op} ${c.value}${suffix ? ` ${suffix}` : ''}`
}

export function describeAudience(conditions: ReadonlyArray<AudienceCondition>): string {
  return conditions.map(describeCondition).join(' · ')
}

// ── Vista previa ─────────────────────────────────────────────────────────────

/**
 * Lo que devuelve la vista previa.
 *
 * `matched` es el total REAL de la condición; `recipients` viene cortado al tope
 * del backend. Los dos números están porque son distintos y la diferencia
 * importa: mandarle a 500 de 1300 sin decirlo es la peor versión de esta
 * pantalla.
 */
export interface AudiencePreview {
  matched: number
  /** De los que matchean, cuántos no tienen dispositivo: no les va a llegar. */
  withoutDevice: number
  /** Cuántos son admin o cuenta interna — casi siempre, nosotros mismos. */
  internalOrAdmin: number
  /** Cortados a `AUDIENCE_RECIPIENT_LIMIT`, los más viejos primero. */
  recipients: Array<{ id: string; email: string; name: string | null; pushTokens: number }>
}

/**
 * Tope de la resolución. Es el MISMO número que `BROADCAST_MAX_RECIPIENTS`: no
 * tiene sentido traer 900 destinatarios que el backend va a rechazar en un solo
 * lote. Vive acá y no importado de `~/lib/notifications` para que este módulo no
 * dependa del de notificaciones — una audiencia es sobre usuarios, no sobre
 * notificaciones.
 */
export const AUDIENCE_RECIPIENT_LIMIT = 500
