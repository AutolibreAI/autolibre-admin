/**
 * La lista ÚNICA de señales de actividad de un usuario.
 *
 * `users` no tiene `last_seen_at`. Lo más cerca que se puede estar de "cuándo
 * fue la última vez que esta persona hizo algo" es el `greatest()` de los
 * timestamps de las filas que sólo aparecen cuando el usuario hace algo:
 * cargó un auto, habló con el asistente, escaneó.
 *
 * Este archivo existe porque **dos pantallas derivan esa señal y tienen que
 * derivarla igual**:
 *
 *  - `users.repo.ts` → `last_activity_at` de la columna del listado de
 *    `/usuarios` (`null` = "se registró y no hizo nada").
 *  - `business.repo.ts` → el criterio de churn de `/negocio` (60 días corridos
 *    sin ninguna señal).
 *
 * Si cada una tuviera su propia lista, el panel diría dos cosas distintas del
 * mismo usuario sin ningún error que lo delate — la misma clase de acoplamiento
 * que `INTERNAL_PREDICATE` entre `ops.repo.ts` y `ops.v_ai_usage`. Si mañana se
 * suma una señal (una tarea de mantenimiento hecha, una consulta de VTV), se
 * suma acá y las dos pantallas la ganan a la vez.
 *
 * No inventa dominio (regla dura 8): cada señal es una fila real de una tabla
 * real. Sólo declara CUÁLES cuentan.
 */

/** Una tabla de `public` cuya presencia marca que el usuario hizo algo. */
export interface ActivitySignal {
  table: string
  /** Columna FK al usuario. */
  userColumn: string
  /** Columna de timestamp que marca "cuándo". */
  tsColumn: string
}

export const USER_ACTIVITY_SIGNALS: ReadonlyArray<ActivitySignal> = [
  { table: 'vehicles', userColumn: 'user_id', tsColumn: 'created_at' },
  { table: 'conversations', userColumn: 'user_id', tsColumn: 'created_at' },
  { table: 'driving_sessions', userColumn: 'user_id', tsColumn: 'created_at' },
]

/**
 * Expresión SQL `greatest(...)` de la última señal de un usuario.
 *
 * `userIdRef` es el alias de la columna id del usuario en la consulta que
 * llama (`'u.id'`, `'ru.id'`, …) — nunca entrada de usuario, siempre un literal
 * del código, igual que `SORT_COLUMNS` en `users.repo.ts`.
 *
 * `floor` (opcional) suma un piso a la comparación. `/usuarios` NO lo quiere:
 * un usuario sin ninguna señal tiene que dar `null` para que la columna diga
 * "se registró y no hizo nada". Churn SÍ lo quiere (`u.created_at`): sin piso,
 * ese mismo usuario no churnearía jamás.
 */
export function lastSignalSql(userIdRef: string, opts: { floor?: string } = {}): string {
  const terms = USER_ACTIVITY_SIGNALS.map(
    (s) => `(select max(t.${s.tsColumn}) from ${s.table} t where t.${s.userColumn} = ${userIdRef})`,
  )
  if (opts.floor) terms.unshift(opts.floor)
  return `greatest(${terms.join(', ')})`
}
