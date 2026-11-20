# «Alta por» y el catálogo del equipo (migración 035)

Alcance: `migrations/035_ops_alta_por.sql` (+ `.test.sql`), `src/lib/team.ts`,
`src/server/team.repo.ts`, `src/fn/team.ts`, `src/components/SourcerSelect.tsx`,
`src/components/SourcingHistoryCard.tsx`, `src/components/SourcingCounts.tsx`,
`src/routes/_authed/comercial.equipo.tsx`, la columna y el filtro de `/solicitudes`, el selector
de `/solicitudes/$applicationId`, el «Alta por» de `/partners/$partnerId`, el bloque «Altas por
persona» de `/comercial/resumen` y `listProspectOwners` de `partner-prospects.repo.ts`. Agregado el
2026-11-20.

## Qué es

«Alta por» = **quién del equipo trajo** a un proveedor. Se carga en cada solicitud de alta
(`partner_applications`), nueva o vieja, para tener el historial, contar altas por persona y
liquidar comisiones. **No es** `reviewed_by_id` (quién la revisó en el panel) ni `how_found` (lo
que declaró el proveedor): no se pisan ni se reutilizan.

## Dónde vive: `ops`, sin pedido al backend

Es dato de operación del equipo; `ops` es del panel (decisión 3 del `CLAUDE.md`). Tres tablas:

| Tabla | Qué |
|---|---|
| `ops.team_member` | Las personas: nombre (único sin mayúsculas), rol `fundador \| comercial \| otro`, activa, `active_since`, `inactive_since`, `user_id` opcional (único). |
| `ops.partner_application_sourcer` | La asignación VIGENTE, una fila por solicitud. Sin fila = sin asignar. |
| `ops.partner_application_sourcer_log` | Append-only: antes → después, quién, cuándo. |

La solicitud va por UUID pelado (guardrail 6); las FKs ops → ops sí van. Los SP siguen los 8
guardrails y además escriben `ops.action_log`.

## Reglas que el SP hace cumplir

- **Control de pisada**: `ops.set_application_sourcer` recibe lo que el operador VIO
  (`p_expected_member_id`, NULL = sin asignar). Si cambió → `SOURCER_CHANGED` y la UI relee. Así
  «Es mío» nunca pisa en silencio una asignación hecha un segundo antes.
- **Inactiva no se asigna** (`MEMBER_INACTIVE`), salvo que ya fuera la asignada (re-guardar es
  no-op). Por eso Lautaro no aparece para asignar, pero sí en sus altas («Lautaro (inactivo)»).
- Misma persona = no-op, sin historial. Quitar (`NULL`) sí queda en el historial.
- No toca `partner_applications` ni bloquea ningún cambio de estado ni la aprobación.
- Una persona no se borra: se desactiva (`inactive_since` = hoy en Buenos Aires).

## La UI

- **Confirmación** antes de cambiar una ya asignada («Esta alta figura a nombre de X.
  ¿Cambiarla?»). Del lado del cliente; el control de pisada del SP es la red.
- **«+ Agregar persona»** desde el mismo selector: da de alta y asigna en el mismo gesto.
- **«Es mío»** sólo si el usuario logueado está vinculado a una persona ACTIVA
  (`ops.team_member.user_id`); se vincula en Comercial › Equipo.
- **Progreso** en `/solicitudes`: «X de Y solicitudes sin asignar», sobre las NO descartadas de
  cualquier fecha y estado (publicadas incluidas). «Ver las sin asignar» arma el filtro con
  publicadas a la vista: el listado las oculta por default.
- Search param **`applicationSourcer`** (`none` o uuid), calificado (`notifications.md`). El filtro
  compara `member_id::text` para que `'none'` no se castee a uuid, y sólo se arma con la 035.

## El conteo

`sourcingCounts(unit)`: semana (lunes) o mes en hora de Buenos Aires, por la **fecha de la
solicitud** (`partner_applications.created_at`), no por la de asignación: una alta vieja cargada
hoy cae en su semana real. Sin las descartadas. Las fechas viajan como `YYYY-MM-DD` armadas en SQL
y se formatean como texto (sin `Date`). Columnas: las personas activas más las inactivas con algo
en el período, «Sin asignar» y total.

## Comercial: opción A (decidido el 2026-11-20)

`ops.partner_prospect.owner_id` sigue siendo un `users.id`. `listProspectOwners` ofrece las personas
del catálogo ACTIVAS con usuario vinculado (con el nombre del catálogo) más quien ya figure como
comercial de un contacto. **Mientras nadie esté vinculado, usa la lista vieja** (admins de Clerk):
si no, el selector quedaría vacío justo después de aplicar la 035. Pasar `owner_id` a la persona del
catálogo (opción B) tocaría los SP de la 030/031 y la liquidación de Altas; no se hizo.

## Sin la 035

`teamAvailable()` (`to_regclass` de las tres tablas, cachea sólo el `true`). Sin ella: no hay
selector, ni columna, ni filtro, ni «Es mío»; Equipo y «Altas por persona» dicen qué falta; la ficha
del partner no muestra nada. Las escrituras tiran `TEAM_UNAVAILABLE`.

## Cómo se probó

- Suite `035_ops_alta_por.test.sql`: **42/42** en una réplica PGlite (`tmp/run-035.mjs`, con
  `users`/`partner_applications` mínimos y los helpers de la 007), aborta en rojo sin la 035. Cubre
  forma (sin sobrecarga, INVOKER, `search_path`, sin FK a `public`), semilla, alta/edición/vínculo
  de personas, asignación, no-op, `SOURCER_CHANGED`, inactiva, quitar, descartada, y la integración
  con `PREPARE` sin tipos.
- `vite build` + `tsc --noEmit` limpios; borde server-only limpio.
- Capturas con el arnés `tmp/harness` (rutas y componentes reales, server functions con datos de
  ejemplo). **No corrida en DEV ni aplicada en ninguna base**: la aplica el `vercel-build` del
  próximo deploy de `main`.
