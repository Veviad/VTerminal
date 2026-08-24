# Veviad Runbooks

A runbook is a reusable, versioned checklist that VTerminal runs against the
terminal you are looking at. It checks things and changes them only with your
approval on every single command. It then proves the change worked and writes a report
you can hand to someone else.

The feature is experimental and **off by default**. Turn it on in
**Settings → Runbooks**. While it is off, Rust refuses every runbook command, so
the switch is a capability gate and not a UI preference.

- [Five-minute tour](#five-minute-tour)
- [Writing one without YAML: the wizard](#writing-one-without-yaml-the-wizard)
- [Writing one from what you already did: AI](#writing-one-from-what-you-already-did-ai)
- [Writing YAML](#writing-yaml)
- [Goal-directed steps](#goal-directed-steps)
- [Approvals and the trust model](#approvals-and-the-trust-model)
- [Evidence and reports](#evidence-and-reports)
- [Sharing and versioning](#sharing-and-versioning)
- [Reference](#reference)

---

## Five-minute tour

Open **Runbooks** from the header. Three tabs: **Library** (what you can run),
**Run** (what is running), **History** (what has run).

VTerminal ships three macOS assessments that change nothing, so you can watch
one work without risk:

- **macOS Security Posture:** FileVault, SIP, Gatekeeper, the application
  firewall, automatic updates.
- **macOS Developer Workstation Health:** Xcode CLT, the SDK, Git, Rosetta,
  free space, optionally Homebrew.
- **macOS Backup & Storage Readiness:** free space, the Time Machine
  destination and backup age, APFS, optional local snapshots.

Pick one, press **Run**, and you get a preflight screen: which terminal it will
bind to, any inputs, and how much output to keep. Press **Start runbook**.

From there every command appears as an approval card. You see the exact line,
you can edit it, and nothing is typed into your terminal until you approve. When
the run ends you get a report; **History** keeps it.

Four more examples ship in [`examples/runbooks`](../examples/runbooks) as
importable folders, including the two that use AI.

---

## Writing one without YAML: the wizard

**Library → New** opens a four-stage wizard. It works offline and saves as you
type.

| Stage | What you set |
|---|---|
| **Basics** | id, version, title, description, tags, target platform (macOS 13+, Linux, Any), default failure policy, whether the runbook needs network or root, and the absolute paths it writes to |
| **Inputs** | string, integer, boolean, path or enum, each with a description, a default and whether it is required |
| **Checks** | ordered steps, each with a check (a shell command with explicit `VRUN_*` input mappings and exit codes, or a manual question), and optionally an **apply** that fixes what the check found plus a **verify** that proves it worked |
| **Review** | validation issues you can click to jump to, three summary tiles, and the exact YAML that will be published |

Choosing macOS or Linux adds a locked first step that stops the run on the wrong
platform. **Any** adds no guard, so your commands must handle portability
themselves.

Ticking **Remediate when this check fails** adds the apply and verify phases
together, because a runbook that changes something without proving it worked is
rejected at publish time. Verify is seeded from the check, which is usually the
right proof. Every path the runbook writes to belongs in the Basics list: it is
shown in preflight before the first command runs.

The wizard still cannot author `agent`, `goal` or Ansible actions. Those change
who decides whether a step succeeded, so they are read as YAML before they run.
Publish what you have, export it, and edit the file. See below.

---

## Writing one from what you already did: AI

**Library → New → Generate with AI** authors a draft from a plain-language
requirement and, optionally, a terminal session as context.

The usual case: you installed and configured something by hand in a tab, and you
want a runbook that does it again elsewhere. Attach that session and the model
turns what you ran into steps. The command you used becomes the `apply`, and
the way you would tell it already happened becomes the `check` and the `verify`.

What leaves your machine is shown before it is sent. Pick the session, untick
any command you do not want to share, and edit the assembled text directly; that
box is the payload, verbatim. Attaching is unavailable when terminal context is
switched off in **Settings → AI**, and for a tab that has run a Runbook (its
output is suppressed so redacted evidence cannot be recovered).

The result is an ordinary draft. It opens on **Review** with its validation
issues listed, every field editable, and nothing saved to the Library until you
publish it through the same path a hand-written draft takes. Generated commands get no
special trust: each one is still approved in your terminal when the runbook runs.

Drafts stay out of the Library until **Publish to Library** succeeds.
Publication generates `runbook.vrun.yaml` and `README.md` and then applies the
same strict parsing, secret-like content checks and digest registration as any
imported package. The first publication defaults to `1.0.0`; publishing changes
requires a strictly greater version. Publishing an unchanged draft does nothing.

You can reopen a wizard project later. Removing the Library source leaves the
draft available to republish; discarding a published draft detaches the wizard
project only. The published runbook and its run history stay.

---

## Writing YAML

### The authoring loop

1. **Export runbook** from the Library. You get a folder named
   `runbook-<id>-v<version>`.
2. Edit `runbook.vrun.yaml` and `README.md` in any editor.
3. Keep `metadata.id` if it serves the same purpose, bump `metadata.version`,
   and keep step IDs stable for controls that have not changed.
4. **Import** the folder.

Registrations are path-based: re-importing the same folder refreshes that
source, while importing a copy from elsewhere creates a second one. Exporting a
bundled example imports back as a normal user source, so the original stays.

### Package layout

```text
my-runbook/
├── runbook.vrun.yaml   required
├── README.md           optional
└── ansible/            playbooks, roles and static inventory for ansible.playbook
```

Anything else at the root is rejected, as are symlinks, includes, remote
references and package scripts. The generated JSON Schema is
[`runbook-v1alpha1.schema.json`](../src-tauri/schemas/runbook-v1alpha1.schema.json)
if your editor can use it.

### A complete definition

```yaml
apiVersion: runbooks.veviad.com/v1alpha1
kind: Runbook

metadata:
  id: inspect-host
  version: 1.0.0
  title: Inspect a POSIX host
  description: |
    Markdown, shown during preflight.
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

A definition is frozen at run creation: VTerminal stores the original YAML, its
canonical JSON and a SHA-256 of each. Editing the package afterwards affects
future runs only after a refresh, never a live or historical one.

### Inputs

Types are `string`, `integer`, `boolean`, `path` and `enum`.

Inputs are **not secrets**. Identifiers that look like one (`password`, `token`,
`api_key`, `client_secret`, …) are rejected outright, and every value is
retained in the report. Never put a password, token or private key in an input,
a comment or a manual evidence note.

A shell action reaches an input only through an explicit `env` mapping in the
dedicated `VRUN_` namespace:

```yaml
with:
  command: "test -r \"$VRUN_CONFIG\""
  env:
    VRUN_CONFIG: configPath
```

The engine quotes the value into an isolated `/bin/sh -c` wrapper, classifies
and records that exact wrapper, and asks for approval because the wrapper is
opaque. This is what stops `PATH`, `BASH_ENV` or `GIT_EXTERNAL_DIFF` becoming an
approval bypass. **There is no templating and no string interpolation anywhere
in a definition.**

### Steps, phases and actions

A step runs up to three phases: **check** → **apply** → **verify**. Check
decides whether work is needed; apply does it; verify proves it.

Every step needs a check phase from `check:` or from `goal.checks`. An
`apply:` is never complete without verification, so it needs `verify:` or
`goal.checks`. A `verify:` without an `apply:` is an error.

Each phase is one action:

| `uses:` | Behaviour |
|---|---|
| `shell` | One inline command. No control characters, newlines, heredocs or here-strings; 4,096 characters maximum. |
| `agent` | Bounded Markdown instructions for the configured model. It proposes commands; each one is approved separately in the same visible terminal. |
| `manual` | Asks you for an outcome, a required comment and an optional evidence note. |
| `ansible.playbook` | Native in 0.2.10. Uses a user-installed `ansible-runner` as the explicit local controller, binds approval to exact project/inventory digests, retains structured per-host outcomes, forces check and verify phases into preview-only check mode, and still requires verification after apply. |

An Ansible action references files beneath the package's `ansible/` directory.
VTerminal launches `ansible-runner` locally without inheriting the visible
terminal shell; its inventory may target remote hosts. Input mappings become
JSON extra vars:

```yaml
apply:
  uses: ansible.playbook
  with:
    playbook: ansible/site.yml
    inventory: ansible/inventory/hosts.yml
    limit: web
    inputVars:
      http_port: service_port
```

A shell check declares disjoint compliant and non-compliant exit codes; any
other code is an execution error, not a non-compliance.

**Apply success alone never checks a step.** Only `already_compliant` and
`remediated_verified` appear as checked in the final report.

`onFailure` is `pause` (default), `stop` or `continue`. A paused step lets you
retry from a fresh check, skip, waive with an actor/reason/timestamp, or stop.
Mutations are never replayed automatically. An **unknown** outcome always pauses
for you, even under `continue`. Not knowing what happened is not a result you
can carry forward.

---

## Goal-directed steps

### The problem

Write a runbook that installs Docker. On Debian that is `apt-get`, on RHEL
`dnf`, on Arch `pacman`. Write a runbook that enables a firewall: `ufw`,
`firewalld` or `nft`. A fixed command list needs one runbook per distribution,
and the day a target does not match, it fails.

Handing the whole thing to a model instead swaps that for a different problem:
the model decides both what to do *and* whether it worked, and a model that
believes it succeeded reports success.

A **goal** splits those apart. You state what must be true and the exact
conditions that prove it. The model picks the commands. The engine runs the
conditions and decides.

```yaml
- id: docker-running
  title: Docker Engine is installed and running
  goal:
    intent: |
      Docker Engine is installed from the distribution's own repository and
      its daemon is running and enabled at boot.
    checks:
      - command: "command -v docker"
        expect: [0]
      - command: "docker info >/dev/null 2>&1"
        expect: [0]
  apply:
    uses: agent
    instructions: |
      Install Docker Engine using this distribution's package manager.
```

The goal is met only when **every** condition exits with a code it declares. All
of them run even after one fails, so the report can say which two of four
conditions are unmet rather than just "something".

Notice there is no `check:` and no `verify:`. The goal serves as both: one
statement of the condition instead of the same command written twice, which is
two places for one truth to drift.

Goal conditions are ordinary commands in your visible terminal, so they carry
the same assurance as any other: `shell_observed`, not attested. Nothing here
claims a more trustworthy executor. What changed is *who reads the result*.

### Bounds

`constraints` narrow what an agent phase may do. Put them on a step, or in
`spec.defaults.constraints` for the whole document. A step that declares its
own block replaces the defaults entirely, so reading the step tells you what
applies.

```yaml
constraints:
  maxCommands: 12    # proposals, refusals included
  maxSeconds: 900    # wall clock for the phase
  maxRounds: 6       # model turns; may only LOWER your global setting
  network: false     # refuse anything that looks networked
  privilege: none    # refuse sudo, doas, pkexec, su
```

Every field narrows. Nothing here widens what you already allow, and
`network: true` / `privilege: root` refuse nothing. They are a statement of
expectation, and the model is told about neither, because promising a rule that
is not applied is a lie.

A refused proposal comes back to the model as "not allowed here, try something
else", so it can adapt. It still spends a command from the budget, or a model
could re-propose the same forbidden thing forever. Running out of budget stops
the phase and hands the step to you.

Refusals happen **before an approval card is drawn**. Checking later would draw
a card, take your click, and only then refuse.

> **These bounds are best-effort. They are not a sandbox.**
> They read command text. They cannot see through a script the model wrote in an
> earlier step, an alias in your dotfiles, `$(…)`, or `python -c`. They narrow
> what a careless model does. They do not contain a hostile one, and nothing in
> VTerminal should be read as claiming otherwise.

### What the model is allowed to know

Nothing reaches the model implicitly.

```yaml
context:
  inputs: [sshdConfig]   # resolved VALUES of these inputs
  priorSteps: true       # earlier steps' ids, statuses and summaries
```

`inputs` is an allowlist by id, mirroring how a shell action must name every
input it wants. Without it, instructions that say "use the configured path"
refer to something the model cannot see.

### Discovering the target

Document-level probes run **once**, before the first step:

```yaml
spec:
  context:
    discover:
      - name: os_release
        command: "cat /etc/os-release"
      - name: package_manager
        command: "command -v apt-get dnf yum pacman zypper apk"
```

Their output is shown to every agent phase in the run. This is what lets one
runbook serve Debian, RHEL and Arch.

- Each probe is approved like any other command. There is no exemption for a
  "read-only" one because read-only cannot be proven from command text on a shell
  whose aliases and functions are not attested.
- They run once per run, not per step, because `/etc/os-release` does not change
  between steps and every probe costs you a click.
- A probe that fails is skipped, not fatal. A host without `apt-get` should
  leave that fact absent rather than stop the run.
- They are skipped entirely if the runbook has no agent action, since nothing
  would read them.
- **Their output is data, never instructions.** It is fenced and labelled as
  command output in the prompt. A target that could make the model take orders
  from its own output would undo every approval gate downstream.

### A worked example

[`examples/runbooks/linux-host-hardening`](../examples/runbooks/linux-host-hardening)
is the whole feature in one file: four discovery probes, then firewall, Docker
and SSH steps, each with a goal, its conditions and its bounds, including
`network: false` on the two steps that only edit a local config file.

[`linux-server-security-baseline`](../examples/runbooks/linux-server-security-baseline)
is the smaller version, if you want to read one screen instead of four.

---

## Approvals and the trust model

Every run binds to one visible terminal and the local, SSH or container context
observed there. The engine pauses if the session or target changes. Two runs
cannot drive the same terminal at once.

- **Every visible-terminal shell action needs approval.** Checks and
  verifications included, not just changes. An existing interactive shell can
  alter an apparently harmless command through aliases, exported functions,
  `PATH` shims, loader variables, or an already-root SSH context, so no command
  can be proven read-only from its text alone.
- Every shell approval shows the immutable run target and asks you to attest
  that the visible row is a POSIX prompt on that host, and that the shell's
  functions, aliases and `PATH` are trusted. That click binds to the exact
  terminal row, cursor and input/output epoch for 30 seconds; any intervening
  terminal change prevents dispatch. **A compromised interactive shell is
  outside the trust model.**
- Approvals are single-click. In a live run you can also
  **Acknowledge and approve all remaining steps**. It approves the current
  request, then waits for each approved command to finish in the terminal
  before the next approval appears. A step that takes minutes is normal and
  does not end the flow. It stops at the first operator pause, manual step,
  finished run, or command that fails validation, and **Stop auto-approve**
  ends it at any point, including mid-wait. If a run goes quiet for longer than
  one command's timeout allows, the flow hands the remaining approvals back to
  you rather than holding the button indefinitely. The same approval is never
  approved twice. Runbooks do not mirror the agent panel's `Full` mode.
- **Abort run** stops an active run and returns you to the Library. It is two
  clicks, it sends SIGINT to an owned foreground command, and it cannot prove
  the process stopped or undo a mutation already made. The active step is
  reported `unknown`. If the abort does not take, the run stays in front of you
  with its error rather than being navigated away from.
- **A model phase has its own approval**, separate from the shell approvals for
  the commands it later proposes. That card names the step's goal and its
  enforced bounds, because a model phase is opaque and this is the only moment
  you see the objective before the model has it. It also reports whether the
  provider is networked.
- Networked, privileged or opaque checks and verifications are approved and then
  reported as phase deviations.
- Editing a command keeps both the proposed and the executed text in the report.
- Visible-terminal checks and verifications are reported as `shell_observed`,
  never as an attested deterministic executor. A per-attempt token stops stale
  or replayed terminal output settling a different attempt; it cannot prove your
  interactive shell evaluated the line exactly.
- Once a terminal has run a runbook action, its raw scrollback is excluded from
  restore/archive persistence and OSC 52 clipboard writes stay disabled for that
  terminal's lifetime. Semantic shell/cwd markers are quarantined while an
  attempt is observed.
- **Review runbook** in the live header reopens the definition mid-run.

A timeout means the outcome is *unknown*: the command is not killed and not
retried. Cancelling sends SIGINT to the owned foreground job and stops
observation, but cannot prove the process stopped, terminate detached work, or
undo what already happened. The active step is reported `unknown`. After a
process restart, active runs become `interrupted`, in-flight attempts become
`unknown`, and resuming requires an explicit terminal rebind.

---

## Evidence and reports

### How much output is kept

Three levels:

| Mode | Kept per attempt |
|---|---|
| `none` | Nothing. Results, timestamps, approvals and operator comments only. |
| `tail` | Up to 8 KiB of redacted output. |
| `full` | The 8 KiB tail **plus** a redacted artifact of up to 1 MiB on disk. |

**Settings → Runbooks → Record terminal output** sets the floor:

| Setting | Meaning |
|---|---|
| **Never** | Off by default. Nothing is kept unless you raise a single run before starting it. |
| **As the runbook asks** (default) | Each package decides via `spec.audit.recordOutput`; one that asks for nothing gets `tail`. |
| **Always, in full** | Every attempt keeps an artifact, and no run can opt out. |

Preflight shows the resolved level and only offers levels at or above it. You
can raise a single run, never lower it, and the clamp is applied in Rust. A
stale frontend cannot reduce your audit level. **Never** is "off by default"
rather than "recording forbidden", so a run you specifically want evidence for
is still possible.

### Reading it back

A report shows each attempt's redacted tail inline. Where a full artifact
exists, **View recorded output** opens it. The recorded digest is re-verified on
every read: an artifact that has been deleted, resized or altered since the run
is reported as no longer readable rather than shown, because bytes that no
longer match what was recorded are worse than none because you cannot tell by looking.

The same viewer serves the report at the end of a run and the same run reopened
from History months later.

### Limits, honestly

- **Redaction is best-effort.** Common credential patterns, CLI and URL
  credentials, token prefixes and private-key blocks are redacted before
  display, persistence or export. A secret with no recognisable name or shape
  cannot be found reliably.
- **`full` is bounded by your scrollback.** Capture reads what xterm still
  holds (10,000 lines by default). A chatty command still yields an honest
  tail, not a complete transcript, and the report marks truncation explicitly.
- **A run can fill its evidence budget** (2,048 artifacts or 64 MiB). When it
  does, remaining attempts keep tails only and the report records that once, as
  an unresolved risk. The run does not fail for it.
- **Recorded output is kept until you delete the run.** There is no automatic
  expiry, deliberately: marking an aged artifact missing would downgrade a
  finished run from *succeeded* to *completed with exceptions* at the next
  startup, rewriting history because time passed. Deleting a run removes its
  artifacts from disk.
- Under **Always, in full**, the runbook artifact is the *only* durable copy of
  that terminal's output, since a runbook terminal's raw scrollback is already
  excluded from the session archive.

### Reports

Every terminal outcome, whether succeeded, exceptional, failed or cancelled, produces
a canonical `report.json`. `report.md` is generated only from that validated
JSON. **Export report** writes both plus eligible evidence artifacts; it is not
an importable package. Removing a package registration never deletes its runs.

Step and executive summaries come from engine-fixed statuses and bounded
structured evidence. **Report evidence is never sent to a model to improve
prose.** Summaries an agent returns during a model phase you approved are
retained, and that is a different thing: audit retention and model input are
separate, and recording more output does not feed more of it to a model.

---

## Sharing and versioning

Keep `metadata.id` stable while a runbook serves the same purpose. Bump the
semantic version whenever behaviour, requirements, inputs or the meaning of a
step changes. Step IDs are durable report identifiers. Never reuse one for a
different check.

Prefer idempotent checks, the smallest safe apply, and a verification of the
observable end state rather than of the command that produced it.

> **A runbook using goals, constraints or discovery is rejected by an older
> VTerminal**, with an opaque YAML error. `apiVersion` is matched exactly and
> every structure refuses unknown fields, so there is no partial understanding.
> This is safer than silently ignoring a bound the author relied on, but worth
> knowing before you share a file.

---

## Reference

### Step

| Field | Required | Notes |
|---|---|---|
| `id`, `title` | yes | `id` is a durable report identifier |
| `required` | no, default true | An optional step does not downgrade the run |
| `check` | unless `goal` | One action |
| `apply` | no | Needs `verify` or `goal` |
| `verify` | unless `goal` when `apply` is set | Cannot appear without `apply` |
| `goal` | no | `intent` plus 1–8 `checks` |
| `constraints` | no | Replaces `spec.defaults.constraints` wholesale |
| `context` | no | `inputs` (≤16 ids), `priorSteps` |
| `onFailure` | no, default from `spec.defaults` | `pause` \| `stop` \| `continue` |

### Spec

| Field | Notes |
|---|---|
| `target.kind` | `active-terminal` |
| `inputs` | Map of id → definition |
| `declaredCapabilities` | `network`, `privilege`, `writes`; preflight disclosure, not enforcement |
| `defaults` | `onFailure`, `constraints` |
| `audit.recordOutput` | `none` \| `tail` \| `full`; your Settings floor can only raise it |
| `context.discover` | Up to 6 probes, run once before the first step |
| `steps` | 1–256 |

### Limits

| Thing | Limit |
|---|---|
| Definition file | 1 MiB |
| Shell command | 4,096 characters, one line |
| Markdown (`description`, `instructions`, `goal.intent`) | 16,384 characters |
| Titles | 160 characters, single line |
| Steps | 256 |
| Goal conditions per step | 8 |
| Discovery probes per document | 6 |
| Context inputs per step | 16 |
| Output tail per attempt | 8 KiB |
| Full artifact per attempt | 1 MiB |
| Evidence per run | 2,048 artifacts / 64 MiB |
