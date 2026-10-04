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
outside this cooperative supervisor. On Windows 10+/Server 2016+, the standalone
supervisor uses an unnamed kill-on-close Job Object and atomic create-time job
membership. It permits only the three standard stream handles to be inherited.
Root exit alone is insufficient: settlement requires a zero-active-process job
receipt and a successful supervisor close. Surviving descendants are stopped by
job handle, reported as a failed gate, and never selected by PID or process name.
Missing/invalid receipts, unsupported job APIs, or local PowerShell compilation
policy failures fail closed. No policy overrides, elevation or app imports are
used. The callback exposes PID and standard streams, not a Node IPC channel.
Cold OS PowerShell/C# startup has a separate bounded 90-second deadline. The
optional execution timeout begins after the suspended child is acknowledged and
resumed; it does not charge compilation time to the test's execution budget.

The helper's dependency-free synthetic suite is
`node --test scripts/windows-verification-process.node-test.mjs`. Windows runtime cases
are skipped on other systems; a Linux source/test pass is not Windows evidence.
The exact candidate still requires a real native Windows test run and the user's
separate final platform acceptance. These checks do not change release readiness.

`.github/workflows/v2-server.yml` runs for pull requests into `main` that touch
the product, and manually. It runs Linux x64 source verification. A pull
request always adds the browser workflows and the package jobs; a manual run
selects them with the `browser` and `packages` inputs. The package jobs build
independent Linux x64 Node packages with and without native PTY. Each job
builds and smokes its own extracted artifact before uploading only its archive
and checksum. The manifest binds the commit and actual source-byte digest;
source changes during packaging fail the build. Private profiles and failure
roots are never uploaded. The desktop workflow is unchanged. No release,
installer publication or deployment occurs.

Workflow source is not evidence of a successful hosted run; consult the run for
the exact commit and package variant. The local headless smoke exercises both
legacy and explicit native-Durable profiles with one artifact build; it also
checks ordinary stopped-owner restart without automatically resuming work.

The browser suite runs the same scenarios in `legacy-json` and `native-durable`
projects. Each boot verifies the selected backend and actual SQLite presence;
restart omits the initial selector. Host fixture setup/teardown has its own
75-second budget, separate from the unchanged 90-second user-workflow budget;
the individual Windows boot limit remains 60 seconds. This accommodates two
real cold boots in the restart scenario without weakening its assertions.

`pnpm test:contract` includes the common positive/negative IPC/HTTP table, not
only the earlier IPC characterization. These fixtures exercise real adapters
and journals, but are not a replacement for actual Electron and HTTP/WebSocket
runs.

`tests/v2/realTransportLoad.test.ts` measures real loopback pressure and native
PTY output. Windows ConPTY requires local pipes that the application test guard
intentionally rejects. A separate, credential-free native-I/O driver therefore
owns the real PTY; the Fate host keeps the unchanged network guard. The tests
require actual native start/output/exit and a matching driver-close receipt.
Proxy admission or a kill call is not exit proof. Its IPC hop, sanitized shell
environment and host-only memory figures are explicit measurement limits;
same-process/native artifact and long-duration leak evidence remain separate.

Electron screenshots use Playwright-owned per-test output directories. Tests
must not overwrite tracked screenshots or change the source identity they verify.

Windows adaptations keep every assertion. Link-refusal cases use a real file
symlink where the host grants that privilege and a directory junction
otherwise. Private-file checks read the live NTFS DACL, because mode bits carry
no meaning there, and a real other-user allow rule replaces `chmod`. Sidecar
fingerprints skip only the eight SQLite WAL-index lock bytes that Windows makes
unreadable while a connection is open. A poll that waits for native workflow
admission has an explicit budget for the live ACL helper processes.

The private test home contains `AppData\Local` and `AppData\Roaming`. Windows
resolves known folders from `USERPROFILE`; when they were missing the lookup
returned an empty path, and Windows PowerShell wrote its module cache into the
working directory. On a clean checkout that changed the verified source during
the run. `tests/v2/testInfrastructure.test.ts` now checks this.

The physical-pointer Electron case needs an unlocked interactive Windows
desktop. A locked session refuses the click and fails that case; no synthetic
click replaces it. `scripts/check-windows-tty.mjs` binds cancellation to the
typed operator error code, not to one exact message string.
`scripts/check-windows-launcher.mjs` adds a later `PATH` directory with a
second `node.exe` and companion shim; the launcher must start only the first.
It also runs every launch under an emulated stock-client script policy
(`Restricted`) and requires that the started application does not inherit the
launcher's own process policy. This emulation is not a clean-machine install.
