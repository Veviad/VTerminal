# Runbook execution and Scheduled Tasks

Runbooks execute against the target shown in preflight. Select a terminal there
and check whether it says **local shell**, **SSH**, or another remote context.
A saved SSH tab keeps its host label after a disconnect; that label does not
establish a connection. Reconnect before running a remote runbook. Using the
local shell in a disconnected SSH tab requires an explicit local-target choice.

Platform checks are prerequisites. A Linux runbook should stop on macOS; select
a Linux target or author a runbook for the intended platform instead of skipping
the guard and running incompatible commands.

## Diagnosing an execution

- A command refused before dispatch, such as a busy terminal, is recorded as a
  failed dispatch with its reason. It does not require reconciliation for an
  unknown command outcome.
- A command that may have started but has no reliable completion remains
  **Unknown**. Inspect its effects before retrying it.
- A non-integrated shell can be verified with a bounded, nonce-based shell
  challenge after a prompt has been attested. The real command only starts after
  that challenge establishes that the target is a responsive shell.
- The run history retains attempt outcomes and timing. App logs contain
  diagnostic dispatch metadata without recording command output or credentials.

## Generate a Scheduled Task from a session

1. Open **Scheduled Actions → Editor → Generate with AI**.
2. Describe the work and recurrence, such as a Docker space report every night at
   03:00.
3. Optionally attach a terminal session, deselect unwanted commands, and edit the
   exact context text before generating. The global terminal-context setting and
   runbook-output privacy restrictions apply here too.
4. Review the draft's steps, target, recurrence and permissions, then save it.

The model returns an unsaved, disabled task with no automatic command approval.
A session with a live saved SSH connection proposes that saved host as the task
target. An unresolved remote connection requires selecting a saved target.
Historical commands can span local and remote shells, so review the destination.

## Run a Runbook every night

1. Create a Scheduled Task and choose **Runbook** as its content.
2. Select the target and a published runbook, and fill in its inputs.
3. Set a daily recurrence at 03:00.
4. Choose **Runbook automatic approval**:

   | Policy | Behavior |
   | --- | --- |
   | No automatic approval | Stops when a phase needs approval. |
   | Approve read-only commands | Approves reads without network, elevated privileges or opaque execution. |
   | Approve all runbook commands | Approves commands within the selected definition and its constraints; no employee approval is needed. |

5. Review the authorization notice and save/enable the task.

Scheduled runbooks use background execution and the native check/apply/verify
engine. The saved authorization includes the definition digest, target, inputs
and approval policy. A changed package requires review and selection of its
current definition. Duplicating a task clears its automatic approval.

Saved deny rules still apply. Manual steps, unresolved results and other
operator decisions stop an unattended run and record the reason. Password
prompts cannot be answered unattended; configure suitable SSH authentication and
noninteractive commands before enabling the task.

Run details link to the native Runbook report with per-step evidence. Execution
timeouts, cancellation and missed-run handling follow the Scheduled Actions
settings. The application must remain running for schedules to fire; a sleeping
or closed application does not run tasks at 03:00. The chosen missed-run policy
controls what happens when it becomes available again.
