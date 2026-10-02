# Historical M5 Linux handoff - preparation, not acceptance

> **Historical checkpoint. Do not execute this as the current handoff.** The record below retains its original commits, results and task scope. The `windows-m5-verification` and `v2-preparation-linux` branches were intentionally deleted. Current work is on `v2-native-pi-durable`; `main` and `backup/main-before-m4-02518314500b` are the other retained branches. Use [current candidate status](current-status.md) and [candidate setup](quickstart.md).
>
> The old narrow-tab issue has a current source repair, and the old scrollbar dependency has been removed from the current dependency graph. Neither updates old artifact receipts or establishes current platform/package acceptance. Historical counts and restrictions below remain attributed only to their original source checkpoints; missing older unpublished source is not recovered evidence.

Continue from the **source-only `windows-m5-verification` branch** in `Master0fFate/pi-fategui`, not main or the older Linux candidate. Check its exact remote commit against the separately delivered publication receipt. Its base is Linux work head `1ef706036ff62fd1be5f129851c102cac77db1ae`, which descends from accepted M4 `8b4f3ea7565375fd6d86a0d8950fcd9ffb6baebc`.

**M4 remains accepted. M5 is not accepted. Stop before T51.** macOS is outside this task. Do not turn preparation or a successful local test into ordered task acceptance.

## Do Windows and Linux need to run together?

Most work can run sequentially: Windows source fixes/rechecks, then Linux source regressions and host lifecycle checks. Linux does not need a GUI for server/OpenSSH/user-service validation.

Keep both machines available only for the actual **Windows native desktop to Linux SSH** gate: credential picker and replacement fences, host/workspace trust and pins, reconnect, unavailable-host routing and no local fallback. A text-only Linux session cannot certify the Windows picker or native desktop. An inaccessible/locked Windows desktop is not a passing native result.

## Required Linux environment

The operator must provide a disposable, reachable test host with:

- A normal **non-root** account and a real login/session policy, a functioning `systemd --user` manager and user bus. Record logout/linger policy; do not change it silently to get a pass. A root container with no user manager does not satisfy T49.
- Working, preinstalled real OpenSSH client/server and strict host-key verification. The earlier `/run/sshd` preflight failed; inspect the actual supported host rather than assuming that result is repaired. Host/daemon setup is an operator prerequisite, not authorization for the agent to deploy or install a service.
- Supported Node (at least 22.19.0), declared pnpm 11.17.0 or an explicitly recorded actual mismatch, Git, Python 3, required target-native toolchain/libraries and installed Playwright Chromium for applicable browser checks. Record Linux distribution, architecture and Node ABI.
- A private disposable checkout/project/home and test-only keys/access files, provisioned through approved host-local setup. Never copy desktop/provider credentials or overwrite the user's SSH config/known_hosts.
- For T50 activation, the **separately approved and already installed** reviewed production Node server artifact and separate test-only Pi composition required by [the fixture contract](../../tests/remote/fixtures/README.md). A historical archive does not establish that newer source was packaged/tested. If no current reviewed fixture exists, record the blocker; the current no-package/no-deployment instruction does not permit making one just to pass the gate.

No executable/installer/package/release build, deployment, service installation, paid-provider request, credential copying, SDK source edit/new or expanded SDK patch, machine shutdown or T51 is authorized. Only stop owned test processes. Retain private fixtures and ownership locks on unconfirmed child exit.

## Fresh checkout and separate plans

Preserve existing dirty source and ignored plans. Do not stash/reset/clean/force. Use a new directory. If unexpected source changes exist in the selected checkout, stop and report them.

```sh
git clone --no-tags --branch windows-m5-verification https://github.com/Master0fFate/pi-fategui.git pi-fategui-m5-linux-check
cd pi-fategui-m5-linux-check
git status --short --branch
git rev-parse HEAD
git merge-base --is-ancestor 8b4f3ea7565375fd6d86a0d8950fcd9ffb6baebc HEAD
git ls-files plans
node --version
pnpm --version
```

Require the expected published commit and no tracked `plans/`. **Git does not retrieve plans/evidence.** Obtain the updated private plans pack separately and extract its `plans/` folder into this fresh root; do not overwrite an older pack. Read `plans/EXECUTOR.md`, `ROADMAP.md`, `progress.json`, M4/M5 gates and T44-T50 reports before running work. Use the supplied pack's publication/source/check bindings; do not invent missing Linux evidence.

Install independently from the unchanged lockfile. Never reuse Windows `node_modules`, Windows native binaries or the earlier Linux native dependency tree:

```sh
pnpm install --frozen-lockfile
python3 plans/tools/planctl.py check
python3 plans/tools/planctl.py next
```

`next` remains T44 until an independent reviewer accepts its required evidence. Do not falsify that prerequisite to unlock a remote runner.

## Run and record checks

Use supported isolated runners, private homes and a disposable source copy for destructive JS builds. Run sequentially and preserve complete stdout/stderr, actual PID, exit/signal, versions and source hashes. Monitor long jobs in short intervals; do not use an opaque 90-minute tool timeout.

```sh
pnpm typecheck
pnpm check:boundaries
pnpm test:v2
pnpm test
pnpm build
pnpm build:cli
pnpm build:server
pnpm build:web
pnpm smoke:server
pnpm test:network
pnpm test:web
# Native Windows Electron/picker checks are recorded on Windows, not claimed here.
# pnpm package / package:server: NOT RUN under the current package prohibition.
```

`pnpm build` cleans output; do not run builds concurrently. A platform skip, missing native library, unavailable browser, failed fixture or expected refusal is not a product pass. Linux results must bind this newer source, not the supplied older server-only archive.

## Gates still requiring real evidence

The focused Windows passes cover the repaired341px tab boundary and stable owned-window native Close, not all UI/input conditions. Practical review also found a pre-existing narrower CSS conflict: at inspector widths259px or less, global label hiding and M3 icon hiding can leave blank tabs. It was source-confirmed, not live-tested in this increment. The native fixture can also sample stale DOM geometry before helper startup if the owned window changes size/DPI. Its trusted-close completion prevents a wrong target from being accepted, but stronger pre-input sample binding remains a follow-up. These findings are retained for a bounded later fix; the user's finish-transfer instruction does not turn them into passes.

1. **T44:** Installed Windows layouts, forwarding and `--new-instance`. Added Chromium slots still contend for the same canonical desktop owner. Preserve the documented separate-process/independent-runtime/shared-session behavior. A guard or a second window is not a complete repair. Empty independent profiles would change data semantics and need explicit approval; no credential/history migration is authorized.
2. **T45:** Map the actual Windows CLI/ACL/ConPTY and supported test-only provider seam evidence to the exact current source. No live provider is necessary. Preserve cancellation/late-settlement ownership.
3. **T46:** Exact full `react-remove-scroll-bar@2.3.8` terms remain unavailable. The demonstrated emitted Vite/Rolldown helper, HTML and mandatory notice-copy defects are repaired and separately audited; do not call that complete notice closure. Keep strict refusal, exact source provenance and protected dependency/patch inputs.
4. **T47-T48:** Real OpenSSH known/unknown/changed key, wrong authentication, local port collision, cancellation/rapid switch and owned-child cleanup; then actual Windows native chooser/document/window/private-file replacement, pinned host/workspace readiness, reconnect and no local fallback.
5. **T49:** Independently owned **non-root user service**, accepted active work through client loss, actual logout/session policy, settled stop and restart uncertainty. Idle child-process survival or `nohup` does not satisfy this gate.
6. **T50:** Review current executable external-fixture preparation and its prerequisite/activation guards. With actual accepted prerequisites and the approved preinstalled fixture, prove remote sentinel bytes/Git diff versus unchanged client bytes; kill the active tunnel only and retain the same host PID/work; reconnect to the original result/invocation count. In a **separate case**, kill the host after admitted effect before response, then show interrupted/unknown without replay. Include stalled-stop retained profile/checkout locks. Record actual PIDs, bytes, hashes, diffs, counts and observed exits. Local mocks/helper tests or a refused runner do not satisfy this gate.

Update reports and progress in dependency order, retaining failed/blocked evidence. Obtain independent review. Do not accept M5 or merge/push main while a required gate is open. The preparation branch and private evidence handoff preserve progress; they are not the checkpoint.

See [historical Linux evidence](M5-linux-preparation.md), [Windows verification instructions](M5-Windows-verification-prompt.md) and [host operation](remote-host-service.md). Keep archives, plans, private fixtures, credentials, logs and traces out of public Git history.
