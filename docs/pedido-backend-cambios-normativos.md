# Pedido al backend: cola de cambios normativos del radar (2026-11-03)

De: panel de administración (`autolibre-admin`). Para: Ramiro (backend hex).

Tarjeta: [Cola de revisión de cambios normativos](https://trello.com/c/uwe7nQ37).

## Qué hay hoy

Conocimiento › Cambios normativos es el diseño de la cola, contra datos de ejemplo:

- Por cambio: tema, jurisdicción, valor anterior y nuevo, vigencia, norma con link y **cita
  textual** de la fuente, quién lo propuso, y el **diff por renglón** sobre la sección del .md.
- Chequeos fijos (en código, no por IA): hay cita, hay URL https, el diff cambia algo, el valor
  nuevo está en lo agregado, el anterior en lo sacado y no queda en otro renglón. Con uno en rojo
  no se puede aprobar: es «la regla que no se cumplió».
- Acciones: **aprobar** (exige tildar «leí la norma en la fuente» y un resumen), **rechazar con
  motivo**, y revisadas con su changelog. La IA nunca aprueba.
- El historial de versiones de cada documento es real (`knowledge_documents`).
- Lo que no se puede mostrar real: el texto de la sección, porque el .md no se puede bajar.

## Qué falta

- [ ] Tabla `regulatory_changes`: `topic`, `jurisdiction`, `old_value`, `new_value`,
  `effective_from`, `norm`, `source_url`, `quote`, `document_id`, `section`, `proposed_diff`,
  `status` (`pending | approved | edited_and_approved | rejected | postponed`), `reject_reason`,
  `postponed_until`, `change_summary`, `proposed_by` (`detector | <userId>`), `reviewed_by`,
  `reviewed_at`.
- [ ] `GET /admin/knowledge-documents/:id/content`: el markdown vigente, para el diff real.
- [ ] Aprobar = subir una versión nueva con el diff aplicado por el camino que ya existe
  (`POST /knowledge-documents/markdown` con `supersedesDocumentId`) + guardar `change_summary` en
  la versión. «Editar y aprobar» manda el diff editado por la persona.
- [ ] `POST /admin/regulatory-changes/:id/reject` (`reason` obligatoria) y `/postpone`
  (`until`).
- [ ] Job detector que arma las fichas, y una prueba de control después del reindexado (preguntas
  fijas que el asistente tiene que contestar con el valor nuevo).

## Permisos

Sólo admins (`AdminGuard`). Aprobar queda a nombre de la persona logueada.

## Listo cuando

- La cola muestra cambios reales con su cita y el diff contra el .md verdadero.
- Aprobar sube la versión nueva y el changelog se ve en el historial.
- Rechazar sin motivo no se puede.

## Preguntas abiertas

1. ¿Qué significa cada color del semáforo?
2. ¿Quién aprueba: cualquier admin o una persona designada?
3. ¿Quién escribe las preguntas de control?
