# M3 Expressive

## Use

In **Settings → Skins**, select **M3 Expressive** under **Skin**. For the reference's navy/indigo and lavender colors, separately select **M3 Expressive** under **Palette**. Save changes to keep them; closing without saving restores the previous selection. Neither selector changes the other.

Inter is the skin's bundled interface-font default. Code font, density, motion preferences, and your per-skin font overrides remain independent. Pane widths remain user-resizable and are not reset when changing skin. Personal dithered backgrounds remain optional, visible only inside the conversation inset.

## Design decisions

- The supplied workspace reference governs the blue-indigo frame/header, near-black rounded conversation inset, selected navigation capsules, and 36px outlined floating composer with a circular send action. Following explicit user feedback, the outer sidebar/workspace/inspector containers are now contiguous and square at their junctions: no black perimeter, floating-pane gutters, or rounded outer islands. Resize tracks use the same panel tone and retain their full hit regions. Compact/collapsed layouts keep this continuous frame and the expressive inner controls.
- Surface hierarchy comes from palette tokens, not decorative gradients, glass, generated wallpaper, or nested cards. The companion palette is a restrained, manually mapped approximation of Material color roles—not a claim of a generated canonical Material scheme. Other dark/light palettes retain the skin's geometry.
- The two emphasized areas are navigation and the prompt. Operational typography remains dense; literal code keeps the selected code font. Existing components, handlers, keyboard semantics, capability gates, and resize regions remain authoritative.
- Agent group headers use centered square icon slots with balanced leading/label spacing and aligned tree connectors. Compact search and its add/folder actions scale together, leaving the placeholder readable.
- Detailed session rows keep metadata and hover actions without reserving an empty extra line. Both detailed and compact rows leave safe inner space around their curves.
- The music player stays mounted, including its audio element. A small renderer-only layout observer aligns it 12px inside the actual resized inspector and reserves its measured height in the inspector's scroll region. Its collapse control is integrated into the top row. Collapsed inspector/browser-shift states retain the existing floating fallback. An empty subagent-preview placeholder and its otherwise purposeless resize rule are omitted; selecting a real agent still opens the real preview.
- The conversation fill sits below the existing dither layer; the content above remains transparent. There is no skin-specific image or external resource request.
- Native window buttons are not Material controls. Their platform order, shape, drag exclusions, and reserved areas are unchanged. The native window remains opaque and resizable. This is the user's explicitly accepted **joined-pane fallback**, not native transparency or a CSS transparency claim. Electron 43.6.0 documents that transparent windows are not reliably resizable and Windows system-menu/double-click maximize is unavailable; `transparent` is a construction option, not a runtime appearance toggle. Introducing those constraints globally would affect other skins. No native window options were changed.

## Boundaries

Both skin and palette use ID `m3-expressive`, in separate registries. Default and Angelcore keep their existing styles and component implementations. Version 1/2 pack manifests still allow only `default` and `dreamcore` component bases; M3 does not expand executable or declarative pack capabilities. Three built-ins do not consume any of the sixteen pack slots. Appearance override validation and prepaint storage recognize the new built-in.

No new dependency, font download, arbitrary CSS import, script execution, or privileged renderer API was introduced. Existing focus treatment, reduced-motion settings, and OS reduced-motion handling remain in effect; this skin adds no animations.

## Verification and screenshots

`tests/e2e/m3-expressive.spec.ts` launches real Electron with the existing deterministic test runtime. It exercises selection, palette independence, preview cancellation, saved restart, normal/compact layouts, pane resizing, task/model/tool/resource/browser surfaces, agent fixtures, music geometry, and importing/removing an actual personal background. It checks zero outer pane margins/radii, contiguous pane/resize-track geometry and matching panel backgrounds at normal/compact/collapsed widths, no document overflow, composer/header containment, complete secondary-tab labels, safe session insets, centered root/group/node agent icons and balanced group-header spacing, readable search placeholders, unchanged platform chrome shape, symmetric dock insets, and inspector scroll clearance. Screenshots are not DOM-styled mockups.

The screenshots use fixture sessions, agents, tool output, and a local Git project, not a live authenticated model. Normal captures are 1600×900 with panes resized through real controls; compact captures are 1100×760 and 980×760, plus 640×680 with the panes collapsed through their real controls. `background-study.png` explicitly uses the repository's synthetic light-study image to test dither visibility; it is not bundled artwork for this skin.

Gallery under [`screenshots/m3-expressive/`](../screenshots/m3-expressive/):

- `workspace-1600.png`: normal workspace, detailed sessions, Agents and music.
- `populated-run.png`: populated agent tree and tool activity.
- `settings.png`, `light-preview.png`: saved settings and independent light-palette preview.
- `tasks-model-picker.png`, `tools.png`, `context.png`, `resources-browser.png`: operational surfaces.
- `compact-1100.png`, `compact-980.png`, `compact-640-collapsed.png`: compact/narrow layouts and the minimum-width collapsed workbench.
- `background-study.png`: optional background conversion and visibility.

Verified in the isolated implementation checkout on Windows:

- `pnpm verify`: passed typecheck, 194 unit files (2,049 passed / 3 skipped), production and E2E builds, and all 18 Electron journeys.
- After the final joined-shell fallback (retaining agent icon slots and compact search), `pnpm typecheck`, `pnpm build:e2e` (including the renderer build), and `pnpm exec playwright test tests/e2e/m3-expressive.spec.ts`: passed (1 journey).
- `git diff --check`: passed. The build emits the existing large-chunk advisory.

Native screenshots are captured on Windows only. Parameterized WindowChrome unit tests cover Windows/macOS/Linux branch behavior; they are not native macOS/Linux visual verification.

## Sources

Read alongside the supplied user reference, not in place of it:

- [Building with M3 Expressive](https://m3.material.io/building-with-m3-expressive): expressive emphasis and sparing use of hero moments.
- [Shape corner-radius scale](https://m3.material.io/styles/shape/corner-radius-scale): expanded expressive shape scale and optical nesting.
- [Color roles](https://m3.material.io/styles/color/roles): tonal surface hierarchy and paired content colors.
- [Typography tokens](https://m3.material.io/styles/typography/type-scale-tokens): deliberate emphasized labels, plain readable body text.
- [Button groups](https://m3.material.io/components/button-groups/overview): shaped, connected selection groups. Existing Fate navigation semantics are retained.
- [State layers](https://m3.material.io/foundations/interaction/states/state-layers): selected and transient interaction states are distinct.
- [Expressive motion](https://m3.material.io/m3-expressive-motion-theming): expressive motion is not an obligation to bounce an operational workbench.
- [Material Web labs](https://github.com/material-components/material-web/tree/main/labs): incomplete/experimental Expressive web component coverage is why this implementation uses existing Fate components and CSS, not a framework transplant.
- [Electron custom title bars](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar): preserve platform controls and drag/no-drag regions.
- [Electron 43.6.0 custom window styles](https://github.com/electron/electron/blob/v43.6.0/docs/tutorial/custom-window-styles.md): transparent-window resize and Windows maximize limitations.
- [Electron 43.6.0 BaseWindow options](https://github.com/electron/electron/blob/v43.6.0/docs/api/structures/base-window-options.md): constructor-level native transparency option.
