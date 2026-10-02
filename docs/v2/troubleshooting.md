# V2 candidate troubleshooting

Start with [candidate status](current-status.md), [setup](quickstart.md), and [security and limits](security-and-limits.md). Preserve the exact candidate commit, actual Node/OS/architecture, redacted error, exit status and source of any package. A past M5 receipt or an old checked box does not establish the current result.

## Desktop or companion will not start

**`--new-instance` conflicts with an owner.** A separate Chromium profile still resolves to the same canonical Fate data root. The competing core is refused. Use **File → New Window** when you need a synced view of the running session. Independent shared-data runtimes need the unresolved ownership implementation; do not remove locks or silently switch to empty profiles.

**The launcher asks for `fate-server` or Node.** Server convenience modes require the separately installed companion and Node 22.19+. Verify the actual installed package and runtime. Normal desktop mode does not require this companion. Do not substitute Electron run-as-Node or assume a source checkout is a complete installed package.

**The profile is unavailable or cannot be initialized.** Check the selected profile, existing descriptor, private ownership/permissions and registered workspace. Initialization does not overwrite existing files. `web` creates only a genuinely missing profile; it refuses corruption and mismatched workspace/port settings. Use the host-local `doctor` command from [setup](quickstart.md) for observation, not repair.

**Native state will not open.** Missing, incompatible, corrupt or uncertain retained native state blocks startup. Do not select legacy storage as an automatic fallback, delete review records, or remove SQLite sidecars. Preserve state and use the stopped-owner [migration](migration-cli.md) or [workflow review](native-workflow-review.md) procedure appropriate to the exact candidate.

## Browser login or controls fail

**No web page in the package.** A `--without-web` archive intentionally omits browser assets. `serve` is the authenticated server mode; `web` additionally serves the built web entry and opens the login page. Use an exact reviewed web-enabled package; an old successful source web build is not package acceptance.

**One-time code is rejected.** It may be expired, already used or from another profile. Generate a fresh code on the running execution host and enter it only in that host's login form. Noninteractive issuance requires a new private `--out-file`. Do not paste codes into a URL or include them in diagnostics. Repeated failures are rate-limited.

**Workspace is visible but actions are disabled.** Confirm connection/snapshot readiness, the selected workspace/session, current control lease, advertised capability and permission. New clients are observers. CLI profiles start read-only. Control cannot raise the host cap or enable unsupported features. Do not infer provider readiness from listener health.

**Permission reduction failed.** This is a known candidate integration gap: the selector currently sends reductions to an increase-only challenge route. A failed request has not reduced authority. Preserve the refusal and wait for the reviewed implementation; do not claim success or bypass the guard.

**A previously sent action has no clear result.** Keep its original request identity and inspect the original status and observable effects. A fresh-ID resend can duplicate an effect. Reconnecting, claiming control or restarting does not resolve uncertainty automatically.

**Old messages or Monitor data are absent.** Unsupported Monitor must be shown as unavailable. Snapshot paging is implemented, but the separate older-history service is not yet connected to a production client. Do not interpret either case as proof that no work or history exists.

## Remote connection fails

**SSH host verification is required.** Compare the host-key fingerprint with the operator through a trusted channel and use the system SSH tools to establish the known-host record. A changed key requires investigation. Fate deliberately uses strict checking and does not accept unknown keys or password prompts.

**Authentication failed.** Check the desktop's SSH alias/key/agent separately from the scoped Fate client credential. The native picker expects the Fate client file, never the SSH private key, provider key or server owner credential. File replacement or unsafe permissions can invalidate a previously approved reference.

**Local port collision.** Choose an unused configured local port or let the native tunnel select one. Do not relax Host/Origin checks or introduce permissive CORS. A tunneled browser would need its exact origin approved separately; it is not configured by the native desktop setup.

**Server or workspace identity changed.** Stop and verify the actual host ID, workspace ID/generation and protocol with the operator. Do not silently update trust pins. A reachable port is not enough, and failure must not launch a local fallback agent.

**Connection was lost while work was running.** The UI shows last-known state. The independent host may still be running and billing a provider. Reconnect and inspect status; request cancellation through the supported route if needed, then wait for actual settlement. Closing the desktop or tunnel alone does not stop that work.

## Service, verification or release result is incomplete

**The host stops at logout.** Inspect the real non-root user-service/session policy with the operator. A detached idle process or root container is not service/logout validation. Enabling linger is a separate host-policy decision; Fate does not do it automatically.

**Windows verifier reports ownership unconfirmed.** This is intentional: its current supervisor has no validated Job Object receipt for the whole child tree. Direct-child exit or a successful `taskkill` is insufficient. Retain fixtures; missing supervision must be implemented and verified before this gate can pass.

**Source checks pass but release readiness does not.** The verifier reports distinct manual/native gates and never declares a release ready. The current V2 workflow is manual Linux source verification, not the Node artifact/PTY platform matrix. Package closure, real SSH/service behavior, native-Durable end-to-end operation and final human acceptance remain separate.

**An old M5 note reports a missing dependency license or narrow tabs.** Those notes preserve their original checkpoint. Current source removes the old scrollbar dependency and repairs the narrow-tab presentation issue. That does not repair an already built old artifact or replace current exact-artifact/native validation. See [current status](current-status.md).
