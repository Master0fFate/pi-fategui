# M3 Expressive

## Use

In **Settings → Skins**, select **M3 Expressive** under **Skin**. For the reference's navy/indigo and lavender colors, separately select **M3 Expressive** under **Palette**. Save changes to keep them; closing without saving restores the previous selection. Neither selector changes the other.

Roboto Flex is the skin's bundled interface-font default. Code font, density, motion preferences, and your per-skin font overrides remain independent. Pane widths remain user-resizable and are not reset when changing skin. Personal dithered backgrounds remain optional, visible only inside the conversation inset.

## Design decisions

- The supplied workspace reference governs the blue-indigo frame/header, near-black rounded conversation inset, selected navigation capsules, and 36px outlined floating composer with a circular send action. Following explicit user feedback, the outer sidebar/workspace/inspector containers are now contiguous and square at their junctions: no black perimeter, floating-pane gutters, or rounded outer islands. Resize tracks use the same panel tone and retain their full hit regions. Compact/collapsed layouts keep this continuous frame and the expressive inner controls.
- Surface hierarchy comes from palette tokens, not decorative gradients, glass, generated wallpaper, or nested cards. The companion palette is a restrained, manually mapped approximation of Material color roles—not a claim of a generated canonical Material scheme. Other dark/light palettes retain the skin's geometry.
- The two emphasized areas are navigation and the prompt. Operational typography remains dense; literal code keeps the selected code font. Existing components, handlers, keyboard semantics, capability gates, and resize regions remain authoritative.
- Agent group headers use centered square icon slots with balanced leading/label spacing and aligned tree connectors. Compact search and its add/folder actions scale together, leaving the placeholder readable. Sidebar tabs share the search origin, height and two action slots; missing actions leave empty layout space, not dummy controls. M3 omits the tab-entry vertical animation so switching Sessions/Agents/Resources does not move the search row, including with a user-selected monospace font.
- Detailed session rows keep metadata and hover actions without reserving an empty extra line. Both detailed and compact rows leave safe inner space around their curves.
- The music player stays mounted, including its audio element. A small renderer-only layout observer aligns it 12px inside the actual resized inspector without shrinking the inspector's scroll region. The previous height reservation exposed a rectangular inspector-colored footer behind the rounded card; it is now a genuine overlay. Layout wrappers are explicitly transparent and unclipped; subtle token-derived shadows belong only to the rounded player/playlist cards. Its collapse control is integrated into the top row. Collapsed inspector/browser-shift states retain the existing floating fallback. An empty subagent-preview placeholder and its otherwise purposeless resize rule are omitted; selecting a real agent still opens the real preview.
- Browser-owned chrome uses tonal capsule tabs with a filled selected state (not the inherited underline), centered close/add controls, tonal navigation actions, and one rounded address field. This is a custom M3-inspired adaptation, not a canonical Material tab component. Compact density preserves the treatment, long titles truncate, and the tab strip scrolls horizontally. All fills derive from palette tokens; website styles and native browser behavior remain independent.
- The conversation fill sits below the existing dither layer; the content above remains transparent. There is no skin-specific image or external resource request.
- Workspace header actions use explicit centered grid boxes with zero padding/line-height and block SVGs, retaining 40px normal / 30px compact or narrow controls. Optical sizing is refined from 17px glyphs to 20px normal / 18px compact or narrow for balanced glyph-to-button proportions. Electron measurements found the existing SVG and group centers already exact (41px normal / 29px compact header center); no per-icon translation or group shift was introduced. Regression captures `header-{normal,mono,compact,compact-mono}.png` cover both interface fonts and the platform-safe drag region.
- Native window buttons are not Material controls. Their platform order, shape, drag exclusions, and reserved areas are unchanged. The native window remains opaque and resizable. This is the user's explicitly accepted **joined-pane fallback**, not native transparency or a CSS transparency claim. Electron 43.6.0 documents that transparent windows are not reliably resizable and Windows system-menu/double-click maximize is unavailable; `transparent` is a construction option, not a runtime appearance toggle. Introducing those constraints globally would affect other skins. No native window options were changed.

## Bundled typography

Material's baseline default remains Roboto; **Roboto Flex** is its variable expressive option, not a Google brand-font requirement. Fate bundles unmodified `@fontsource-variable/roboto-flex` 5.3.0 locally under SIL OFL 1.1. The normal `opsz.css` entry retains variable weight (100–1000) and optical sizing (8–144); Chromium's automatic optical sizing follows the actual text size. No stylistic axis animation or new layout treatment is introduced.

The fallback stack is Roboto Flex → locally available Roboto → the already bundled Noto families/system sans. No CDN or remote font request is used. The picker exposes **Roboto Flex** for every skin; M3 uses it as a default only, so a saved per-skin font override still wins. Code font is separate. Angelcore retains its already bundled JetBrains Mono. Copyright attribution and the full OFL accompany releases in [`FONT_LICENSES.md`](../FONT_LICENSES.md).

Version-2 pack creators can refer to `roboto-flex` as a built-in appearance default, or supply their own declared WOFF/WOFF2 with `local:` references. No new font-import UI or relaxed security limits are needed; see [skin pack fonts](skins.md#bundled-fonts-and-defaults). Electron tests verify actual loaded `FontFace` entries—not just CSS stacks—for Roboto Flex, Angelcore's JetBrains Mono, and a namespaced imported font, including picker selection, default reset, and restart.

## Boundaries

Both skin and palette use ID `m3-expressive`, in separate registries. Default and Angelcore keep their existing styles and component implementations. Version 1/2 pack manifests still allow only `default` and `dreamcore` component bases; M3 does not expand executable or declarative pack capabilities. Three built-ins do not consume any of the sixteen pack slots. Appearance override validation and prepaint storage recognize the new built-in.

The only added production dependency is the locally bundled Roboto Flex font package. No runtime font download, arbitrary CSS import, script execution, or privileged renderer API was introduced. Existing focus treatment, reduced-motion settings, and OS reduced-motion handling remain in effect; this skin adds no animations.

## Theme compliance

The skin CSS contains no fixed palette colors or font-family overrides: surfaces, text, selection, outlines, and shadows derive from `--theme-*` tokens. Interface/code fonts and motion/density preferences retain the existing appearance resolver and per-skin overrides.

The Electron journey now checks **Midnight**, **Daylight**, **Monochrome**, a copper custom Fate palette loaded from a real fixture `themes.json` through the production `SettingsService`, and the existing deterministic Pi-theme fixture. For each, computed panel/canvas/primary/on-accent/text colors must match that palette while M3 identity, geometry, interface font, density, and the live draft remain unchanged. Saving the custom palette then cancelling a different preview restores the custom palette, not the companion M3 palette. The journey restores the M3 palette before final compact screenshots and restart.

Pi discovery is deterministic in this harness, not an externally installed Pi theme. The production shared palette contract and `SettingsService`/`PiThemeService` unit tests cover mapped Pi loading and the explicit project-trust boundary. Every built-in palette, including M3 Expressive, is also checked against the complete `themeDefinitionSchema`.

Theme-compliance follow-up verification: typecheck and E2E build passed; four focused unit files / 29 tests passed; the expanded M3 journey passed, and existing skin/pack Electron journeys passed with the production theme loader enabled in the harness. This follow-up changes tests/harness only, not the accepted skin design.

## Verification and screenshots

`tests/e2e/m3-expressive.spec.ts` launches real Electron with the existing deterministic test runtime. It exercises selection, palette independence, preview cancellation, saved restart, normal/compact layouts, pane resizing, task/model/tool/resource/browser surfaces, agent fixtures, music geometry, and importing/removing an actual personal background. It checks zero outer pane margins/radii, contiguous pane/resize-track geometry and matching panel backgrounds at normal/compact/collapsed widths, no document overflow, composer/header containment, complete secondary-tab labels, safe session insets, centered root/group/node agent icons and balanced group-header spacing, readable search placeholders, unchanged platform chrome shape, symmetric dock insets, and unchanged inspector content geometry when the music overlay opens. Screenshots are not DOM-styled mockups.

The screenshots use fixture sessions, agents, tool output, and a local Git project, not a live authenticated model. Normal captures are 1600×900 with panes resized through real controls; compact captures are 1100×760 and 980×760, plus 640×680 with the panes collapsed through their real controls. `background-study.png` explicitly uses the repository's synthetic light-study image to test dither visibility; it is not bundled artwork for this skin.

Gallery under [`screenshots/m3-expressive/`](../screenshots/m3-expressive/):

- `workspace-1600.png`: normal workspace, detailed sessions, Agents and music.
- `populated-run.png`: populated agent tree and tool activity.
- `settings.png`, `light-preview.png`: saved settings and independent light-palette preview.
- `tasks-model-picker.png`, `tools.png`, `context.png`, `resources-browser.png`: operational surfaces.
- `compact-1100.png`, `compact-980.png`, `compact-640-collapsed.png`: compact/narrow layouts and the minimum-width collapsed workbench.
- `background-study.png`: optional background conversion and visibility.

Verified in the isolated implementation checkout on Windows:

- `pnpm verify` after Roboto Flex integration: passed typecheck, 194 unit files (2,051 passed / 3 skipped), production and E2E builds, and all 18 Electron journeys.
- Font-focused checks also passed: 3 unit files / 10 tests and the M3/Angelcore Electron journeys, including a real built-in-font pack import and custom WOFF2 picker/restart flow. The M3 journey confirms actual loaded Roboto Flex and JetBrains Mono faces, automatic optical sizing, Inter override/default reset, and zero HTTP(S) font requests. Gallery images were refreshed after the bundled Roboto Flex face loaded.
- `git diff --check`: passed. The build emits the existing large-chunk advisory.

Music/sidebar follow-up: actual Electron inspection found the dock/stage wrappers already transparent, but opening music reduced active inspector content height from 760px to 515px, exposing a 245px opaque footer. A no-reflow regression failed before removing the reservation. Follow-up verification passed `pnpm verify` (typecheck, 194 unit files / 2,051 passed and 3 skipped, production/E2E builds, all 18 Electron journeys) and the focused music/layout unit rerun (13 tests). New music captures (`music-floating.png`, `music-floating-compact.png`, `music-floating-light.png`, `music-browser-shifted.png` and their corner crops) exercise real local PCM playback, playlist selection, close/reopen, and compare actual corner pixels with underlying content while closed. `music-reserved-footer-before.png` records the old reservation. Search captures (`search-{normal,mono,compact,compact-mono}-{sessions,automations,resources}.png`) and repeated tab-click geometry assertions cover both Roboto Flex and JetBrains Mono without forcing the interface font.

Browser/header follow-up verification: typecheck and full production/E2E build passed; six focused Electron journeys passed (M3 browser, M3 workspace, both Angelcore journeys, and Default/Angelcore control-cohesion journeys). `tests/e2e/m3-browser.spec.ts` checks selected/inactive palette colors, capsule geometry, icon centering, long-title truncation, tab overflow/select/close/add, Back/Forward/Reload/address navigation, annotation/device toggles, and native view bounds. It repeats geometry and unchanged website Georgia/background checks for dark, Daylight, and a real custom Copper palette at normal and compact/narrow widths.

Browser captures are `browser-m3-{dark,light,custom}[-compact].png` and matching `-chrome.png` crops. Window/page capture APIs do not composite the separate native website view into these shell captures; `browser-website-unchanged.png` is captured directly from that real WebContents, without image compositing or DOM styling.

Native screenshots are captured on Windows only. Parameterized WindowChrome unit tests cover Windows/macOS/Linux branch behavior; they are not native macOS/Linux visual verification.

## Sources

Read alongside the supplied user reference, not in place of it:

- [Building with M3 Expressive](https://m3.material.io/building-with-m3-expressive): expressive emphasis and sparing use of hero moments.
- [Shape corner-radius scale](https://m3.material.io/styles/shape/corner-radius-scale): expanded expressive shape scale and optical nesting.
- [Color roles](https://m3.material.io/styles/color/roles): tonal surface hierarchy and paired content colors.
- [Material typography](https://m3.material.io/styles/typography) and [typography tokens](https://m3.material.io/styles/typography/type-scale-tokens): baseline Roboto and variable Roboto Flex, deliberate emphasized labels, plain readable body text.
- [Roboto Flex metadata](https://raw.githubusercontent.com/google/fonts/main/ofl/robotoflex/METADATA.pb), [OFL license](https://raw.githubusercontent.com/google/fonts/main/ofl/robotoflex/OFL.txt), and [Fontsource installation](https://fontsource.org/fonts/roboto-flex/install): family identity, axes, attribution, and offline distribution.
- [Button groups](https://m3.material.io/components/button-groups/overview): shaped, connected selection groups. Existing Fate navigation semantics are retained.
- [State layers](https://m3.material.io/foundations/interaction/states/state-layers): selected and transient interaction states are distinct.
- [Expressive motion](https://m3.material.io/m3-expressive-motion-theming): expressive motion is not an obligation to bounce an operational workbench.
- [Material Web labs](https://github.com/material-components/material-web/tree/main/labs): incomplete/experimental Expressive web component coverage is why this implementation uses existing Fate components and CSS, not a framework transplant.
- [Electron custom title bars](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar): preserve platform controls and drag/no-drag regions.
- [Electron 43.6.0 custom window styles](https://github.com/electron/electron/blob/v43.6.0/docs/tutorial/custom-window-styles.md): transparent-window resize and Windows maximize limitations.
- [Electron 43.6.0 BaseWindow options](https://github.com/electron/electron/blob/v43.6.0/docs/api/structures/base-window-options.md): constructor-level native transparency option.
