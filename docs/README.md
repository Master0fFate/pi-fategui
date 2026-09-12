# Fate UI documentation

This directory holds the focused guides referenced by the [project README](../README.md). The README stays a short path to first launch; the detail lives here.

## By task

- **Open your first project** — [Get started](../README.md#get-started-in-60-seconds) (README), then [Sessions and processes](sessions-and-processes.md) for windows, processes, and session references.
- **See what your agents are doing** — [Features](features.md) covers Activity Pulse, the Activity timeline (live events + direct-write ledger), Review Runway, Git/files, the terminal, the browser, and native media.
- **Choose a skin or author a theme** — [Skins](skins.md) and [Themes](themes.md).
- **Build a dense operate UI** — [Fate Compact](../design/COMPACT.md) (Settings density system; candidate for a full-app transition).
- **Remember project and personal coding notes** — [Memory Learning](project-learning.md).
- **Drive multi-agent work** — [Agent orchestration](agent-orchestration.md) (one executor for direct agents and dependency-based workflows).
- **Manage longer objectives** — [GoalMax and durable work](goalmax.md).
- **Understand the embedded runtime** — [Pi SDK compatibility](sdk-compatibility.md).
- **Review trust, permissions, and isolation** — [Architecture and security](architecture.md) and [SECURITY.md](../SECURITY.md).
- **Build, package, or cut a release** — [Development and release](development.md).

## By audience

- **New users** — README → [Sessions and processes](sessions-and-processes.md) → [Features](features.md).
- **Operators and reviewers** — [Features](features.md) → [Architecture and security](architecture.md) → [SECURITY.md](../SECURITY.md).
- **Customizers** — [Skins](skins.md) → [Themes](themes.md).
- **Power users** — [Agent orchestration](agent-orchestration.md) → [Sessions and processes](sessions-and-processes.md).
- **Contributors and maintainers** — [CONTRIBUTING.md](../CONTRIBUTING.md) → [Development and release](development.md).

## Conventions

Fate UI uses numeric `major.minor.patch` versions with an optional display name: **V1.0.0 - Modulo**. Update ordering and artifact names use the version, not the name. Installers remain unsigned; verify downloads against `SHA256SUMS` and review platform trust warnings. Keep important work backed up. See the README's [trust boundaries](../README.md#local-first-with-explicit-boundaries) and [Architecture and security](architecture.md).
