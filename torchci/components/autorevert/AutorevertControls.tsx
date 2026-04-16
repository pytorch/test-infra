import {
  Autocomplete,
  Button,
  IconButton,
  TextField,
  Tooltip,
} from "@mui/material";
import { DateTimePicker, LocalizationProvider } from "@mui/x-date-pickers";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import styles from "./autorevert.module.css";

dayjs.extend(utc);

interface AutorevertControlsProps {
  timestamp: dayjs.Dayjs;
  onTimestampChange: (ts: dayjs.Dayjs) => void;
  availableWorkflows: string[];
  selectedWorkflows: string[];
  onWorkflowsChange: (workflows: string[]) => void;
  signalFilter: string;
  onSignalFilterChange: (filter: string) => void;
}

export default function AutorevertControls({
  timestamp,
  onTimestampChange,
  availableWorkflows,
  selectedWorkflows,
  onWorkflowsChange,
  signalFilter,
  onSignalFilterChange,
}: AutorevertControlsProps) {
  return (
    <div className={styles.controlsBar}>
      {/* Timestamp navigator */}
      <div className={styles.timestampNav}>
        <Tooltip title="Back 1 hour">
          <IconButton
            size="small"
            onClick={() => onTimestampChange(timestamp.subtract(1, "hour"))}
          >
            ◀◀
          </IconButton>
        </Tooltip>
        <Tooltip title="Back 5 minutes">
          <IconButton
            size="small"
            onClick={() => onTimestampChange(timestamp.subtract(5, "minute"))}
          >
            ◀
          </IconButton>
        </Tooltip>

        <LocalizationProvider dateAdapter={AdapterDayjs}>
          <DateTimePicker
            value={timestamp}
            onChange={(v) => v && onTimestampChange(v)}
            ampm={false}
            format="YYYY-MM-DD HH:mm"
            slotProps={{
              textField: {
                size: "small",
                sx: { width: 200, fontFamily: "monospace" },
              },
            }}
          />
        </LocalizationProvider>

        <Tooltip title="Forward 5 minutes">
          <IconButton
            size="small"
            onClick={() => onTimestampChange(timestamp.add(5, "minute"))}
          >
            ▶
          </IconButton>
        </Tooltip>
        <Tooltip title="Forward 1 hour">
          <IconButton
            size="small"
            onClick={() => onTimestampChange(timestamp.add(1, "hour"))}
          >
            ▶▶
          </IconButton>
        </Tooltip>

        <Tooltip title="Jump to now">
          <Button
            size="small"
            variant="outlined"
            onClick={() => onTimestampChange(dayjs())}
            sx={{ minWidth: 0, px: 1 }}
          >
            Now
          </Button>
        </Tooltip>
      </div>

      {/* Workflow filter */}
      <Autocomplete
        multiple
        size="small"
        options={availableWorkflows}
        value={selectedWorkflows}
        onChange={(_, newValue) => onWorkflowsChange(newValue)}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Workflows"
            placeholder="Filter workflows"
          />
        )}
        sx={{ minWidth: 280, maxWidth: 500 }}
        limitTags={2}
      />

      {/* Signal filter */}
      <TextField
        size="small"
        label="Signal filter"
        placeholder="e.g. test_cuda | inductor"
        value={signalFilter}
        onChange={(e) => onSignalFilterChange(e.target.value)}
        sx={{ width: 200 }}
      />
    </div>
  );
}
