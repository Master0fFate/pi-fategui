# Product

<!-- impeccable:product-schema 1 -->

## Platform

desktop (Electron)

## Users

Software developers working in local repositories who want Pi’s real coding-agent capabilities through a graphical desktop workspace. They need long-running conversations, tool activity, code changes, files, and terminals to remain legible and controllable.

## Product Purpose

Fate UI is a local-first Electron desktop interface for the real Pi coding agent. It lets a developer select and trust a repository, initialize Pi through `@earendil-works/pi-coding-agent`, converse with streamed output, inspect tool activity and code changes, manage durable sessions and branches, browse files, and use a separate integrated terminal.

Success means the GUI remains responsive and trustworthy during real agent work without wrapping Pi’s terminal UI or substituting mocked production responses.

## Positioning

Fate UI embeds Pi’s SDK in the Electron main process and translates its runtime into an application-owned, typed event model. The renderer stays presentation-only: it receives normalized state through a narrow validated preload bridge while Pi, credentials, files, Git, and shell processes stay outside the renderer.

## Operating Context

The product runs as a native desktop window beside a developer’s editor and repository. Its embedded Pi SDK owns provider authentication under `~/.pi/fateGUI/`; shared Pi sessions, settings, MCP configuration, skills, prompt templates, extensions, and context files remain compatible with the established Pi resource layout. It does not run or require the Pi terminal program. Repositories are potentially untrusted and may contain project-local Pi resources.

## Capabilities and Constraints

- Product name: **Fate UI**.
- Required stack: Electron, strict TypeScript, React, Vite, Tailwind CSS, Radix UI, Lucide, Zustand, TanStack Query where cached async state is useful, xterm.js, Monaco, react-virtuoso, electron-builder, Vitest, React Testing Library, and Playwright.
- The Electron main process owns Pi, sessions, project selection, filesystem, Git, terminal processes, settings, credential references, dialogs, and menus.
- The preload exposes named, Zod-validated commands and events only. The renderer has no Node, Electron, filesystem, shell, or child-process access.
- The embedded Pi SDK is preferred. Unsupported SDK capabilities must have honest unavailable states rather than invented behavior.
- Fate UI imports Pi credentials once on its first run, then owns provider auth and model configuration; raw API keys are never stored or displayed in renderer state.
- Project trust is explicit. Manual terminal commands remain visually distinct from Pi-generated tool execution.
- Conversation/event lists must remain usable with 5,000 entries, rapid streaming, large tool output, hundreds of changed files, and long sessions.

## Brand Commitments

The shipped Fate UI interface is the product reference for atmosphere and first-launch hierarchy. Preserve a dark-first, restrained, spacious, professional and calm character, with neutral charcoal surfaces, soft borders, subtle depth, excellent typography, and one cool violet accent. Do not copy any specific competing product.

## Evidence on Hand

- Product and architecture specification: `TASK.md`.
- Current product screenshots: `screenshots/fate-ui-dark.png` (dark) and `screenshots/fate-ui-light.png` (light).
- Official Pi SDK and RPC documentation: `https://pi.dev/docs/latest/sdk` and `https://pi.dev/docs/latest/rpc`.
- No testimonials, customer claims, benchmark data, pricing, or third-party brand assets were supplied; do not fabricate them.

## Product Principles

1. **Real agent, honest state.** Production output comes only from Pi; unavailable capabilities and authentication blockers are explicit.
2. **Local authority.** Projects, sessions, credentials, Git, and shell processes remain under main-process control.
3. **Security by boundary.** Renderer capabilities are narrow, typed, validated, and project-root confined.
4. **Calm under load.** Streaming, tools, diffs, and long histories remain stable through batching, entity state, virtualization, and bounded output.
5. **Immediate control.** Every action acknowledges input promptly; stop, steer, queue, recovery, and focus states stay visible.

## Accessibility & Inclusion

Use accessible Radix primitives, complete keyboard navigation, visible focus styles, semantic status announcements, sufficient contrast, minimum practical hit targets, and reduced-motion behavior. The desktop workspace must remain operable without a pointing device.
