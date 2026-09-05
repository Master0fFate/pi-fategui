# Development and release

How to build, verify, package, and release Fate UI from source. For the contribution workflow, code review expectations, and licensing of contributions, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Prerequisites

- Node.js **22.19.0 or newer**
- pnpm **11.17.0**
- Git on `PATH`
- A Windows, macOS, or Linux desktop environment
- Build tools for native modules on Linux (`build-essential` and Python 3)

## Setup

```bash
git clone https://github.com/Master0fFate/pi-fategui.git
cd pi-fategui
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

The development launcher uses an isolated Electron profile, so it can run alongside an installed Fate UI without activating the installed process. That Chromium profile is stable per checkout under the operating system's temporary directory. Provider credentials, models, and other Fate data still use the production store (`~/.pi/fateGUI`). Set `PI_DESKTOP_DEV_PROFILE` to override the Electron profile location; set `FATE_GUI_DATA_DIR` only if you actually want a separate Fate data directory.

## Verification

```bash
pnpm typecheck       # strict TypeScript
pnpm test            # Vitest unit/integration suite
pnpm test:e2e        # Playwright Electron suite
pnpm verify          # typecheck + tests + E2E
pnpm build           # production main/preload/renderer bundles
pnpm smoke           # production-entry smoke test
pnpm package         # target-native unpacked package + packaged smoke
pnpm dist            # target-native installer artifacts
```

`node-pty`, transcription libraries, and other native dependencies are built or selected on the target operating system. Do not treat cross-compilation as equivalent to a native build.

## Build an installer from source

To build an installer from source, install the platform prerequisites above, check out the desired tag, run `pnpm install --frozen-lockfile`, then run `pnpm dist` (or `pnpm dist:artifacts` to skip the speech-runtime and full-build gates) on the target operating system.

## Release process

The cross-platform GitHub Actions package matrix runs for pull requests, pushes to `main`, version tags, and non-promotion manual dispatches.

- Native hosted runners build, install or mount, and smoke-test Windows x64, macOS Apple Silicon and Intel, and Linux x64 packages: Windows NSIS, macOS DMG and PKG, Linux AppImage and DEB.
- A release tag must be `v<package.json version>` and point to history contained in `main`.
- After every native job passes, a version tag publishes seven installers and `SHA256SUMS` to its GitHub Release.
- A manual dispatch with empty promotion inputs stages the same seven installers and `SHA256SUMS` as `verified-prerelease-installers`, retained for 14 days. It does not create a tag or publish a release.

The Renderer performance profiles workflow compares normal, Performance, and Holy sh*t modes on all four native targets. It freezes the candidate's profiling harness for both revisions; manual runs accept `baseline_ref`, defaulting to the nearest version tag. CPU work is timed separately from post-GC retained-heap measurements and final-output checks.

Cross-platform or native dependency changes must pass the GitHub Actions matrix. Do not claim another operating system was verified solely from a cross-compiled artifact.

The [Pi SDK 0.85.0 integration notes](sdk-upgrade-0.85.0.md) record upstream changes, compatibility decisions, and dependency constraints. [Beta3 performance evidence](performance-0.9.7-beta3.md) records the before/after workload and measurements. Main-process and SDK-backed logic tests run in Node; renderer DOM tests run in jsdom. When validating from inside an installed Fate UI, unset `TRANSCRIBE_LIBRARY` only in the validation subprocess so it loads the checkout's native speech library.
