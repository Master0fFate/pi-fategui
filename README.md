# Fate UI

A local-first Electron GUI for the real Pi coding agent. Fate UI embeds `@earendil-works/pi-coding-agent`; it does not scrape Pi’s TUI and production never uses mocked agent responses.

## Requirements

- Node.js 22.19 or newer
- pnpm 11
- Git on `PATH`
- Windows, macOS, or Linux desktop environment
- At least one Pi-supported model provider for live prompts
- Optional: `yt-dlp` on `PATH` for the settings-gated music player

```bash
pnpm install
pnpm dev
```

## Pi authentication

Pi Desktop uses Pi’s existing provider configuration, `~/.pi/agent/auth.json`, OAuth sessions, and supported environment credentials. API keys are never sent to or stored in renderer state.

If the app shows **Authentication required**:

1. Open the Pi CLI.
2. Run `/login` and authenticate a provider.
3. Reopen the project in Pi Desktop.

Runtime initialization still occurs without credentials so project resources and diagnostics can load; prompting remains unavailable until Pi reports an authenticated model.

## Optional music player

Enable the player under **Settings → General → Ambient audio**. Fate UI uses a local `yt-dlp` executable and never downloads one automatically. Put `yt-dlp` on `PATH`, or launch Fate UI with `YT_DLP_PATH` set to its absolute path. Links are resolved lazily; media is streamed directly and is not saved to the project.

## Bundled fonts

**Settings → General → Typography** separates interface and code/terminal fonts. Noto Sans is the default, with bundled coverage for extended Latin (including Croatian), Cyrillic, Greek, Devanagari, Hebrew, and Simplified Chinese. Inter, Poppins, Montserrat, JetBrains Mono, Noto Sans Mono, and native system stacks are selectable without a network connection. Redistribution notices are in `FONT_LICENSES.md`.

## Features

- Explicit native project selection and trust
- Real project-bound `AgentSessionRuntime`
- Streamed text, reasoning, tool execution, stop, steer, and follow-up
- Persistent sessions, search, switching, conversation forks, isolated Git worktree sessions, clone, import, branches, and compaction where supported by Pi
- Virtualized conversation and tool timelines
- Native project-file references and model-gated image attachments
- OpenAI/Codex GPT Image generation rendered inline and copied under `~/.pi/agent/generated-images/<session-id>/`
- Runtime Pi permissions: Read only, project-confined Edit files, and confirmed Full access
- Root-confined file tree/search with lazy Monaco previews
- Git status, exact push targets, fetch/pull/push, worktree switching, line counts, and lazy Monaco diffs
- Main-process `node-pty` terminal rendered with xterm.js, visibly separate from Pi tools
- Command palette (`Ctrl/Cmd+K`), native menus, keyboard shortcuts, settings, diagnostics, and local application logs
- Offline bundled typography with separate interface and code/terminal selectors plus extended Unicode fallbacks
- Optional lower-right music dock with lazy link/playlist resolution through a locally installed `yt-dlp`

## Session and worktree workflow

A **conversation fork** branches Pi history but stays in the current Git working tree. The sidebar’s isolated-worktree action instead creates `fate/<prompt-slug>` from committed `HEAD`, opens it as the active trusted project, starts a project-scoped Pi session, and restores the selected prompt for editing. Uncommitted changes remain in the source worktree. The worktree switcher returns to any registered worktree.

On a session’s first turn, Fate UI asks the active configured model for a sidebar-safe title in the background. Prompt acceptance and generation are never blocked; a bounded prompt title remains the fallback, and an explicit manual rename is never overwritten. Git status separately shows the exact remote/branch a push will publish, so session titles never silently become Git branch names.

## Architecture

- **Main process:** Pi SDK/runtime, sessions, trust, filesystem, Git, terminal PTYs, settings, logs, native dialogs, and menus.
- **Preload:** frozen named methods only; requests, results, and events are validated with shared Zod schemas.
- **Renderer:** React presentation and entity-indexed Zustand state. It has no Node, Electron, filesystem, credential, shell, or child-process access.

Electron uses `contextIsolation: true`, `nodeIntegration: false`, sandboxing, web security, denied permissions/popups, and main-frame-only IPC. Filesystem requests accept project-relative forward-slash paths and perform lexical/canonical containment checks. Git uses `execFile` argument arrays and bounded output. Manual terminals are owned by their creating renderer and require a trusted project. The optional music bridge is disabled by default, accepts public HTTPS links only, invokes `yt-dlp` without a shell or user config/plugins, and bounds process time and output.

Pi starts in project-confined **Edit files** mode; **Read only** removes mutation tools. Explicitly confirmed **Full access** is intentionally unsandboxed: for the current project session it activates Pi bash and permits Pi file tools to resolve host paths outside the project with the permissions of the user running Fate UI. Opening another project resets Pi to Edit files.

Pi events are normalized into application-owned contracts. Text deltas are coalesced, IPC batches are byte/count bounded, tool output is truncated with head/tail context, and stale session-generation events are discarded. Conversation, tools, files, and changes use virtualization; Monaco and xterm are lazy-loaded.

## Development and verification

```bash
pnpm typecheck       # strict TypeScript
pnpm test            # Vitest + React Testing Library
pnpm test:e2e        # Playwright Electron with a test-only deterministic main adapter
pnpm verify          # typecheck + unit/integration + E2E
pnpm build           # production main/preload/renderer
pnpm smoke           # launch production Electron entry and exit after renderer load
pnpm smoke:packaged  # launch the current OS unpacked package and verify native layout
```

The E2E adapter exists only under `tests/` and is built into `.test-dist/`; electron-builder excludes both. Production composition always constructs the real `PiRuntimeService`.

## Packaging

```bash
pnpm package         # unpacked app for the current OS
pnpm dist            # current-OS installer/artifact
pnpm dist:artifacts  # installer from an existing production build
```

`node-pty` ships as an unpacked production dependency. Windows and macOS use upstream prebuilds; Linux compiles the native addon on the target host. The cross-platform CI matrix runs verification, target-native packaging, and packaged smoke checks on Windows, macOS, and Linux. Releases are unsigned unless signing credentials are supplied by the build environment, so local artifacts may trigger OS reputation warnings.

The Fate UI application mark is generated from `build/icon.svg` into Windows ICO, macOS ICNS, and Linux PNG sizes with `pnpm icons:generate`.

## Current limitations

- Pi extension commands can be entered, but the public session API does not expose their full command registry for autocomplete; discovered prompt templates are suggested.
- File previews are limited to 1 MiB. Binary files, submodules, symlinks, oversized files, and directory/result caps produce explicit unavailable/truncated states.
- GUI accept/revert controls are intentionally omitted; unsafe destructive Git operations are not exposed.
- External editor launch is allowlisted to known text/source extensions. Like any path handed to another local process, it cannot provide a cross-process atomic open guarantee against a simultaneously malicious local process.
- Public installers still require platform signing/notarization credentials supplied outside the repository.

See `PRODUCT.md`, `DESIGN.md`, and `BUILD_NOTES.md` for product truth, visual rules, implementation decisions, manual checks, and Pi API notes.
