import {
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
} from "@mui/material";
import { START_PRESETS, StartPreset } from "lib/triage/issueTriage";

export default function TriageControls({
  preset,
  startDate,
  onStartChange,
  includeChildren,
  onIncludeChildrenChange,
}: {
  preset: StartPreset;
  startDate: string;
  // The new `start` URL value: a preset name or a YYYY-MM-DD date.
  onStartChange: (_start: string) => void;
  // Page-wide: parent labels count their child labels' issues too.
  includeChildren: boolean;
  onIncludeChildrenChange: (_include: boolean) => void;
}) {
  return (
    <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
      <FormControl size="small" sx={{ minWidth: 240 }}>
        <InputLabel id="triage-start-label">Issues created since</InputLabel>
        <Select
          labelId="triage-start-label"
          label="Issues created since"
          value={preset}
          onChange={(e) => {
            const value = e.target.value as StartPreset;
            onStartChange(value === "custom" ? startDate : value);
          }}
        >
          {START_PRESETS.map((p) => (
            <MenuItem key={p.value} value={p.value}>
              {p.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      {preset === "custom" && (
        <TextField
          size="small"
          type="date"
          label="Start date"
          value={startDate}
          onChange={(e) => {
            if (e.target.value !== "") {
              onStartChange(e.target.value);
            }
          }}
          slotProps={{ inputLabel: { shrink: true } }}
        />
      )}
      <Tooltip title="On: a parent label (e.g. oncall: pt2) counts the issues of every label below it. Off: only the issues with the parent label and none of its children, i.e. not yet routed further.">
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={includeChildren}
              onChange={(e) => onIncludeChildrenChange(e.target.checked)}
            />
          }
          label="Include child labels"
        />
      </Tooltip>
    </Stack>
  );
}
