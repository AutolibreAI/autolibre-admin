---
paths:
  - 'src/server/**'
  - '.claude/skills/db-connect/**'
---

# Base de datos

## Leé el DDL antes de introspeccionar

`../autolibre-backend-hex/autolibre-ddl-ddd.md` es la fuente de verdad del modelo.
Consultá la base viva solo cuando necesites el **estado real** (confirmar que corrió una migración,
inspeccionar datos), no para saber cómo es una tabla.

## Cómo consultar

Desde la raíz del repo (para que resuelva `.env`):

```bash
node .claude/skills/db-connect/query.mjs "select tablename from pg_catalog.pg_tables where schemaname='public' order by 1"
```

- **Solo lectura por default.** El runner rechaza `insert/update/delete/drop/truncate/alter/create/grant/revoke/merge`.
- `--allow-write` existe. **Confirmá con el usuario antes de usarlo**: pega contra la base real.
- Requiere `POSTGRES_DATABASE_URL` en `.env`, y `pg` + `dotenv` instalados (ya están, como devDeps).

Las tablas están en `public`. El schema `drizzle` es bookkeeping de migraciones — ignoralo.

## Qué hay (relevado el 2026-08-26)

**42 tablas.** Volúmenes aproximados de las que importan para dimensionar una pantalla:

```
users                    2703      vehicle_catalogs         1047
vehicles                 1235      vehicle_catalog_specs     904
vehicle_catalog_images    900      conversation_messages    1341
conversations             552      driving_sessions          625
diagnostic_dtcs           160      ai_diagnostics            133
partner_services          129      fines                     120
session_dtc_snapshots     115      driving_telemetry_analysis 109
services                   79      legal_acceptances          78
notifications              68      expo_push_tokens           68
feedback                   61      partner_links              59
insurances                 58      vehicle_last_dtc_scans     57
partners                   35      service_categories         16
maintenance_plans          10      vehicle_inspections         4
partner_applications        3      leads                       0
```

`-1` en `reltuples` significa "nunca analizada", no cero: `assistant_proposals`, `driver_licenses`,
`files`, `maintenance_occurrences`, `maintenance_occurrence_files`, `notification_rules`,
`partner_brands`, `partner_fuel_types`, `rag_documents`, `recommendation_impressions`,
`registration_cards`, `user_notification_preferences`, `vehicle_catalog_manuals`. Para saber el
tamaño real de esas, `count(*)`.

**`pgvector` está instalado** (`vector`, `halfvec`, `sparsevec`, HNSW/IVFFlat) — lo usa
`rag_documents`, cuyas categorías son `dtc_codes | manual | brand | mechanics`.

## Enums — el vocabulario del dominio

Son 36. Los que más van a aparecer en el panel:

```
user_role                     user | admin | provider
auth_provider                 clerk | native
partner_status                active | paused | archived
partner_tier                  founding | standard
partner_source                application | legacy_sheet | manual
partner_application_status    not_contacted | contacted | in_conversation | verbal_agreement | discarded
partner_link_kind             instagram | website | facebook | mercado_libre | x | tiktok | other
lead_status                   new | contacted | won | lost
lead_source                   marketplace | recommendation
document_status               active | expired | pending_renewal
fine_status                   pending | paid | appealed
fine_source                   manual | provider
fine_jurisdiction             caba | pba | ezeiza | lanus | santa_fe | lomas_zamora | corrientes | entre_rios | misiones
fuel_type                     gasoline | diesel | cng | electric | hybrid
transmission_type             manual | automatic | cvt
inspection_type               standard | cng
notification_status           pending | sent | read
notification_channel          push | email | sms
notification_delivery_status  sent | failed | no_token
conversation_status           active | closed
driving_session_status        pending_chunks | completed | failed
legal_document                terms_of_service | privacy_policy
```

**No dupliques estos valores a mano en el front.** Derivalos del contrato del backend. Un enum
copiado se desincroniza el día que el backend agrega un valor, y el síntoma es una fila que se
renderiza en blanco.

`partner_application_status` es un embudo (`not_contacted → contacted → in_conversation →
verbal_agreement`), con `discarded` como salida. Eso es una pantalla de pipeline, no un dropdown.

## Las dos únicas funciones de aplicación

El resto de `pg_proc` es pgvector. Estas dos son nuestras:

```sql
approve_partner_application(p_application_id uuid, p_reviewer_id uuid, p_coverage_zone text)
set_updated_at()   -- trigger
```

`approve_partner_application()` existe **porque no había panel**. El backend le puso una condición
explícita para que siga siendo aceptable: *"que se mantenga flaca: mueve estado y copia datos, no
decide nada."*

Cuando el panel implemente la aprobación, esa condición no se relaja. Si hay una decisión que tomar,
la toma el panel o un caso de uso del backend — **nunca se le agrega lógica a la función.**

## Convenciones del schema

- IDs `UUID`
- Columnas `snake_case`, **en inglés**
- El DDL agrupa por tema, **no por bounded context**. Su sección 3 ("Archivos y documentos") mezcla
  tablas de `files/` con tablas de `vehicle-management/`. No uses esa agrupación para inferir
  límites de contexto.
