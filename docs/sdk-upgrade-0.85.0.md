# Pi SDK 0.85.0 integration

## Source and compatibility

The version was selected from the [upstream GitHub release](https://github.com/earendil-works/pi/releases/tag/v0.85.0), not npm's latest-version listing. The release tag resolves to `107d79f11072bbc8a3a757ed7fd69596bee7d68c`. Its source archive matched the published SHA-256 value `b4dd5d4db4cd2832389da6445485bbca9db9c6d83bb7504d67975af5c5fe8307`. The dependency and lockfile pin the matching published SDK package.

The reviewed release includes persistent Claude effort metadata, provider stream fixes, safer imports and forks, compaction-boundary fixes, and restoration of externally held session entries. Fate UI continues to embed the SDK directly; it does not launch Pi's terminal application.

Version 0.85.0 has an undeclared runtime import of `@earendil-works/pi-server`, tracked in [upstream PR #9170](https://github.com/earendil-works/pi/pull/9170). Fate explicitly depends on the matching 0.85.0 package so SDK imports and packaged startup work. The existing OpenRouter compatibility patch remains necessary and is carried forward to pi-ai 0.85.0.

## What uses the SDK

Saved-session references now use `SessionManager.inMemory()` with detached entries. Reading a tagged session no longer invokes the writable `SessionManager.open()` path, which can migrate legacy files or append a missing newline. The SDK owns migration and active-branch reconstruction. Fate verifies the session identity, rejects cyclic active paths, redacts excerpts, and keeps the existing 5,800-character output limit and untrusted-reference boundary.

The tagged SDK documentation describes self-contained compaction `retainedTail` checkpoints, but the stable SDK entry projection does not expand them. Fate therefore retains a small compatibility projection for those checkpoints, including their precedence over legacy `firstKeptEntryId` data. An empty retained tail must not expose older messages.

Stop now calls the SDK's `abortCompaction()` for manual compaction as well as stopping streaming work. Ordinary sessions, forks, clones, and durable child restoration already use SDK APIs; replacing them would add another implementation rather than remove one.

## What stays in Fate

Agent Teams, legacy subagents, project trust, confined tools, mutation records, browser controls, validated IPC, presentation limits, and active-work guards remain Fate-owned. Pi does not replace those application responsibilities. In particular, the update does not enable experimental server workflows or weaken the restrictions on replacing a running session.

Basic Prompt Optimization no longer inherits extended coding-session reasoning. Advanced research keeps its existing settings. Cancellation releases the caller promptly, but a provider that ignores its abort signal can continue remote work until its own timeout. Live provider latency and rewrite quality require provider-specific testing; the local regression tests use deterministic responses.

## Other dependencies

| Package | Previous | Selected |
| --- | --- | --- |
| Electron | 43.4.1 | 43.6.0 |
| transcribe-cpp | 0.2.1 | 0.2.3 |
| Lucide React | 1.33.0 | 1.40.0 |
| Mermaid | 11.17.0 | 11.17.2 |
| TypeBox | 1.3.16 | 1.3.25 |
| Testing Library React | 16.3.2 | 16.3.3 |
| Testing Library user-event | 14.6.5 | 14.6.7 |
| Node 22 types | 22.19.18 | 22.20.1 |
| Vite React plugin | 6.1.0 | 6.1.1 |
| PostCSS | 8.5.26 | 8.5.28 |

React 18, Tailwind 3, Zod 3, TypeScript 5, Vitest 4, jsdom 26, and pnpm 11 remain on their existing major versions. Radix popover stays pinned to 1.1.22: 1.1.23 failed the compact permission-picker journey twice, and the journey passed after restoring 1.1.22. The bundled yt-dlp was already the latest stable upstream release, 2026.08.19, with matching pinned checksums.

## Verification and limits

Regression coverage includes real SDK restoration of legacy files, unchanged source bytes, Unicode across read chunks, inactive-branch exclusion, checkpoint precedence, stale identities, cycles, and compaction cancellation. Main-process and SDK-backed logic tests run in Node; DOM tests use jsdom. This avoids esbuild's cross-realm byte-array failure without weakening production code or installing a global test polyfill.

The reference reader uses 64 KiB I/O chunks but still reconstructs the session's entries. Total memory and synchronous read time therefore scale with session size; this is not a hard input-size bound. No new file-size rejection was added that would make previously readable large sessions unavailable.

Tests launched from the installed app must not inherit its native speech-library override. Unset `TRANSCRIBE_LIBRARY` in the validation subprocess so it verifies this checkout's library, not the running installation. The manual fork smoke launcher now uses its own Chromium profile and strips this override; it no longer deletes shared instance profiles.
