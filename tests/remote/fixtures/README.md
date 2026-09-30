# Real OpenSSH fixture

`pnpm test:remote` must run against the packaged Linux x64 Node server and a real OpenSSH daemon. The fake Pi composition is a separate test harness; it must not appear in the production package.

Use disposable Linux hosts/projects/homes only. The fixture creates fresh test-only SSH keys and a private known_hosts file. It leaves the operator's real SSH files untouched. Strict host-key checking, batch key authentication, no agent forwarding, no remote command, and forward-failure reporting remain enabled. No automatic deployment is part of a client connection.

A normal root-run OpenSSH daemon needs its distribution's privilege separation directory. A non-root daemon needs a permitted test account and readable private fixture files. If the environment cannot run the real daemon, the command must fail with `REMOTE_FIXTURE_UNAVAILABLE`. Do not skip the required workflow or replace it with an in-memory transport.

Required evidence: original host PID, tunnel PID, host restart PID, sentinel before/after bytes, real Git diff, invocation count, last-known run state after tunnel kill, no client-project write, journal status after host kill, no replay, wrong key, changed SSH host key, port collision, incompatible protocol, and stalled cancellation with retained ownership. An OpenSSH preflight failure is not a pass for any of those cases.

The Linux user-service gate is separate. A background child or `nohup` command does not prove user-service survival after logout.
