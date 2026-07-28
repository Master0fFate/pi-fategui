# Contributing to Fate UI

Thank you for helping improve Fate UI. Contributions should preserve its local-first architecture, explicit project trust, and honest use of the real Pi runtime.

## Before you start

- Search existing issues and pull requests.
- Use a focused issue for substantial features or architecture changes.
- Report vulnerabilities privately through [SECURITY.md](SECURITY.md), never in a public issue.
- Keep changes narrow; avoid unrelated cleanup in the same pull request.

## Development setup

```bash
git clone https://github.com/Master0fFate/pi-fategui.git
cd pi-fategui
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Requirements are Node.js 22.19+, pnpm 11.17.0, Git, and a supported desktop environment. Linux native modules require a compiler toolchain and Python 3.

## Architecture rules

- The **main process** owns Pi, credentials, projects, files, Git, terminal PTYs, settings, dialogs, and logs.
- The **preload** exposes only narrow, named, validated methods and events.
- The **renderer** remains presentation-only and must not gain Node.js, Electron, filesystem, credential, shell, or child-process access.
- Project-local resources must never bypass the existing trust decision.
- Use argument arrays rather than shell interpolation for child processes.
- Preserve bounded output, cancellation, race handling, and rollback semantics.
- Production must use the real Pi runtime; deterministic adapters belong only under tests.

## Quality gates

Run the checks affected by your change. Before requesting review, the full default is:

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

Packaging changes should additionally run on the target operating system:

```bash
pnpm package
pnpm dist:artifacts
```

Cross-platform or native dependency changes must pass the GitHub Actions matrix. Do not claim another operating system was verified solely from a cross-compiled artifact.

## Pull requests

A strong pull request includes:

- the problem and intended behavior;
- a concise implementation summary;
- security or trust-boundary implications;
- tests added or updated;
- exact verification commands and results;
- screenshots for visible UI changes;
- known limitations or follow-up work.

Use clear commit messages and keep generated build output, installers, credentials, and local agent state out of Git.

## Contributions and licensing

Unless explicitly stated otherwise, a contribution intentionally submitted for inclusion in Fate UI is provided under the Apache License 2.0, as described in Section 5 of [LICENSE](LICENSE). You represent that you have the right to submit the contribution.

Retain applicable copyright, license, attribution, and trademark notices. Modified distributions must follow Apache-2.0 and include [NOTICE](NOTICE) and applicable terms from [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Community conduct

Be respectful, specific, and evidence-driven. Critique code and decisions rather than people. Harassment, discrimination, threats, or deliberate disruption are not acceptable.
