import { useSettings } from "../../hooks/useSettings";
import { type EvidenceRecordingPolicy } from "../../lib/runbooks";
import { S } from "../../lib/strings";
import { useAppStore } from "../../stores/appStore";
import { Field, Toggle, inputClass } from "../ui/Row";

/** The three policies, least to most retaining, with their copy attached.
 *
 * A list rather than a lookup keyed by the stored value: the value arrives from
 * the settings store as a plain string, and indexing a copy map with it would
 * be an unchecked object access for no gain. Here the union is checked at the
 * literals and the order is the order the picker shows. */
const RECORDING_CHOICES: {
  value: EvidenceRecordingPolicy;
  label: string;
  description: string;
}[] = [
  {
    value: "none",
    label: S.settings.runbooks.recordingOptions.none,
    description: S.settings.runbooks.recordingDescriptions.none,
  },
  {
    value: "runbook",
    label: S.settings.runbooks.recordingOptions.runbook,
    description: S.settings.runbooks.recordingDescriptions.runbook,
  },
  {
    value: "all",
    label: S.settings.runbooks.recordingOptions.all,
    description: S.settings.runbooks.recordingDescriptions.all,
  },
];

/** Capability gate for the experimental Runbooks subsystem.
 *
 * The switch only controls discovery in the webview. Rust independently checks
 * `runbooks_enabled` on every IPC entry point because a stale or modified
 * frontend must not be able to import definitions or drive a terminal while
 * the feature is disabled.
 */
export function RunbooksSettings() {
  const enabled = useAppStore((s) => s.runbooksEnabled);
  const recording = useAppStore((s) => s.runbooksOutputRecording);
  const { save } = useSettings();

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          {S.settings.runbooks.title}
        </h3>
        <p className="text-[11px] leading-relaxed text-text-secondary">
          {S.settings.runbooks.intro}
        </p>
        <Toggle
          label={S.settings.runbooks.enable}
          hint={S.settings.runbooks.enableHint}
          checked={enabled}
          onChange={(value) => void save({ runbooks_enabled: value })}
        />
      </section>

      {enabled && (
        <section className="space-y-3">
          <Field
            label={S.settings.runbooks.recording}
            hint={S.settings.runbooks.recordingHint}
          >
            <select
              className={inputClass}
              value={recording}
              onChange={(event) =>
                void save({ runbooks_output_recording: event.target.value })
              }
            >
              {RECORDING_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-[11px] leading-relaxed text-text-secondary">
            {RECORDING_CHOICES.find((choice) => choice.value === recording)?.description}
          </p>
          <p className="text-[10px] leading-relaxed text-text-muted">
            {S.settings.runbooks.recordingRetention}
          </p>
        </section>
      )}

      <p className="rounded-md border border-border-subtle bg-bg-card px-3 py-2 text-[11px] leading-relaxed text-text-muted">
        {enabled ? S.settings.runbooks.enabledNotice : S.settings.runbooks.disabledNotice}
      </p>
    </div>
  );
}
