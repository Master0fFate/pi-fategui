# Angelcore coverage and verification

This pass extends the skin beyond the main chat. Screenshots below are actual Electron renders with deterministic test data, not generated mockups.

## Checks run

`pnpm verify` passed on Windows: TypeScript, production builds, **1,917 unit tests** (two existing skips), and **15 Electron E2E tests**. The dedicated journey is `tests/e2e/angelcore-complete.spec.ts`.

The journey checks populated states, not only empty panels. It verifies:

- One-line composer controls with Memory enabled at 980, 1280, and 1680px window widths, plus compact-mode checks. Project/model labels truncate; secondary actions remain in the tools menu.
- Non-overlapping workspace header identity and action controls.
- Queued messages, ordinary tasks, GoalMax criteria/editor, agent trees and clickable child previews, Context, Resources, Activity, and tool cards.
- Populated music playlists and transport controls in normal and compact modes.
- Model selection and both app and native-title tooltips.
- Browser tab creation, Back/Forward/Reload, address field, and device toolbar. The HTTP test page retains its own font and background; Chromium page content is not themed.
- A v2 pack containing a real WOFF2 font and embedded PNG, actual font loading, per-surface and density overrides, user selection of Poppins, and restart persistence. Code/terminal font stays independently selectable.
- Native title restoration after tooltip dismissal or leaving the skin.

The typed surface inventory in `src/renderer/skins/surfaces.ts` must match the creator-facing names in `src/shared/skinStyles.ts`. A regression test enforces that correspondence. Global fallbacks cover shared controls, while surface entries provide independent overrides.

## Screenshot gallery

| Surface | Evidence |
| --- | --- |
| Queue and ordinary tasks | [Normal](../screenshots/angelcore-complete/angelcore-queue-tasks.png) |
| GoalMax | [Criteria](../screenshots/angelcore-complete/angelcore-goal.png) · [Editor](../screenshots/angelcore-complete/angelcore-goal-editor.png) · [Compact criteria strip](../screenshots/angelcore-complete/angelcore-goal-tasks-compact.png) |
| Agents | [Child preview and controls](../screenshots/angelcore-complete/angelcore-agent-preview.png) · [Compact](../screenshots/angelcore-complete/angelcore-agents-compact.png) |
| Context | [Normal](../screenshots/angelcore-complete/angelcore-context.png) · [Compact](../screenshots/angelcore-complete/angelcore-context-compact.png) |
| Resources | [Normal](../screenshots/angelcore-complete/angelcore-resources.png) · [Compact](../screenshots/angelcore-complete/angelcore-resources-compact.png) |
| Music and playlist | [Normal](../screenshots/angelcore-complete/angelcore-playlist.png) · [Compact](../screenshots/angelcore-complete/angelcore-playlist-compact.png) |
| Model picker | [Open selector](../screenshots/angelcore-complete/angelcore-model-picker.png) |
| Tooltips | [App tooltip](../screenshots/angelcore-complete/angelcore-tooltip.png) · [Styled native title](../screenshots/angelcore-complete/angelcore-native-tooltip.png) |
| Browser controls | [Tabs, navigation, address, and device controls](../screenshots/angelcore-complete/angelcore-browser-chrome.png) |
| Memory-on toolbar | [Narrow compact layout](../screenshots/angelcore-complete/angelcore-compact-memory.png) |
| Other surfaces | [Memory library](../screenshots/angelcore-complete/angelcore-learning.png) · [Commands](../screenshots/angelcore-complete/angelcore-commands.png) · [Activity](../screenshots/angelcore-complete/angelcore-activity.png) |
| Custom fonts | [Poppins override in a bundled-font pack](../screenshots/angelcore-complete/skin-fonts-v2.png) |

## Boundaries and follow-up

The browser screenshot intentionally shows the app-owned chrome. Native Chromium views are separate surfaces; their styling was checked independently. Native OS dialogs and safety-critical confirmation typography are not replaced by an imported font.

The address parser now keeps HTTP(S) links ending in `.html` or `.svg` as network URLs, while retaining bare local filenames. A separate, pre-existing limitation remains: Back through local-file history can revisit an expired local-page capability. This pass does not weaken that security policy.

These results do not constitute native macOS/Linux verification of this branch. Those platforms still need the normal CI matrix before release. No new prerelease was published as part of this pass.

For the pack format and allowed appearance settings, see [Skins](skins.md).
