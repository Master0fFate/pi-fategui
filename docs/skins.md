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

The only supported folder entries are `skin.json`, declared `background.png`, optional `README.md`, and optional `LICENSE`. Each text file is limited to 32 KB. Operating-system metadata files are ignored. Subfolders, links/junctions, hard-linked files, SVG, HTML, JavaScript, CSS, external URLs, unsupported manifest keys, and path traversal are rejected. At most 16 packs load. Keep the original source folder if you want to retain editable source artwork.

## Implementation boundary

- `src/shared/skins.ts`: versioned manifest, runtime catalog, and bounded layout contracts.
- `src/main/settings/SkinPackService.ts`: main-owned validation, copying, discovery, export, and removal.
- `src/main/settings/registerSkinIpc.ts`: native folder pickers behind the existing trusted-main-frame IPC guard. Renderer requests cannot supply filesystem paths.
- `src/renderer/skin.ts`: active identity, approved CSS variables, base selection, and bounded prepaint snapshot.
- `src/renderer/skins/`: typed component slots with Default/Angelcore implementations.
- `src/renderer/styles/skins/`: frame geometry, terminal components, and constrained pack styling.

Feature components retain buttons, handlers, input refs, drafts, and scroll containers. Only presentation leaves change. Pack identity is separate from its component base, and palette identity remains separate from both. Full custom component code is intentionally unsupported in version 1.

The session/inspector headers share geometry, resize targets paint one separator, and plugin status occupies layout below the header. Pack settings cannot alter these invariants or session permissions.

## Personal dithered backgrounds

Under **Skins → Background**, choose a local PNG, JPEG, or WebP up to **12 MB / 32 megapixels**. The personal importer downsamples to at most **960 pixels per side**, then converts source luminance/transparency with an 8×8 ordered dither. This is image conversion, not a texture pasted over an unchanged picture.

Only the processed personal PNG and strength are cached in the renderer profile's IndexedDB. The original is not uploaded or retained by the app. Personal background changes save immediately, separately from skin/color Save and Cancel. **Remove background** deletes that personal cache, falling back to a selected pack's image if present.

Backgrounds sit behind the central workspace, below its header. Sidebars and the composer remain opaque. Changing palettes reuses the cached bitmap; it does not reprocess the image. There is no animated noise, remote image loading, or per-frame pixel loop. Personal object URLs are revoked when replaced or removed.

Native macOS/Linux integration uses the normal cross-platform CI matrix. Simulated platform layout attributes on Windows are not native verification.
