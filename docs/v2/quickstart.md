# V2 candidate setup

**Read [candidate status](current-status.md) and [security and limits](security-and-limits.md) before installation.** V2 is a source candidate, not an accepted release. The procedures below reflect the implemented command grammar; their clean-fixture execution against the final candidate is pending. They are not package publication, migration or platform-acceptance receipts.

## Choose the execution host

- **Local desktop:** the installed desktop app owns Pi and your project on this computer. Normal local use does not require the Node companion.
- **Local web:** a separate Node companion owns the project and serves a loopback login page. Closing the browser does not stop the host.
- **Remote desktop:** the desktop connects through system OpenSSH to an already installed, independently running Node companion. Execution and provider credentials belong to the remote host.

The network client has fewer capabilities than local desktop. In particular, it has no native browser, file reveal, voice or network manual terminal, and ordinary Git writes and rich media transport are unavailable. Review the full [capability matrix](current-status.md#capability-matrix).

## Local desktop

Use the [desktop installation guide](../../README.md#get-started-in-60-seconds) for a published desktop build. An existing release download is not evidence that it contains this candidate. For source work, use [development instructions](../development.md) and record the selected commit and exact dependencies.

```sh
fate /absolute/path/to/project
```

Review project trust before Pi initializes. New trusted local sessions start in **Edit files**; valid saved grants restore only within the host limit. Unreadable or corrupt permission storage blocks execution. Full access remains an explicit unsandboxed grant.

Later ordinary `fate` launches forward to the running app. **File → New Window** opens a synced view. `--new-instance` requests a separate Chromium slot, but another live core owning the same canonical Fate data root prevents startup. Do not use it as a guaranteed independent shared-data runtime or bypass the lock. See [sessions and processes](../sessions-and-processes.md).

Pi 1.0 packages are present, but fresh unspecified profiles still select legacy storage. Use the [rollout explanation](current-status.md#pi-10-and-durable-rollout) before selecting native storage or reviewing migration. A flag alone does not convert existing data.

## Node companion prerequisites

The independent companion requires **Node 22.19 or later**; its target runtime must also support the selected native SQLite/Durable dependencies. Development uses **pnpm 11.17.0** and the frozen lockfile. Node and Electron native-module builds are separate.

The server package builder currently enables **Linux x64 only**. Use an explicitly supplied, reviewed package for the chosen commit; verify its manifest, checksums, internal-link inventory, notices and target-native results. No accepted current V2 download is established by this guide. Follow the [package guide](../../build/server-package/README.md); a server-only `--without-web` archive cannot serve the web UI. Do not reuse a desktop installation or Electron-rebuilt PTY as a Node package.

After the companion is installed with its command on PATH, use `fate-server` directly. For an extracted package, invoke its CLI entry with Node instead. For example:

```sh
node "/absolute/path/Fate server/dist/cli/main.js" help
```

Replace `help` with the same subcommand and arguments shown after `fate-server` below.

The desktop launcher delegates `init`, `serve`, `web`/`--web`, `provider`, `auth-code`, `access-key` and `doctor` to the installed companion. It does not download one or use Electron as a hidden Node server. Use direct `fate-server` commands for migration and workflow review; do not assume every Node command is a desktop-launcher alias.

## Local web login

Choose a disposable workspace for first validation. Review it before granting trust. Use a fresh named profile and an unused loopback port:

```sh
fate-server web --profile local-web --workspace "/absolute/path/project" --trust-workspace --port 47119
```

`web` initializes only a missing profile; it does not replace a corrupt profile or change an existing profile's workspace/port. CLI-created profiles start with a **read-only host maximum**, terminal disabled and browser integration disabled. This is stricter than the general server-composition default of Edit files. Browser control cannot raise the host maximum. The CLI has no permission-cap or terminal-enablement flag.

Keep the host terminal open. The command opens or prints a login-page URL such as `http://127.0.0.1:47119/`, with no secret in it. In a second host-local terminal:

```sh
fate-server doctor --profile local-web
fate-server auth-code --profile local-web
```

`doctor` is observational; it does not repair ownership or start a second runtime. `auth-code` requires the running host and an interactive private terminal, or a new file in an existing private directory:

```sh
fate-server auth-code --profile local-web --out-file "/private/access/browser-code.txt"
```

Enter the one-use code in the login form before its five-minute expiry. Do not put it in a URL, command-line argument, screenshot or shared log. The code is exchanged in a POST body. The browser uses a scoped HttpOnly session cookie and an in-memory CSRF token; provider and owner secrets remain on the host.

Choose a registered workspace. You begin as an observer; explicitly claim control before supported mutations. Shared selected-session state can change when another controller selects a session. Check the host, workspace, session, connection, control and permission display before acting. The current permission selector has an unresolved reduction issue; see [limits](security-and-limits.md#control-permission-and-shared-selection).

## Headless host and provider setup

For a server without the web UI, initialize once and run in the foreground:

```sh
fate-server init --profile remote --workspace "/absolute/path/project" --trust-workspace --port 47119
fate-server serve --profile remote
```

Initialization saves a private read-only profile without starting an agent. `serve` uses the existing profile. In a separate private terminal on that same execution host:

```sh
fate-server provider login --profile remote
fate-server provider status --profile remote
```

Use the supported interactive Pi login lifecycle. Provider status reports configured SDK state, not a paid validation call. Unsupported OAuth flows require Pi-supported host setup; do not invent a callback exchange. The running host is the sole profile writer. Never copy the desktop provider store or server owner credential to a client.

Ctrl+C requests controlled host shutdown. Wait for real settlement before restarting or changing versions. For independent service ownership, review the [Linux user-service guide](remote-host-service.md). Installing/enabling a service and choosing logout/linger policy are explicit operator steps. The host cannot continue executing while asleep or powered off.

## Desktop through SSH

1. Have the operator preinstall and start the reviewed Node package on a reachable Linux x64 host. Record the server ID, registered workspace ID/generation and loopback port from the host's ready output. A listening port alone is not readiness.
2. Configure a normal system OpenSSH host alias on the desktop. Independently verify the host-key fingerprint through a trusted channel, then establish the known-host entry using your SSH tools. Unknown or changed keys block Fate connections. Do not disable strict checking, discard known-host records, or enable agent forwarding to make a test pass. Fate's tunnel uses noninteractive key/agent authentication, not a password prompt.
3. On the running execution host, issue a workspace-scoped **Fate client credential** into a new private file:

   ```sh
   fate-server access-key create --profile remote --workspace "/absolute/path/project" --out-file "/private/access/desktop-client.json"
   ```

   Arrange an explicitly approved secure transfer of this client file to a private desktop location. The command does not transfer it. This is neither the SSH private key nor the server owner/provider credential.
4. In the desktop host selector, add an SSH profile. Enter the SSH alias, remote port, verified server ID, workspace ID/generation and label. Use the native picker for the private client file, then confirm the server identity. Saving a profile does not deploy, connect or start agent work.
5. Select the saved profile, or use `fate connect PROFILE`, where `PROFILE` is the saved profile identifier. The main process owns the tunnel and credential read. It verifies identity, protocol, workspace and readiness before permitting work. Failure does not start a local agent as a fallback.

Disconnect closes only the owned tunnel. Independently hosted work may remain active and incur provider charges. [Troubleshooting](troubleshooting.md) covers host verification, stale state and uncertain outcomes. Real SSH, native picker, service and active-loss acceptance remain pending for the final candidate.
