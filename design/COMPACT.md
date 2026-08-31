# Fate Compact

**Status:** live behind **Settings → Interface → Compact mode**.  
**On now:** whole workbench — Settings, chrome, chat, composer, inspector, lists, and dialogs.  
**Off:** `DESIGN.md` look. No Compact CSS leaks into Off.  
**Nested option:** Compact sessions (only while Compact mode is on).  
**Flag:** `document.documentElement.dataset.compactMode` (`true` / `false`). One attribute. CSS only.  
**Reference:** Settings dialog — start at **Agent → Providers**.  
**Code:** `:root[data-compact-mode="true"]` in `src/renderer/styles/global.css`.

This file is the operate-surface design system. It keeps Fate UI colors, type families, and calm charcoal atmosphere. It changes **density, rhythm, and chrome**.

Root `DESIGN.md` still owns the workbench shell (panes, conversation, composer). When a new operate surface is built, use this file. When the whole app moves to Compact, merge these tokens into `DESIGN.md`.

---

## Overview

**Creative North Star: “The Instrument Panel”**

A Fate Compact screen is a dense instrument, not a brochure. You scan a category, change a value, and leave. Every extra pixel is a tax.

The atomic unit is the **Provider Row**: one hairline list, 6×10 padding, 11/9 type, control on the right. Agent → Providers is the proof. Copy that row. Do not invent a second density.

**Key Characteristics:**
- Tight groups. Modest gaps between groups. No empty min-heights.
- Head = label + one small line. No icon blocks.
- Lists live in an 8px boxed stack. Rows split with a 1px line.
- Same charcoal + rare violet as the workbench. Density is the change, not color.

---

## Colors

Same palette as `DESIGN.md`. Do not add colors for Compact.

| Role | Token | Use |
|---|---|---|
| Canvas | `--theme-canvas` | page / dialog field wells |
| Panel | `--theme-panel` | dialog, nav, lists |
| Raised | `--theme-raised` | hover, selected fill, inputs |
| Border | `--theme-border` | list chrome, row splits |
| Border strong | `--theme-border-strong` | inputs, ghost buttons |
| Text | `--theme-text` | labels, 11px strong |
| Subtle | `--theme-subtle` | 9px helpers |
| Muted | `--theme-muted` | idle nav, meta |
| Accent | `--theme-accent` | selected, focus, primary |
| Success / warning / danger | semantic tokens | status only |

**Selected fill.** `color-mix(in srgb, var(--theme-accent) 8%, transparent)`.

**The One Signal Rule.** Violet marks the current action or location. It is not decoration.

**The Status-Only Rule.** Green, amber, and red appear only for real state (ready, key needed, error).

---

## Typography

One UI sans. Mono only for code, paths, shortcuts, and measured IDs.

| Role | Size | Weight | Color | Use |
|---|---|---|---|---|
| Dialog title | 13px | 620 | text | one per dialog |
| Section label | 11px | 600 | text | group head (`h3` / `strong`) |
| Row label | 11px | 600 | text | toggle / field name |
| Helper | 9px | 400 | subtle | one line under the label, max 46ch |
| Control | 10px | 400–600 | text | selects, ghost buttons, row names |
| Meta | 9px | 400–600 | subtle / muted | counts, chips, logs |
| Flag | 8px | 600 | warning / on-accent | `key needed`, `live` |
| Shortcut | 9px mono | 400 | text-soft | keycaps |

Line-height for helpers: **1.45**. Letter-spacing on dialog title: **-0.015em**.

**The 11/9 Rule.** A Compact label is 11px. Its helper is 9px. Do not use 12–16px heads on operate surfaces.

**The Tool, Not Costume Rule.** Mono is for machine text only.

---

## Layout

### Rhythm

Copy these numbers. Do not invent a fifth step.

| Token | Value | Use |
|---|---|---|
| `gap-1` | 1px | type stack inside a row; nav item stack |
| `gap-2` | 2px | helper under a head |
| `pad-row` | 6px 10px | every row |
| `gap-row` | 12px | label cluster ↔ control |
| `gap-group` | 8px | head → list; stacked fields |
| `gap-section` | 14px / 12px | next section: `margin-top: 14px; padding-top: 12px; border-top` |
| `pad-panel` | 12px 14px 16px | scroll body |
| `pad-nav` | 8px | side nav inset |
| `rail` | 156px | settings-style category rail |

**The No Empty Height Rule.** `min-height: 0` on rows. Height comes from padding + content. Banned: 54 / 62 / 76 / 96px row floors.

**The Tight-Then-Separate Rule.** Rows inside a group are tight. Space above the next heading is larger than space below it.

### Chrome

| Part | Size |
|---|---|
| Dialog | width `min(100vw - 40px, 760px)`, height `min(680px, 88vh)`, radius 12px |
| Header | 46px |
| Footer | 44px |
| Nav item | 34px, radius 6px, icon 14px |
| Select / text input | 28px |
| Primary action | 30px, min-width 110px, 11px type |
| Toggle track | 34 × 19 |
| Icon button | 24px |

At ≤700px: stack the rail as 5 equal icon tabs. Hide the rail labels. Keep row padding.

### Structure

One operate surface:

1. **Rail** — categories. Icon + label + optional 9px detail. Selected = raised fill + accent icon. No check mark.
2. **Head** — 11px title + 9px line. No section icon.
3. **Group** — 1px border, 8px radius, stacked rows.
4. **Sticky footer** — status left, actions right.

Do not wrap a group in a second card.

---

## Elevation & Depth

Flat by default. Depth is a 1px border or a tonal fill.

| Layer | Treatment |
|---|---|
| Pane / group / list | 1px `--theme-border`, no shadow |
| Selected row | 8% accent wash |
| Hover row | `--theme-raised` |
| Dialog / toast | one offset shadow (`0 28px 90px` / `0 14px 38px` mixed with `--theme-shadow`) |
| Focus | 2px accent outline, offset −2px inside a list, +2–3px on a free control |

**The Flat-by-Default Rule.** A shadow is only for a layer above the page (dialog, toast, menu). Lists do not cast shadows.

---

## Shapes

| Token | Value | Use |
|---|---|---|
| `radius-flag` | 4px | chips, keycaps, tiny badges |
| `radius-control` | 6px | inputs, nav items, ghost buttons |
| `radius-list` | 8px | groups, lists, notices, toasts |
| `radius-dialog` | 12px | the dialog only |
| Toggle | 10px pill | the switch track only |

Borders are **1px**. Pills are for tiny status only (`live`, `key needed`).

**The One Chrome Rule.** A list gets a box. A row inside it gets a hairline. Nothing else gets a card.

---

## Components

### 1. Provider Row — the atom

Use this for anything you can pick, toggle, or act on in a list: providers, voice models, shortcuts, theme rows, diagnostic lines.

```
┌──────────────────────────────────────────────┐
│ [mark]  Name                          meta  ×│  ← 6px 10px
│         9px helper                           │
└──────────────────────────────────────────────┘
```

- Padding: `6px 10px`. Gap: `8px`.
- Name: 10–11px, weight 600, ellipsis.
- Helper / count: 9px subtle, tabular nums for counts.
- Selected: 8% accent wash.
- Hover: raised.
- Trailing action (remove / download) is **icon-only**. It sits in a separate hit target and does not select the row.
- Voice models: name + helper stay left and share one text column. Tiny `live` / tier chips sit on the right, then the icon.
- Focus-visible: 2px accent outline, offset −2px.

### 2. Group head

```
Providers                         [ Add provider ]
Click a row to pick the default.
```

- Strong 11px. Small 9px subtle, max 46ch, 2px below the label.
- Optional trailing ghost: 10px, `5px 9px`, 6px radius, strong border, raised fill.
- Then the boxed list, `margin-top: 8–10px`.

### 3. Preference row

Label cluster on the left. Control on the right.

- Padding `6px 10px`. Gap `12px`.
- Strong 11px + small 9px.
- Split stacked rows with `1px` border.
- Controls: 28px select, 34×19 toggle, or a 10px ghost.

### 4. Boxed list

Theme group, font group, toggle stack, provider list, voice models, shortcuts, diagnostics, logs.

- `border: 1px solid var(--theme-border); border-radius: 8px;`
- No extra outer padding. Rows carry their own `6px 10px`.
- Do not put a boxed list inside another boxed list.

### 5. Inputs

- Height 26px. Padding `0 7px`. Radius 6px. Type 10px.
- Settings selects use `compact`. The **open menu** is compact too (portaled): item padding `4px 8px 4px 22px`, 10px label, 8px detail on the same line.
- Fill: `--theme-raised`. Border: `--theme-border-strong`.
- Focus: text-colored border + `0 0 0 3px color-mix(in srgb, var(--theme-accent) 12%, transparent)`.
- Disabled: 45% opacity.

### 6. Toggle

- Track 34×19, 10px pill.
- Off: border fill. On: accent fill, on-accent thumb.
- The row is the hit target. The input is visually hidden.

### 7. Flags and chips

- Flag: 8px, `1px 5px`, radius 4px, warning tint at 12%.
- Accent flag (`live`, selected tier): accent fill, on-accent type.
- Meta chip: 9px, `2px 6px`, raised or border fill.

### 8. Notice / status

One compact row. Not a banner.

- Padding `6px 10px` or `8px 10px`.
- 13–14px icon. 11px strong + 9px helper.
- Ready = success icon. Blocked = warning type. Error = danger type.

### 9. Dialog chrome

- Header 46px. Title 13px. One 10px muted line.
- Close: 28px ghost.
- Footer 44px. Status 10px left. Primary 30px right.
- Toast: 8px padding, 8px radius, sits above the footer.

### 10. Title bar

Compact is a **layout change**, not thinner padding on a stacked header.

```
SESSION · Session title · Idle  2 files     [palette][browser][folder][term][inspector]
```

- One 36px row. Eyebrow, title, and pulse sit on one baseline.
- Long pulse context is hidden. Chips stay.
- Icon buttons 24px, 2px gap.
- Sidebar brand is one row: logo only. Hide the Fate UI wordmark. Do not put the project name on that row.
- Settings header is one row: title + description.

### 11. Category rail

- 156px. Item 34px. Icon 14px + 11px label + 9px detail.
- Selected = raised + accent icon. No check. No badge.

---

## Do's and Don'ts

### Do
- **Do** start from Agent → Providers and copy its padding, type, and list chrome.
- **Do** use 11px labels and 9px helpers.
- **Do** put related controls in one boxed list.
- **Do** keep hit targets real: the whole row, or a separate trailing control.
- **Do** keep all existing behavior when you densify a screen.

### Don't
- **Don't** add a 17px icon beside every section title.
- **Don't** wrap a picker in a padded card.
- **Don't** set row `min-height` to “make it feel clickable.” Use padding.
- **Don't** nest cards. One box per group.
- **Don't** invent a second type ramp for operate UI.
- **Don't** spend accent on idle chrome.

---

## Adopt a new surface

Use this list when you move another screen to Compact.

1. Strip section icons and check marks.
2. Convert each title to 11px + 9px.
3. Put stacked prefs in a boxed list. Row padding `6px 10px`.
4. Flatten inner cards. Heads stay. Chrome goes.
5. Set selects/inputs to 28px / 10px / 6px radius.
6. Drop empty min-heights.
7. Keep every control, label, ARIA name, and handler.

**Audit test.** Blur the screen. You still see: rail → heads → boxed groups → sticky action. If you see stacked cards or large empty rows, it is not Compact.

---

## Token snapshot (copy into CSS)

```css
/* Fate Compact — operate surfaces */
--compact-label: 11px;
--compact-helper: 9px;
--compact-control: 10px;
--compact-row-pad: 6px 10px;
--compact-row-gap: 12px;
--compact-group: 8px;
--compact-section: 14px;
--compact-input-h: 28px;
--compact-nav-h: 34px;
--compact-header-h: 46px;
--compact-footer-h: 44px;
--compact-radius-control: 6px;
--compact-radius-list: 8px;
--compact-selected: color-mix(in srgb, var(--theme-accent) 8%, transparent);
```

These custom properties are the spec. They are not wired as a `:root` block yet. When the app fully transitions, put them on `:root` and replace the Settings literals.
