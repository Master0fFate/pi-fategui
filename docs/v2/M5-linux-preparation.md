# M5 Linux preparation - not accepted

Branch: `v2-preparation-linux`. Published code commit: `f43f7b5fb96b2ff9d50f761848e8d8ecf6aa7073`. Its Git tree `5e766bcc19be87839605bd796e2bdb818553a0ba` is byte-identical to the tested local code commit `1fac11899d324293db3ed83cf62f56ae296bf5f0`; GitHub connector publication changes commit metadata, not source bytes.

The full updated plans and preserved evidence were delivered separately as `pi-fategui-M5-updated-plans.zip`. Extract its `plans/` folder into a fresh checkout before running the plan checker or reading task reports. Do not overwrite older plans or dirty source without preserving them. The Git branch contains the implementation and these handoff documents.

Actual Linux checks passed: strict typecheck; boundaries 379/0; v2 646 passed with two required Windows ACL cases skipped; desktop units 2,601 passed with two existing skips; network 32 passed with two disclosed skips; desktop, CLI, server and web builds; separate headless smoke.

The server-only Linux x64 archive passed fresh frozen staging and tar-extraction production smokes under Node 24.19.0/ABI 137. It has its own freshly rebuilt Node PTY, no Electron dependency, 19,957 checksummed files and 636 internal links. SHA256: `569bfdb45af2d596c4d57722dc3c8832afd3366a37467eebbf7b1d1e8cb5ced0`. Web assets are deliberately excluded by the documented `--without-web` option. Its idle host survives a separate HTTP client exiting; this is not active-work/service/SSH proof.

M4 remains accepted. T44 is implemented pending review/native Windows proof. T45-T50 remain blocked, and T50 is implementation-incomplete. Actual real sshd preflight exits 255 because `/run/sshd` is missing. The current remote runner only preflights then refuses activation; real sentinel/diff, active tunnel loss, separate host kill after effect, invocation count/no replay and stalled-stop cases remain unexecuted. Non-root service/logout and native Windows/installed/E2E/ACL/TTY/picker gates remain pending. Browser tests fail preflight at missing installed Chromium. Web-enabled packaging refuses missing exact React-scroll license text; Vite/Rolldown injected helper attribution is also incomplete.

No M5 acceptance, deployment, real credential copying, paid-provider test, SDK source/new or expanded patch edit, shutdown batch or T51. See [the copyable Windows prompt](M5-Windows-verification-prompt.md) and the full per-card/gate reports in the delivered plans pack.
