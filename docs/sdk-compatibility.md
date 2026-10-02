# Pi SDK compatibility

## Current release pin

Fate UI uses matching, exact `1.0.0` pins for `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-durable`, and `@earendil-works/chord`.

The upstream source authority is [Pi v1.0.0](https://github.com/earendil-works/pi/releases/tag/v1.0.0), dated **2026-10-01**, at commit [`a13d35a742c6ef8462812a28fbe1d8c8b7431c32`](https://github.com/earendil-works/pi/commit/a13d35a742c6ef8462812a28fbe1d8c8b7431c32). The exact published npm distributions were inspected and their integrity hashes are retained in `pnpm-lock.yaml`. The lockfile also fixes transitive Pi packages to the matching release. Registry `latest` and unreleased source are not version authorities.

All four native packages declare MIT. Their published tarballs omit separate license files; the complete upstream license from this exact commit is retained in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). The server notice writer retains these full terms and verifies their source-commit link, exact license-content hash, and package pins before generating notices. This is distinct from the still-open `react-remove-scroll-bar@2.3.8` exact-license closure gate: no unsupported license text or dependency downgrade is substituted for that package.

## What Fate uses

- Public `AgentSessionRuntime`, `ModelRuntime`, `SessionManager`, and service-construction APIs for real provider-backed sessions, direct resume, and fork-at-leaf cloning
- Public Pi Durable and Chord entry points for native durable execution and storage integration; test-only provider substitutes are never production adapters
- SDK model discovery, `getSupportedThinkingLevels`, SDK version metadata, and supported authentication flows
- Public queue, steering, follow-up, cancellation, compaction, and transcript reconstruction APIs
- Typed tool definitions and the SDK's transcript-backed system prompt/tool loadout
- Native provider payloads and built-in model catalogs rather than duplicate application-side transport implementations

## Pi 1.0 compatibility boundary

`AgentSession.prompt()` now reports `started`, `queued`, or `handled` through `preflightResult`. Rejected prompts throw without invoking the acknowledgment. Fate validates these exact dispositions instead of coercing strings to booleans. A locally handled extension command is acknowledged without retaining a phantom queue item, consuming staged model/thinking choices, or generating a first-turn title. Errors before admission restore the reservation; errors after acknowledgment still report a run failure without retracting accepted input. Queue-capable requests reserve bounded durable bookkeeping before entering SDK hooks, so idle-to-queued and queued-to-started races follow the actual native disposition. Identity-bound consumption preserves staged settings even when hooks transform the user text. An unknown disposition throws synchronously and leaves a host-lifetime execution/model/permission fence, including when abort rejects or does not settle. Restart is required to clear an SDK compatibility fence.

Pi 1.0 supports OpenAI ChatGPT sign-in as well as API keys. Offline wire tests use an explicitly fake `sk-`-prefixed API key when checking the native 30-minute long-cache payload, because token-authenticated requests intentionally omit fields unsupported by ChatGPT. OpenRouter payload tests select the `openai-completions` API explicitly; OpenRouter also has native Anthropic-API models now.

## Carried patches

Both patches remain necessary against the exact 1.0.0 distribution:

1. `pi-coding-agent`: `includeHomeAgentSkills: false` prevents discovery of `HOME/.agents/skills` and ancestors above the registered project before filesystem enumeration. There is no equivalent native option. Server profiles pass it to both package-manager extension preflight and resource loaders; desktop discovery retains upstream defaults. Project trust still gates local resources. Post-load filtering is not an adequate replacement
2. `pi-ai`: OpenRouter omits reasoning when the off mapping is absent or null, while preserving explicit off mappings. Upstream still invents `effort: "none"` for an undefined mapping

The patches change only the public unbundled SDK entry points Fate imports. The separately bundled upstream CLI is not a Fate runtime entry and is not represented as patched. Patch paths and content hashes are retained by the lockfile and server closure projection.

## What stays application-owned

Fate keeps its renderer/main boundary, project trust, isolated provider store, permissions, editable queues, recovered drafts, browser boundaries, worktree ownership, and GoalMax evidence gates. Native Pi execution/storage must sit behind these host-owned boundaries; installing a newer SDK must not implicitly enable upstream CLI built-in MCP or codemode extensions.

The independent server closure explicitly lists native Durable/Chord roots. Both host source-build configs keep their subpath imports external to preserve Chord async-context identity, along with Node built-ins such as `node:sqlite`. Source builds do not establish packaged target readiness or authorize service installation.

## Verification and upgrade policy

1. Inspect the tagged upstream source, release notes, exact distributions, and licenses before changing pins
2. Review sessions, prompt admission, queues, cancellation, reasoning, provider payloads, and tool schemas
3. Install with the pinned pnpm version and exact lockfile integrity; verify a frozen install
4. Port only necessary patches and verify both positive and negative behavior
5. Run `PiSdkCompatibility.test.ts`, runtime/session/agent tests, `sdkHomeSkills.test.ts`, typechecking, and source builds
6. Keep native packaging and real-provider/target-OS validation separate. Offline tests establish integration contracts, not live-provider quality or release readiness

The full platform release gates remain those in [Development and release](development.md).
