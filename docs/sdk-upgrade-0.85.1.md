# Pi SDK 0.85.1 integration

## Source and scope

Selected from the [upstream GitHub release](https://github.com/earendil-works/pi/releases/tag/v0.85.1), published September 5, 2026, rather than a registry latest-version query. The project uses pnpm to install the exact matching published packages and record integrity in its lockfile. This supersedes the dependency workaround described in [the 0.85.0 integration notes](sdk-upgrade-0.85.0.md).

## Delete before adding

- Removed the direct `pi-server` dependency. Pi 0.85.1 fixes the accidental experimental server imports; the supported local SDK remains intact. The experimental client, protocol, and server packages are no longer in Fate's lockfile.
- Replaced Fate's child-model reasoning-level filter with Pi's `getSupportedThinkingLevels`. The old filter always advertised `off` and accepted extended levels without explicit support. `pi-ai` is now a direct, exact dependency because Fate imports that public helper; it was already a transitive SDK dependency.
- Replaced the hard-coded Pi version in model-discovery requests with the SDK's exported `VERSION`.

## Adopt upstream behavior

Astra is supplied by the built-in catalog for both `openai` and `openai-codex`; no application-side model definition is needed. The pinned SDK defaults both to 272,000 context tokens, supplies pricing tiers and image/tool capabilities, and disallows reasoning `off`. Direct OpenAI also disallows `minimal`; Codex maps it to `low`. Fate's child catalog and validation now use these upstream effort rules.

The SDK supplies the GPT-5.6+ long-cache request fix: `prompt_cache_options.ttl: "30m"` replaces the old `prompt_cache_retention: "24h"` wire field. No duplicate Fate transport patch was added.

The OpenRouter patch remains necessary: 0.85.1 still emits `reasoning.effort: "none"` when the model has no explicit off mapping. The existing narrow patch is carried forward unchanged and covered by an offline payload test.

## Keep application responsibilities

The remaining release changes concern Pi's terminal selector keybindings, mouse hover, and Alt-wheel scrolling. They do not replace Electron/React interactions, so no terminal behavior was transplanted into Fate UI. Session restoration via `SessionManager.inMemory` was already adopted in 0.85.0. Trust, authentication isolation, queues, browser controls, Agent Teams, and retained-tail session projection remain Fate-owned.

No Astra definition was found in tracked project source. This upgrade does not modify local `~/.pi/fateGUI/models.json` or `~/.pi/agent/models.json`. A manually added model can still override upstream metadata. Remove only the redundant manual definition if native defaults are desired; preserve intentional provider routing, context overrides, and credentials.

## Verification

- Typecheck passed.
- Unit tests: 168 files passed; 1,752 tests passed, one skipped. Six new offline SDK tests cover native Astra on both providers, reasoning capabilities, long-cache payloads, and the OpenRouter patch. Payload tests stop before network access and use isolated credential/catalog paths.
- Production build and Windows x64 unpacked packaging passed, including native dependency verification and the real packaged renderer, SDK, speech, terminal, themes, and yt-dlp smoke checks.
- Browser tests: all eight passed after fixing the voice-button test's input setup. The failure after the performance tests occurred with neither `:hover` nor `:active` applied. The test now brings the window forward, waits for the button to be enabled, uses locator hover, and confirms a real active press before checking its appearance. The style assertions remain unchanged; no renderer code changed.
- Validation subprocesses unset the installed application's `TRANSCRIBE_LIBRARY` override.

The full local `pnpm verify` check passed for the 0.9.8-beta3 candidate, and the Windows x64 installer built successfully. Live provider requests, installed-installer testing, macOS, and Linux still require separate verification. No installed-application update was performed.
