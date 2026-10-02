# Fate Node server package

This package runs on the execution host with plain Node. Pi remains the execution engine. Install Node 22.19 or later. The manifest lists the Node version and ABI used for the actual package smoke. Linux x64 is the first target. Windows and other targets require their own checks.

The archive includes compiled CLI/server files, optional web files, its own exact runtime dependencies, unchanged existing patches, the dependency/license map, notices and checksums. It contains no desktop application, provider profile or client credential. The optional manual terminal dependency is built under Node on the actual target. Terminal access still requires explicit host policy.

After extraction, use the package path. A path with spaces is supported.

```bash
node "/absolute/path/Fate server/dist/cli/main.js" help
node "/absolute/path/Fate server/checks/smoke.mjs" "/absolute/path/Fate server" --verify-only
node "/absolute/path/Fate server/checks/smoke.mjs" "/absolute/path/Fate server"
```

The smoke uses a new private temporary HOME and workspace. It tests real production CLI startup, authentication refusal, profile contention on a different port, controlled SIGTERM, restart and package-native PTY when included. A separate short-lived HTTP client exits; the same host PID and health endpoint must remain alive. This proves that the client does not own the host process. It does not prove active-run recovery or a configured user service. The host child blocks outbound connections. The smoke does not log in to a provider or inspect an existing user profile. A failed fixture is retained for diagnosis.

Explicit host setup:

```bash
node "/absolute/path/Fate server/dist/cli/main.js" init --profile default --workspace "/absolute/workspace" --trust-workspace --port 43117
node "/absolute/path/Fate server/dist/cli/main.js" serve --profile default
```

Review the workspace before adding trust. Server authentication and provider credentials use separate private host storage. Provider setup is a host-local action. No credential store is copied from a desktop. Use `help` for available host commands. Provider login tests with paid providers are outside this package smoke.

The process runs in the foreground. Ctrl+C or SIGTERM requests controlled shutdown. A browser or SSH client does not own the process. A process supervisor needs separate operator setup. This package does not deploy files or install a service.

Build the package on Linux x64 from an installed development checkout:

```bash
pnpm build:cli
pnpm build:server
pnpm build:web
pnpm package:server --without-web --with-terminal --store-dir /absolute/pnpm-store
```

The verified M5 preparation artifact uses `--without-web`. At that checkpoint, the web build passed, but the web-enabled package stopped at its strict notice check because `react-remove-scroll-bar@2.3.8` lacked a verifiable full license text. The [fixed-viewport adaptation](../../docs/v2/fixed-viewport-scroll.md) removes that dependency from the current source graph; attribution remains unresolved for older artifacts that include it. Source removal does not establish web-enabled package notice closure: verify the actual candidate's emitted modules and complete notices. The collector records exact browser and worker module owners, font hashes, versions and published notices before refusing an incomplete archive. Do not describe this server-only artifact as proof of the web-enabled distribution.

Use `--without-web` to omit browser assets. Omit `--with-terminal` to omit the optional node-pty package. Packaging uses a fresh, frozen production install and prefers the approved pnpm store. It preserves the existing supply-chain policies. Missing package data or policy metadata can be fetched from the configured registry. Use `--offline` only when both the locked package data and policy metadata are cached. A missing offline input is a failure. For a source native build, supply supported Node headers through `npm_config_nodedir`. Do not reuse an Electron native build.

`SHA256SUMS` covers regular files. `LINKS.json` records internal package links. The smoke verifies both. The tar archive has a separate SHA256 file. Checksums detect changes; they do not establish publisher trust. Review `server-manifest.json`, `server-dependency-map.json` and `THIRD_PARTY_NOTICES.md`. A web-enabled build also requires `web-dependency-map.json`, `WEB_THIRD_PARTY_NOTICES.md` and the copied exact web/font licenses.

Keep the previous runtime and profile backup. Stop a running candidate before changing versions. Do not overwrite a live package or profile. Package verification is one M5 gate. Required Windows and host-service manual checks can remain pending even when this Linux artifact passes.
