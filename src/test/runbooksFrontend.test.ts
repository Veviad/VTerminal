import { beforeEach, describe, expect, it } from "vitest";

import {
  atLeastEvidence,
  commandWithRunbookEnvironment,
  createRunbookEventBuffer,
  definitionRecordOutput,
  evidenceFloor,
  evidenceModesAtOrAbove,
  evidenceTailLimit,
  isCheckedStepState,
  normalizeRunbookReport,
  pollRunbookUntilTerminal,
  type EvidenceMode,
  type RunbookDefinition,
  type RunbookEvent,
  type RunbookReportWire,
  type RunbookRun,
} from "../lib/runbooks";
import {
  selectLiveRunbookRun,
  selectLiveRunbookRuns,
  useRunbookStore,
} from "../stores/runbookStore";

const target = {
  kind: "active-terminal" as const,
  session_id: "session-1",
  shell: "/bin/zsh",
  cwd: "/srv/app",
  remote_kind: null,
  remote_target: null,
  context_marker: "local-host",
  observed_at: "2026-08-13T12:00:00Z",
};

function run(): RunbookRun {
  return {
    run_id: "run-1",
    status: "running",
    target,
    active_step_id: null,
    active_phase: null,
    pending_approval_id: null,
    pause_reason: null,
    steps: [
      { id: "secure-ssh", status: "pending", title: "Secure SSH", required: true, index: 0 },
    ],
  };
}

beforeEach(() => useRunbookStore.getState().reset());

describe("runbook event state", () => {
  it("keeps runbook approvals separate and updates the durable checklist projection", () => {
    const store = useRunbookStore.getState();
    store.setActiveRun(run());
    store.dispatchEvent({
      type: "StepChanged",
      run_id: "run-1",
      step_id: "secure-ssh",
      status: "applying",
      phase: "apply",
    });
    store.dispatchEvent({
      type: "ApprovalRequested",
      run_id: "run-1",
      approval_id: "approval-1",
      step_id: "secure-ssh",
      phase: "apply",
      command: "install -m 600 sshd_config /etc/ssh/sshd_config",
      explanation: "Updates the SSH daemon configuration.",
      classification: { read_only: false, network: false, privileged: true, opaque: false },
    });

    const state = useRunbookStore.getState().activeRun;
    expect(state?.steps[0]).toMatchObject({ id: "secure-ssh", status: "applying", phase: "apply" });
    expect(state?.status).toBe("waiting_approval");
    expect(state?.pending_approval?.approval_id).toBe("approval-1");
  });

  it("renders only positive verification states as checked", () => {
    expect(isCheckedStepState("already_compliant")).toBe(true);
    expect(isCheckedStepState("remediated_verified")).toBe(true);
    for (const state of ["needs_action", "failed", "skipped", "waived", "unknown"] as const) {
      expect(isCheckedStepState(state)).toBe(false);
    }
  });

  it("buffers early channel events until the run and full evidence mode are installed", () => {
    const delivered: RunbookEvent[] = [];
    const evidenceModes: Array<string | undefined> = [];
    const buffer = createRunbookEventBuffer((event) => {
      delivered.push(event);
      useRunbookStore.getState().dispatchEvent(event);
      if (event.type === "RunInTerminal") {
        evidenceModes.push(useRunbookStore.getState().activeRun?.evidence_mode);
      }
    });

    buffer.handle({
      type: "RunStarted",
      run_id: "run-1",
      session_id: "session-1",
    });
    buffer.handle({
      type: "StepChanged",
      run_id: "run-1",
      step_id: "secure-ssh",
      status: "checking",
      phase: "check",
    });
    buffer.handle({
      type: "RunInTerminal",
      run_id: "run-1",
      attempt_id: "attempt-1",
      approval_id: null,
      session_id: "session-1",
      command: "sshd -T",
      timeout_ms: 1_000,
      environment: {},
    });

    expect(delivered).toEqual([]);
    useRunbookStore.getState().setActiveRun({ ...run(), evidence_mode: "full" });
    buffer.activate("run-1");

    expect(delivered.map((event) => event.type)).toEqual([
      "RunStarted",
      "StepChanged",
      "RunInTerminal",
    ]);
    expect(evidenceModes).toEqual(["full"]);
    expect(useRunbookStore.getState().activeRun?.steps[0].status).toBe("checking");
  });

  it("preserves preflight evidence mode across durable refreshes", () => {
    const store = useRunbookStore.getState();
    store.setActiveRun({ ...run(), evidence_mode: "full" });
    store.setActiveRun({ ...run(), status: "waiting_approval" });
    expect(useRunbookStore.getState().activeRun?.evidence_mode).toBe("full");
  });

  it("restores authoritative pending actions on a same-run durable refresh", () => {
    const store = useRunbookStore.getState();
    store.setActiveRun(run());
    store.setActiveRun({
      ...run(),
      status: "waiting_approval",
      active_step_id: "secure-ssh",
      active_phase: "apply",
      pending_approval_id: "approval-db",
      pending_approval: {
        approval_id: "approval-db",
        run_id: "run-1",
        step_id: "secure-ssh",
        phase: "apply",
        command: "install config",
        explanation: "Durably recovered approval",
        classification: { read_only: false, network: false, privileged: true, opaque: false },
      },
    });
    expect(useRunbookStore.getState().activeRun?.pending_approval?.approval_id).toBe(
      "approval-db",
    );

    store.setActiveRun({
      ...run(),
      status: "waiting_operator",
      active_step_id: "secure-ssh",
      active_phase: "verify",
      pending_operator: {
        run_id: "run-1",
        step_id: "secure-ssh",
        reason: "manual verification required",
        choices: [],
      },
      pending_manual: {
        request_id: "manual-db",
        run_id: "run-1",
        step_id: "secure-ssh",
        title: "Secure SSH",
        instructions: "Verify the service manually.",
        phase: "verify",
      },
    });
    expect(useRunbookStore.getState().activeRun?.pending_manual?.request_id).toBe("manual-db");
    expect(useRunbookStore.getState().activeRun?.pending_operator?.reason).toBe(
      "manual verification required",
    );
  });

  it("keeps independent live runs addressable across different sessions", () => {
    const first = { ...run(), run_id: "run-a", target };
    const second = {
      ...run(),
      run_id: "run-b",
      target: { ...target, session_id: "session-2", context_marker: "other-host" },
    };
    const store = useRunbookStore.getState();
    store.setActiveRun(first);
    store.setActiveRun(second);

    // The workspace selects the most recent run, while events for the first
    // remain durable and update only its registry entry.
    store.dispatchEvent({
      type: "StepChanged",
      run_id: "run-a",
      step_id: "secure-ssh",
      status: "checking",
      phase: "check",
    });
    expect(useRunbookStore.getState().activeRun?.run_id).toBe("run-b");
    expect(useRunbookStore.getState().runsById["run-a"].steps[0].status).toBe("checking");
    expect(useRunbookStore.getState().runsById["run-b"].steps[0].status).toBe("pending");
  });
});

describe("runbook cancellation reconciliation", () => {
  it("polls until terminal instead of trusting the first post-cancel read", async () => {
    const states: RunbookRun["status"][] = ["running", "waiting_operator", "cancelled"];
    const observations: RunbookRun["status"][] = [];
    let calls = 0;
    const terminal = await pollRunbookUntilTerminal(
      "run-1",
      async () => {
        const status = states[Math.min(calls, states.length - 1)];
        calls += 1;
        return { ...run(), status };
      },
      {
        maxAttempts: 5,
        intervalMs: 0,
        onObservation: (value) => observations.push(value.status),
      },
    );

    expect(calls).toBe(3);
    expect(observations).toEqual(states);
    expect(terminal.status).toBe("cancelled");
  });

  it("bounds cancellation polling when settlement never becomes terminal", async () => {
    let calls = 0;
    await expect(
      pollRunbookUntilTerminal(
        "run-1",
        async () => {
          calls += 1;
          return run();
        },
        { maxAttempts: 3, intervalMs: 0 },
      ),
    ).rejects.toThrow(/did not reach a terminal state/);
    expect(calls).toBe(3);
  });
});

describe("runbook command environment", () => {
  it("quotes inputs without creating persistent shell state", () => {
    expect(commandWithRunbookEnvironment("printf '%s' \"$VRUN_NAME\"", { VRUN_NAME: "O'Brien" })).toBe(
      `env VRUN_NAME='O'"'"'Brien' /bin/sh -c 'printf '"'"'%s'"'"' "$VRUN_NAME"'`,
    );
  });

  it("rejects control bytes and invalid variable names", () => {
    expect(() => commandWithRunbookEnvironment("true", { "BAD-NAME": "value" })).toThrow(/Invalid/);
    expect(() => commandWithRunbookEnvironment("true", { GIT_EXTERNAL_DIFF: "helper" })).toThrow(/Invalid/);
    expect(() => commandWithRunbookEnvironment("true", { VRUN_OK: "line\nbreak" })).toThrow(/control/);
  });
});

describe("canonical report projection", () => {
  it("flattens per-step approvals without changing canonical outcome data", () => {
    const wire: RunbookReportWire = {
      api_version: "runbooks.veviad.com/report/v1alpha1",
      run_id: "run-1",
      status: "succeeded",
      definition: {
        id: "linux-baseline",
        version: "1.0.0",
        title: "Linux baseline",
        source_sha256: "source-digest",
        canonical_sha256: "json-digest",
      },
      target: {
        kind: "active-terminal",
        session_id: "session-1",
        shell: "/bin/zsh",
        cwd: "/srv/app",
        remote_kind: null,
        remote_target: null,
        context_marker: "local-host",
      },
      inputs: { port: 22 },
      environment: {
        app_version: "0.1.1",
        model: "test-model",
        resumes: [
          {
            resumed_at: "2026-08-13T12:00:02Z",
            app_version: "0.1.2",
            model: "resume-model",
            previous_target: {
              kind: "active-terminal",
              session_id: "session-1",
              shell: "/bin/zsh",
              cwd: "/srv/app",
              remote_kind: null,
              remote_target: null,
              context_marker: "local-host",
            },
            target: {
              kind: "active-terminal",
              session_id: "session-2",
              shell: "/bin/zsh",
              cwd: "/srv/app",
              remote_kind: "ssh",
              remote_target: "server.example",
              context_marker: "server.example",
            },
          },
        ],
      },
      timing: {
        created_at: "2026-08-13T12:00:00Z",
        started_at: "2026-08-13T12:00:01Z",
        finished_at: "2026-08-13T12:00:03Z",
        duration_ms: 2_000,
      },
      checklist: [
        {
          id: "secure-ssh",
          title: "Secure SSH",
          required: true,
          status: "remediated_verified",
          checked: true,
          changed: true,
          assurance: "deterministic_shell",
          summary: "Disabled direct root login and verified sshd settings.",
          operator_comment: null,
          waiver: null,
          attempts: [
            {
              id: "attempt-1",
              phase: "verify",
              executor: "shell",
              status: "succeeded",
              proposed_command: "test -f /etc/ssh/sshd_config",
              executed_command: "test -f /etc/ssh/sshd_config",
              exit_code: 0,
              duration_ms: 25,
              output_tail: "",
              output_observed_bytes: 12,
              output_captured_bytes: 8,
              output_redacted: false,
              output_truncated: true,
              error: null,
              intent_at: "2026-08-13T12:00:01Z",
              result_at: "2026-08-13T12:00:02Z",
            },
          ],
          approvals: [
            {
              id: "approval-1",
              phase: "apply",
              status: "approved",
              proposed_command: "old command",
              executed_command: "edited command",
              read_only: false,
              network: false,
              privileged: true,
              opaque: false,
              actor: "operator",
              reason: null,
              requested_at: "2026-08-13T12:00:01Z",
              decided_at: "2026-08-13T12:00:02Z",
              edited: true,
            },
          ],
          deviations: [
            {
              kind: "edited_command",
              detail: "Operator edited the proposed command.",
              proposed_command: "old command",
              executed_command: "edited command",
            },
          ],
          evidence: [],
          exceptions: [],
          unresolved_risks: [],
        },
      ],
      executive_summary: "The baseline is satisfied.",
      exceptions: [],
      unresolved_risks: [],
    };

    const report = normalizeRunbookReport(wire);
    expect(report.result).toBe("succeeded");
    expect(report.definition.yaml_sha256).toBe("source-digest");
    expect(report.checklist[0]).toMatchObject({ step_id: "secure-ssh", checked: true });
    expect(report.checklist[0].attempts[0]).toMatchObject({
      output_observed_bytes: 12,
      output_captured_bytes: 8,
    });
    expect(report.resumes[0]).toMatchObject({ app_version: "0.1.2", model: "resume-model" });
    expect(report.canonical).toBe(wire);
    expect(report.approvals[0]).toMatchObject({
      step_id: "secure-ssh",
      approval_id: "approval-1",
      executed_command: "edited command",
    });
    expect(report.deviations[0].message).toContain("edited_command");
  });
});

describe("evidence recording policy", () => {
  it("mirrors the Rust floor for every policy and declaration", () => {
    expect(evidenceFloor("all", null)).toBe("full");
    expect(evidenceFloor("all", "none")).toBe("full");
    expect(evidenceFloor("none", "full")).toBe("none");
    expect(evidenceFloor("runbook", null)).toBe("tail");
    expect(evidenceFloor("runbook", "full")).toBe("full");
    expect(evidenceFloor("runbook", "none")).toBe("none");
  });

  it("raises a request to the floor and never lowers it", () => {
    expect(atLeastEvidence("none", "full")).toBe("full");
    expect(atLeastEvidence("tail", "full")).toBe("full");
    expect(atLeastEvidence("full", "none")).toBe("full");
    expect(atLeastEvidence("tail", "none")).toBe("tail");
  });

  it("offers only the modes at or above the floor", () => {
    expect(evidenceModesAtOrAbove("none")).toEqual(["none", "tail", "full"]);
    expect(evidenceModesAtOrAbove("tail")).toEqual(["tail", "full"]);
    // `all` leaves the operator no choice at all, which is what an audit
    // floor means — the picker collapses to a single option.
    expect(evidenceModesAtOrAbove("full")).toEqual(["full"]);
  });

  it("reads a package's request and treats its absence as no request", () => {
    const definition = (audit?: { recordOutput?: EvidenceMode }): RunbookDefinition => ({
      kind: "Runbook",
      metadata: { id: "d", version: "1.0.0", title: "D" },
      spec: { target: { kind: "active-terminal" }, steps: [], ...(audit ? { audit } : {}) },
    });
    expect(definitionRecordOutput(definition())).toBeNull();
    expect(definitionRecordOutput(definition({ recordOutput: "full" }))).toBe("full");
  });

  it("harvests nothing at all when the run keeps no output", () => {
    // Not merely a smaller cap: Rust discards this output, so harvesting it
    // would move bytes the operator declined to keep across the IPC boundary.
    expect(evidenceTailLimit("none")).toBe(0);
    expect(evidenceTailLimit("tail")).toBe(8_192);
    expect(evidenceTailLimit("full")).toBe(1_048_576);
    // A run row missing its mode falls back to the column's SQL default.
    expect(evidenceTailLimit(undefined)).toBe(8_192);
  });
});

describe("durable refresh versus live events", () => {
  it("drops a snapshot that events have overtaken", () => {
    const store = useRunbookStore.getState();
    store.setActiveRun(run());
    const issuedAtRevision =
      useRunbookStore.getState().runRevisions["run-1"] ?? 0;

    // The approval arrives while the snapshot above is still in flight.
    store.dispatchEvent({
      type: "ApprovalRequested",
      run_id: "run-1",
      approval_id: "approval-1",
      step_id: "secure-ssh",
      phase: "check",
      command: "sshd -T",
      explanation: "Reads the running configuration.",
      classification: { read_only: false, network: false, privileged: false, opaque: true },
    });
    expect(useRunbookStore.getState().activeRun?.pending_approval?.approval_id).toBe(
      "approval-1",
    );

    // The pre-approval snapshot lands late. Applying it would erase the
    // approval and leave the run spinning with nothing to click.
    store.upsertRun({ ...run(), status: "running" }, issuedAtRevision);

    const after = useRunbookStore.getState().activeRun;
    expect(after?.pending_approval?.approval_id).toBe("approval-1");
    expect(after?.status).toBe("waiting_approval");
  });

  it("still applies an operator-initiated read", () => {
    // No revision means "authoritative": reopening History or the panel is how
    // an operator recovers a run whose events were missed entirely.
    const store = useRunbookStore.getState();
    store.setActiveRun(run());
    store.dispatchEvent({
      type: "ApprovalRequested",
      run_id: "run-1",
      approval_id: "approval-1",
      step_id: "secure-ssh",
      phase: "check",
      command: "sshd -T",
      explanation: "Reads the running configuration.",
      classification: { read_only: false, network: false, privileged: false, opaque: true },
    });

    store.upsertRun({ ...run(), status: "succeeded" });

    expect(useRunbookStore.getState().activeRun?.status).toBe("succeeded");
  });

  it("applies a snapshot that no event has overtaken", () => {
    const store = useRunbookStore.getState();
    store.setActiveRun(run());
    const issuedAtRevision =
      useRunbookStore.getState().runRevisions["run-1"] ?? 0;

    store.upsertRun({ ...run(), status: "succeeded" }, issuedAtRevision);

    expect(useRunbookStore.getState().activeRun?.status).toBe("succeeded");
  });
});

describe("header live-run selection", () => {
  it("stops presenting a run once it reaches a terminal state", () => {
    const store = useRunbookStore.getState();
    store.setActiveRun({ ...run(), status: "succeeded" });

    const { activeRun, runsById } = useRunbookStore.getState();
    // The selection survives so the end-of-run report stays openable...
    expect(activeRun?.run_id).toBe("run-1");
    expect(runsById["run-1"]).toBeDefined();
    // ...but it must not hold the header slot. Treating the selection as
    // liveness pinned a finished run's pill there until the app restarted.
    expect(selectLiveRunbookRun(activeRun, runsById)).toBeNull();
    expect(selectLiveRunbookRuns(runsById)).toEqual([]);
  });

  it("presents a run that is still waiting on the operator", () => {
    useRunbookStore.getState().setActiveRun({ ...run(), status: "waiting_approval" });

    const { activeRun, runsById } = useRunbookStore.getState();
    expect(selectLiveRunbookRun(activeRun, runsById)?.run_id).toBe("run-1");
  });

  it("treats an interrupted run as live so it can still be rebound", () => {
    useRunbookStore.getState().setActiveRun({ ...run(), status: "interrupted" });

    const { activeRun, runsById } = useRunbookStore.getState();
    expect(selectLiveRunbookRun(activeRun, runsById)?.run_id).toBe("run-1");
  });

  it("falls through a finished selection to another session's live run", () => {
    const store = useRunbookStore.getState();
    store.upsertRun({ ...run(), run_id: "run-2", status: "running" });
    store.setActiveRun({ ...run(), status: "cancelled" });

    const { activeRun, runsById } = useRunbookStore.getState();
    expect(selectLiveRunbookRun(activeRun, runsById)?.run_id).toBe("run-2");
  });
});
