# Build Notes

## Completed

- Phase 1 / f1: Electron + Vite + React + Tailwind foundation, secure preload, typed IPC, three-pane shell, tests, and packaging configuration.
- Phase 2 / f2: canonical project selection and explicit trust, real project-bound Pi `AgentSessionRuntime`, existing Pi authentication/model discovery, prompt preflight acceptance, streamed text/reasoning/tool events, stop, model/thinking/session state, normalized errors, and bounded IPC batching.

## Decisions

- Main output is ESM; sandbox-compatible preload is bundled as CJS.
- Renderer IPC is exposed as one frozen, narrow `piDesktop` object. Shared Zod schemas validate both arguments and responses.
- Pane geometry is renderer-local Zustand state persisted to local storage.
- `PiRuntimeService` owns the SDK and uses `createAgentSessionRuntime()` with cwd-bound services; its injectable adapter exists only for deterministic tests. Production always uses the real SDK.
- Pi credentials remain owned by Pi's `ModelRuntime` and normal auth files/environment. The renderer receives only model availability and an actionable auth status, never credentials.
- Project paths are canonicalized with `realpath`, verified as directories, and persisted through Pi's project trust store only after a native warning dialog.
- SDK events are normalized into app-owned contracts and coalesced in batches of at most 100 events / 256 KiB. Adjacent text deltas cap at 32 KiB, tool payloads at 64 KiB, and lifecycle snapshots omit repeated message history.

## Current limitations

- Session creation is implemented, but saved-session listing/switching/forking UI remains for the sessions slice.
- Terminal, file tree, and Git actions remain future slices. Tool events are normalized now; the detailed chronological tool inspector follows in f3.
- Packaging is unsigned and uses generated default application artwork.

## Manual verification

1. Run `pnpm install`.
2. Run `pnpm dev` and confirm the window appears.
3. Drag both separators, toggle both side panes, and restart to confirm persistence.
4. Use Tab and arrow keys on separators; verify visible focus.
5. Select a trusted repository. Confirm model and thinking controls populate from the real Pi runtime.
6. Send a prompt and confirm text/reasoning streams; use Stop during a run.
7. If authentication is absent, run the Pi CLI, enter `/login`, then reopen the project.
8. Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm smoke`.

## Pi API discrepancies

- SDK 0.81.1 was verified from installed types and docs. `prompt()` uses `preflightResult` because its returned promise intentionally settles only after the complete run.
- `AgentSessionRuntime` replacement subscriptions and extension bindings are rebound through `setRebindSession`; switch/fork/import commands are not exposed until their dedicated UI slice.
- Project-bound runtime services are created before model availability is evaluated so trusted project extensions can register providers. A no-credential project still initializes its runtime, then reports the exact `/login` recovery step.
