# Pedido al backend — 2026-10-03

De: panel de administración (`autolibre-admin`). Para: equipo de `autolibre-backend-hex`.

Dos pedidos. El primero es el grande: hoy bloquea editar y crear las reglas de
notificación desde el panel. El segundo es chico y hace exacta una métrica nueva.

Todo lo relevado salió de **producción** el 2026-10-03 (`autolibre`, `doadmin`,
puerto 25060), sólo lectura.

---

## 1. Reglas de notificación: editar textos y plazos, crear reglas, y una sola tabla

### Lo que quiere el equipo

1. **Editar el texto** (título y cuerpo) de los recordatorios de vencimiento.
2. **Editar los plazos** (los "N días / km antes").
3. **Crear reglas nuevas** desde el panel.
4. **Una sola tabla de reglas**, no dos: hoy conviven
   `public.notification_rules` (backend) y `ops.notification_schedule` (panel).

### Lo que hay hoy

**`public.notification_rules`** — 22 filas, todas `push · before · active`,
sembradas el 2026-08-30 (`updated_at = created_at` en las 22: nadie las tocó
desde entonces).

```
id · source_type · channel · offset_unit (days|km) · offset_direction (before|after)
   · offset_value · active · created_at · updated_at
UNIQUE (source_type, channel, offset_unit, offset_direction, offset_value)
```

| Documento | Plazos |
|---|---|
| Seguro, VTV, Licencia | 30 · 15 · 7 · 2 · 1 días |
| Mantenimiento | 30 · 15 · 7 · 2 · 1 días + 100 · 50 km |

- **No hay columna de texto.** Título y cuerpo los arma el backend en código.
  Por eso el panel no los puede editar, ni con SQL.
- El de mantenimiento sale **"custom de tu vehículo vence el …"**: es el slug
  crudo del servicio. Es un bug.
- `registration_card` y `fine` existen en `notification_source_type` y no
  tienen ninguna regla.

**`ops.notification_schedule`** (del panel, migración 014): envíos por
**audiencia** (condiciones sobre el usuario) + **recurrencia**, con título y
cuerpo propios. Hay 1 regla activa ("sin vehículo, día por medio"). **No hay
motor que la dispare**: el panel no puede mandar un push sin una request de un
admin (`POST /notifications/broadcast` usa el token del admin logueado), y un
envío programado no tiene a nadie logueado.

### Por qué el panel no lo resuelve solo

- **El texto vive en el código del backend.** No hay columna que el panel
  pueda editar.
- **Cambiar un plazo NO es un `UPDATE offset_value`.** La dedupe de avisos es
  `(rule_id, source_id)` y la FK de `notifications.rule_id` es
  `ON DELETE RESTRICT`. Si la regla de 30 pasa a decir 45, los avisos que ya
  salieron "a 30 días" quedan atribuidos a una regla de 45. Además, quien ya
  recibió el de 30 no recibe el de 45. Cambiar un plazo es crear la regla
  nueva y pausar la vieja.
- **No sabemos qué hace el motor con un plazo ya vencido** al crear o
  reactivar una regla. Lo relevado: a veces lo recupera (un seguro recibió el
  aviso de 30 y el de 15 días en el mismo tick), a veces no. Si el panel crea
  "seguro 60 días", ¿le suena a todos los que hoy están a menos de 60 días, en
  ráfaga?
- **No sabemos si el seed reactiva reglas en cada deploy.** Si lo hace, una
  pausa desde el panel se deshace sola.

### Propuesta: un solo modelo de regla, del backend

Una regla = **cuándo** + **a quién** + **qué dice**.

```
notification_rules
  id
  name                      -- para el panel
  trigger_kind              -- 'document_expiry' | 'schedule'
  -- document_expiry (lo que hay hoy):
  source_type, offset_unit, offset_direction, offset_value
  -- schedule (lo que hoy es ops.notification_schedule):
  audience jsonb            -- condiciones cerradas {field, op, value}; NUNCA SQL
  recurrence jsonb          -- {kind: 'everyNDays'|'weekly'|…, atHour, atMinute}
  starts_on, ends_on, max_per_user, require_device, exclude_internal
  -- común:
  channel
  title_template, body_template   -- con variables: {{vehiculo}}, {{patente}},
                                  -- {{vence}}, {{aseguradora}}, {{servicio}}…
  active
  created_by, created_at, updated_at
```

- Las 22 reglas actuales pasan con `trigger_kind = 'document_expiry'`. Sus
  textos de hoy entran como `title_template` / `body_template`, así nada
  cambia el día del deploy.
- `ops.notification_schedule` se migra a `trigger_kind = 'schedule'`. Las
  condiciones son el catálogo cerrado del panel (`src/lib/audience.ts`): se lo
  pasamos tal cual. Cuando esté, el panel deja de escribir `ops` y borra esa
  tabla.
- Las variables de cada `source_type` las define el backend. El panel sólo
  necesita la lista para mostrar los botones de "insertar variable" y validar.
- **El motor de `schedule` es el que falta hoy.** El backend ya tiene el cron de
  entrega y `Notification.create()` con el filtro de preferencias; hoy el
  envío programado del panel no tiene quién lo dispare.

### Endpoints que necesitaría el panel (todos con `AdminGuard`)

| Método | Ruta | Para |
|---|---|---|
| `GET` | `/notification-rules` | listar con su texto vigente (el panel ya lee la tabla por SQL; esto es para el texto si sigue en código) |
| `POST` | `/notification-rules` | crear |
| `PATCH` | `/notification-rules/:id` | editar texto, audiencia, recurrencia, `active` |
| `GET` | `/notification-rules/variables` | variables disponibles por `source_type` |
| `POST` | `/notification-rules/:id/preview` | renderizar el texto contra un caso real (opcional) |

Para cambiar un plazo, el panel llamaría `POST` (regla nueva) + `PATCH active=false`
(la vieja). O el backend expone un `PATCH` de plazo que haga eso por dentro.

La identidad del admin viaja en el token de Clerk, como en
`/notifications/broadcast`. Que `created_by` / quién editó quede registrado
es lo único que tenemos como auditoría.

### Preguntas que necesitamos contestadas

1. ¿El seed de reglas corre en cada deploy? ¿Hace `ON CONFLICT DO NOTHING` o
   `DO UPDATE SET active = true`?
2. Al **crear o reactivar** una regla de plazo, ¿el motor manda el aviso a
   quien ya pasó ese plazo? ¿En ráfaga?
3. ¿El motor relee las reglas en cada tick o las cachea al arrancar?
4. ¿Por qué VTV 1–2 días, licencia 1–15 días y los de km tienen **0 avisos**
   generados? ¿No hay datos que los cumplan, o el motor no los evalúa?
5. ¿`offset_direction = 'after'` está implementado en el motor? (Sería "tu VTV
   venció hace 7 días".)
6. ¿Qué haría falta para `registration_card` y `fine`?

### Mientras tanto

Las reglas de `public.notification_rules` se ven en `/notificaciones/reglas`
**sólo lectura**. El panel no va a escribir esa tabla por SQL: sin las
respuestas 1 y 2, una pausa se puede deshacer sola o un alta puede disparar
una ráfaga.

---

## 2. Guardar el teléfono en `users`

### Para qué

`/metricas` ahora cuenta personas por canal: app, WhatsApp y web. Una persona
que escribió por WhatsApp y después bajó la app tiene que contarse **una vez**,
como usuario de la app que llegó por WhatsApp.

### El problema

`users.phone` está **vacío en los 250 usuarios** de producción. Hoy el panel
sólo puede cruzar un contacto de WhatsApp/web con una cuenta de dos formas:

1. la persona pidió un presupuesto **desde la app** con el mismo teléfono
   (`quote_requests` trae `user_id` + `contact_phone`);
2. el email del pedido web coincide con `users.email`.

Quien escribió por WhatsApp, bajó la app y nunca pidió nada desde ahí **queda
contado dos veces**: como "sólo WhatsApp" y como usuario de la app.

### Lo que pedimos

- Completar `users.phone` desde Clerk (el claim `phone` del token, o el webhook
  `user.created` / `user.updated`). Si la persona no cargó teléfono en Clerk,
  queda `NULL`, sin problema.
- **Normalizado igual que `quote_requests.contact_phone`**: `549` + 10 dígitos.
  Si no, el cruce no matchea.
- Opcional: pedir el teléfono en el onboarding de la app.

Con eso el panel cruza por `users.phone` sin cambiar nada más.
