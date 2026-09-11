# Interface skins and community packs

Use **Settings → Skins** to select a component skin, choose colors and fonts, import/export packs, and configure a personal background.

**Default** keeps the established workbench. **Angelcore** uses terminal-style text actions, selected-row markers, a command composer, labeled transcript entries, ASCII tool status, and a numeric context gauge. Both remain clickable GUIs with the same state, keyboard controls, browser, Monaco, trust controls, and manual terminal.

## Import a pack

1. Download or create a pack folder containing `skin.json` and any declared assets.
2. Click **Import skin folder** in Settings → Skins and choose that folder—not its parent.
3. The installed pack appears in the Skin dropdown and the pack list. Click **Preview**, or select it in the dropdown.
4. **Save changes** keeps the selection. Closing Settings without saving restores the previous appearance.

Imports make a managed copy under:

- Windows: `%USERPROFILE%\.pi\fateGUI\skins\<pack-id>\`
- macOS/Linux: `~/.pi/fateGUI/skins/<pack-id>/`
- With a custom data root: `$FATE_GUI_DATA_DIR/skins/<pack-id>/`

This is user data, not the application installation directory. **Open skins folder** opens the exact configured location. **Refresh packs** reloads edited manifests. Invalid packs are skipped with diagnostics; a missing saved pack falls back to Default without resetting unrelated settings.

Import, export, and removal act on disk immediately. Preview/Save/Cancel affect selection, not installation. Removal asks for confirmation and resets a selected pack to Default; if its optional palette was selected, the palette also falls back. An existing ID is never silently overwritten: remove the old version or use a new ID. Exports create a new `<pack-id>` folder at the chosen destination.

## Appearance defaults and your overrides

Angelcore defaults its interface font to **JetBrains Mono**. The Interface font picker shows the effective font, not the unused base preference. Choosing another interface font really changes navigation, settings, conversation text, and the composer; Code & terminal remains a separate choice for literal code, tool output, diffs, and xterm.

Appearance resolution is: saved base preferences → component-base defaults → pack defaults → your overrides for that skin. Font, density, and motion overrides are stored per skin in `skinAppearanceOverrides`. Switching skins does not destroy another skin's choices. **Reset to skin appearance defaults** clears the current skin's overrides; Save and Cancel still apply. Integrations reading raw settings should use `resolveSkinAppearance` from `src/shared/skinAppearance.ts` to obtain the effective values.

Packs can supply appearance defaults, not operational settings: permissions, providers, models, project trust, Memory Learning, audio playback, and tool policy are not pack-configurable. Safety confirmations keep a bundled, known typeface. Native OS dialogs, embedded web pages, and file/image contents are not rewritten by a skin.

## Make a version 1 pack

Start with [`examples/skins/ashen-terminal`](../examples/skins/ashen-terminal). It is an importable test pack, not a built-in preset. The example contains a synthetic light study; no external art or font is required.

Minimal `skin.json`:

```json
{
  "schemaVersion": 1,
  "id": "my-terminal",
  "name": "My Terminal",
  "version": "1.0.0",
  "description": "A quiet terminal workbench.",
  "base": "dreamcore",
  "layout": {
    "contentWidth": 840,
    "contentPadding": 32,
    "controlRadius": 0,
    "ruleContrast": "strong"
  }
}
```

Required fields are shown above except `layout`, which is optional. `author` is optional too. IDs are 2–32 lowercase letters/digits/hyphens, starting with a letter. Built-in names and Windows device names are reserved. Installed IDs are internally namespaced as `pack:<id>`, so they cannot shadow built-ins. `version` uses `major.minor.patch` with an optional lowercase prerelease suffix. `schemaVersion` must be 1.

Allowed layout values:

- `contentWidth`: integer 720–1120 pixels.
- `contentPadding`: integer 16–48 pixels; compact mode caps padding at 16 pixels.
- `controlRadius`: integer 0–8 pixels.
- `ruleContrast`: `subtle` or `strong`, derived from the active palette.

`base` is `default` (Default) or `dreamcore` (Angelcore). The `dreamcore` identifier is retained for settings and pack compatibility; the skin is named Angelcore in the app. Packs select existing component implementations; they cannot introduce React components, arbitrary layout trees, CSS selectors, hidden controls, scripts, or new font loaders.

### Optional palette

Add `palette: { "tone": "dark", "colors": { ... } }`, using the color tokens in [Themes](themes.md). It appears separately in the color picker as the pack's name, with ID `pack-<id>`. Importing or selecting a skin never forces its palette. Existing Fate/Pi/custom colors remain independent.

### Optional background

Add a PNG named `background.png` and:

```json
"background": { "file": "background.png", "opacity": 0.1 }
```

The pack importer accepts a source PNG up to **4 MB / 8 megapixels**. It validates and converts it into a deterministic binary-alpha dither, at most **640 pixels per side / 128 KB**, before saving the managed copy. Exports contain this processed PNG, not the original source image. Supported opacity values are `0.06`, `0.1`, and `0.16`. The background is tinted by the selected palette. A personal background takes precedence; removing the personal image reveals the pack background again.

For version 1, the supported folder entries are `skin.json`, declared `background.png`, optional `README.md`, and optional `LICENSE`. Each text file is limited to 32 KB. Operating-system metadata files are ignored. Subfolders, links/junctions, hard-linked files, SVG, HTML, JavaScript, CSS, external URLs, unsupported manifest keys, and path traversal are rejected. At most 16 packs load. Keep the original source folder if you want to retain editable source artwork.

## Version 2: full surface styling, fonts, and embedded images

Version 1 packs continue to work. Use `"schemaVersion": 2` for the following optional additions. They are declarative data, not executable extensions.

### Bundled fonts and defaults

```json
"fonts": [
  { "id": "body", "name": "My Interface", "file": "body.woff2", "monospace": false },
  { "id": "mono", "name": "My Terminal", "file": "mono.woff2", "monospace": true }
],
"appearance": {
  "interfaceFont": "local:body",
  "codeFont": "local:mono",
  "compactMode": false,
  "compactSessions": true,
  "reduceMotion": true
}
```

A pack can contain two WOFF/WOFF2 files, up to **256 KB each**, with a maximum declared expanded size of **8 MB**. Keep filenames to lowercase letters, digits, and hyphens followed by `.woff` or `.woff2`; IDs use the same characters without the extension. Include the fonts' redistribution licenses in `LICENSE`. Variable fonts can cover multiple weights in one file.

All installed pack fonts appear in Interface font; those marked `monospace` also appear in Code & terminal. Internally they are namespaced as `skin-font:<pack-id>:<font-id>`. Defaults refer to a bundled font with `local:<font-id>` or use a built-in font ID. Fonts load locally through the browser's font parser, are cached for reuse, and fall back with a visible warning if loading fails. Removing a pack removes references to its fonts without changing operational settings.

The only supported `appearance` keys are `interfaceFont`, `codeFont`, `compactMode`, `compactSessions`, `reduceMotion`, `performanceMode`, and `holyShitMode`. Unknown keys are rejected.

### Every owned UI surface has a style entry

```json
"styles": {
  "normal": {
    "global": { "controlRadius": 0, "surfaceRadius": 0, "padding": 10, "rowHeight": 30, "fontSize": 12 },
    "music": { "surface": "panel", "padding": 12 },
    "modelPicker": { "border": "borderStrong" },
    "tooltips": { "surfaceRadius": 0, "padding": 8 }
  },
  "compact": { "global": { "padding": 6, "rowHeight": 26, "fontSize": 11 } },
  "compactSessions": { "sidebar": { "rowHeight": 26, "controlRadius": 0 } }
}
```

`global` supplies fallbacks. Surface-specific values take precedence. Normal styles are overlaid with compact styles when Compact mode is on, then compact-session styles when Compact sessions is on. Component-base styles are inherited, so old Angelcore-based packs also receive complete surface coverage.

| Entry | UI covered |
| --- | --- |
| `shell`, `sidebar` | Workspace chrome, navigation, project/session rows, compact sessions |
| `conversation`, `composer`, `queue` | Transcript, input, tools menu, queued/held messages, goal steering |
| `tasks`, `goal` | Ordinary tasks, GoalMax criteria, flight deck, goal editor and confirmation |
| `agents` | Teams, child sessions, controls, transcripts, workspace review dialog |
| `tools`, `activity`, `notifications` | Tool cards/output chrome, activity filters/timeline, toasts/notices/error banners |
| `context`, `resources` | Context metrics, token charts, resource groups and rows |
| `music` | Dock, transport, local/remote source input, populated playlist |
| `settings`, `dialogs` | Settings sections, selectors, general popovers/dialogs and confirmations |
| `modelPicker`, `tooltips` | Model/reasoning/provider pickers, options, app tooltips and native-title tooltips |
| `files`, `changes` | File tree, preview chrome, review controls, Git rows |
| `browser` | Tab strip, new/close tab buttons, address field, Back/Forward/Reload, local-file/annotation/device controls; not the Chromium page itself |
| `learning`, `automations` | Memory library/review forms, automation list and editor |

Allowed properties are `controlRadius` (0–12 px), `surfaceRadius` (0–16 px), `padding` (4–24 px), `rowHeight` (24–48 px minimum), `fontSize` (11–16 px base), `surface` (`canvas`, `panel`, `raised`), and `border` (`border`, `borderStrong`, `textSoft`). Colors always come from the selected palette. Controls and metadata retain their no-wrap/truncation rules; compact action labels may stay smaller than body text. Long messages, code, descriptions, and warnings remain readable rather than being forced onto one line.

The composer keeps Memory, its tools menu, model selection, and send/stop controls on one line. Secondary actions move into the tools menu and labels shorten as space shrinks. Skin options cannot disable these layout protections or remove controls.

### Embedded image

Instead of a separate image file, version 2 can contain raw PNG base64:

```json
"background": { "data": "<PNG base64, without a data: prefix>", "opacity": 0.1 }
```

Use `data` or `file`, not both. A source version-2 manifest can be up to **6 MB** to accommodate a **4 MB** PNG. Import validates and dithers the image, writes the processed `background.png`, and removes the base64 payload from the managed manifest. Export remains a portable folder. The user can override it with a personal image through Background settings. Normalized manifests and other text files remain limited to 32 KB; no remote image or font URLs are loaded.

Older app versions do not understand these v2 fields or per-skin overrides. Keep a settings backup before downgrading.

## Implementation boundary

- `src/shared/skins.ts`, `skinFonts.ts`, `skinStyles.ts`, `skinAppearance.ts`: versioned contracts, font IDs, surface styles, and effective preference resolution.
- `src/main/settings/SkinPackService.ts`: main-owned validation, copying, discovery, export, and removal.
- `src/main/settings/registerSkinIpc.ts`: native folder pickers behind the existing trusted-main-frame IPC guard. Renderer requests cannot supply filesystem paths.
- `src/renderer/skin.ts`: active identity, approved CSS variables, base selection, and bounded prepaint snapshot.
- `src/renderer/skins/`: typed component slots with Default/Angelcore implementations.
- `src/renderer/skins/surfaces.ts`: the complete, typed surface-to-DOM inventory used by the renderer.
- `src/renderer/skins/NativeTitleTooltips.tsx`: styled hover/focus hints for owned native titles, restored on cleanup.
- `src/renderer/styles/skins/`: frame geometry, terminal components, whole-surface styling, and constrained pack overrides.

Feature components retain buttons, handlers, input refs, drafts, and scroll containers. Only presentation leaves change. Pack identity is separate from its component base, and palette identity remains separate from both. Full custom component code is intentionally unsupported in both versions.

The session/inspector headers share geometry, resize targets paint one separator, and plugin status occupies layout below the header. Pack settings cannot alter these invariants or session permissions.

## Personal dithered backgrounds

Under **Skins → Background**, choose a local PNG, JPEG, or WebP up to **12 MB / 32 megapixels**. The personal importer downsamples to at most **960 pixels per side**, then converts source luminance/transparency with an 8×8 ordered dither. This is image conversion, not a texture pasted over an unchanged picture.

Only the processed personal PNG and strength are cached in the renderer profile's IndexedDB. The original is not uploaded or retained by the app. Personal background changes save immediately, separately from skin/color Save and Cancel. **Remove background** deletes that personal cache, falling back to a selected pack's image if present.

Backgrounds sit behind the central workspace, below its header. Sidebars and the composer remain opaque. Changing palettes reuses the cached bitmap; it does not reprocess the image. There is no animated noise, remote image loading, or per-frame pixel loop. Personal object URLs are revoked when replaced or removed.

The visual regression journey captures populated queues/tasks, goals/editors, agent trees/previews, Context, Resources, model pickers, tooltips, music playlists, and browser chrome, including compact states and Memory-on narrow toolbars. Browser tests also check that the page's own font and background are unchanged. Local-file history can still revisit an expired page capability; this pre-existing browser limitation is separate from the skin and its security policy is not relaxed here.

See [Angelcore coverage and screenshot gallery](angelcore-coverage.md) for the exercised surfaces and exact checks.

Native macOS/Linux integration uses the normal cross-platform CI matrix. Simulated platform layout attributes on Windows are not native verification.
