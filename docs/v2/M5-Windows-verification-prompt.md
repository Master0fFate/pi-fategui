# Copyable Windows verification prompt

Paste the following into the Windows continuation session. Keep the required Linux gates separate.

```text
Continue the M5 preparation on branch v2-preparation-linux of
https://github.com/Master0fFate/pi-fategui. Stop before T51.

Use a fresh checkout or worktree. Extract the delivered
pi-fategui-M5-updated-plans.zip into its root so plans/ is present.
The full plan/evidence pack is delivered separately from Git. Preserve
any older plans and dirty source before using an existing checkout.
Published code commit f43f7b5fb96b2ff9d50f761848e8d8ecf6aa7073 has the
same exact Git source tree as the tested local commit 1fac11899d324293db3ed83cf62f56ae296bf5f0.

Read plans/EXECUTOR.md, plans/ROADMAP.md, plans/progress.json,
plans/reports/M4-completion-gate.md and plans/reports/M5-completion-gate.md
first. Also read the T44–T50 reports, M5 source/check evidence, and
plans/DECISIONS.md's M5 continuation amendment.

M4 is accepted. M5 is NOT accepted. T44 is implemented pending native
Windows proof/review. Later cards contain preparation with unaccepted
prerequisites; do not activate or accept them out of order.

Use a real native Windows desktop and the supported Node version
(Node >=22.19.0). Use the declared pnpm version 11.17.0 if available.
Record exact OS, architecture, Node ABI, pnpm, commit and source hashes.
Use fresh temporary profiles/projects and the repository's isolated test
runners. Do not copy actual desktop/provider credentials or invoke a paid
provider. Do not edit SDK sources or add/expand SDK patches. Do not deploy,
install a remote service, publish a release or run the shutdown batch.

Run and preserve exit codes and complete logs for these commands:

git switch v2-preparation-linux
git pull --ff-only origin v2-preparation-linux
git rev-parse HEAD
node --version
pnpm --version
pnpm install --frozen-lockfile
py -3 plans/tools/planctl.py check
py -3 plans/tools/planctl.py next
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
pnpm test:e2e
pnpm package

Run builds sequentially: pnpm build cleans dist. Record missing platform
prerequisites as blockers. Do not weaken a guard, replace a native fixture
with a mock, skip a required case, or call an unavailable check passed.
package:server currently enables only Linux x64. It is not a Windows
server-package pass. Desktop pnpm package and its packaged smoke must run
on Windows; use the real package output rather than the Linux archive.

Required native/manual checks:
1. Invoke the installed fate.cmd from cmd.exe AND PowerShell with ordinary
   project paths, spaces, Unicode, quotes, shell metacharacters, --,
   --project, --new-instance and a directory named serve. Exercise the
   existing primary-instance forwarding. Invalid/duplicate flags and
   token-like arguments must fail before side effects. Check Windows
   command-line quoting, normal execution policy, and argument fidelity.
   The unsigned PowerShell wrapper and normal npm/pnpm global .cmd shim
   location are unresolved native concerns. Verify both actual layouts;
   do not assume ../dist/cli from the shim is the package root.
2. Test server modes with Node/companion missing. The setup error must be
   explicit, with no install/download and no Electron run-as-Node fallback.
   Verify delegation to a separately installed supported Node companion.
3. Verify private profile/owner/client files using actual Windows ACLs.
   Browser sessions and client credentials must be refused by /api/admin.
   No owner secret or selected credential path/token may reach renderer,
   clipboard, transport diagnostics or ordinary logs. Test private-file
   output failure and revocation using synthetic fixture access only.
4. Exercise hidden TTY input and Ctrl+C with the real terminal. Test login
   cancellation/late settlement/provider errors with the supported fake
   adapter seam. No live/paid provider request or real key transfer.
5. In the actual desktop, add an SSH profile through the native picker.
   Verify explicit host-identity trust, canceled picker, document/window
   replacement, replaced private file, invalid alias/port, save failure,
   reconnect and selected-host persistence. Do not expose private paths.
6. Against a separately preinstalled test host and REAL OpenSSH, verify
   known-key success, unknown/changed host-key refusal, wrong-key refusal,
   local port collision, strict forwarding arguments, cancel/rapid-switch
   fences, and owned-child cleanup. No remote command, deployment,
   agent forwarding or user SSH config/known_hosts overwrite.
7. Verify authenticated server identity/protocol/epoch, journal readiness,
   provider-auth-required distinct from transport connection, workspace
   identity/generation pinning and no local fallback after failure. Check
   unavailable remote preserves the selected host and blocks mutations.

Unresolved Linux/remote gates (Windows does not substitute for them):
- The final Linux archive is server-only with native PTY, built using
  --without-web. The web-enabled package is blocked by unavailable full
  published license text for react-remove-scroll-bar@2.3.8. Preserve the
  exact physical web/font dependency map and close that gate with verified
  source evidence. Also attribute the injected Vite/Rolldown virtual
  helpers and unowned rolldown-runtime asset to their exact licenses;
  200 physical owners does not establish complete web notice coverage. Do not silently omit notices or call the web artifact verified.
- The recorded real sshd preflight failed 255: missing /run/sshd. Provision
  a supported disposable fixture through the host operator, outside this
  task's automatic actions. Use test-only keys and known_hosts.
- pnpm test:remote is currently an honest failing preflight/activation
  guard, NOT a complete T50 test suite. Implement the cases in
  tests/remote/requiredCases.ts after prerequisite acceptance, using the
  packaged production Node server plus a separate test-only Pi adapter
  composition. Never put the fake adapter in the production package.
- Prove remote sentinel bytes/Git diff and unchanged client sentinel;
  active run survives tunnel kill with same host PID; reconnect returns
  actual result and original invocation count; separately kill host after
  admitted effect but before response, then show unknown/interrupted
  without replay. Also prove security failures and stalled stop retains
  profile/checkout locks until actual settlement. Preserve PID, bytes,
  counts, hashes, exit codes and redacted logs.
- Run the mandatory non-root Linux systemd user-service gate. Inspect the
  supplied unit. Verify independent PID/work after client loss, settled
  stop, restart uncertainty/no replay and actual logout/session policy.
  The current environment has no non-root user-service session. A bare
  production process check is not a service/logout pass.

Fix real failures within T44–T50. Preserve failed evidence. Request the
required independent security/credential/remote reviews. Update per-card
reports, progress, the completion gate and this prompt. Keep acceptance
in prerequisite order. Do not mark M5 accepted while ANY required gate is
pending, failed or unexecuted. Do not start T51.
```
