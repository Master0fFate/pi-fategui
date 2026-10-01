# T50 external real OpenSSH fixture (prepared, NOT accepted)

`pnpm test:remote` now contains executable workflows, not an sshd preflight followed by an unconditional pending exception. **Nothing in this directory proves T48/T49/T50 acceptance.** The current Windows machine has no usable local sshd/non-root Linux user-service fixture. Do not activate here. Missing fixture/approval exits 1, never skips passing cases.

## Safety and ownership

Only an **already provisioned, disposable, non-root Linux x64 host** with a real OpenSSH daemon and Node >=22.19 is supported. No daemon setup, service install, sudo, key authorization changes, deployment, dependency installation, credential copying, provider requests, or package/release builds are performed by the runner. The operator must separately review prerequisites and authorize activation. SSH does not bootstrap a server or install anything.

The main data path is real OpenSSH `-N -L`, strict pinned known_hosts, batch key-only authentication, no agent/config discovery, no password/interactive fallback, no TTY/agent forwarding, and exit-on-forward-failure. Separate, explicitly authorized fixture-control SSH exec calls use the same checks to operate *only* the disposable fixture. They are not part of the production client connection contract. Never point the controller at a real checkout/home/profile/service. The host is independently owned by a detached fixture supervisor, **not** by the forwarding SSH process. This is NOT evidence of user-service survival after logout (T49).

## Two distinct compositions

1. `production-proof.mjs` dynamically imports the **preinstalled packaged** `dist/server/main.js` under package-only resolution and outbound-network guards. It validates the entire checksum/file set and internal link manifest, forbids desktop module imports, starts the packaged non-listening core, proves idle runtime/provider dormancy and unchanged sentinel bytes, then stops its own disposable core. Its evidence is labeled `packaged-production-idle`. It is not a packaged production network/UI workflow or a native/user-service gate.
2. `host.ts`, built with `vite.remote-test.config.ts`, is a **separate test-only** composition. It injects the existing typed `FakePiSdkAdapter` through `startAuthenticatedNodeServerWithFactory` / `createFateCore`. Fate HTTP/auth/tickets/journal/admission/workspace/checkout locks/recovery and Pi SDK runtime/session-manager objects remain real. Execution is deterministic, credential-free, and provider calls are blocked by the adapter. Actual emitted assistant messages are recorded through the SDK's public `SessionManager.appendMessage` API so the authenticated reconnect snapshot contains the original message. No SDK source or patch changes. The test composition is never a production entry, selector, package member, or acceptance substitute.

The dedicated build configuration outputs only `tests/remote/.built/host.mjs`. When **separately authorized on a prepared fixture**, source bundling is `pnpm exec vite build --config vite.remote-test.config.ts`. No build/install/deploy is part of `test:remote`. Do not run a package/executable/release build to supply the fixture. The fixture must already have the built host, its exact matching SDK dependencies, the existing independent production package, and `controller.mjs`, `fixture-lib.mjs`, `production-proof.mjs`. External test-host dependencies must not resolve from a real user installation. Leave all SDK/version/patch files untouched.

## Explicit configuration

Provisioning these files is the fixture owner's work, outside the runner. Credentials must already be fixture-only. Only references are read; private keys are never copied. Use a fresh private evidence directory for each run and a fresh private fixture root each time; preparation refuses to overwrite prior cases.

Windows storage must have an actually verified NTFS owner/DACL: only the current user, SYSTEM, and local Administrators may have Allow entries. This includes fixture JSON, existing fixture SSH key and known_hosts, the newly created evidence root, generated negative-test files, and a final recursive evidence-tree check. Mode 0700/0600 is NOT Windows ACL evidence. Choose a new evidence directory beneath an already restricted parent; broad inherited TEMP/Users/Everyone ACLs are refused. The runner uses read-only `Get-Acl`/SID/reparse checks and never repairs or widens an operator path. POSIX paths retain private-mode checks. No real credential bytes are copied.

Client JSON (absolute client paths; remote paths are absolute Linux paths):

```json
{
  "host": "disposable.example.invalid", "user": "t50", "sshPort": 2222,
  "identityFile": "C:\\fixture\\fixture-only-key",
  "knownHostsFile": "C:\\fixture\\private_known_hosts",
  "reviewedBindingFile": "C:\\fixture\\independently-reviewed-binding.json",
  "remoteBindingFile": "/srv/t50/independently-reviewed-binding.json",
  "remoteNode": "/opt/node/bin/node",
  "remoteController": "/srv/t50/controller.mjs",
  "remoteConfig": "/srv/t50/fixture.json",
  "hostPort": 49282, "localPort": 49281,
  "disposable": true, "preinstalled": true
}
```

Remote JSON (owned by the disposable account, NOT a request input):

```json
{
  "root": "/srv/t50/disposable-run-001",
  "node": "/opt/node/bin/node",
  "hostEntry": "/srv/t50/harness/host.mjs",
  "productionEntry": "/srv/t50/production-proof.mjs",
  "productionRoot": "/srv/t50/preinstalled-production-package",
  "reviewedBindingFile": "/srv/t50/independently-reviewed-binding.json",
  "hostPort": 49282, "localPort": 49281,
  "allowCrashLockQuarantine": true
}
```

`root` must already exist, be owned by the non-root fixture user, mode 0700, canonical and not a symlink, not `/` or the account's real home. Its `.fate-t50-disposable` marker must contain exactly `T50 disposable preinstalled fixture\n`. The fixture must permit loopback local forwarding and isolated fixture-only control exec. Ports must be unused initially, `hostPort < 65535` (the contender uses the next port). No fixture account credentials are generated/authorized by the runner. Only a fresh **wrong** test key and a conflicting public known_hosts entry are generated in the private local evidence directory for negative tests. The actual server key/config is never changed; the changed-key case proves rejection of a conflicting pin for the same actual SSH endpoint.

### Independently reviewed expected artifact binding (mandatory)

The two binding paths above reference the SAME preinstalled reviewed JSON bytes (no copying/upload by the runner). Its schema is `{version:1, reviewId:<named independent review>, sourceBase:<40-hex reviewed source base>, files:[{role,path,sha256}], dependencies:{root,files:[{path,sha256}],links:[{path,target}]}}`. The nine mandatory absolute-file roles are `node`, `config`, `controller`, `controllerHelper` (`fixture-lib.mjs`), `processHelper` (`fixture-process.mjs`), `bindingHelper` (`fixture-binding.mjs`), `host` (separate test bundle), `productionProbe`, and `productionSums` (the candidate package's exact `SHA256SUMS`). Hashes MUST come from the independently reviewed CURRENT candidate artifacts, not whichever stale self-consistent package happens to be on the host. Missing expected binding refuses; the runner never generates review/acceptance from observed host bytes.

`dependencies.root` must be the separate host bundle's physical adjacent `node_modules`. `dependencies.files` is the COMPLETE externally reviewed regular-file inventory, with POSIX relative paths and exact hashes; `links` is the complete reviewed internal link inventory. This binds actual SDK/PiAI/MCP/ws/node-pty dependency bytes, not merely package versions or package.json files. Extra/changed files, external symlinks, missing inventory, or module resolution outside the reviewed tree refuse. Package checksum self-consistency is checked separately AFTER its SHA256SUMS bytes match the reviewed expected digest.

Before loading the remote controller, the runner executes only fixed inline read-only Node/crypto verification over real SSH. It checks the remote binding JSON against the local reviewed digest, all required artifact digests, the full dependency inventory/resolution and config/path relationships. Each controller invocation revalidates this binding, and the controller receives and rechecks the independently expected digest before starting a host, contender or production probe. Verification does not install/provision/deploy/build/copy credentials or load SDK/provider code. An absent external reviewed manifest is a blocker, not a replaced passing gate. `fixture-binding.mjs` is also preinstalled alongside the controller/helper.

The source checkout's actual `plans/progress.json` must independently record T48 and T49 as accepted with available nonempty reports and reviewer records; it is read-only and hashes are preserved. Neither the manifest nor the approval phrase bypasses this prerequisite. Missing/unaccepted gates refuse BEFORE SSH or evidence-directory creation.

`allowCrashLockQuarantine` is a narrow, explicit fixture-owner authorization. Fate never reclaims locks by PID/heartbeat. After the crash barrier and the supervisor's actual SIGKILL exit, the controller verifies that the exact process no longer exists, that all captured lock paths stay inside that case's private home, and that every complete owner record/token is unchanged. Only then does the explicit `recover-crash-locks` control action **rename** those exact dead fixture lock directories into a preserved quarantine before restart. No locks/stores are deleted. If authorization/death/token/path proof is missing or the PID was reused, restart remains safely blocked. This action is NEVER used for the live/stalled case and is not a production auto-recovery API.

Only after explicit separate activation authorization (these are examples, not commands executed in source preparation):

```sh
FATE_T50_ACTIVATION_APPROVAL='T50 external disposable fixture explicitly approved' \
  node scripts/test-remote.mjs --fixture /absolute/client-fixture.json \
  --evidence /absolute/new-evidence-directory --activate
```

Alternative executable Node test entry: set `FATE_T50_FIXTURE_JSON`, `FATE_T50_EVIDENCE_ROOT`, and the same activation approval, then `node --test tests/remote/remoteWorkspace.test.mjs`. Absent fixture fails; it is not a skipped passing integration test. The approval phrase is an operator safety acknowledgement, **not** an authentication mechanism or a gate acceptance label. Independent review of T48/T49 and the current amendment remains required; the runner never edits plans/status.

## Prepared assertions (not executed remotely here)

- Three **separate** Git repositories/profiles/cumulative invocation ledgers: `tunnel`, `crash`, `stall`. Remote preimage/effect bytes are base64-preserved, real Git diff and HEAD are recorded, and a client-only sentinel is byte-identical after each workflow.
- Tunnel case: admitted prompt edits a real remote sentinel, remains active at a deterministic settlement barrier, loses its actual SSH forwarding process, retains the exact Linux host PID/start identity and invocation count one, finishes with the tunnel absent, then reconnects using the ORIGINAL durable browser cookie/CSRF/principal (validated via bounded auth/session GET), obtains a NEW WS ticket without rebootstrap, and reads the original request's journal receipt and original SDK assistant message through the real authenticated HTTP snapshot. A separately bootstrapped distinct principal must be refused with FORBIDDEN for that original status. No resubmission.
- Crash case: a test-only wrapper holds the **real runtime result** after admission/edit and before journal settlement/HTTP response. It waits for persisted adapter invocation evidence and recovery flush. The runner verifies the ORIGINAL request's `admitted` record, effect bytes/diff, no released response, then separately SIGKILLs that host. Restart uses the same durable profile/ledger and ORIGINAL browser cookie/CSRF/principal, but a different actual PID/start identity and fresh WS ticket. No auth ownership check is weakened; distinct-principal status remains FORBIDDEN. The original request status is `outcome_unknown`, cold lifecycle is interrupted/unknown, and cumulative persisted prompt count remains exactly one. Neither status reconciliation nor host restart resends any prompt.
- Prepared real OpenSSH assertions require refusal of an unknown host key, wrong identity key, conflicting host pin, and an occupied local forward port. Fate refuses anonymous HTTP and protocol 999 without another invocation. These are diagnostic-specific failures, not arbitrary nonzero exits treated as success.
- Stall case: cancellation/settlement barriers stay held while `stop()` returns incomplete. Both profile lock and checkout ownership remain; independently launched same-profile and separate-profile/same-checkout contenders must fail with ownership diagnostics, not timeouts. Releasing the barrier proves eventual genuine settlement. Cancellation refusal may keep ownership retained even after settlement; the harness does not remove locks or falsely assert cleanup.

## Evidence and safe unfinished results

`evidence.jsonl` records requests/statuses/results, original request/session/workspace/host/epoch IDs, actual host and tunnel PIDs/start identities, bytes/diffs, cumulative invocation ledger, cold recovery/lifecycle/journal records, strict negative results, actual private-storage probe outputs/exits, and cleanup outcomes. The append/fsync ledger helper creates a real empty baseline before composition even with zero invocations, and never truncates that baseline on restart. Every local process has full (not truncated-tail) redacted stdout/stderr plus actual exit code/signal. Output logs are streamed live with UTF-8 handling, token-boundary carry and backpressure; all actual credential prefixes fo1/fc1/fb1/fs1/ft1/**fx1** and registered secrets are redacted, including nested records. The in-memory protocol capture is bounded at 4 MiB; overflow fails the case while complete redacted file logs remain intact. Deadlines require actual completion after bounded SIGTERM/SIGKILL attempts, not signal success: timed-out commands fail even if they later exit 0, and unproved exit/log settlement explicitly retains ownership/fails. Controller production/contender probes use the same mechanism. Windows tunnel start identity comes from `Get-Process.StartTime`; Linux uses `/proc/<pid>/stat`. The independently running supervisor records **actual** host child exit code/signal and its own PID/start identity. A SIGKILL exit has code `null`, signal `SIGKILL`; no fabricated numeric exit. Fixture host logs and ledgers remain on the host and are collected to the local evidence JSON before/after owned cleanup. Credentials/bootstrap/cookie/CSRF/tickets are redacted, not printed as evidence. All evidence is private (mode 0600 under a 0700 directory on POSIX).

Failures leave `failed-unfinished` evidence and exit 1 (if private storage itself is unavailable, refusal occurs before writes and stderr includes the actual ACL probe exit/output). Case ownership is registered before host readiness, forward readiness, and OS identity checks. Startup failure still reaches cleanup; each socket/tunnel/log/remote-host/final-log step is attempted independently. Any cleanup failure, including failed failure-evidence writes, propagates failure and prevents `case-complete`/`workflow-complete` or exit 0. Spawn errors are observed immediately to prevent unhandled rejection while readiness runs, but the original failure remains rejected to callers and the actual close/spawn-error records are persisted. Cleanup kills only the exact verified own PID/start identity; it preserves repositories, profiles, locks, ledger, and logs. It never deletes uncertain stores, accepts a gate, shuts down a machine/service, or replays a request. The sole ownership transition is the explicitly authorized, verified-death crash-fixture lock quarantine described above. An absent-host refusal is not a workflow pass. Review the complete redacted logs and every `case-complete`/`workflow-complete` record; a partial run is never full acceptance.

## Preparation checks (no fixture activation)

`node --test tests/remote/fixture-lib.test.mjs tests/remote/fixture-repair.test.mjs tests/remote/fixture-challenge.test.mjs tests/remote/fixture-path.test.mjs` checks strict arguments, validation, activation refusal, full redacted log retention/actual process exits, actual empty-ledger append/restart bytes, cleanup failure propagation, delayed spawn-error observation, actual ancestor-junction refusal, and read-only Windows ACL decisions against an independent actual `Get-Acl` query. ACL outcomes depend on the actual scratch parent, not the machine alone: parent runs `67-remote-helpers` and `72-final-remote-helpers`, beneath an owner-only test root, independently observed restricted ACLs and validator exit 0. The fresh review's separate worktree scratch paths had broad inheritance and correctly produced validator exit 4; its exact independent query is in `fresh-review/helper-tests.log`. Both outcomes are retained separately. The validator never provisions/repairs ACLs or reads a real credential file; no provider/SDK/SSH host is invoked. `node --check` checks `.mjs` syntax. Typecheck is static. These checks do NOT run SSH, remote hosts, native suites, production probes, or remote workflow acceptance. The real fixture tests remain unexecuted until a supported preinstalled fixture and separate permission are supplied.
