import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { JsonEditor, KeyValueEditor } from "../components/settings/McpSettings";

function EnvironmentHarness() {
  const [entries, setEntries] = useState([
    { name: "TOKEN", value: "plain-value", secret: false },
  ]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  return (
    <KeyValueEditor
      label="Environment variables"
      entries={entries}
      slotPrefix="env"
      forceSecret={false}
      keyPlaceholder="NAME"
      valuePlaceholder="Stored in vault"
      addLabel="Add environment variable"
      secrets={secrets}
      setSecrets={setSecrets}
      onChange={(next) =>
        setEntries(
          next.map((entry) => ({
            name: entry.name,
            value: entry.value ?? "",
            secret: Boolean(entry.secret),
          })),
        )
      }
    />
  );
}

function HeaderHarness() {
  const [entries, setEntries] = useState([{ name: "X-Token" }]);
  const [secrets, setSecrets] = useState<Record<string, string>>({
    "header:X-Token": "vault-value",
  });
  return (
    <KeyValueEditor
      label="Custom secret headers"
      entries={entries}
      slotPrefix="header"
      forceSecret
      keyPlaceholder="Header name"
      valuePlaceholder="Value (stored in vault)"
      addLabel="Add header"
      secrets={secrets}
      setSecrets={setSecrets}
      onChange={(next) => setEntries(next.map(({ name }) => ({ name })))}
    />
  );
}

describe("MCP key/value editor", () => {
  it("moves environment values into and out of secret storage", () => {
    render(<EnvironmentHarness />);
    const toggle = screen.getByRole("checkbox");

    fireEvent.click(toggle);
    const secret = screen.getByPlaceholderText("Stored in vault");
    expect(secret).toHaveAttribute("type", "password");
    expect(secret).toHaveValue("plain-value");

    fireEvent.click(toggle);
    const plain = screen.getByPlaceholderText("Value");
    expect(plain).toHaveAttribute("type", "text");
    expect(plain).toHaveValue("plain-value");
  });

  it("retains a header secret when its name changes", () => {
    render(<HeaderHarness />);
    fireEvent.change(screen.getByPlaceholderText("Header name"), {
      target: { value: "X-Renamed-Token" },
    });
    expect(screen.getByPlaceholderText("Value (stored in vault)")).toHaveValue(
      "vault-value",
    );
  });
});

function JsonHarness() {
  const [value, setValue] = useState('{"name":"Calendar","enabled":true}');
  return <JsonEditor value={value} onChange={setValue} />;
}

describe("MCP JSON editor", () => {
  it("formats valid JSON and reports invalid input", () => {
    render(<JsonHarness />);

    expect(screen.getByRole("status")).toHaveTextContent("Valid JSON");
    fireEvent.click(screen.getByRole("button", { name: "Format JSON" }));
    expect(screen.getByRole("textbox", { name: "MCP JSON configuration" })).toHaveValue(
      '{\n  "name": "Calendar",\n  "enabled": true\n}',
    );

    fireEvent.change(screen.getByRole("textbox", { name: "MCP JSON configuration" }), {
      target: { value: '{"name":}' },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Check JSON");
    expect(screen.getByRole("button", { name: "Format JSON" })).toBeDisabled();
  });
});
