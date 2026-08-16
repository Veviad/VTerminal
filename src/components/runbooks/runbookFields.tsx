/**
 * Form primitives shared by the wizard stages and the remediation editor.
 *
 * Extracted so the two can live in separate files without either owning the
 * other's styling — a second copy of `fieldClass` is how two panes of the same
 * dialog start looking subtly different.
 */

export const fieldClass =
  "mt-1 w-full rounded-md border border-border-subtle bg-bg-card px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent";
export const labelClass = "block text-[9px] text-text-muted";

export function TextField({ inputId, label, value, placeholder, onChange }: {
  inputId?: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return <label className={labelClass}>{label}<input id={inputId} className={fieldClass} value={value} placeholder={placeholder} onChange={(event) => {
    onChange(event.target.value);
  }} /></label>;
}

/** Exit codes from a comma-separated list. Non-integers are dropped rather than
 *  becoming NaN, which serializes to `null` and fails validation confusingly. */
export function parseCodes(value: string): number[] {
  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item));
}

/** `VRUN_NAME=inputId` per line. Values never reach the command text itself. */
export function parseMappings(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split("\n")
      .map((line) => line.split("=", 2).map((part) => part.trim()))
      .filter(([name, id]) => Boolean(name && id)),
  );
}
