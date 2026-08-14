# Linux host hardening baseline

A goal-directed runbook. Every step says what must be **true** and gives the
exact conditions that prove it; the model works out which commands get there on
*this* distribution.

Import it with **Runbooks → Import**, then run it against a terminal that is
sitting at a prompt on the host you want to harden — local or over SSH.

## What it does

| Step | Goal | Proven by |
|---|---|---|
| `firewall-default-deny` | An active firewall denying inbound by default, SSH still reachable | `ufw status` / `firewall-cmd --state` / `nft list ruleset` |
| `docker-engine-running` | Docker Engine from the distribution's own repository, daemon running | `command -v docker`, `docker info` |
| `ssh-root-login-disabled` | Running sshd config refuses direct root login | `sshd -T \| grep permitrootlogin no` |
| `ssh-password-authentication-disabled` | Running sshd config accepts keys only | `sshd -T \| grep passwordauthentication no` |

## Why it is not four copies of one script

Before the first step the runbook runs four **discovery** commands — the
distribution, the package manager, which firewall tooling exists, and the init
system — each with its own approval. Their output goes to the model as data.
That is what lets one file serve Debian, RHEL and Arch: the model reads what is
actually installed instead of branching on a guess.

The model then proposes commands. It does not decide whether they worked: after
its apply phase, the engine runs the goal conditions itself and grades them. A
model that reports success on a host where `docker info` still fails does not
get a passing step.

## What each step is allowed to do

Both SSH steps declare `network: false`. Editing a local configuration file
needs no network, and a step that cannot reach out cannot fetch a config from
one. A proposal that looks networked is refused before an approval card is
drawn, so it costs the model a round rather than costing you a click.

Every step declares `privilege: root`, because hardening a host requires it —
that is a disclosure, not a grant. You still approve each command.

The document-level `maxCommands: 15` / `maxSeconds: 900` bound each phase. The
two SSH steps tighten that to 8 commands: rewriting one directive in one file
should not take more.

**These bounds are best-effort, not a sandbox.** They read command text. They
cannot see through a script the model wrote in an earlier step, a shell alias in
your dotfiles, or `python -c`. They narrow what a careless model does; they do
not contain a hostile one.

## Evidence

The runbook asks for `recordOutput: full`, so each attempt keeps a redacted
artifact you can open from the report — a hardening change is the kind of thing
someone asks about six months later. Your **Settings → Runbooks** policy can
raise this but never lower it; set it to *Never* if you do not want output kept
and the runbook's request is ignored downward.

## Before you run it

- **Have a second way in.** Steps 3 and 4 disable root login and password
  authentication. Confirm a non-root account with a working key can already log
  in. The instructions tell the model to check, but the consequence is yours.
- **systemd is assumed** for "running and enabled at boot". On a host without
  it, `docker info` still proves the daemon runs, but the model will need a
  different way to make it persist.
- **The firewall step runs in the terminal you are connected through.** Its goal
  text says SSH must stay reachable; read the proposed commands before
  approving, because an approval here is how you keep your session.
