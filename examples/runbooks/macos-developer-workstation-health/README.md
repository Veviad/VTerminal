# macOS Developer Workstation Health

This assessment-only runbook checks a macOS 13 or newer development machine for:

- a selected Xcode Command Line Tools installation;
- a resolvable macOS SDK and Git binary through `xcrun`;
- whether the current shell is running natively rather than through Rosetta
  translation (`sysctl.proc_translated` being absent means native);
- a configurable minimum amount of startup-disk free space; and
- Homebrew availability when the optional requirement is enabled.

`minimumFreeSpaceGb` defaults to 20 GiB. The runbook explicitly checks that the
input is between 1 and 1000 before using it. `requireHomebrew` defaults to
`false`, so teams that do not standardize on Homebrew do not receive a finding.

The target guard stops the run outside macOS 13+. Other controls continue after
a finding so the final report provides a complete workstation snapshot. The
package has no `apply` or model action and declares no network, privilege, or
write capability.
