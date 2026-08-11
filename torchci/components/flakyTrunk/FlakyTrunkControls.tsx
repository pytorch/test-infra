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
import { DENOMINATOR_OPTIONS, DenominatorKey } from "./common";

export default function FlakyTrunkControls({
  startTime,
  setStartTime,
  stopTime,
  setStopTime,
  timeRange,
  setTimeRange,
  granularity,
  setGranularity,
  denominator,
  setDenominator,
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
  denominator: DenominatorKey;
  setDenominator: (_: DenominatorKey) => void;
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
      <ToggleButtonGroup
        exclusive
        value={denominator}
        onChange={(_event, newDenominator: DenominatorKey | null) => {
          if (newDenominator !== null) {
            setDenominator(newDenominator);
          }
        }}
        sx={{ height: 56 }}
      >
        {DENOMINATOR_OPTIONS.map((option) => (
          <ToggleButton key={option.value} value={option.value}>
            {option.label}
          </ToggleButton>
        ))}
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
