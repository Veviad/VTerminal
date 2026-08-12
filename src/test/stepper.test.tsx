import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Stepper } from "../components/ui/Row";

// The stepper backs settings that reach 100 (agent max steps), so typing has to
// be a first-class way in — and each write goes to the Rust store, so a typed
// value must produce ONE write, not one per digit.
describe("Stepper", () => {
  const field = () => screen.getByRole("textbox") as HTMLInputElement;

  it("commits a typed value once, not per keystroke", () => {
    const onChange = vi.fn<(v: number) => void>();
    render(<Stepper value={10} min={1} max={100} step={5} onChange={onChange} />);
    // The digits of "100" land one at a time; none of the intermediates may save.
    fireEvent.change(field(), { target: { value: "1" } });
    fireEvent.change(field(), { target: { value: "10" } });
    fireEvent.change(field(), { target: { value: "100" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(field());
    expect(onChange.mock.calls).toEqual([[100]]);
  });

  it("clamps typed values into range", () => {
    const onChange = vi.fn<(v: number) => void>();
    render(<Stepper value={10} min={1} max={100} step={5} onChange={onChange} />);
    fireEvent.change(field(), { target: { value: "500" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(100);
  });

  it("rejects non-digits instead of committing NaN", () => {
    const onChange = vi.fn<(v: number) => void>();
    render(<Stepper value={10} min={1} max={100} step={5} onChange={onChange} />);
    fireEvent.change(field(), { target: { value: "1e-2x" } });
    expect(field().value).toBe("12");
    // A cleared field is not a value — it reverts rather than saving 0 or NaN.
    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.blur(field());
    expect(onChange).not.toHaveBeenCalled();
    expect(field().value).toBe("10");
  });

  it("steps by `step`, not by one", () => {
    const onChange = vi.fn<(v: number) => void>();
    render(<Stepper value={10} min={1} max={100} step={5} onChange={onChange} />);
    screen.getByRole("button", { name: "+5" }).click();
    expect(onChange).toHaveBeenLastCalledWith(15);
    screen.getByRole("button", { name: "−5" }).click();
    expect(onChange).toHaveBeenLastCalledWith(5);
  });

  it("jumps by ten steps with shift, and clamps at the ends", () => {
    const onChange = vi.fn<(v: number) => void>();
    render(<Stepper value={10} min={1} max={100} step={5} onChange={onChange} />);
    fireEvent.keyDown(field(), { key: "ArrowUp", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(60);
    fireEvent.keyDown(field(), { key: "ArrowDown", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith(15);
  });

  it("escape discards the draft — including on the blur it triggers", () => {
    // The blur handler runs inside the Escape keydown, before React has applied
    // the reverted draft; without the latch it would save the discarded text.
    const onChange = vi.fn<(v: number) => void>();
    render(<Stepper value={10} min={1} max={100} step={5} onChange={onChange} />);
    fireEvent.change(field(), { target: { value: "77" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    fireEvent.blur(field());
    expect(onChange).not.toHaveBeenCalled();
    expect(field().value).toBe("10");
  });

  it("enter commits exactly once despite the blur it triggers", () => {
    const onChange = vi.fn<(v: number) => void>();
    render(<Stepper value={10} min={1} max={100} step={5} onChange={onChange} />);
    fireEvent.change(field(), { target: { value: "42" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.blur(field());
    expect(onChange.mock.calls).toEqual([[42]]);
  });

  it("steps from typed text rather than the unsaved prop", () => {
    // ± keeps focus (no blur commit), so the click must build on the draft.
    const onChange = vi.fn<(v: number) => void>();
    render(<Stepper value={10} min={1} max={100} step={5} onChange={onChange} />);
    fireEvent.change(field(), { target: { value: "80" } });
    screen.getByRole("button", { name: "+5" }).click();
    expect(onChange.mock.calls).toEqual([[85]]);
  });

  it("defaults to single steps for callers that want them", () => {
    const onChange = vi.fn<(v: number) => void>();
    render(<Stepper value={13} min={10} max={20} onChange={onChange} />);
    screen.getByRole("button", { name: "+1" }).click();
    expect(onChange).toHaveBeenLastCalledWith(14);
  });
});
