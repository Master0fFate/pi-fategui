# Security Policy

Security is a product boundary in Fate UI, not an afterthought. The renderer is intentionally separated from credentials, files, Git, shells, and the embedded Pi runtime.

## Supported versions

Security fixes are applied to the latest release and the current `main` branch. Older releases may not receive backports.

| Version | Supported |
| --- | --- |
| Latest release | ✅ |
| `main` | ✅ |
| Older releases | ❌ |

## Report a vulnerability privately

**Do not open a public issue for an unpatched vulnerability.**

Use [GitHub private vulnerability reporting](https://github.com/Master0fFate/pi-fategui/security/advisories/new). Include:

- the affected version or commit;
- operating system and architecture;
- a concise impact statement;
- reproduction steps or a minimal proof of concept;
- whether project trust or Full access was enabled;
- any suggested mitigation.

Do not include real credentials, private repository contents, or unrelated personal data.

## Response process

Maintainers will make a good-faith effort to:

1. acknowledge a complete report within 5 business days;
2. reproduce and assess impact;
3. coordinate a fix and disclosure timeline with the reporter;
4. publish a security advisory and patched release when appropriate.

Timelines may vary with severity, reproduction quality, and upstream dependencies.

## Scope

High-value areas include:

- renderer-to-main IPC authorization or validation bypasses;
- project-root containment escapes;
- project trust bypasses;
- unintended credential exposure;
- command or argument injection in Git, terminals, media, or external tools;
- unsafe extension, skill, prompt, or package loading;
- malicious session/import handling;
- release artifact or update-chain compromise.

Full access is intentionally unsandboxed after explicit user confirmation. A report that only demonstrates the documented authority of Full access is not a vulnerability unless it also bypasses the confirmation or exceeds the stated boundary.

## Safe harbor

Good-faith research that avoids privacy violations, data destruction, service disruption, credential theft, and access beyond accounts or systems you own is welcome. Stop testing and report immediately if you encounter sensitive data.
