# Pi Desktop

A local-first Electron GUI for the real Pi coding agent. Pi Desktop embeds `@earendil-works/pi-coding-agent`; it does not scrape Pi’s TUI and production never uses mocked agent responses.

## Requirements

- Node.js 22.19 or newer
- pnpm 11
- Git on `PATH`
- Windows, macOS, or Linux desktop environment
- At least one Pi-supported model provider for live prompts

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

## Features

- Explicit native project selection and trust
- Real project-bound `AgentSessionRuntime`
- Streamed text, reasoning, tool execution, stop, steer, and follow-up
- Persistent sessions, search, switching, fork, clone, import, branches, and compaction where supported by Pi
- Virtualized conversation and tool timelines
- Native project-file references and model-gated image attachments
- Root-confined file tree/search with lazy Monaco previews
- Git status, line counts, and lazy Monaco diffs
- Main-process `node-pty` terminal rendered with xterm.js, visibly separate from Pi tools
- Command palette (`Ctrl/Cmd+K`), native menus, keyboard shortcuts, settings, diagnostics, and local application logs

## Architecture

- **Main process:** Pi SDK/runtime, sessions, trust, filesystem, Git, terminal PTYs, settings, logs, native dialogs, and menus.
- **Preload:** frozen named methods only; requests, results, and events are validated with shared Zod schemas.
- **Renderer:** React presentation and entity-indexed Zustand state. It has no Node, Electron, filesystem, credential, shell, or child-process access.

Electron uses `contextIsolation: true`, `nodeIntegration: false`, sandboxing, web security, denied permissions/popups, and main-frame-only IPC. Filesystem requests accept project-relative forward-slash paths and perform lexical/canonical containment checks. Git uses `execFile` argument arrays and bounded output. Manual terminals are owned by their creating renderer and require a trusted project.

Pi events are normalized into application-owned contracts. Text deltas are coalesced, IPC batches are byte/count bounded, tool output is truncated with head/tail context, and stale session-generation events are discarded. Conversation, tools, files, and changes use virtualization; Monaco and xterm are lazy-loaded.

## Development and verification

```bash
pnpm typecheck       # strict TypeScript
pnpm test            # Vitest + React Testing Library
pnpm test:e2e        # Playwright Electron with a test-only deterministic main adapter
pnpm verify          # typecheck + unit/integration + E2E
pnpm build           # production main/preload/renderer
pnpm smoke           # launch production Electron entry and exit after renderer load
```

The E2E adapter exists only under `tests/` and is built into `.test-dist/`; electron-builder excludes both. Production composition always constructs the real `PiRuntimeService`.

## Packaging

```bash
pnpm package         # unpacked app for the current OS
pnpm dist            # current-OS installer/artifact
```

`node-pty` ships as an unpacked production dependency. Native package scripts are allowlisted in `pnpm-workspace.yaml`. Releases are unsigned unless signing credentials are supplied by the build environment, so local artifacts may trigger OS reputation warnings.

## Current limitations

- Pi extension commands can be entered, but the public session API does not expose their full command registry for autocomplete; discovered prompt templates are suggested.
- File previews are limited to 1 MiB. Binary files, submodules, symlinks, oversized files, and directory/result caps produce explicit unavailable/truncated states.
- GUI accept/revert controls are intentionally omitted; unsafe destructive Git operations are not exposed.
- External editor launch is allowlisted to known text/source extensions. Like any path handed to another local process, it cannot provide a cross-process atomic open guarantee against a simultaneously malicious local process.
- Installers use the default Electron icon until production artwork and signing credentials are supplied.

See `PRODUCT.md`, `DESIGN.md`, and `BUILD_NOTES.md` for product truth, visual rules, implementation decisions, manual checks, and Pi API notes.
