# Pi SDK compatibility

## Current release pin

Fate UI uses matching, exact pins of `@earendil-works/pi-coding-agent@0.87.1` and `@earendil-works/pi-ai@0.87.1`.

Checked against the canonical [upstream GitHub release](https://github.com/earendil-works/pi/releases/tag/v0.87.1) on **2026-09-25**, not an npm latest-version query. The stable release was published **2026-09-22** at commit [`f07218c4d4bbc12bef056a7058c3dd49dfe41abe`](https://github.com/earendil-works/pi/commit/f07218c4d4bbc12bef056a7058c3dd49dfe41abe). The GitHub `main` branch contains newer, unreleased changes and is not a stable SDK target. Matching exact distribution packages install the tagged version through the project's lockfile; GitHub release notes and tagged source are the version authority.

The [0.86.0 release](https://github.com/earendil-works/pi/releases/tag/v0.86.0) adds prompt-cache warming, model-specific compaction budgets, and transcript-backed prompt/tool updates. The [0.87.0 release](https://github.com/earendil-works/pi/releases/tag/v0.87.0) makes SessionManager the canonical model transcript and adds context edits and image resize limits. Fate's model sessions get those SDK capabilities without replacing desktop-owned approval, queue, and history boundaries. SDK tests were adapted to inspect the new transcript and provider prompt instead of the obsolete `agent.state.systemPrompt`. No new MCP client was added upstream; Fate's opt-in MCP bridge is app-owned.

## What Fate uses

- The public `AgentSessionRuntime` / `ModelRuntime` APIs for real provider-backed execution.
- SDK model discovery, `getSupportedThinkingLevels`, exported SDK version metadata, and supported authentication flows.
- Public queue, steering, follow-up, cancellation, compaction, and session reconstruction APIs.
- Typed tool definitions with explicit parameter schemas.
- The released long-cache request behavior and built-in model catalog, rather than duplicate application-side transport patches.

## What stays application-owned

Fate keeps its renderer/main boundary, project trust, isolated provider store, durable editable queues, recovered drafts, browser permissions, unified agent/workflow execution, worktree ownership, and GoalMax evidence gates. Upstream terminal interactions and experimental client/server designs do not replace those desktop responsibilities.

The narrow OpenRouter patch in `patches/` remains necessary in 0.87.1: the tagged `openai-completions.ts` still emits a default `none` effort when `thinkingLevelMap.off` is undefined. It is covered by offline payload tests. Experimental Pi client/server packages are not part of Fate's production runtime.

## Upgrade policy

1. Check upstream GitHub releases and the tagged changelog first. Do not treat an unreleased `main` commit or registry tag as proof of a compatible release.
2. Review changes to sessions, queues, cancellation, model reasoning, provider payloads, and tool schemas before changing the pins.
3. Install matching exact packages with the project's pinned pnpm version, preserving lockfile integrity.
4. Rebase and test carried patches; remove a patch only when upstream actually supersedes it.
5. Run `PiSdkCompatibility.test.ts`, runtime/session/agent tests, the full verification suite, and native packaging checks.
6. Adopt useful public capabilities without replacing stronger existing Fate behavior or widening trust boundaries.

Offline tests demonstrate wire payloads and integration contracts. They do not establish live-provider response quality. Platform release readiness is recorded separately by the native CI matrix described in [Development and release](development.md).
