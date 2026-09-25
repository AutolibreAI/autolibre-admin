# Ficha de pedido (`/leads/pedidos/:id`) — cambios del 2026-09-25

Pedido del operador, con las dudas ya cerradas. Seis cambios, en cuatro fases.

## Relevamiento (producción, `doadmin`, puerto 25060)

- Pedidos `app`: 8, **los 8 con `vehicle_id`** y patente que coincide. `web`: 23, sin cuenta ni vehículo.
- Sobre esos 8 autos: VIN en `vehicles` 6/8 · km 5/8 · con escaneo DTC 6/8 · 18 tareas ·
  **nº de motor en `vehicles` 0/8** (cédula 4/8, seguro 7/8).
- `ops.quote_request_rubro`: **0 filas** → reestructurarla no migra datos.
- `ops.quote_request_response`: 15 filas. Migraciones 001–015 aplicadas.
- `../autolibre-backend-hex` no está en esta máquina. No hace falta: las dos tablas nuevas son de `ops`.

## Decisiones cerradas

| Tema | Decisión |
|---|---|
| Plantillas | Se edita la plantilla CRUDA (`{{variables}}`), nunca el texto renderizado (hornearía los datos de un pedido). Guardar = versión nueva, vigente para todos. Historial + volver a una anterior. **Se pueden crear plantillas nuevas** (título + a quién va: persona/taller). |
| Bloque «Presupuestos» | Las líneas 📍📞🕘💵📅 por taller quedan **fijas en código**; se edita el texto alrededor de `{{presupuestos}}`. |
| Notas | La única nota que queda es el **hilo de notas internas** (varias por pedido, durante todo el proceso). Se ocultan: nota de auditoría (contactado/respondido/cerrar/presupuestos), «nota interna del cierre» (`closed_reason`), «nota del resultado» (`outcome_note`) y la nota interna por presupuesto. El cierre conserva **Motivo** + **Resultado**. Lo ya cargado en esos campos se sigue mostrando en el recorrido / la fila. |
| Rubros | Multiselect. Candidato = cubre **al menos uno**; orden por cantidad de rubros cubiertos desc, después distancia, después tier/nombre. Servicio puntual: **fuera**. |
| Zona | Mismo control que rubro: desplegable multiselect (no chips). |
| Vehículo | Bloque visible siempre que el pedido tenga `vehicle_id` (aunque no sea `app`). Nº de motor: `vehicles` → cédula → seguro, diciendo la fuente. |
| Presupuestos | Filas compactas, columnas alineadas para comparar. |

## Fase 1 — pantalla, sin migraciones

1. **Notas** (`QuoteRequestActions.tsx`, `QuoteResponses.tsx`):
   - Sacar `AuditNoteField` de las tres transiciones y del formulario de presupuesto. Los SP no cambian:
     `p_note` viaja `NULL`.
   - En cerrar: sacar «Nota interna del cierre» y «Nota del resultado». Queda Motivo + Resultado +
     el campo de nota del hilo (ver Fase 2, punto 3, para que sea atómico).
   - `QuoteResponses`: ocultar el campo «Nota interna» del form y de la fila; si una fila vieja la tiene,
     se muestra (sólo lectura) para no perder el dato.
   - La tarjeta de Notas internas queda como está (es la de la captura).
2. **Presupuestos compactos** (`ResponseRow`):
   - Una fila por taller: `N · nombre (+Aliado/pausado)` | precio (alineado a la derecha, tabular) |
     vigencia | detalle en 2 líneas con «ver más».
   - Dirección/teléfono/horario en una segunda línea chica, truncada.
   - ↑↓ / Editar / Borrar en un menú «⋯» (o visibles al hover/focus, accesibles por teclado).
   - El form de alta/edición no cambia (salvo la nota).
3. **`MultiSelect` compartido** (`src/components/MultiSelect.tsx`): trigger con resumen
   («Motor, Frenos +1»), popover con casillas + buscador, «Limpiar», contador. Agregar `popover` de
   shadcn y sacarle la sombra (`design-system.md`). Primer uso: zona en `PartnerCandidates`
   (sigue en `useState`, sigue por contención).

## Fase 2 — varios rubros + nota atómica al cerrar (migración 016)

1. `ops.quote_request_rubro` → PK `(quote_request_id, category_slug)`, sin `service_slug`. Sin FK a
   `public` (guardrail 6). 0 filas: se recrea.
2. `ops.set_quote_request_rubros(p_quote_request_id, p_actor_id, p_category_slugs text[])`: reemplaza el
   conjunto entero, valida cada slug contra `service_categories` activas, `[]` = sin clasificar,
   UNA entrada en `ops.action_log` con before/after. `DROP FUNCTION` de la 013 con su firma exacta +
   caso de suite que cuente firmas en `pg_proc`.
3. `ops.close_quote_request`: sumar `p_internal_note text` que, si viene, se agrega al hilo
   (mismo formato fechado en Buenos Aires que `add_quote_request_internal_note`) **en la misma
   transacción** que el cierre — el pedido cerrado ya no admite notas, y dos llamadas separadas
   dejarían una nota de un cierre que falló. Agregar parámetro = DROP + CREATE (trampa de la 009) +
   conteo de firmas; re-verificar las validaciones de la 011 en la suite nueva.
4. App:
   - Search param `quoteRubro` → `quoteRubros` (`string[]`, `multiSelectParam`); precedencia igual
     que hoy: la URL gana, si no los guardados.
   - `QuoteRequestDetail.rubroCategorySlugs: string[]` (sumar al SELECT; `READ_COLUMNS` no aplica, es `ops`).
   - `listPartnerCandidates(categorySlugs[])` devuelve `matchedCategories` por candidato y ordena por
     `cardinality(matched) desc, distance, tier, name`.
   - `PartnerCandidates`: rubro con `MultiSelect`, chips de rubros cubiertos en cada fila,
     «Guardar clasificación» sigue separando mirar de guardar.
5. `013/*.test.sql`: la suite queda probando una función que ya no existe → mover lo que siga
   valiendo a `016_*.test.sql` (mismo criterio que 008→009).

## Fase 3 — plantillas editables (migración 017)

1. Tabla `ops.quote_message_template_version`: `id` uuid, `template_key` text, `title`, `audience`
   (`CHECK in ('persona','taller')`), `content`, `archived` bool, `actor_id`, `created_at`.
   Vigente = última versión por `template_key`. Append-only (volver atrás = versión nueva con el
   texto viejo, así el historial dice quién y cuándo).
2. SP `ops.save_quote_message_template(p_key, p_title, p_audience, p_content, p_actor_id)`:
   `SECURITY INVOKER`, `search_path` fijo, `assert_actor`, log en `ops.action_log`. Valida
   representabilidad: `{{codigo}}` presente, contenido no vacío, audiencia válida.
   **Las variables desconocidas se validan en zod** (la lista vive en TS, `TEMPLATE_VARIABLES`),
   con el mismo mensaje en el form. Archivar = versión nueva con `archived = true` (no hay borrado).
3. Las 4 plantillas actuales quedan en código como **semilla**: si una `template_key` no tiene
   versiones, se usa la del código. La primera edición crea la versión 1. El chequeo de `{{codigo}}`
   en tiempo de módulo se queda para la semilla.
4. Render: `renderQuoteTemplate` no cambia de firma (recibe `QuoteTemplate`). `{{presupuestos}}` sigue
   armándose en código. `OPTIONAL_LINE_KEYS` y las variables se documentan en el editor.
5. Loader de la ficha: `listQuoteTemplatesFn` en el mismo `Promise.all`. `QuoteTemplates` y
   `PartnerCandidates` (botón «Pedir cotización») dejan de importar `QUOTE_TEMPLATES`:
   **«Pedir cotización» busca la plantilla `cotizacion_red` en lo que vino del loader.**
6. UI: en `QuoteTemplates`, botón «Editar plantilla» y «Nueva plantilla» → `Sheet` con:
   título, a quién va, textarea con el texto crudo, lista de variables (click = insertar),
   vista previa renderizada con ESTE pedido, historial (quién/cuándo, «usar esta versión»).
   El borrador por pedido (`edits`) sigue existiendo y es otra cosa: se aclara en pantalla.
7. `adminMiddleware` en lectura y escritura.

## Fase 4 — vehículo del usuario en la ficha (sólo lectura)

1. `findQuoteVehicleProfile(vehicleId)` en `quote-requests.repo.ts` (o `vehicles.repo.ts`):
   - VIN (`vehicles.vin`), nº de motor con fuente (`vehicles` → última `registration_cards` →
     última `insurances`, `nullif(btrim(...),'')`), km (`odometer_value`).
   - DTCs activos: `session_dtc_snapshots.codes` de la sesión de `vehicle_last_dtc_scans`, con
     `lookupDtc()` para el título, + fecha del escaneo. **Ojo**: `listUserVehicleSummaries` cuenta
     `diagnostic_dtcs` (sólo los buscados) — alinear los dos al mismo criterio en este cambio, o
     `/usuarios` y la ficha dirán números distintos.
   - Tareas: `maintenance_occurrences` de ese auto, hechas y pendientes.
   - Null ≠ 0: «nunca escaneado» ≠ «0 DTCs».
2. Extraer `Tasks`/`TaskRow`/`TaskStateTag` de `usuarios.$userId.tsx` a un componente compartido.
3. Tarjeta «Vehículo» de la ficha: VIN · Motor (fuente) · Km · DTCs (códigos + título) ·
   «Tareas (N hechas / M pendientes)» plegable. Sin escrituras.

## Verificación

- `vite build` + `tsc --noEmit` (el build regenera `routeTree.gen.ts`).
- Borde server-only: `grep -rl "quote-requests.repo\|quote_message_template\|nombre_corto\|POSTGRES_DATABASE_URL" .output/public` → vacío.
- Suites 016 y 017 con `BEGIN … ROLLBACK`: **en rojo primero, después en verde, contra DEV**
  (`localhost:5435`). El `.env` de esta máquina hoy apunta a producción: no se corren ahí.
  Producción después, por `:25060`, nunca por el pooler.
- Probe en la ficha real: un pedido `app` con vehículo, uno `web` sin vehículo, 2 rubros elegidos,
  editar una plantilla y ver que otro pedido ya la usa.
- Docs: `leads.md` (plantillas editables, rubros múltiples, notas, bloque vehículo),
  `ops-write-actions.md` (016, 017), `CLAUDE.md` (tabla de pantallas, fila `/leads/pedidos/:id`).
