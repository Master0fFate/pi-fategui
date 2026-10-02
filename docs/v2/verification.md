# Verify a v2 source candidate

The verifier is a source-check orchestrator. It does not accept a release or certify
another machine. Use the repository's pinned pnpm version and frozen dependencies.
Run `pnpm verify:v2 --scope core --plan` to inspect the exact command list without
starting checks. Run `pnpm verify:v2 --scope core` for type, boundary, V2, contract,
main/renderer unit, JavaScript bundle, headless smoke and numeric-loopback network
checks. Unit workers install their network guard before application imports.
Guards and private test homes are defense in depth, not a hostile-code sandbox.

`--scope browser` adds actual browser workflows and requires the matching already
installed Chromium test dependency. `--scope desktop` also adds actual Electron
workflows; Linux desktop checks use only a local X11 display or a validated owned
Wayland socket. A relative Wayland name is resolved before replacing the runtime
directory. Display authorization files are referenced locally, never copied into
test homes. Remote X11 displays are rejected.

The default scope is `full`. Source gates can pass while the result still reports
manual gates pending and exits 2. The historical browser-smoke gate, real approved
SSH host, native platform matrix, distribution notices and human acceptance remain
separate. Artifact creation additionally requires explicit `--artifacts`; inspect
its plan and resolve the distribution notice and target-platform gates first. No selected scope
reports `releaseReady: true`.

Each gate uses a new private HOME/data/temp environment, fixed argument arrays,
and explicit PID/start/finish receipts. Git source inventory also runs with a
scrubbed environment and filesystem monitor disabled. Source changes during the
run fail verification. Interruptions are sticky: a child that handles a signal
and exits zero does not turn cancellation into a pass. Failed or unconfirmed roots
are retained. POSIX gates own a process group; deliberately escaping that group is
outside this cooperative supervisor. The Windows supervisor currently cannot
prove whole-tree settlement, so it reports unconfirmed and retains fixtures rather
than certifying a direct child exit. A real Windows Job Object implementation and
native validation are required before this orchestrator can pass there.

`.github/workflows/v2-server.yml` is manual-only and prepares Linux x64 source
verification. It leaves the existing desktop workflow unchanged, creates no
application installers/packages/releases, and uploads no private profiles or
failure roots. Its optional browser step is separately reported. The workflow is
not evidence of a successful hosted run; consult the run for the exact commit.
