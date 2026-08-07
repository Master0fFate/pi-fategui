# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Software developers working in local repositories who want Pi’s real coding-agent capabilities through a graphical desktop workspace. They need long-running conversations, tool activity, code changes, files, and terminals to remain legible and controllable.

## Product Purpose

Pi Desktop is a local-first Electron interface for the real Pi coding agent. It lets a developer select and trust a repository, initialize Pi through `@earendil-works/pi-coding-agent`, converse with streamed output, inspect tool activity and code changes, manage durable sessions and branches, browse files, and use a separate integrated terminal.

Success means the GUI remains responsive and trustworthy during real agent work without wrapping Pi’s terminal UI or substituting mocked production responses.

## Positioning

Pi Desktop embeds Pi’s SDK in the Electron main process and translates its runtime into an application-owned, typed event model. The renderer stays presentation-only: it receives normalized state through a narrow validated preload bridge while Pi, credentials, files, Git, and shell processes stay outside the renderer.

## Operating Context

The product runs as a native desktop window beside a developer’s editor and repository. It uses local project directories, Git working trees, Pi’s existing provider authentication and session storage, shell processes, skills, prompt templates, and context files. Repositories are potentially untrusted and may contain project-local Pi resources.

## Capabilities and Constraints

- Product name: **Pi Desktop**.
- Required stack: Electron, strict TypeScript, React, Vite, Tailwind CSS, Radix UI, Lucide, Zustand, TanStack Query where cached async state is useful, xterm.js, Monaco, react-virtuoso, electron-builder, Vitest, React Testing Library, and Playwright.
- The Electron main process owns Pi, sessions, project selection, filesystem, Git, terminal processes, settings, credential references, dialogs, and menus.
- The preload exposes named, Zod-validated commands and events only. The renderer has no Node, Electron, filesystem, shell, or child-process access.
- The embedded Pi SDK is preferred. Unsupported SDK capabilities must have honest unavailable states rather than invented behavior.
- Existing Pi authentication is reused; raw API keys are never stored or displayed in renderer state.
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
