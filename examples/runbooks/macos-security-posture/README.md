# macOS Security Posture

This assessment-only runbook checks six foundational controls on a workstation
running macOS 13 or newer:

- supported macOS target and version;
- FileVault full-disk encryption;
- System Integrity Protection (SIP);
- Gatekeeper app assessments;
- the macOS application firewall; and
- automatic installation of critical and system-data updates.

The target guard stops the run on another operating system or an older macOS
release. On a supported Mac, failures use `continue` so the report captures all
independent controls instead of stopping after the first finding.

The package declares no network, privilege, or write capability. It has no
`apply` or model action and cannot change a setting. Native v1 still asks for
approval before each shell check because it runs in the visible terminal and
the interactive shell is part of the trust boundary.
