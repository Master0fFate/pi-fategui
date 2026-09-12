# Pi SDK compatibility

## Current release pin

Fate UI V1 uses matching, exact pins of `@earendil-works/pi-coding-agent@0.85.1` and `@earendil-works/pi-ai@0.85.1`.

Checked against the canonical [upstream GitHub release](https://github.com/earendil-works/pi/releases/tag/v0.85.1) on **2026-09-12**, not an npm latest-version query. The release was published on **2026-09-05**, at commit [`d981de1229ef899957bbe968bc8dcda02a21f477`](https://github.com/earendil-works/pi/commit/d981de1229ef899957bbe968bc8dcda02a21f477). It was still the latest non-draft, non-prerelease GitHub release at verification time.

Upstream `main` contains newer work but still reports version `0.85.1`; those commits are not a newer released SDK. V1 deliberately stays on the released tag rather than shipping unversioned behavior changes.

## What Fate uses

- The public `AgentSessionRuntime` / `ModelRuntime` APIs for real provider-backed execution.
- SDK model discovery, `getSupportedThinkingLevels`, exported SDK version metadata, and supported authentication flows.
- Public queue, steering, follow-up, cancellation, compaction, and session reconstruction APIs.
- Typed tool definitions with explicit parameter schemas.
- The released long-cache request behavior and built-in model catalog, rather than duplicate application-side transport patches.

## What stays application-owned

Fate keeps its renderer/main boundary, project trust, isolated provider store, durable editable queues, recovered drafts, browser permissions, unified agent/workflow execution, worktree ownership, and GoalMax evidence gates. Upstream terminal interactions and experimental client/server designs do not replace those desktop responsibilities.

The existing narrow OpenRouter patch in `patches/` remains necessary for reasoning-off requests without an explicit off mapping. It is covered by offline payload tests. Experimental Pi client/server packages are not part of Fate's production runtime.

## Upgrade policy

1. Check upstream GitHub releases and the tagged changelog first. Do not treat an unreleased `main` commit or registry tag as proof of a compatible release.
2. Review changes to sessions, queues, cancellation, model reasoning, provider payloads, and tool schemas before changing the pins.
3. Install matching exact packages with the project's pinned pnpm version, preserving lockfile integrity.
4. Rebase and test carried patches; remove a patch only when upstream actually supersedes it.
5. Run `PiSdkCompatibility.test.ts`, runtime/session/agent tests, the full verification suite, and native packaging checks.
6. Adopt useful public capabilities without replacing stronger existing Fate behavior or widening trust boundaries.

Offline tests demonstrate wire payloads and integration contracts. They do not establish live-provider response quality. Platform release readiness is recorded separately by the native CI matrix described in [Development and release](development.md).
