---
paths:
  - 'src/**/*.tsx'
  - 'src/styles.css'
---

# Design system

## La fuente de verdad está en otro repo

`autolibre-mobile/modules/shared/ui/theme/tokens.ts` (Figma → *Foundations / Design System*).

`src/styles.css` es un **puerto**, no un original. Si un valor de acá y uno de allá no coinciden,
gana mobile y este archivo está mal. Cuando cambie el Figma, se actualiza mobile primero y después
se re-portea acá.

## Las tres cosas que se rompen más seguido

### 1. El sistema es light-only

En mobile, `Colors.dark` **espeja** a `Colors.light` — existe como fallback de tipado, no como tema.
Acá `.dark` solo declara `color-scheme: light` por la misma razón.

No diseñes contra un modo oscuro. No agregues un toggle de tema. Si hace falta uno, es una decisión
de diseño que se toma en el Figma, no en el CSS del panel.

### 2. No hay sombras

```ts
// tokens.ts
export const Shadows = {
  sm: { shadowOpacity: 0, elevation: 0 },
  md: { shadowOpacity: 0, elevation: 0 },
  accent: { shadowOpacity: 0, elevation: 0 },
}
```

Los tres niveles son cero. El sistema separa superficies con **bordes**, no con elevación.

- ❌ `shadow-sm`, `shadow-md`, `drop-shadow-*`
- ✅ `border border-border`

shadcn trae `shadow-*` por default en varios componentes (`card`, `popover`, `dropdown-menu`). Al
agregar un componente nuevo, **revisá y sacá la sombra**.

### 3. El verde es acento, no protagonista

Del comentario de cabecera de `tokens.ts`:

> *"El verde de marca es un acento de identidad (íconos activos, navegación, CTAs de alto contraste),
> nunca el color dominante de la interfaz: la base visual es blanco, gris y Action Dark."*

Por eso `--primary` de shadcn está mapeado a **Action Dark (`#1C2B1C`)** y no al verde. Un botón
primario es oscuro. El verde aparece en el ítem de nav activo, en `--accent` y en el foco (`--ring`).

Si una pantalla se ve verde, está mal.

## Tokens

Todo vive en `:root` de `src/styles.css` y se expone a Tailwind vía `@theme inline`.

| Grupo | Tokens |
|---|---|
| Marca | `--brand-500` `#2A8C3A` · `--brand-200` `#A8DFB0` · `--brand-50` `#E8F5E8` · `--action-dark` `#1C2B1C` |
| Neutros | `--canvas` `#F1F2F0` · `--surface` `#FEFEFD` · `--surface-2` `#F3F4F6` · `--border-neutral` `#E4EAE4` |
| Texto | `--gray-900` `#111827` · `--gray-700` `#374151` · `--gray-500` `#6B7280` · `--gray-400` `#9CA3AF` · `--gray-300` `#D1D5DB` |
| Estado | verde `#1A7A4A` · amarillo texto `#9A6B0F` · rojo `#A8231A` · violeta `#5B3F8C` (+ su `-bg`) |

### Dos quirks portados a propósito

**`--status-violet` se llama "Status/Orange" en el Figma y su hex real es violeta.** No es un error
de transcripción: está así en el archivo fuente y mobile lo portó fiel. Es el 3er nivel de severidad
del catálogo de DTC (`amarillo` / `violeta` / `rojo`).

**El ámbar tiene dos valores.** `--status-yellow` (`#9F7401`) es el del swatch; `--status-yellow-text`
(`#9A6B0F`) es el legible sobre fondo claro. Para texto y badges usá el segundo — es lo que hace
`StatusBadge`.

> ⚠ **Pero la clase de Tailwind NO se llama igual que la variable, y esto ya mordió.**
> `@theme inline` expone **`--color-status-yellow: var(--status-yellow-text)`** — o sea que
> **`text-status-yellow` YA es el ámbar legible `#9A6B0F`**. No existe ningún
> `--color-status-yellow-text`, así que **`text-status-yellow-text` no genera nada**: Tailwind
> descarta la clase desconocida en silencio y el elemento hereda el color del padre.
>
> Cómo se ve el bug: un badge de advertencia que sale gris o negro en vez de ámbar. `tsc` pasa, el
> build pasa, `cn()` pasa — **no hay ninguna herramienta que lo agarre**. Se encontró leyendo el
> `@theme` a mano después de escribirlo mal seis veces.
>
> Regla que sale de esto y aplica a TODO token nuevo: **el nombre de la clase es lo que está en
> `@theme inline`, nunca lo que está en `:root`.** Antes de usar una clase de color que no viste en
> otro archivo del repo, `grep --color-<nombre> src/styles.css`. Si no está ahí, no existe.

## Clases utilitarias disponibles

Además del vocabulario de shadcn (`bg-card`, `text-muted-foreground`, …), `@theme inline` expone:

`bg-brand` · `bg-brand-soft` · `bg-brand-muted` · `bg-action` · `bg-canvas` · `bg-surface` ·
`bg-surface-2` · `text-status-green` · `bg-status-green-bg` · y los equivalentes de yellow / red /
violet.

Usá estos antes que un arbitrary value. `bg-[#2A8C3A]` es un bug: no sigue al token si el token cambia.

## Tipografía

**Outfit** para títulos y datos · **DM Sans** para cuerpo y UI. Se cargan desde Google Fonts en
`__root.tsx` con `preconnect` + `display=swap`.

```
font-heading  → Outfit    (h1–h4 ya lo aplican en la capa base)
font-sans     → DM Sans   (default de <body>)
```

### El peso NO es un parámetro libre

En mobile cada peso es un **archivo** y el número va en el nombre (`Outfit_600SemiBold`,
`DMSans_500Medium`). Pedir un `fontWeight` que no sea el del archivo cargado no cambia de archivo:
lo sintetiza el sistema y en Android se ve embarrado. Bug real que costó esa lección:
`filter-options-sheet.tsx` pedía `fontWeight: 600` sobre `DMSans_500Medium`.

En web la fuente variable hace disponible cualquier peso, así que ese bug específico no aplica. **Lo
que sí sigue aplicando es el emparejamiento**: un título nunca va en DM Sans, un párrafo nunca va en
Outfit. Solo se cargan los pesos que el sistema usa (DM Sans 400/500/700, Outfit 600/700) — pedir
otro obliga a sumarlo a la URL de Google Fonts, y eso es una decisión, no un detalle.

### Escala

La escala de mobile (`Typography`) fue **medida, no inventada**: un relevamiento encontró 41 pares
familia+tamaño distintos y solo 9 con token, así que se agregaron los tres más usados que faltaban
(`footnote`, `bodyMdMedium`, `bodyLgMedium`). Lo que se dejó afuera a propósito: los tamaños
fraccionarios (12.5, 11.5, 13.5) — *"eso no es vocabulario de diseño, es alguien empujando píxeles
de a medio"*.

Misma disciplina acá: si un tamaño nuevo aparece tres veces, es un token. Si aparece una vez, está
mal medido.

## Espaciado y radios

`Spacing`: 4 · 8 · 12 · 16 · 20 · 24 · 32 — la escala de 4px de Tailwind ya los cubre
(`gap-1` … `gap-8`).

`Radius`: 6 / 10 / 14 / 18 / 24 / full → `rounded-sm` … `rounded-2xl` / `rounded-full`.

`ControlSize.button.borderRadius` es **8px**, y ese es el `--radius` que consumen los componentes de
shadcn. No es el mismo número que `Radius.md` (10): los controles interactivos tienen su propia
medida en el sistema.

## Al agregar un componente de shadcn

```bash
npx shadcn@latest add <componente>
```

Después, siempre:

1. **Sacar `shadow-*`** (ver arriba).
2. Verificar que no haya hexes hardcodeados ni colores de la paleta default de shadcn.
3. Si necesita un color que el vocabulario de shadcn no cubre (un estado, chrome flotante), usá el
   token de AutoLibre — no inventes una variante nueva de shadcn.
