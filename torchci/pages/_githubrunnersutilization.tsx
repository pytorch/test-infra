import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import TablePanel from "components/metrics/panels/TablePanel";
import { RocksetParam } from "lib/rockset";
import { durationDisplay } from "components/TimeUtils";
import { TimeRangePicker } from "./metrics";
import { useState } from "react";
import dayjs from "dayjs";
import {
  Grid,
  Stack,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  SelectChangeEvent,
} from "@mui/material";

const ROW_HEIGHT = 340;

/**
 * Allows the user to pick the TTS metrics.
 */
export function RunnerTypePicker({
  runnerType,
  setRunnerType,
}: {
  runnerType: string;
  setRunnerType: any;
}) {
  function handleChange(e: SelectChangeEvent<string>) {
    setRunnerType(e.target.value as string);
  }

  return (
    <>
      <FormControl>
        <InputLabel id="github-runner-type-picker-select-label">
          Runner Type
        </InputLabel>
        <Select
          defaultValue={runnerType}
          label="Runner Type"
          labelId="github-runner-type-picker-select-label"
          onChange={handleChange}
        >
          <MenuItem value={"macos-12"}>MacOS 12</MenuItem>
          <MenuItem value={"macos-12-xl"}>MacOS 12 XL</MenuItem>
          <MenuItem value={"ubuntu-20.04"}>Ubuntu 20.04</MenuItem>
          <MenuItem value={"ubuntu-22.04"}>Ubuntu 22.04</MenuItem>
          <MenuItem value={"ubuntu-latest"}>Ubuntu Latest</MenuItem>
          <MenuItem value={"windows-2019"}>Windows 2019</MenuItem>
        </Select>
      </FormControl>
    </>
  );
}

export default function Page() {
  const [startTime, setStartTime] = useState(dayjs().subtract(30, "day"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [timeRange, setTimeRange] = useState<number>(30);

  const timeParams: RocksetParam[] = [
    {
      name: "startTime",
      type: "string",
      value: startTime,
    },
    {
      name: "stopTime",
      type: "string",
      value: stopTime,
    },
  ];
  const [runnerType, setRunnerType] = useState<string>("macos-12-xl");

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
        <RunnerTypePicker
          runnerType={runnerType}
          setRunnerType={setRunnerType}
        />
      </Stack>
      <Grid item xs={6} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"Runners utilization daily"}
          queryCollection={"utilization"}
          queryName={"runner_utilization"}
          groupByFieldName={"label"}
          granularity={"day"}
          timeFieldName={"started_date"}
          yAxisFieldName={"duration"}
          yAxisRenderer={durationDisplay}
          queryParams={[
            {
              name: "timezone",
              type: "string",
              value: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
            ...timeParams,
          ]}
        />
      </Grid>
      <Grid item xs={6} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"Runners utilization daily by repo"}
          queryCollection={"utilization"}
          queryName={"runner_utilization_by_repo"}
          groupByFieldName={"project"}
          granularity={"day"}
          timeFieldName={"started_date"}
          yAxisFieldName={"duration"}
          yAxisRenderer={durationDisplay}
          queryParams={[
            {
              name: "timezone",
              type: "string",
              value: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
            {
              name: "label",
              type: "string",
              value: runnerType,
            },
            ...timeParams,
          ]}
        />
      </Grid>
      <Grid item xs={6} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"Runners utilization daily by activity on PyTorch"}
          queryCollection={"utilization"}
          queryName={"runner_utilization_by_activity"}
          groupByFieldName={"activity"}
          granularity={"day"}
          timeFieldName={"started_date"}
          yAxisFieldName={"duration"}
          yAxisRenderer={durationDisplay}
          queryParams={[
            {
              name: "timezone",
              type: "string",
              value: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
            {
              name: "label",
              type: "string",
              value: runnerType,
            },
            ...timeParams,
          ]}
        />
      </Grid>
    </div>
  );
}
