import { Box } from "@mui/material";
import KeyButton from "components/tests/cost/KeyButton";
import type { WorkflowPreset } from "lib/api/tests/cost/types";
import { isScope } from "lib/tests/cost/runnerHours";

// The workflow scope keys: every workflow, each preset, and the custom scope
// ticked in the workflows card, shown only while it is in force.
export default function ScopeKeys({
  presets,
  scope,
  scopeLabel,
  onScopeChange,
  showCustom,
}: {
  presets: WorkflowPreset[];
  scope: readonly string[];
  scopeLabel: string;
  onScopeChange: (_workflows: string[]) => void;
  showCustom: boolean;
}) {
  const preset = presets.find((p) => isScope(scope, p.workflows));
  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
      <KeyButton
        title="Every workflow"
        active={scope.length === 0}
        onClick={() => onScopeChange([])}
      >
        All workflows
      </KeyButton>
      {presets.map((p) => (
        <KeyButton
          key={p.value}
          title={`${p.workflows.join(" + ")}: ${p.description}`}
          active={preset?.value === p.value}
          onClick={() => onScopeChange([...p.workflows])}
        >
          {p.label}
        </KeyButton>
      ))}
      {showCustom && scope.length > 0 && preset === undefined && (
        <KeyButton
          title="Workflows ticked below"
          active
          onClick={() => undefined}
        >
          Custom: {scopeLabel}
        </KeyButton>
      )}
    </Box>
  );
}
