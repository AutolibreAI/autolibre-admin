# Comercial: ficha completa, historial de charlas y pestaña API Chasis

Plan del 2026-11-11, aprobado ese día; las cuatro decisiones de abajo se tomaron como estaban
recomendadas. **Las tres etapas hechas** (030: ficha, charlas, filtros · Resumen y Altas · 031: API Chasis), sin
commit y sin aplicar en ninguna base.

## Lo que hay hoy (relevado contra producción, `doadmin`, puerto 25060)

- Una tabla, `ops.partner_prospect` (migración 024), una fila por proveedor. Se escribe sólo por
  SP de `ops` (`create` / `update` como PARCHE con autoguardado / `import`), con `ops.action_log`.
- Pantallas: `/comercial/hoy` y `/comercial/contactos`. Cada contacto es una tarjeta que se edita
  en el lugar (`ProspectCards.tsx`); alta en un `Sheet` (`ProspectComposer`), CSV en
  `ProspectImporter`. Filtros: texto, estado, origen, rubro, comercial. **No hay filtro de zona**
  (la localidad es texto libre y sólo se busca por `q`).
- **No hay historial**: "último contacto", "con quién hablé" y la nota son UN valor por contacto,
  que se pisa.
- Datos: **47 contactos, todos `pending`, todos origen `scrapeo`, ninguno vinculado, ninguno con
  fecha de contacto.** El frente está escrito al principio de la nota corta:
  `[Ruta 2 · GPS Taller · km 121] …`. 45 de 47 los cargó la misma persona el 2026-10-29.
- Otros que leen esta tabla y no se pueden romper: `partners.propuestas` (filtro "último contacto"
  por `last_contact_on` de los vinculados) y `partners.sellos` (`findPhoneMatchesFn`).
- Proveedores: 152 en `partners` (106 vienen de una solicitud, con `application_id`). Hoy ningún
  contacto matchea por teléfono ni con `partners` ni con `partner_applications`.

## Backend de la app: no hace falta tocarlo

Todo lo nuevo es dato del equipo comercial: vive en `ops`, como la 024. Lo que se lee de `public`
(`partners`, `partner_applications`, `quote_requests` para el N° de pedido) es sólo lectura, como ya
hace el vinculador. **No hay especificación para Ramiro.**

## Parte 1 — Contactos

### Migración 030 (`ops`)

`ops.partner_prospect` suma columnas (todas opcionales salvo donde se dice):

| Campo | Tipo | Nota |
|---|---|---|
| `front` | `ruta-2 \| corredor-norte \| por-pedido` | nullable; filtrable |
| `front_quote_request_id` | uuid | sólo con `por-pedido`; el SP valida que el pedido exista (sin FK) y la UI lo muestra como `AL-n` con link |
| `knew_autolibre` · `has_capacity` | bool | nullable = no se sabe |
| `client_acquisition` · `management_system` · `network` | text | |
| `preferred_channel` | `whatsapp \| app_web` | |
| `verify_test_response` · `verify_identity` · `verify_payment` · `verify_reputation` | bool, default false | "Verificado" = los 4, **derivado al leer**, no una columna |
| `discard_reason` | text | obligatorio con estado descartado (SP + zod) |
| `next_step` | text | lo último que se definió en una charla |
| `partner_registered_on` | date | fecha de alta, se fija al vincular (ver decisión 1) |

Estados nuevos (CHECK reemplazado): `to_contact → contacted → interested → registered →
first_order → job_confirmed`, más `discarded`.

Mapeo de los viejos (en producción los 47 son `pending`, así que hoy sólo aplica la primera fila):

| Viejo | Nuevo | Por qué |
|---|---|---|
| Pendiente | Por contactar | |
| Llamé, no atendió | Por contactar | no hubo charla real; queda "volver a llamar" como próximo paso |
| Ir en persona | Por contactar | próximo paso "Ir en persona" |
| Lo piensa | Contactado | |
| Interesado | Interesado | |
| Registrado | Registrado | |
| No le interesa | Descartado | motivo "No le interesa (estado anterior)" |

Tabla nueva **`ops.partner_prospect_interaction`** (una charla), APPEND-ONLY:
fecha (default ahora), canal (`call|whatsapp|visit`), atendió, habló con quien decide, qué le contó
(4 checks), modelo ofrecido (`fee_per_job|free_plan|other`) + número dicho (texto: "8%", "$15.000"),
reacción, preguntas y respuestas (texto), objeción (lista cerrada + "otra" con texto), trabajos/mes
para pagar (int), notas de pitch, estado resultante, próximo paso, próxima fecha, actor.

`ops.add_partner_prospect_interaction` inserta la charla **y en la misma transacción** actualiza el
contacto: estado, `last_contact_on` = fecha de la charla, `next_step`, `next_follow_up_on`. Así Hoy,
los contadores y el filtro de Partners › Propuestas siguen funcionando sin cambios. Obligatorios en
la charla: canal, estado y próximo paso (la fecha la pone sola).

Se reescribe `_normalize_partner_prospect` (claves nuevas) con DROP + CREATE; firmas públicas de
`create/update/import` iguales, así el importador CSV no cambia. Suite `.test.sql` en PGlite como la
024 (rojo sin la migración, verde con ella).

### Pantallas

- **Ficha** `/comercial/contactos/$prospectId` (el listado pasa a `comercial.contactos.index.tsx`:
  con el listado en `comercial.contactos.tsx` la ficha quedaría anidada sin `<Outlet/>`, trampa de
  `scan-sessions.md`). Arriba: estado, frente, verificación (badge), "Conseguido por", vínculo con el
  proveedor. Después: los datos de la ficha (autoguardado por campo, como hoy) y el **historial de
  charlas** completo, de la más nueva a la más vieja.
- **"Registrar charla"**: botón en cada tarjeta, en la ficha y en Hoy. En el celular abre a pantalla
  completa. Arriba sólo lo obligatorio, con botones grandes (canal, estado — precargado con el
  actual —, próximo paso con atajos "Volver a llamar / Mandar info / Ir en persona" y fecha con
  "Mañana / 3 días / 1 semana"). Sí/no y reacción como botones de un toque. El resto en "Más
  detalle", plegado. Teclado numérico en los números. Un solo "Guardar".
- **Tarjeta del listado**: suma frente, badge "Verificado" y el último próximo paso; sigue editable
  en el lugar.
- **Filtros nuevos**: frente, zona (localidades de la base, multiselección), verificado. Los de hoy
  (estado, origen, rubro, comercial, búsqueda) siguen igual. Search params calificados `prospect*`.
- **"Comercial" pasa a decir "Conseguido por"** en la UI (es el mismo `owner_id`; el alta ya lo
  precarga con quien está logueado).
- **Vínculo con el proveedor**: además del vinculador actual, una lista "Posibles altas sin
  vincular" (contactos cuyo teléfono coincide con un proveedor o una solicitud). Un único match →
  un botón "Vincular"; más de uno → elegir. Nunca se vincula solo. Al vincular se guarda la fecha de
  alta y, si estaba antes de "Registrado", se ofrece pasarlo.
- **Pestaña "Resumen"** (filtros: frente, zona, rubro, responsable, rango de fechas): contactos por
  estado, verificados, altas del mes, objeciones más repetidas con conteo, promedio de trabajos/mes
  para pagar, y la lista de vencidos o para hoy.
- **Pestaña "Altas"**: por mes (selector), agrupado por "Conseguido por": proveedor, fecha de alta,
  verificado. Para liquidar.

## Parte 2 — API Chasis (migración 031)

- `ops.chasis_agency` (ficha: nombre, contacto, teléfono normalizado con la misma función, zona,
  habló con quien decide, usa Carbufy, para qué, datos que le importan como lista de checks, autos o
  consultas/mes, cómo lo resuelve hoy y con qué proveedor, API o web, interés en otra cosa,
  "Referido cargado en Chasis", tiene taller/lubricentro/gomería, conseguido por). Estados:
  `contacted → saw_sample → proposal_sent → client`, más `discarded` con motivo. Usa Carbufy = sí
  descarta con ese motivo (lo hace el SP en la misma operación; la UI lo avisa antes).
- `ops.chasis_agency_interaction`, misma forma que la de proveedores con su modelo
  (suscripción / pack + precio dicho) y sus objeciones.
- Aviso en ámbar: cliente sin "Referido cargado en Chasis".
- **"Crear contacto de proveedor"** (si tiene taller/lubricentro/gomería): crea el contacto con
  frente Corredor Norte y nombre, teléfono, zona y conseguido por copiados, y deja el link entre los
  dos. Si el teléfono ya es un contacto, lo dice y linkea a ése en vez de duplicar.
- Pestaña `/comercial/api-chasis` con lista + resumen arriba (por estado, clientes, referidos
  cargados, consultas/mes del pipeline, objeciones), ficha `/comercial/api-chasis/$agencyId` con
  historial. Hoy muestra también las agencias vencidas o para hoy.

## Orden de trabajo

1. 030 + ficha + charlas + filtros nuevos (lo que Tobías usa todos los días).
2. Resumen + Altas + posibles altas sin vincular.
3. 031 + API Chasis.

Cada etapa queda usable sola. Verificación: suites en PGlite, el repo real contra la réplica,
`vite build` + `tsc --noEmit`, y la pantalla en el navegador a 375 px (la sesión de Clerk puede
impedirlo; si pasa, se dice).

## Decisiones abiertas

1. **Fecha de alta para liquidar**: ¿cuando se aprueba (se crea el proveedor) o cuando manda la
   solicitud? Recomendado: aprobación; la de la solicitud se muestra al lado.
2. **La etiqueta en la nota**: `[Ruta 2 · GPS Taller · km 121]` → frente Ruta 2, origen "Red GPS
   Taller" cuando dice GPS Taller (hoy los 47 dicen "Scrapeo"), y la nota queda empezando por
   "km 121 · …". ¿Va?
3. **Charlas sin edición**: una charla mal cargada no se corrige ni se borra en esta versión; se
   carga otra. ¿O querés poder corregir la última del día?
4. **El campo "Plan" de hoy (Gratis / Plus)** queda en la ficha como "Plan que eligió", aparte del
   "modelo ofrecido" de cada charla.
