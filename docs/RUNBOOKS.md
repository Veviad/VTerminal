# Veviad Runbooks v1alpha1

Runbooks are reusable, versioned checklists that assess and, with explicit
approval, change the system in the currently visible terminal. The feature is
experimental and is disabled by default in **Settings → Runbooks**.

## Package layout

A package is a local directory with exactly one definition at its root:

```text
my-runbook/
├── runbook.vrun.yaml   required
├── README.md           optional
└── ansible/            reserved for the follow-on Ansible adapter
```

Other root files, symbolic links, includes, remote references, and package
scripts are rejected. Native v1 never uploads a local script into an SSH or
container session. See [`examples/runbooks`](../examples/runbooks) for complete
packages and
[`runbook-v1alpha1.schema.json`](../src-tauri/schemas/runbook-v1alpha1.schema.json)
for the generated JSON Schema.

## Included macOS examples

VTerminal includes three assessment-only packages for macOS 13 and newer. They
use no model actions, declare no network, privilege, or write capability, and
never remediate a setting:

- [macOS Security Posture](../examples/runbooks/macos-security-posture) checks
  FileVault, SIP, Gatekeeper, the application firewall, and automatic critical
  and system-data updates. It is the first included Runbook selected when no
  valid selection exists.
- [macOS Developer Workstation Health](../examples/runbooks/macos-developer-workstation-health)
  checks Xcode Command Line Tools, the macOS SDK, Git, Rosetta translation,
  configurable free space, and optional Homebrew availability.
- [macOS Backup & Storage Readiness](../examples/runbooks/macos-backup-storage-readiness)
  checks configurable free space, the Time Machine destination and backup age,
  APFS, and optional local snapshots.

Included sources carry an **Included with VTerminal** badge. Removing one hides
it from the Library without deleting its package or historical runs. Use
**Restore examples** to make all hidden included sources visible again.

## Export, edit, and import a package

**Export runbook** in the Library creates a complete import-ready folder named
`runbook-<id>-v<version>`. It contains the exact validated
`runbook.vrun.yaml`, optional `README.md`, and allowed `ansible/` tree from the
registered source. VTerminal revalidates package digests before export, rejects
symlinks and path escapes, and never merges into or overwrites an existing
destination.

A practical authoring loop is:

1. Export an included or imported Runbook from the Library.
2. Edit its YAML and README with any text editor.
3. Keep `metadata.id` for the same operational purpose, bump
   `metadata.version`, and keep durable step IDs for unchanged controls.
4. Import the edited folder. An exported included example imports as a normal
   user source, so the bundled original remains available separately.

Registrations are path-based. Importing the same folder refreshes that source;
importing a copy at another path creates a separate user source.

Package export is for reuse and authoring. **Export report** in History is a
different operation: it exports a completed run's `report.json`, `report.md`,
and eligible evidence. Report output is not an importable Runbook package.

## Definition

```yaml
apiVersion: runbooks.veviad.com/v1alpha1
kind: Runbook

metadata:
  id: inspect-host
  version: 1.0.0
  title: Inspect a POSIX host
  description: |
    Markdown shown during preflight.
  tags: [linux, assessment]

spec:
  target:
    kind: active-terminal

  inputs:
    configPath:
      type: path
      default: /etc/example.conf

  declaredCapabilities:
    network: false
    privilege: none
    writes: []

  defaults:
    onFailure: pause

  steps:
    - id: config-readable
      title: Configuration is readable
      check:
        uses: shell
        with:
          command: "test -r \"$VRUN_CONFIG\""
          env:
            VRUN_CONFIG: configPath
        outcomes:
          compliantExitCodes: [0]
          noncompliantExitCodes: [1]
```

The definition is immutable during a run. At creation, VTerminal stores the
original YAML, canonical JSON, and a SHA-256 digest of each. Editing the package
afterward can affect a future run only after refresh; it cannot change a live or
historical run.

### Inputs

Supported types are `string`, `integer`, `boolean`, `path`, and `enum`. Inputs
are non-secret and are retained in the report. Secret-like input identifiers
are rejected; do not enter passwords, tokens, private keys, or credentials.

Shell actions can receive an input only through an explicit `env` mapping. The
environment name must use the dedicated `VRUN_` namespace. The engine quotes
the value into an isolated `/bin/sh` child-shell wrapper, classifies and records
that exact wrapper, and requests approval because the wrapper is opaque. This
prevents process-control variables such as `PATH`, `BASH_ENV`, or
`GIT_EXTERNAL_DIFF` from becoming an approval bypass. There are no arbitrary
template expressions or string interpolation.

### Steps and actions

Every step has a `check`. An optional `apply` must be followed by `verify`.
Available native action kinds are:

- `shell`: one inline command, no control characters, newlines, heredocs, or
  here-strings, and at most 4,096 characters.
- `agent`: bounded Markdown instructions for the selected model. Agent commands
  use the same visible terminal and each mutation has its own approval.
- `manual`: asks the operator for an outcome, required comment, and optional
  evidence note.

`ansible.playbook` is parsed and validated but deliberately unavailable at
runtime until the dedicated Runner adapter ships. It never falls back to a
generic shell command.

A shell check declares disjoint compliant and non-compliant exit codes. Any
other code is an execution error. Apply success alone never checks a step;
verification must pass. Only `already_compliant` and `remediated_verified`
appear checked in the final report.

`onFailure` is `pause`, `stop`, or `continue` and defaults to `pause`. A paused
operator may retry from a fresh check, skip, waive with actor/reason/timestamp,
or stop. Mutations are never replayed automatically.

## Approval and target model

Each run binds to one visible terminal and its observed local, SSH, or container
context. The engine pauses on a session or target change. Two runs cannot drive
the same terminal concurrently.

- Apply actions always require a one-time approval.
- Native v1 requires approval for every visible-terminal shell action,
  including checks and verification. An existing interactive shell can alter
  apparently harmless commands through aliases, exported functions, PATH
  shims, loader variables, or already-root SSH/container context, so it cannot
  be proven read-only from command text alone.
- Every shell approval displays the immutable run target and requires an
  operator to attest that the visible row is a POSIX shell prompt on that
  host/container and that the session's shell, functions, aliases, and PATH are
  trusted. The app binds that click to the exact terminal row, cursor, and
  input/output epoch for 30 seconds; any intervening terminal change prevents
  dispatch. A compromised interactive shell remains outside v1's trust model.
- Networked, privileged, or opaque checks and verifies require approval and are
  reported as phase deviations.
- Runbooks never honor the ordinary agent panel's `Auto all` setting.
- Model phases are always treated as opaque and require their own approval.
  On-device models are reported as local; cloud and user-configured remote
  providers are additionally reported as networked.
- The proposed and executed commands are both retained when an operator edits a
  command.
- Visible-terminal shell checks and verification are reported as
  `shell_observed`, not as an attested deterministic executor. The per-attempt
  token prevents stale/replayed terminal output from settling a different
  attempt; it cannot prove that an operator-trusted interactive shell evaluated
  the textual line exactly. The shell and its startup configuration remain part
  of the explicitly attested target trust boundary.
- Once a terminal executes a Runbook action, its raw scrollback is excluded
  from restore/archive persistence and OSC 52 clipboard writes remain disabled
  for that terminal's lifetime. Semantic shell/cwd markers are quarantined
  while each attempt is observed; delayed descendant output after completion
  remains part of the explicitly trusted target session.

A timeout means the outcome is unknown; it does not kill or retry the command.
Cancelling an active run sends SIGINT to the owned foreground job and stops
observation, but cannot prove the process stopped, terminate detached work, or
undo mutations already made; the active step is therefore reported `unknown`.
After a process restart, active runs become `interrupted`, in-flight attempts
become `unknown`, and resumption requires an explicit terminal rebind.

## Evidence and reports

Run creation discloses one of three evidence modes:

- `none`: metadata only.
- `tail` (default): an 8 KiB redacted output tail per attempt.
- `full`: a redacted artifact capped at 1 MiB per attempt.

Common credential patterns, CLI/URL credentials, token prefixes, and
private-key blocks are rejected or redacted before display, persistence, or
export. Detection is intentionally conservative but necessarily best-effort:
an arbitrary secret without a recognizable name or shape cannot be identified
reliably. Never place a secret in a definition, input, comment, or manual
evidence field. Redaction and truncation are explicit in the report.

Every terminal outcome—successful, exceptional, failed, or cancelled—produces
canonical `report.json`. `report.md` is generated only from that validated JSON.
**Export report** contains both reports and eligible evidence artifacts. This is
separate from **Export runbook**, which creates a reusable package from a Library
source. Removing a package registration never deletes its historical runs.

Step and executive summaries are derived from the engine-fixed statuses and
bounded structured evidence. Native v1 uses deterministic summaries by default;
it never sends report evidence to a model merely to improve prose. Agent action
summaries returned during an explicitly approved model phase are retained.

## Versioning guidance

Keep `metadata.id` stable for the same operational purpose. Bump the semantic
version whenever behavior, requirements, inputs, or step meaning changes. Step
IDs are durable report identifiers: never reuse an ID for a different check.
Prefer idempotent checks and the smallest safe apply action, then verify the
observable end state independently.
