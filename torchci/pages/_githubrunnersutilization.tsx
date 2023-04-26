import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import TablePanel from "components/metrics/panels/TablePanel";
import { RocksetParam } from "lib/rockset";
import { durationDisplay } from "components/TimeUtils";
import { TimeRangePicker } from "./metrics";
import { useState } from "react";
import dayjs from "dayjs";
import {
  Grid,
} from "@mui/material";

const ROW_HEIGHT = 340;

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

  return (
    <div>
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
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
        queryParams={timeParams}
      />
    </Grid>
    </div>
  );
}
