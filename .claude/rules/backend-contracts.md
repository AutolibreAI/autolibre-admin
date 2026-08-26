---
paths:
  - 'src/server/**'
  - 'src/fn/**'
  - 'src/lib/types.ts'
---

# Contratos con el backend

## Dónde está la verdad

`../CLEAN-ARCHITECTURE/autolibre-backend-hex` — NestJS, DDD + CQRS + Hexagonal, bounded contexts.

- `CLAUDE.md` de ese repo: la ley de arquitectura y las decisiones de modelado
- `autolibre-ddl-ddd.md`: **el DDL es la fuente de verdad del modelo de datos.** Leelo antes de
  introspeccionar la base viva.
- `.claude/rules/` de ese repo: `ddd-architecture.md`, `database-schema.md`, `api-documentation.md`,
  `naming-conventions.md`, `error-handling.md`, `external-integrations.md`

> Ojo: `ram_projects/autolibre-backend` es OTRO repo (monorepo npm `vehicle-care`). El que manda es
> el `-hex`.

## Bounded contexts

| Contexto | Módulo | Aggregates |
|---|---|---|
| Identidad y Acceso | `auth/` | User, LegalAcceptance |
| Gestión de Vehículos | `vehicle-management/` | Vehicle, VehicleCatalog, VehicleCatalogSpec, VehicleCatalogImage, VehicleCatalogManual, Insurance, VehicleInspection, RegistrationCard, Fine, DriverLicense |
| Archivos | `files/` | File |
| Mantenimiento | `maintenance/` | MaintenancePlan, MaintenanceOccurrence |
| Diagnóstico y Telemetría | `diagnostics/` | DrivingSession, DiagnosticDtc, AiDiagnostic |
| Asistente IA | `assistant/` | Conversation |
| Notificaciones | `notifications/` | Notification, NotificationRule, ExpoPushToken, UserNotificationPreference |
| Marketplace | `marketplace/` | Partner, PartnerApplication, Lead |
| Feedback | `feedback/` | Feedback |

Dos carpetas de `src/` **no** son bounded contexts, y son las únicas:

- `shared/` — transversal (`UniqueId`, excepciones, infra de Drizzle)
- `query/` — **capa de composición de lectura**. Vive ahí lo que cruza contextos y no tiene dueño
  natural (`GET /alerts`, `GET /vehicles/:id`, `GET /vehicles`).

**`query/` es la puerta natural del panel.** Buena parte de las vistas de admin son reportes que
cruzan contextos, que es exactamente lo que esa capa existe para resolver. Antes de escribir un SQL
desde el panel, mirá si el reporte pertenece a `query/`.

## Vocabulario — donde más fácil se desalinea una conversación

**Se dice `Partner`, nunca `Provider`.** El taller/gestoría es un Partner. El sufijo `Provider` está
reservado para integraciones externas (`XxxProvider` / `XxxGateway`); un aggregate llamado `Provider`
obligaba a nombres como `GoogleSheetsProviderProvider`.

**`PartnerApplication` y `Lead` apuntan en direcciones opuestas** y se confunden fácil:

- `PartnerApplication` — el taller viniendo **hacia nosotros** (se anota desde la landing)
- `Lead` — el usuario yendo **hacia el taller** (pide contacto)

Si en una conversación se usan mal, la conversación entera se desalinea sin que nadie lo note.

**`Recommendation` no es un aggregate** y nunca tuvo tabla: es el resultado de un cálculo. Lo que sí
se persiste es `recommendation_impressions`, telemetría append-only para el dataset de
learning-to-rank. El scoring es un *domain service*.

**El enum `user_role` todavía tiene `'provider'`.** Es sabido y no es un olvido: vive en `auth/`, otro
bounded context, y cambiarlo obliga a recrear el tipo entero.

## Auth — Clerk

El backend usa Clerk con `AuthGuard` global (`APP_GUARD`); `@Public()` es la única salida.

Tres cosas se configuran **fuera del repo**, en el dashboard de Clerk, y las tres tienen síntomas
concretos si faltan:

1. **`CLERK_JWT_KEY`** — clave pública del JWKS en PEM. Con ella la firma se verifica en proceso; sin
   ella el SDK resuelve el JWKS contra la API de Clerk (funciona igual, pero más caro).
2. **Los claims `email`, `name`, `phone` en el session token.** *El token default de Clerk NO los
   trae.* Sin ellos hay un round-trip a Clerk en **cada** request autenticada, y un `warn` una sola
   vez por proceso. Ese warn en los logs es la señal.
3. **`CLERK_WEBHOOK_SECRET`** — para `POST /api/v1/webhooks/clerk` (`user.created`, `user.updated`).
   Firma Svix, que valida timestamp además de firma: **el reloj del server desfasado más de 5 minutos
   rechaza todos los webhooks con 401**, y el síntoma parece un secreto mal copiado.

Sincronización de `users`: el webhook es el camino principal; el provisioning JIT queda como red de
seguridad.

**La clave de identidad es el par `(auth_provider, external_auth_id)`, nunca el email.** Hoy son dos
columnas de `users`, o sea un usuario = exactamente una identidad externa.

### Qué falta acá

`src/server/session.ts` es **placeholder declarado** — cookie sellada, sin Clerk. Reemplazarlo por
Clerk web es trabajo pendiente y el gate de admin sale de `user_role`.

## Aceptación legal

No se captura "en el alta" porque el backend **no tiene momento de alta**: el `User` aparece por
webhook o JIT. Va por `POST /legal/acceptances`. La versión vigente es una **constante de dominio**
(`legal-document.vo.ts`), no una fila de config — así "desde cuándo rige esta versión" queda en el
historial de git.

Hoy **solo registra**: no hay guard que bloquee a quien no aceptó. Sumarlo sería un cambio de
contrato para los clientes (un 403 posible en todas las pantallas) que hay que coordinar.

## Al escribir un adapter

1. **Preguntá primero si va contra la API hex o contra Postgres.** Es una decisión abierta (ver
   CLAUDE.md). La regla de mobile es "hex por default", pero el panel tiene el caso real de los
   reportes cross-contexto.
2. Modelá las entidades desde los **contratos reales de la API**, nunca desde la forma de los datos
   de otra pantalla. En mobile eso ya costó tirar y rehacer un módulo entero.
3. Respetá el vocabulario de arriba en tipos y nombres de archivo.
