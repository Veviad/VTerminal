# macOS Backup & Storage Readiness

This assessment-only runbook checks a workstation running macOS 13 or newer for:

- a configurable amount of free space on the startup disk;
- a configured Time Machine destination;
- the latest Time Machine backup date recorded by macOS within a configurable age;
- APFS on the startup volume; and
- a local Time Machine snapshot when that optional requirement is enabled.

`minimumFreeSpaceGb` defaults to 20 GiB and is checked against a 1–1000 range.
`maximumBackupAgeDays` defaults to seven days and is checked against a 1–365
range. `requireLocalSnapshots` defaults to `false` because local snapshot policy
varies between teams and backup configurations.

The age check reads Time Machine's recorded `SnapshotDates` preference through
`defaults`; it does not open protected backup contents and therefore does not
require root or Full Disk Access.

The target guard stops the run outside macOS 13+. Other checks continue after a
finding to capture the whole backup and storage posture. The package has no
`apply` or model action and declares no network, privilege, or write capability.
