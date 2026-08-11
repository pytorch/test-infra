import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from "@mui/material";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import _ from "lodash";
import { TimeRangePicker } from "pages/metrics";
import React, { useCallback, useEffect, useState } from "react";
import { EntityKey, METRIC_OPTIONS, MetricKey } from "./common";

export default function FlakyTrunkControls({
  startTime,
  setStartTime,
  stopTime,
  setStopTime,
  timeRange,
  setTimeRange,
  granularity,
  setGranularity,
  metric,
  setMetric,
  entity,
  setEntity,
  minRuns,
  setMinRuns,
}: {
  startTime: dayjs.Dayjs;
  setStartTime: (_: dayjs.Dayjs) => void;
  stopTime: dayjs.Dayjs;
  setStopTime: (_: dayjs.Dayjs) => void;
  timeRange: number;
  setTimeRange: (_: number) => void;
  granularity: Granularity;
  setGranularity: (_: Granularity) => void;
  metric: MetricKey;
  setMetric: (_: MetricKey) => void;
  entity: EntityKey;
  setEntity: (_: EntityKey) => void;
  minRuns: number;
  setMinRuns: (_: number) => void;
}) {
  // Local input keeps the field responsive while committed changes are debounced
  // so the table query does not refetch on every keystroke.
  const [minRunsInput, setMinRunsInput] = useState(String(minRuns));
  useEffect(() => {
    setMinRunsInput(String(minRuns));
  }, [minRuns]);

  const debouncedSetMinRuns = useCallback(
    _.debounce((value: number) => setMinRuns(value), 500),
    []
  );

  const onMinRunsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setMinRunsInput(raw);
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      debouncedSetMinRuns(parsed);
    }
  };

  return (
    <Stack
      direction="row"
      spacing={2}
      alignItems="center"
      flexWrap="wrap"
      useFlexGap
    >
      <TimeRangePicker
        startTime={startTime}
        setStartTime={setStartTime}
        stopTime={stopTime}
        setStopTime={setStopTime}
        timeRange={timeRange}
        setTimeRange={setTimeRange}
      />
      <FormControl sx={{ minWidth: 120 }}>
        <InputLabel id="flaky-trunk-granularity-label">Granularity</InputLabel>
        <Select
          value={granularity}
          label="Granularity"
          labelId="flaky-trunk-granularity-label"
          onChange={(e) => setGranularity(e.target.value as Granularity)}
        >
          <MenuItem value={"day"}>Daily</MenuItem>
          <MenuItem value={"week"}>Weekly</MenuItem>
          <MenuItem value={"month"}>Monthly</MenuItem>
        </Select>
      </FormControl>
      <FormControl sx={{ minWidth: 220 }}>
        <InputLabel id="flaky-trunk-metric-label">Graph metric</InputLabel>
        <Select
          value={metric}
          label="Graph metric"
          labelId="flaky-trunk-metric-label"
          onChange={(e) => setMetric(e.target.value as MetricKey)}
        >
          {METRIC_OPTIONS.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {option.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <ToggleButtonGroup
        exclusive
        value={entity}
        onChange={(_event, newEntity: EntityKey | null) => {
          if (newEntity !== null) {
            setEntity(newEntity);
          }
        }}
        sx={{ height: 56 }}
      >
        <ToggleButton value="jobs">Jobs</ToggleButton>
        <ToggleButton value="labels">Runner labels</ToggleButton>
      </ToggleButtonGroup>
      <TextField
        label="Min runs"
        type="number"
        value={minRunsInput}
        onChange={onMinRunsChange}
        sx={{ width: 120 }}
        slotProps={{ htmlInput: { min: 0 } }}
      />
    </Stack>
  );
}
