import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EffortPicker } from "../components/ui/EffortPicker";
import type { Effort } from "../lib/types";

// The point of the picker is that it is driven by the MODEL's capabilities, not
// by a fixed five-way switch. These tests pin that: a rung the model would
// reject must never be offered, because offering it produces a 400 (Claude
// Haiku 4.5 errors on the effort param; Mistral has no rung above `high`).
describe("EffortPicker", () => {
  const noop = () => {};

  it("renders only the rungs the model declares", () => {
    // A sparse ladder: no `medium`, and no off-switch.
    render(
      <EffortPicker value="max" available={["low", "high", "max"]} onChange={noop} />,
    );
    expect(screen.getByRole("radio", { name: "Low" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "High" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Max" })).toBeTruthy();
    // Neither rung was declared, so neither may be offered.
    expect(screen.queryByRole("radio", { name: "Med" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Off" })).toBeNull();
  });

  it("keeps ladder order regardless of the order it was given", () => {
    render(
      <EffortPicker
        value="low"
        available={["max", "off", "high", "low", "medium"]}
        onChange={noop}
      />,
    );
    const labels = screen.getAllByRole("radio").map((el) => el.textContent);
    expect(labels).toEqual(["Off", "Low", "Med", "High", "Max"]);
  });

  it("marks exactly the current value as checked", () => {
    render(
      <EffortPicker value="medium" available={["off", "low", "medium", "high"]} onChange={noop} />,
    );
    const checked = screen
      .getAllByRole("radio")
      .filter((el) => el.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0].textContent).toBe("Med");
  });

  it("renders nothing when the model cannot reason", () => {
    // A control with one option does nothing; showing it would be a lie.
    const { container } = render(
      <EffortPicker value="off" available={[]} onChange={noop} />,
    );
    expect(container.firstChild).toBeNull();
    const single = render(
      <EffortPicker value="high" available={["high"]} onChange={noop} />,
    );
    expect(single.container.firstChild).toBeNull();
  });

  it("reports the picked rung", () => {
    const onChange = vi.fn<(e: Effort) => void>();
    render(<EffortPicker value="off" available={["off", "low", "high"]} onChange={onChange} />);
    screen.getByRole("radio", { name: "High" }).click();
    expect(onChange).toHaveBeenCalledWith("high");
  });

  it("does not fire while disabled", () => {
    const onChange = vi.fn();
    render(
      <EffortPicker value="off" available={["off", "low"]} onChange={onChange} disabled />,
    );
    screen.getByRole("radio", { name: "Low" }).click();
    expect(onChange).not.toHaveBeenCalled();
  });
});
