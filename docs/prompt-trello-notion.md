# Prompt para actualizar Trello y Notion — tanda del panel admin del 06/11/26

> Pegalo tal cual en el chat de Claude que tiene Trello y Notion conectados.

---

Sos el asistente que mantiene al día las tarjetas de Trello y las páginas de Notion del panel
admin de AutoLibre (repo `AutolibreAI/autolibre-admin`). Hoy, 06/11/2026, se terminó una tanda de
seis tareas. El código está integrado en la rama `updates-6/11` (pusheada) y **todavía no está en `main`**:
nada de esto está en producción. Tu trabajo es actualizar las tarjetas con lo que quedó hecho, lo
que quedó parcial y los pedidos de backend nuevos.

## Cómo trabajar

1. Para cada tarea de abajo, buscá la tarjeta de Trello por su título (o por palabras clave del
   título). Si no la encontrás, no crees una nueva: anotalo en el resumen final.
2. En cada tarjeta encontrada, agregá **un comentario** con: estado, qué se hizo, cómo probarlo y
   qué falta. Usá el texto de la sección de la tarea, en español rioplatense y corto. Para todas,
   la rama a revisar es `updates-6/11` (las ramas por tarea que figuran abajo son sólo de
   referencia: no están en GitHub).
3. **No muevas tarjetas a "Hecho"**: el código no está mergeado. Si el tablero tiene una columna
   tipo "En revisión" / "Review", mové ahí las tareas en estado **Real**; las **Parcial** y
   **Contra mock** dejalas donde están.
4. Si una tarjeta tiene checklist, tildá sólo los ítems que la descripción de abajo da por hechos.
5. En Notion, si hay una página de "Necesidades de backend del panel admin" o similar, sumá la
   sección "Pedidos de backend nuevos o ampliados" de abajo. Si no existe, no la crees: anotalo.
6. Vocabulario: decí "propuestas" (nunca "presupuestos") y "proveedores" (no sólo "talleres").
7. No pegues datos personales de usuarios. Los números de abajo son conteos.
8. Al final, devolvé un resumen: qué tarjetas comentaste, cuáles moviste, cuáles no encontraste.

## Las seis tareas

### 1. Partners y propuestas: ordenar y filtrar (para Tobías) — vence 12/11

- **Estado:** Real. Rama `feat/admin-partners-orden-filtros`.
- **Qué se hizo:** en Partners › Propuestas, orden por cualquier columna (clic en el encabezado,
  asc/desc, con flecha) y filtros combinables: plan, propuestas del mes, propuestas desde el
  27/10/26, zona, rubro, fecha de alta, Aliado sí/no y último contacto (del seguimiento comercial).
  Los filtros activos se ven como chips que se pueden quitar, con "Limpiar filtros". Orden y
  filtros quedan en la URL. "Plan Gratis + más propuestas" sale en dos clics (chip Gratis + clic en
  "Usadas / tope").
- **Cómo probarlo:** `pnpm dev` › Partners › Propuestas › chip "Gratis" › clic en "Usadas / tope".
- **Falta / notas:** el catálogo de planes tiene Gratis, Plus y Plus Max; **no existe "Estándar"**,
  por eso no aparece en el filtro. Ningún contacto de Comercial está vinculado a un proveedor
  todavía, así que "Último contacto" sale "sin contacto" para todos hasta que se vinculen desde
  Comercial › Contactos.

### 2. Solicitud de proveedor: mensaje de bienvenida autorrellenado — vence 12/11

- **Estado:** Real. Rama `feat/admin-solicitud-bienvenida`.
- **Qué se hizo:** en la ficha de cada solicitud, tarjeta "Mensaje de bienvenida" con el texto
  oficial que pasó el equipo, tal cual, y el link al perfil público
  (`autolibre.ai/proveedores/<slug>`, el mismo de la ficha del proveedor) en el lugar de [LINK].
  Botón "Copiar mensaje"; el envío sigue siendo manual. Si falta el link, avisa y no deja copiar.
- **Dato:** el link existe recién al aprobar la solicitud (lo crea el backend al dar de alta el
  proveedor). Antes de aprobar, la tarjeta lo dice. Ojo: la URL es `/proveedores/<slug>`, no
  `/p/<slug>` (`/p/` da 404).

### 3. Ficha del proveedor: cambiar el estado (dar de baja)

- **Estado:** Real. Rama `feat/admin-partner-baja`.
- **Qué se hizo:** botón "Dar de baja" y confirmación para cualquier cambio de estado, con motivo
  opcional. Queda registrado quién lo hizo, cuándo, el antes y el después.
- **Qué le pasa hoy a un proveedor dado de baja** (archivado), según el backend: sale de la app y
  de su perfil público, el asistente de IA deja de recomendarlo, no entra al despacho automático de
  pedidos, su código de taller de cabecera deja de canjearse y no se le pueden emitir códigos de
  reclamo. Sus pedidos y propuestas ya cargados quedan como estaban.
- **Pregunta abierta:** hoy el backend todavía **acepta propuestas nuevas a un proveedor pausado o
  archivado**. ¿Debería rechazarlas?

### 4. Autos por taller de cabecera (vista nueva)

- **Estado:** Real. Rama `feat/admin-taller-cabecera` (incluye la migración 027 de `ops`).
- **Qué se hizo:** pestaña nueva Partners › Taller de cabecera: ranking de proveedores por personas
  y autos vinculados, altas por semana y por mes, activas vs. inactivas (la misma señal de
  "activo" que Métricas, últimos 30 días; no son aperturas de la app). Sólo conteos.
- **Dato de hoy:** 1 código (SERMAY10, Ser May), 2 canjes, 1 persona vinculada hoy, 1 auto.
- **Notas:** el canje de un código de cabecera está en otra tabla que el código de reclamo del
  dueño; la vista muestra los dos por separado ("Reclamado"). La migración la aplica sola el
  deploy de producción.

### 5. Notificaciones: campo "Objetivo" al crear el envío o la regla

- **Estado:** Contra mock (el guardado); la medición del efecto es real. Rama
  `feat/admin-notificaciones-objetivo`.
- **Qué se hizo:** campo "Objetivo" en el envío puntual, el programado y la automatización, con
  12 opciones, todas medibles en "Efecto por envío": cargar vehículo, seguro, VTV, cédula, licencia
  o cualquier documento; crear pedido; elegir una propuesta; escanear el auto; hablar con el
  asistente; registrar un mantenimiento; registrar un dispositivo. La pantalla de efecto lo lee y se
  puede corregir ahí.
- **Falta:** el backend no tiene dónde guardarlo; hoy vive en memoria y se pierde al recargar.
  Pedido ampliado (ver abajo). "Cargar patente" y "cargar kilometraje" no se sumaron: no hay de
  dónde medirlas.

### 6. Estudio de proveedores: cerrar lo pendiente

- **Estado:** Real. Rama `feat/admin-estudio-mejorar-perfil`.
- **Qué se hizo:** la rama de propuestas por rubro, "Sin rubro" y "Qué falta para cada métrica"
  **ya estaba mergeada en main**. Nuevo: en el botón "Reporte" de cada proveedor, bloque "Cómo
  mejorar tu perfil" con reglas fijas según lo que le falte (servicios, ubicación, logo,
  descripción, horarios, dirección, WhatsApp, links). No nombra clientes ni otros proveedores.
- **Nota:** "fotos" es el logo: el perfil del proveedor no tiene galería en el backend.

## Pedidos de backend nuevos o ampliados (versión 7 de necesidades-backend-admin)

- **Ampliado, ahora P0 — `targetAction` en el registro de envíos** (`notification_sends`):
  `POST /notifications/broadcast` tiene que aceptar y guardar el objetivo del envío, de un catálogo
  cerrado de 12 acciones (`vehicle`, `insurance`, `vtv`, `registration_card`, `license`,
  `document`, `quote_request`, `proposal_selected`, `scan`, `chat`, `maintenance`, `push_token`) o
  `null`. No bloquea el front (mock), pero sin esto el objetivo se pierde al recargar. Es lo único
  que le falta a "Efecto por envío".
- **Ampliado, P1 — reglas en un solo modelo:** la regla lleva `targetAction` y cada envío que
  dispara lo hereda.
- **Nuevo, P2 — crear y deshabilitar códigos de taller de cabecera desde el admin.** Hoy es SQL.
  No bloquea el front.
- **Corrección:** "taller de cabecera" sí existe en el backend (códigos de referido); se cierra esa
  pregunta abierta.

## Estado del código (para mencionar en las tarjetas si preguntan)

Las seis tareas y la actualización de `docs/necesidades-backend-admin.md` (versión 7) están
integradas en `updates-6/11`, pusheada a GitHub, sin PR todavía. Falta revisarla y mergearla a
`main`; recién ahí llega a producción (y el deploy aplica la migración 027).
