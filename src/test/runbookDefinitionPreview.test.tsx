import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunbookDefinitionPreview } from "../components/runbooks/RunbookDefinitionPreview";
import type { RunbookDefinition } from "../lib/runbooks";

function definition(overrides: Partial<RunbookDefinition["spec"]> = {}): RunbookDefinition {
  return {
    apiVersion: "runbooks.veviad.com/v1alpha1",
    kind: "Runbook",
    metadata: { id: "linux-host-hardening", version: "1.0.0", title: "Harden a Linux host" },
    spec: {
      target: { kind: "active-terminal" },
      steps: [
        {
          id: "docker-running",
          title: "Docker daemon is running",
          required: true,
          goal: {
            intent: "Docker Engine is installed from the distribution's own repository.",
            checks: [
              { command: "command -v docker", expect: [0] },
              { command: "systemctl is-active --quiet docker", expect: [0] },
            ],
          },
          constraints: { maxCommands: 12, network: true, privilege: "root" },
          apply: { uses: "agent", instructions: "Install Docker Engine." },
        },
      ],
      ...overrides,
    },
  };
}

describe("RunbookDefinitionPreview", () => {
  it("shows the intent and the exact conditions that will grade it", () => {
    render(<RunbookDefinitionPreview definition={definition()} onStart={() => {}} />);

    expect(
      screen.getByText(/Docker Engine is installed from the distribution's own repository\./),
    ).toBeInTheDocument();
    // Both are shown because they answer different questions: a runbook whose
    // conditions do not match its stated intent is only reviewable side by side.
    expect(screen.getByText(/command -v docker/)).toBeInTheDocument();
    expect(screen.getByText(/systemctl is-active --quiet docker/)).toBeInTheDocument();
  });

  it("names the phases a goal stands in for", () => {
    render(<RunbookDefinitionPreview definition={definition()} onStart={() => {}} />);
    // The step declares no `check:` and no `verify:`; saying nothing would read
    // as an assessment-only step that never verifies its own remediation.
    expect(screen.getByText("check: goal conditions")).toBeInTheDocument();
    expect(screen.getByText("verify: goal conditions")).toBeInTheDocument();
  });

  it("lists only the bounds that actually refuse something", () => {
    render(<RunbookDefinitionPreview definition={definition()} onStart={() => {}} />);
    const bounds = screen.getByText(/Bounded:/);
    expect(bounds).toHaveTextContent("at most 12 commands");
    // `network: true` and `privilege: root` permit rather than narrow. Listing
    // them as bounds would imply an enforcement that does not exist.
    expect(bounds).not.toHaveTextContent("network");
    expect(bounds).not.toHaveTextContent("privilege");
  });

  it("explains that discovery probes are approved and shown to the model", () => {
    render(
      <RunbookDefinitionPreview
        definition={definition({
          context: { discover: [{ name: "os_release", command: "cat /etc/os-release" }] },
        })}
        onStart={() => {}}
      />,
    );
    expect(screen.getByText(/Target facts/)).toBeInTheDocument();
    expect(screen.getByText(/cat \/etc\/os-release/)).toBeInTheDocument();
    expect(screen.getByText(/each with its own approval/)).toBeInTheDocument();
  });
});
