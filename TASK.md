You are a senior desktop application engineer and product designer. Build a polished, production-quality desktop GUI for the Pi coding agent.

## Product

Create a local-first desktop application named **Pi Desktop**.

The app must be a genuine graphical interface for the real Pi coding agent. It must not imitate an agent with mocked responses and must not scrape or wrap Pi’s terminal UI.

Use Pi programmatically through:

`@earendil-works/pi-coding-agent`

Reference the current official documentation before implementing Pi-specific APIs:

* https://pi.dev/docs/latest
* https://pi.dev/docs/latest/sdk
* https://pi.dev/docs/latest/rpc

Prefer the embedded Pi SDK. Use RPC mode only if an SDK capability cannot reasonably support the required architecture.
Open a repository using git but make the repository PRIVATE.

## Required stack

Use:

* Electron
* TypeScript with strict mode
* React
* Vite
* Tailwind CSS
* Radix UI primitives
* Lucide icons
* Zustand for local UI state
* TanStack Query only where asynchronous cached state is useful
* xterm.js for terminal output
* Monaco Editor for file and diff viewing
* react-virtuoso for virtualized conversation and event lists
* electron-builder for packaging
* Vitest
* React Testing Library
* Playwright for essential end-to-end tests

Use pnpm as the package manager.

Do not replace Electron with Tauri, Next.js, or a browser-only architecture.

## Architecture

Use a secure Electron architecture:

### Electron main process

The main process owns:

* Pi SDK initialization
* Pi session lifecycle
* filesystem access
* project-directory selection
* Git operations
* shell and terminal processes
* application settings
* secure credential references
* native menus and dialogs

### Preload process

Expose a narrow, typed IPC API through `contextBridge`.

Do not expose raw Node.js, Electron, filesystem, shell, or child-process APIs to the renderer.

Enable:

* `contextIsolation: true`
* `nodeIntegration: false`
* Electron sandboxing where compatible

Validate all IPC payloads with Zod.

### React renderer

The renderer owns presentation and user interaction only.

It receives normalized Pi events from the main process and sends typed commands through the preload API.

Create shared TypeScript types for:

* commands
* Pi events
* messages
* tool calls
* sessions
* model settings
* application settings
* project state
* errors

## Pi integration

Implement a dedicated main-process service:

`src/main/pi/PiRuntimeService.ts`

Use the current Pi SDK APIs rather than invented interfaces.

The runtime service must support:

* creating an agent runtime for a selected project directory
* creating a new session
* switching sessions
* importing or resuming sessions when supported
* forking a session or conversation branch
* sending a prompt
* streaming assistant text
* streaming reasoning metadata when made available by Pi
* steering an active response
* queuing a follow-up
* aborting the current operation
* selecting a model
* setting the thinking level
* reading current messages and runtime state
* subscribing to Pi events
* tool execution start, update, completion, and error events
* context compaction
* disposing resources cleanly
* reconnecting subscriptions whenever Pi replaces the active session

Use `createAgentSessionRuntime()` when session replacement and project-bound runtime state require it.

Do not invent unsupported Pi methods. Where the current SDK does not expose a desired feature, isolate the limitation behind an adapter and show an honest unavailable state in the UI.

Normalize SDK events into an application-owned event union before sending them to React. The renderer should not depend directly on Pi’s raw event structures.

## Core interface

Build a smooth, modern coding-agent interface influenced by the quality level of contemporary AI coding desktop apps, but do not copy any specific product.

The visual style should be:

* dark-first
* restrained
* spacious
* professional
* calm
* highly polished
* subtle depth rather than heavy glassmorphism
* excellent typography
* smooth micro-interactions
* minimal decorative clutter

Use a neutral charcoal background, slightly elevated panels, soft borders, subtle shadows, and one restrained cool accent color.

Avoid:

* excessive gradients
* neon cyberpunk styling
* oversized rounded cards everywhere
* unnecessary dashboards
* fake metrics
* visual noise
* animations that delay interaction

## Main layout

Create a resizable three-column layout.

### Left sidebar

Include:

* app logo and project name
* open project button
* new session button
* searchable session list
* session status
* conversation branches
* skills or prompt templates section
* settings button

The sidebar must be collapsible.

### Center workspace

Include:

* session title
* model selector
* thinking-level selector
* connection status
* context usage indicator when available
* virtualized conversation timeline
* user messages
* streamed assistant messages
* tool-call cards
* errors and retry states
* compacted-context notices
* composer

The composer must support:

* multiline input
* send
* keyboard shortcuts
* stop
* steer current run
* queue follow-up
* slash-command suggestions
* file references
* optional image attachment if the current Pi API supports it

During streaming, do not rerender the entire conversation for every token. Batch or throttle updates to preserve smoothness.

### Right inspector

Create tabs for:

* Changes
* Files
* Tools
* Context

#### Changes

Show:

* changed files
* additions and deletions
* side-by-side or unified Monaco diff
* accept/revert controls only when safely implementable
* open file action

#### Files

Show:

* project file tree
* file search
* Monaco file preview

#### Tools

Show:

* chronological tool execution
* tool name
* status
* summarized input
* live output
* duration
* result or error
* expandable details

#### Context

Show:

* current objective
* active model
* thinking level
* project directory
* loaded skills
* prompt templates
* session metadata
* context or token information when available

The inspector must be collapsible.

## Additional surfaces

Implement:

### Command palette

Open with `Cmd/Ctrl+K`.

Commands should include:

* open project
* new session
* switch session
* change model
* change thinking level
* focus composer
* stop generation
* toggle sidebar
* toggle inspector
* open settings
* open terminal

### Integrated terminal

Provide a toggleable xterm.js panel.

Run the shell through a main-process pseudo-terminal service. Keep this service separate from Pi’s internal tool execution.

### Settings

Include:

* appearance
* default model
* thinking level
* project trust and safety
* terminal shell
* keyboard shortcuts
* Pi diagnostics
* application logs

Do not display or store raw API keys in renderer state. Prefer Pi’s existing provider authentication and configuration mechanisms.

## Interaction quality

Implement:

* immediate visual response to every click
* optimistic UI only where rollback is safe
* skeleton states
* useful empty states
* clear recoverable errors
* persistent panel sizes
* keyboard navigation
* visible focus styles
* accessible Radix components
* reduced-motion support
* native-feeling menus
* smooth but restrained transitions
* no layout jumps during streaming

Use CSS transitions primarily. Use an animation library only when clearly justified.

## Data flow

Use an event-driven architecture.

Example conceptual flow:

1. React invokes `window.piDesktop.prompt(...)`.
2. Preload validates and forwards the command.
3. Main process invokes the Pi runtime service.
4. Pi emits session and message events.
5. Main process normalizes and batches events.
6. Renderer receives typed events.
7. Zustand updates only the affected entities.
8. React renders virtualized messages and tool cards.

Store messages and tool executions by stable IDs rather than replacing giant arrays on every token.

## Project structure

Use a clear structure similar to:

```text
src/
  main/
    index.ts
    ipc/
    pi/
      PiRuntimeService.ts
      PiEventNormalizer.ts
      PiSessionRepository.ts
    git/
    terminal/
    settings/
    security/
  preload/
    index.ts
    api.ts
  renderer/
    app/
    components/
    features/
      chat/
      sessions/
      tools/
      files/
      diffs/
      terminal/
      settings/
    stores/
    hooks/
    styles/
  shared/
    contracts/
    schemas/
    types/
```

Keep files focused. Avoid giant components and god services.

## Implementation sequence

Work in vertical slices.

### Phase 1 — executable shell

Create:

* Electron application
* Vite React renderer
* secure preload bridge
* Tailwind and Radix setup
* development scripts
* packaging configuration
* polished application shell

Verify that the app opens successfully.

### Phase 2 — real Pi connection

Implement:

* project selection
* Pi runtime initialization
* one real session
* prompt submission
* streamed assistant output
* stop action
* connection and error states

Do not proceed with mock agent data once this phase begins.

### Phase 3 — agent tooling UI

Implement:

* normalized tool events
* tool execution cards
* streamed tool output
* completion and failure states
* event timeline

### Phase 4 — sessions

Implement:

* new session
* session list
* switching
* forking or branching
* persistence
* session replacement subscription handling

### Phase 5 — developer workspace

Implement:

* file tree
* Monaco file preview
* Git change detection
* Monaco diff viewer
* integrated terminal

### Phase 6 — polish

Implement:

* command palette
* settings
* keyboard shortcuts
* accessibility
* performance optimization
* tests
* packaging
* documentation

After every phase, run the application and tests and fix failures before continuing.

## Testing requirements

Add unit tests for:

* IPC schemas
* Pi event normalization
* state reducers or store actions
* session replacement behavior
* streamed-message batching
* error normalization

Add integration tests for:

* project selection
* opening a Pi session
* sending a prompt
* receiving streamed events
* aborting a run
* tool status transitions

Use an adapter boundary so Pi can be replaced with a deterministic fake only inside tests.

Add Playwright coverage for:

* first launch
* opening a project
* sending a prompt
* viewing a tool call
* opening a diff
* switching sessions

## Performance requirements

The UI must remain responsive with:

* 5,000 conversation entries
* rapidly streamed text
* large tool outputs
* hundreds of changed files
* long-running sessions

Use:

* virtualization
* memoized selectors
* token batching
* output truncation with expand controls
* lazy-loaded Monaco
* debounced file search
* background processing for expensive diff work

Do not send unrestricted high-frequency events over IPC one token at a time if batching preserves the same user experience.

## Security requirements

Treat selected repositories as potentially untrusted.

Implement:

* explicit project selection
* visible trusted-project state
* confirmation before risky shell commands when controlled by the GUI
* strict IPC allowlists
* path validation
* no arbitrary renderer-side shell execution
* no raw `eval`
* no remote code loading
* no disabled web security
* external links opened through a safe main-process handler

Clearly distinguish Pi-generated tool execution from commands manually launched in the integrated terminal.

## Definition of done

The result is complete when:

1. `pnpm install` succeeds.
2. `pnpm dev` launches the desktop application.
3. A user can select a real local project.
4. The app initializes the real Pi runtime.
5. A user can send a prompt to Pi.
6. Assistant text streams into the conversation smoothly.
7. Tool executions appear as structured cards.
8. The user can stop, steer, or queue a follow-up when supported.
9. Sessions can be created and switched.
10. Files and Git diffs can be inspected.
11. The integrated terminal works.
12. The renderer has no direct Node.js access.
13. Tests pass.
14. The application can be packaged for the current operating system.
15. The README explains setup, Pi authentication, architecture, limitations, development, testing, and packaging.

## Working behavior

Do not merely provide an architecture plan.

Create the files, install dependencies, run the application, execute tests, inspect failures, and correct them.

Before using a Pi SDK symbol, verify it against the current documentation or installed package types.

Do not fabricate successful runtime integration. When Pi authentication or a provider credential prevents a live model response, still verify runtime initialization and document the exact manual authentication step required.

Keep a short implementation log in `BUILD_NOTES.md` containing:

* completed phases
* important architecture decisions
* current limitations
* manual verification steps
* unresolved Pi API discrepancies

Begin by inspecting the repository. If it is empty, initialize the application and start Phase 1 immediately.
