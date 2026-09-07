# Documentos extraídos por OCR (`/documentos`, `/documentos/:tipo/:id`)

Alcance: `src/lib/documents.ts`, `src/server/documents.repo.ts`, `src/fn/documents.ts`,
`src/routes/_authed/documentos.index.tsx`, `src/routes/_authed/documentos.$docType.$docId.tsx`.

## Qué contesta

Qué extrajo el OCR de un documento de vehículo, y si le podés creer. El backend
recibe una foto o un PDF (seguro, cédula, registro de conducir, VTV), le pasa un
OCR y guarda los campos como columnas de texto en cuatro tablas. El OCR falla
seguido — al 2026-09-05 en producción, `registration_cards.holder_name` cargado
en 6 de 10 filas menos, una `insurances` con `policy_number = '1'`.

## El predicado "es OCR"

**`file_id IS NOT NULL`.** Un documento sin archivo se cargó a mano, no pasó por
OCR. Para `vehicle_inspections` **además `source = 'manual'`**: las 24 filas
`source = 'provider'` (de 32) son una consulta a una API de VTV por patente —
sin archivo, sin OCR. Ese predicado vive en el `where` de cada branch del
`UNION ALL` en `listDocuments`, no en el envoltorio.

Al 2026-09-05 eso da 13 seguros + 10 cédulas + 7 registros + 5 VTV = **35 filas**.
El test de cuadre es ese: la suma de los `count(*) where file_id is not null` de
las cuatro tablas.

## El filtro de tipo se llama `kind`, no `type`

TanStack Router **mergea los search params de TODAS las rutas** en un solo tipo
(`FullSearchSchema`). `/chats` ya tiene un `type` (`diagnostico | general | all`).
Un segundo `type` con otro enum rompe el updater funcional de
`<Link search={(prev) => ({ ...prev, ... })}>` en **chats**, no en documentos:
`...prev` arrastra un `type` demasiado ancho y el `to="/chats"` lo rechaza.

Síntoma exacto: `Type '"cedula"' is not assignable to type '"all" | "diagnostico"
| "general"'` en `chats.index.tsx`, sin haber tocado ese archivo.

Por eso `documentSearchSchema` usa `kind`. `DOC_TYPES` / `DocType` /
`DOC_TYPE_LABELS` siguen llamándose "type" — es el concepto de dominio; sólo la
**clave del search param** cambia para esquivar el merge.

## `mismatch` y `missing` son dos flags separados, y no se suman

- **`field_mismatch`**: un campo del OCR contradice al vehículo — los DOS lados
  cargados y distintos (`is distinct from` no alcanza: un lado NULL no es
  mismatch). Sólo aplica a seguro y cédula (patente, VIN); siempre `false` para
  registro (no cuelga de un vehículo) y VTV (no tiene esos campos).
- **`missing_fields`**: un campo que ese tipo DEBERÍA traer quedó vacío. Chequeo
  `coalesce(x::text,'') = ''`, nunca `IS NULL` — el import del legacy sheet dejó
  strings vacíos (convención de todo el repo).

Un `policy_number = '1'` no lo agarra ninguno de los dos: no falta y no
contradice nada. Eso se ve sólo mirando la ficha — que es el punto de la
pantalla.

`DOC_EXPECTED_FIELDS` en `~/lib/documents` define qué campos alimentan
`missing_fields` por tipo. `holder_name` está en la lista de la cédula **a
propósito** (es el que más falla); `dni` NO (la mitad de las cédulas reales no lo
traen impreso, marcarlo sería ruido). `driver_licenses` **no tiene columna
`dni`** — no la pidas.

## El join al vehículo es LEFT en las tres patas

`vehicles` → `vehicle_catalog_specs` → `vehicle_catalogs`. `insurances.vehicle_id`
y `registration_cards.vehicle_id` son NOT NULL, pero la FK garantiza que el SPEC
exista, no el catálogo — misma trampa que `scanner-compatibility.md`. Un `join`
(no `left`) en la 2ª o 3ª pata haría desaparecer del listado a un documento cuyo
vehículo no resuelve a un catálogo. `driver_licenses` **no tiene `vehicle_id`**:
ese branch del union no joinea vehículo (`vehicle_plate` = `null`).

## Los `null::text` de `DETAIL_QUERIES` no son opcionales

Cada tipo tiene su SELECT porque las cuatro tablas no comparten columnas. Los
cuatro producen el MISMO conjunto de columnas de salida (`DocDetailRow`), con
`null::text` / `null::date` explícito para lo que esa tabla no tiene. Sin el
cast, `null` sale como tipo `text` igual pero un `union` entre queries con tipos
distintos por posición explota — acá no hay union (son 4 queries sueltas), pero
el cast mantiene el mapper único y hace obvio qué campo pertenece a qué tipo.

## Ni una escritura, y las dos cosas que faltan

**`/documentos` es read-only entero.** Editar estas tablas necesita un stored
procedure de `ops` con auditoría (`.claude/rules/ops-write-actions.md`) y una
migración — es una decisión aparte, no un olvido. Si aparece un `UPDATE` en
`documents.repo.ts`, está mal.

**No hay preview del archivo.** `GET /files/:id/url` del backend está acotado al
DUEÑO del archivo (`src/server/backend.ts:301-334`): el admin, que nunca subió el
documento, recibe 404. La ficha muestra los metadatos del archivo y lo dice. Un
botón "Descargar" acá daría 404 siempre — no se pone. El arreglo es un endpoint
de acceso admin del lado del backend.
