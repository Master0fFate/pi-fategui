# Build Notes

## Completed

- Phase 1 / f1: Electron + Vite + React + Tailwind foundation, secure preload, typed IPC, three-pane shell, tests, and packaging configuration.

## Decisions

- Main output is ESM; sandbox-compatible preload is bundled as CJS.
- Renderer IPC is exposed as one frozen, narrow `piDesktop` object. Shared Zod schemas validate both arguments and responses.
- Pane geometry is renderer-local Zustand state persisted to local storage.
- Pi integration is deliberately deferred rather than represented with mock agent state.

## Current limitations

- No project access, Pi runtime, sessions, terminal, file tree, or Git actions in foundation slice.
- Shell buttons for future slices communicate availability rather than invoking placeholder data.
- Packaging is unsigned and uses generated default application artwork.

## Manual verification

1. Run `pnpm install`.
2. Run `pnpm dev` and confirm the window appears.
3. Drag both separators, toggle both side panes, and restart to confirm persistence.
4. Use Tab and arrow keys on separators; verify visible focus.
5. Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm smoke`.

## Pi API discrepancies

None evaluated in f1; no Pi SDK symbols are used by this foundation slice.
