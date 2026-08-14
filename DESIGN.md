---
name: Fate UI
description: A calm, local-first graphical workbench for the real Pi coding agent.
colors:
  canvas: "#090b12"
  panel: "#0f121c"
  raised: "#171b28"
  border: "#272c3a"
  text: "#eef0f7"
  muted: "#8992a7"
  accent: "#7c6cff"
  success: "#55c78a"
  warning: "#d2a94b"
  danger: "#e35d6a"
typography:
  title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
  code:
    fontFamily: "Cascadia Mono, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  control: "7px"
  surface: "12px"
  composer: "15px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    height: "38px"
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    height: "34px"
---

# Design System: Fate UI

## Overview

**Creative North Star: “The Focused Workbench”**

Fate UI is a purpose-built instrument for sustained coding work: quiet when idle, precise when active, and transparent when Pi uses tools. A continuous blue-charcoal shell joins navigation, conversation, inspector, and terminal rather than presenting a dashboard of floating cards.

The shipped interface governs atmosphere and first-launch hierarchy; the maintained product screenshots are available at `screenshots/fate-ui-dark.png` and `screenshots/fate-ui-light.png`. Operational states become denser without losing calm, and expression never obscures state or familiar desktop affordances.

**Key Characteristics:**
- Continuous joined panes with fine structural separators.
- Cool near-white type over charcoal tonal layers.
- Violet reserved for focus, selection, streaming, and primary action.
- Spacious first launch; compact, stable density during work.
- Motion acknowledges state without delaying input or moving layout.

## Colors

Canvas and panel neutrals own nearly the entire interface. Accent is deliberately rare; success, warning, and danger appear only for semantic status.

**The One Signal Rule.** Violet marks the current action or location, never ambient decoration across every surface.

## Typography

Native-feeling UI sans handles controls, navigation, and conversation. The platform monospace stack is reserved for code, paths, terminal output, diffs, shortcuts, and measured data. The first-launch heading is the only display-scale type.

**The Tool, Not Costume Rule.** Monospace communicates literal machine content, never generic technical flavor.

## Layout

The default desktop is a resizable three-column workbench: sessions/resources at left, a fluid conversation center, and Changes/Files/Tools/Context at right. The left pane collapses to a 64px rail; the inspector collapses fully. The manual terminal occupies a bounded lower panel. Panel sizes persist locally, while viewport-relative caps protect the center at narrower widths.

Virtualized lists own their scroll regions. Streaming content grows inside the timeline and never changes the outer grid.

## Elevation & Depth

Depth is tonal and structural. Joined panes use one-pixel borders. Menus, dialogs, palette, tool detail, and composer may use one diffuse offset shadow. There is no decorative glass blur or zero-offset neon halo.

**The Flat-by-Default Rule.** A surface earns elevation only when it must sit above another interaction layer.

## Shapes

Controls use compact 6–8px corners; dialogs and substantive floating surfaces use 12px; the composer alone reaches 15px. Pills are reserved for tiny statuses. Borders remain one pixel and panel edges stay joined to the application frame.

## Components

- **Primary buttons:** violet fill, cool-white label, 38px height, immediate hover contrast, and visible focus ring.
- **Rows and tabs:** flat at rest; active state uses a low-contrast fill or thin accent underline.
- **Composer:** the largest-radius input surface with stable multiline height, explicit queue/stop controls, and capability-gated attachments.
- **Tool cards:** one chronological entity with status, summarized input, bounded output, duration, and expandable details.
- **Dialogs/palette:** Radix focus management, dark raised surface, concise labels, no ornamental chrome.
- **Terminal:** near-black xterm canvas clearly labeled “Manual terminal” and “Separate from Pi tools.”

## Do's and Don'ts

### Do:
- **Do** keep project trust, connection, model, thinking, active run, and errors findable.
- **Do** use authored empty, loading, streaming, stopped, compacted, truncated, unavailable, and recovery states.
- **Do** preserve alignment and stable dimensions while text or tool output streams.
- **Do** honor keyboard focus and reduced-motion preferences.

### Don't:
- **Don't** imitate Pi’s TUI or another coding desktop product.
- **Don't** build operational screens from nested rounded cards.
- **Don't** use decorative glass, neon glows, fake metrics, gradient text, or visual noise.
- **Don't** present enabled controls without a real action or an honest capability gate.
