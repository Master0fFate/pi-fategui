<!-- SEED: established with the user before implementation; re-run $impeccable document once there's code to capture the actual tokens and components. -->
---
name: Pi Desktop
description: A calm, local-first graphical workspace for the real Pi coding agent.
---

# Design System: Pi Desktop

## Overview

**Creative North Star: “The Focused Workbench”**

Pi Desktop should feel like a purpose-built instrument for sustained coding work: quiet when idle, precise when active, and transparent when the agent uses tools. The world is a near-black blue-charcoal desktop with clearly joined work surfaces, fine separators, cool near-white type, and a rare violet signal for focus and active state.

The reference in `concept.png` governs atmosphere and first-launch hierarchy. Operational screens replace its broad hero staging with a resizable three-pane workbench; expression never hides state, task, or native desktop affordances.

**Key Characteristics:**
- One continuous desktop shell rather than a dashboard of floating cards.
- Cool charcoal tonal layers separated by one-pixel rules.
- Restrained violet used for focus, selection, streaming, and the primary action.
- Generous breathing room at first launch and compact, stable density during work.
- Motion acknowledges state without delaying input or shifting layout.

## Colors

Use a restrained strategy: neutral charcoal owns the application, while one cool violet carries interaction emphasis. Success, warning, and danger colors are semantic only. Exact production tokens are resolved and extracted during implementation.

**The One Signal Rule.** Violet marks the current action or location; it is not ambient decoration across every surface.

## Typography

Use a native-feeling workhorse UI sans stack for controls, navigation, and conversation. Reserve the platform monospace stack for code, paths, terminal output, diffs, shortcuts, and measured token data. The first-launch heading may be larger, but operational hierarchy stays compact and obvious.

**The Tool, Not Costume Rule.** Monospace communicates literal code or machine data; it never serves as a generic “technical” accent.

## Layout

The primary composition is a resizable three-column workbench: sessions and project navigation at left, the conversation workspace in the fluid center, and a tabbed project inspector at right. The left pane collapses to an icon rail; the inspector collapses completely and leaves a clear reopen control. A separate terminal panel opens below the workspace.

At narrower desktop widths, flexible pane caps preserve the center task before secondary labels disappear. Pane sizes persist locally. Streaming content may grow inside virtualized scrollers but must not alter the surrounding grid.

## Elevation & Depth

Depth is primarily tonal and structural. Joined panes use fine borders; floating surfaces such as menus, dialogs, the command palette, and the composer may use one diffuse, offset ambient shadow. There is no decorative glass blur and no zero-offset neon halo.

**The Flat-by-Default Rule.** A surface earns elevation only when it must sit above another interaction layer.

## Shapes

Controls use compact, gently curved corners; substantive panels remain joined to the application frame. Pills are reserved for small statuses and short selectors. Borders stay one pixel. The composer may have the most generous radius because it is the primary input surface, but it must not turn every surrounding element into a matching rounded card.

## Components

Implementation begins with the joined shell, resize handles, sidebar rows, workspace header, inspector tabs, empty states, composer, and accessible tooltips. Their exact tokens and state recipes are provisional until the first scan-mode extraction.

Every interactive component needs default, hover, focus-visible, active, disabled, loading, and recoverable error behavior where applicable. Disabled future actions must look unavailable and explain the prerequisite rather than behaving like dead buttons.

## Do's and Don'ts

### Do:
- **Do** preserve the concept’s charcoal/violet calm while prioritizing operational clarity.
- **Do** use semantic hierarchy, stable alignment, and concise product language.
- **Do** keep project trust, connection, model, thinking, and active-run state findable.
- **Do** use authored empty, loading, streaming, stopped, compacted, and error states.

### Don't:
- **Don't** imitate Pi’s terminal UI or any competing desktop product.
- **Don't** build the surface from repeated same-size icon cards or nested rounded containers.
- **Don't** use excessive gradients, decorative glass, neon glows, fake metrics, or visual noise.
- **Don't** animate in ways that delay interaction, cause layout jumps, or ignore reduced motion.
