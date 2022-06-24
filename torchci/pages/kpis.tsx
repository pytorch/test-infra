import React, { useState } from "react";
import {
  Grid,
  Paper,
  TextField,
  Typography,
  Stack,
  Skeleton,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  SelectChangeEvent,
} from "@mui/material";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { RocksetParam } from "lib/rockset";
import { durationDisplay } from "components/TimeUtils";
const ROW_HEIGHT = 340;

export default function Kpis() {
  const [startTime, setStartTime] = useState(dayjs().startOf("year"));
  const [stopTime, setStopTime] = useState(dayjs());

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
    <Grid container spacing={2}>
      <Grid item lg={true} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"Percent Jobs Red Over Time"}
          queryName={"master_jobs_red"}
          queryParams={[
            {
              name: "timezone",
              type: "string",
              value: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
            ...timeParams,
          ]}
          interpolateData={false}
          granularity={"week"}
          groupByFieldName={""}
          timeFieldName={"granularity_bucket"}
          yAxisFieldName={"red"}
          yAxisRenderer={(unit) => {
            return `${unit * 100} %`;
          }}
        />
      </Grid>
      <Grid item lg={true} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"Percent Commits Red Over Time"}
          queryName={"master_commit_red_percent"}
          queryParams={[
            {
              name: "timezone",
              type: "string",
              value: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
            ...timeParams,
          ]}
          interpolateData={false}
          granularity={"week"}
          groupByFieldName={""}
          timeFieldName={"granularity_bucket"}
          yAxisFieldName={"red"}
          yAxisRenderer={(unit) => {
            return `${unit * 100} %`;
          }}
        />
      </Grid>
    </Grid>
  );
}
