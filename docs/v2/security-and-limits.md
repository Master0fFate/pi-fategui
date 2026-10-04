# V2 security and limits

**Candidate guidance, not a security certification.** Read [current status](current-status.md) for implementation gaps and pending platform gates. The host account and installed Fate code are trusted. Fate does not isolate you from a malicious program running as the same OS user.

## Host and credential boundaries

- The V2 server binds numeric IPv4 loopback, `127.0.0.1`. There is no public-bind or no-auth setup mode. HTTP/WS routes enforce their authentication and Host/Origin policy; an SSH tunnel does not remove it.
- Local desktop does not start the V2 API listener. Existing local browser/media proxy listeners have separate policies; this is not a claim that desktop opens no sockets.
- The server owner credential is for host-local administration. Client credentials have explicit workspace scope. Provider credentials stay on the execution host. Browser cookies and ordinary client keys do not authorize owner administration.
- Bootstrap codes are one-use, expire after five minutes, and travel in a POST body. Never put credentials in URLs, command lines, project files or public logs. Private output files must be new files in an existing private directory; unsafe paths, aliases or permissions are refused.
- The loopback HTTP cookie is HttpOnly and SameSite=Strict, but cannot provide the Secure-cookie protection of HTTPS. CSRF/Origin checks remain necessary. This is not hostile same-user isolation or public-hosting support.
- Remote paths remain remote. The network API exposes registered workspace data, not an arbitrary host filesystem or a static workspace web root. A remote file path must not be handed to the client's native file-open operation.

Prompts and chosen context go to the configured provider. Other enabled network features also use the network. Local-first does not mean offline-only. Git worktrees isolate checkouts; they are not security sandboxes.

## Control, permission and shared selection

Authentication lets a scoped client observe a workspace. Explicit control grants a bounded, server-owned lease for supported mutations. Control does not grant full access, change host trust or raise the host permission maximum. Stale control/session/workspace generations are refused.

New trusted local sessions default to Edit files. CLI-created server profiles start with a read-only maximum. Valid saved permissions restore only within current host policy; missing grants never imply full access. Corrupt/unreadable permission storage and incomplete escalation writes inhibit execution. A higher grant must be saved before it takes effect.

The network permission selector uses the same scoped, one-use confirmation for reductions and elevations. A successful current response or the original durable receipt is required before treating a reduction as applied. Stale control, selection or permission state cannot confirm a pending change. Above-cap destinations remain denied, even when lower than the previous grant. Do not bypass confirmation or alter grant files while an owner is live.

Selected session is shared within a workspace. Another controller's selection changes that shared target; it is not a private session selection for each browser tab. Refresh and confirm the visible target after a change. Capability labels describe availability, not authority, and the backend still validates requests.

The manual terminal is a human-controlled, unsandboxed shell with the execution host account's authority. Agent Read only/Edit files policy and workspace registration do not sandbox shell commands. Browser support requires explicit host initialization with `--manual-terminal --accept-unsandboxed-shell` and an Edit or Full access host maximum, a supported client, current workspace control, and effective non-read-only permission. The UI requires a warning confirmation before creating a shell. Input is not replayed after connection loss; control/scope loss closes that client's terminal. Closing a terminal does not undo commands or stop detached processes. Native remote-desktop terminal remains unsupported, with no local fallback. Including `node-pty` in a package alone does not enable this feature; real native/artifact verification remains a separate gate.

## Disconnects, uncertain commands and recovery

| Situation | How to interpret it |
| :-- | :-- |
| Lost browser/desktop connection | Displayed work is last-known state, not proof the host stopped. Admitted work may continue and incur charges. |
| Reconnection | Authentication, identity/epoch, workspace/session state and a fresh snapshot must agree before new control/mutations. |
| Missing acknowledgment | The outcome may be unknown. Review the original request/status and actual effects; do not send the same operation with a fresh request ID merely to retry it. |
| Abort requested | A cancellation request is not proof that a tool, SDK turn, process or checkout lease has settled. |
| Host crash, forced kill or power loss | Retain interrupted/unknown history. Startup must not silently replay prompts or external effects. |
| Recovered drafts, goals or workflows | Review retained state and authorize fresh work explicitly. A saved schedule or old goal must not bypass a retained uncertainty fence. |
| Storage failure or unconfirmed stop | Stop unsafe new admissions and retain ownership/evidence; never report success or clean cancellation solely from a timeout. |
| Host sleep/shutdown | No live execution until the host is running again. Durable records are persistence, not an always-on computer. |

Request deduplication, native task receipts and Durable resume facilities are not an exactly-once guarantee for external effects. A logical completion/cancellation record is not proof of physical settlement. GoalMax budget advice is not a hard mid-turn spending cap.

## Ownership and operator recovery

One owner must hold the canonical profile and relevant checkout authority. The current `--new-instance` Chromium slot does not supply a second safe shared-data owner. Do not delete locks, change data roots, or start an older binary to work around an owner conflict.

A lock whose owner process no longer exists on this host is recovered automatically at the next start. After a crash, a forced quit or a power loss the application starts again without operator action. The proof is the operating system's own report that the recorded process is gone. On Linux the boot identity, the PID namespace and the kernel start time of the process are also compared, so a restarted host and a reused PID are recognized.

A lock is never taken on a heartbeat or an age. It is also kept when its record names another host or platform, when the record is missing, unreadable or accompanied by an unknown entry, and when any process holds the recorded PID. Windows and macOS cannot tell a reused PID from the owner, so that case waits until the other process ends. A storage close that could not be confirmed marks the lock for review (`review-required.json`), and no later start recovers it. These cases remain an operator-only action after stopping and verifying all possible owners. `doctor` is observational and does not reclaim a lock.

Recovery needs a filesystem with hard links; without them a lock is kept. Windows and macOS do not compare a machine identity, so two machines with the same host name must not share a lock directory. A stop exactly between two file operations of a start or a recovery can leave a lock directory without a readable record; that directory is kept for an operator.

Use the version-matched [migration procedure](migration-cli.md) and [native workflow review](native-workflow-review.md), with the original plan/backup/source identities intact. Migration preserves original Pi sessions, Team history and worktrees. It does not copy provider credentials, import full-access authority or replay old work. Selecting `native-durable` does not perform that migration.

Rollback requires exclusive stopped ownership and compatible source/backup evidence. Never restore over a live runtime, erase changed candidate files to force a checksum match, or assume identical displayed application versions mean compatible storage. Reviewing UNKNOWN history retains that history; it does not turn the old graph into a safe retry.

## Deliberate scope limits

Remote native browser automation, rich network media, WSL management, automatic host deployment, public/TLS/multi-user hosting, independent selected sessions per client and a new TUI/provider engine are deferred. Ordinary network Git writes, saved Agents/Routines network parity and host-global settings/secret administration are unavailable. Saved-history paging is a separate named read available only when the host advertises `session.history`. Cursors are short-lived, one-use and bound to the client, workspace and selected-session revision. The host admits at most one history disk scan per client and 16 across the service; the reader retains one bounded page.

See the [capability/platform matrix](current-status.md#capability-matrix) before choosing a setup. Real SSH/service/package/platform validation, native CI and independent security review remain separate gates. Unresolved ownership design or failed automated gates cannot be supplied by a user walkthrough.
