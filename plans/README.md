# Implementation Plans

Generated on 2026-08-06 from beta feedback requesting files, filesystem, browser use, computer use, and automations in one place.

The approved implementation uses a tabbed left sidebar—Sessions, Automations, and Resources—plus a universal command center over separate, permission-scoped capabilities. It does not create one giant panel or a universal access toggle.

## Execution order and status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---:|---:|---|---|
| [001](001-unified-resource-workbench.md) | Make Fate UI a unified resource workbench without collapsing security boundaries | P1 | XL, phased | Preserve existing Browser work; later tracks need separate approval | IN PROGRESS (sidebar-first increment implemented) |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (with reason) | REJECTED (with rationale)

## Dependency notes

- Preserve the substantial in-progress Browser tranche and its typed permission boundary. Do not reset or overwrite it while refining the sidebar increment.
- The implemented Resources tab and universal command center deep-link into existing Files, Browser, Pi Library, Terminal, session, and automation surfaces.
- Manual reusable automations precede any time-based or background scheduling.
- Arbitrary OS computer use remains a separate security/platform go/no-go project; the shipped UI labels it unavailable rather than extending browser CDP into host control.

## Confirmed implementation decisions

1. Computer means arbitrary OS control and remains unavailable; Browser is the real scoped alternative.
2. Automations are manually prepared in a fresh session for review and never auto-send; scheduling/background execution is deferred.
3. Filesystem discovery remains confined to the active project.
4. Automation permissions are limited to Read only or project-confined Edit and are applied in main before the new session is published.

## Findings considered and rejected

- **Put every feature into one inspector panel**: rejected because Monaco, native Chromium, terminal, and run history need different interaction surfaces; a mega-panel would reduce usability.
- **Replace the shell with a new dashboard**: rejected because the existing three-pane Focused Workbench is sound and well-covered.
- **Use one master permission switch**: rejected because project, browser-origin, future desktop-target, and automation-run authority have different risks and lifetimes.
- **Call GoalMax/subagent workflows “Automations” without a new product model**: rejected because they lack a user-owned catalog, triggers, schedules, and independent run history.
- **Add arbitrary desktop control alongside the current browser work**: rejected for the first increment because Fate UI currently has no OS capture/input architecture or platform permission model.
