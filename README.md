# Pi Desktop

A local-first Electron GUI for the real Pi coding agent. The current build includes the secure desktop shell plus trusted project selection and a project-bound embedded Pi runtime; production responses are never mocked.

## Requirements

- Node.js 22.19+
- pnpm 11+
- At least one model provider authenticated through Pi

## Pi authentication

Pi Desktop uses Pi's existing `~/.pi/agent/auth.json`, configured providers, and supported environment credentials. It does not collect or store API keys in renderer state.

If the app shows **Authentication required**, open the Pi CLI, run `/login`, complete provider authentication, then reopen the project in Pi Desktop. You can check the same setup with `pi` before launching the desktop app.

## Develop

```bash
pnpm install
pnpm dev
```

Select a directory and review the native trust warning. Pi is initialized only for a canonical, accessible, explicitly trusted directory. Once connected, send prompts, change the available model/thinking level, stream text and reasoning, create a new session, or stop an active run.

## Verify

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

`pnpm smoke` builds and starts the production Electron entry, waits for renderer load, prints `PI_DESKTOP_SMOKE_OK`, and exits. Package with `pnpm package` (unpacked) or `pnpm dist` (installer).

## Architecture and security

The Electron main process owns Pi SDK initialization, sessions, native dialogs, canonicalization, and trust. `PiRuntimeService` embeds `@earendil-works/pi-coding-agent` through `createAgentSessionRuntime()` and Pi's `ModelRuntime`. SDK events are converted to app-owned event/error contracts and bounded batches before IPC.

A sandboxed CJS preload exposes only a frozen, typed `window.piDesktop` API. Both sides validate payloads with Zod. The renderer has no Node, Electron, filesystem, credential, or shell access. `BrowserWindow` enables context isolation and sandboxing and disables Node integration.

See `PRODUCT.md`, `DESIGN.md`, and `BUILD_NOTES.md` for product scope, visual decisions, manual checks, and current limitations.
