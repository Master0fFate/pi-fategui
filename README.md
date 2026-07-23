# Pi Desktop

A local-first Electron GUI foundation for the Pi coding agent. This repository currently contains the **f1 application shell**; real Pi runtime integration follows as a separate vertical slice and is not mocked here.

## Requirements

- Node.js 20+
- pnpm 10+

## Develop

```bash
pnpm install
pnpm dev
```

The development command builds/watches the ESM main process and CJS preload, runs the Vite renderer, then launches Electron.

## Verify

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

`pnpm smoke` builds and starts the production Electron entry, waits for renderer load, prints `PI_DESKTOP_SMOKE_OK`, and exits. Package with `pnpm package` (unpacked) or `pnpm dist` (installer).

## Security architecture

The main process owns native capabilities. A sandboxed CJS preload exposes only `window.piDesktop`, a typed, frozen API. Both ends validate payloads with shared Zod schemas. The renderer has no Node, Electron, filesystem, or shell access. `BrowserWindow` explicitly enables context isolation and sandboxing and disables Node integration.

See `PRODUCT.md`, `DESIGN.md`, and `BUILD_NOTES.md` for product scope, visual decisions, and current limitations.
