# Independent Linux host service

Use the independent Linux x64 Node package. Install it on the execution host before connecting. A desktop connection starts only a local SSH tunnel. It does not install software, start the remote server, change service files, copy credentials, or run root commands.

## Operator setup

Run these commands on the execution host as a normal user. Use a new server profile and a temporary project for the first check. Do not reuse a desktop provider directory.

In the first terminal:

```bash
node "/absolute/path/fate-server/dist/cli/main.js" init --profile remote --workspace "/absolute/path/project" --trust-workspace --port 47119
node "/absolute/path/fate-server/dist/cli/main.js" serve --profile remote
```

Keep that terminal open. The ready line includes the public server ID, epoch and workspace ID/generation needed by the desktop editor. In a second terminal:

```bash
node "/absolute/path/fate-server/dist/cli/main.js" doctor --profile remote
```


Configure a provider with the host-local `provider login` command while that server is running. It uses the private host owner credential and the existing Pi login lifecycle. Browser sessions and client keys cannot use the admin route. Unsupported OAuth flows must use the SDK-supported host setup; do not invent callback exchanges. Provider keys and owner credentials stay on the execution host.

Issue a separate scoped client key to an explicitly selected private file. The desktop profile uses a separately approved client reference. This work does not perform a transfer.

## User service

Review [the example unit](../../examples/fate-server.service.example). Replace every placeholder with an absolute path. Keep the unit and profile outside registered projects. Run it under a normal user account. The example contains no secret values. Node reads the private profile files itself.

Installing or enabling the unit is a separate operator action. Do not run these steps automatically. The operator must verify actual startup, stop, restart and logout behavior on a Linux host with a user service manager. A process test alone does not establish that the service unit works.

A user service can stop when the user logs out. Survival depends on the host session and service policy. If the operator chooses a lingering user service, an administrator must review that host policy. This application does not enable it.

## Failure behavior

| Event | Expected behavior |
| --- | --- |
| Desktop disconnect or tunnel loss | Only the client and its tunnel stop. The independent server and admitted run can remain active. |
| Browser close | Its subscription and control expire. Host work can continue. |
| SIGINT or SIGTERM | Stop new admissions, request actual cancellation and flush through the existing core lifecycle. |
| Stop cannot settle | Keep the process and ownership until actual settlement. Report an incomplete stop. Do not start a competing owner. |
| Forced server kill | A stale owner record can remain. Stop all possible owners and review the record before explicit recovery. Do not delete it based only on an old PID. |
| Server restart after explicit owner recovery | Read the durable journal and existing runtime records. Show interruption or uncertainty. Do not replay old work automatically. |
| Sleep | This host cannot execute while it sleeps. A disconnected client is not proof that the host is awake. |
| Shutdown or power loss | Execution stops. Recovery needs a running host and review of uncertain effects. |
| Disk or storage failure | Refuse new unsafe admissions. Do not report existing work as canceled or completed. |

A supervisor may eventually force-kill a process that cannot stop. That is an interruption, not a clean stop. The retained lock and journal must be reviewed before another owner starts. The example refuses automatic SIGKILL; manual escalation is a separate host action.

## Required manual service gate

On the supported non-root Linux host, record Node/package version, unit bytes, user ID, original PID, restart PID, profile/checkout ownership and test-file bytes. Verify the original PID survives client disconnect and tunnel loss. Verify graceful shutdown releases only settled ownership. Verify logout policy and restart uncertainty. Preserve redacted logs. This gate remains pending when the test host has no user-service session.
