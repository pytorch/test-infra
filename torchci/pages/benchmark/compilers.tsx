import dayjs from "dayjs";
import ReactECharts from "echarts-for-react";
import { EChartsOption } from "echarts";
import useSWR from "swr";
import _ from "lodash";
import {
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  SelectChangeEvent,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import React from "react";
import { useCallback, useRef, useState } from "react";
import { RocksetParam } from "lib/rockset";
import { fetcher } from "lib/GeneralUtils";
import {
  Granularity,
  TimeSeriesPanelWithData,
  seriesWithInterpolatedTimes,
} from "components/metrics/panels/TimeSeriesPanel";
import { TimeRangePicker } from "../metrics";
import { CompilerPerformanceData } from "lib/types";

const LAST_WEEK = 7;
const ROW_HEIGHT = 340;
const ROW_GAP = 30;

function GranularityPicker({
  granularity,
  setGranularity,
}: {
  granularity: string;
  setGranularity: any;
}) {
  function handleChange(e: SelectChangeEvent<string>) {
    setGranularity(e.target.value);
  }
  return (
    <FormControl>
      <InputLabel id="granularity-select-label">Granularity</InputLabel>
      <Select
        value={granularity}
        label="Granularity"
        labelId="granularity-select-label"
        onChange={handleChange}
      >
        <MenuItem value={"month"}>month</MenuItem>
        <MenuItem value={"week"}>week</MenuItem>
        <MenuItem value={"day"}>day</MenuItem>
      </Select>
    </FormControl>
  );
}

function getPassModels(data: any) {
  const passModels = {};

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const testName = `${record.suite} / ${record.compiler}`;
    const modelName = record.name;
    const accuracy = record.accuracy;

    if (!(bucket in passModels)) {
      passModels[bucket] = {}
    }

    if (!(workflowId in passModels[bucket])) {
      passModels[bucket][workflowId] = {}
    }

    if (!(testName in passModels[bucket][workflowId])) {
      passModels[bucket][workflowId][testName] = new Set<string>();
    }

    if (accuracy === "pass" || accuracy === "pass_due_to_skip") {
      passModels[bucket][workflowId][testName].add(modelName);
    }
  });

  return passModels;
}

function isPass(bucket, workflowId, testName, modelName, passModels) {
  return passModels[bucket][workflowId][testName].has(modelName);
}

function computePassrate(data: any, passModels) {
  const totalCount = {};
  const passCount = {};

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const testName = `${record.suite} / ${record.compiler}`;
    const modelName = record.name;

    if (!(bucket in totalCount)) {
      totalCount[bucket] = {};
      passCount[bucket] = {};
    }

    if (!(workflowId in totalCount[bucket])) {
      totalCount[bucket][workflowId] = {};
      passCount[bucket][workflowId] = {};
    }

    if (!(testName in totalCount[bucket][workflowId])) {
      totalCount[bucket][workflowId][testName] = 0;
      passCount[bucket][workflowId][testName] = 0;
    }

    if (isPass(bucket, workflowId, testName, modelName, passModels)) {
      passCount[bucket][workflowId][testName] += 1;
    }

    totalCount[bucket][workflowId][testName] += 1;
  });

  const passrate = [];

  Object.keys(totalCount).forEach((bucket: string) => {
    Object.keys(totalCount[bucket]).forEach((workflowId: string) => {
      Object.keys(totalCount[bucket][workflowId]).forEach((testName: string) => {
        const p = passCount[bucket][workflowId][testName] / totalCount[bucket][workflowId][testName];
        passrate.push({
          "granularity_bucket": bucket,
          "workflow_id": workflowId,
          "test_name": testName,
          "passrate": p,
        });
      })
    })
  });

  return passrate;
}

function PerformanceGraphs({
  queryParams,
  granularity,
}: {
  queryParams: RocksetParam[];
  granularity: Granularity;
}) {
  const queryName = "compilers_benchmark_performance";
  const queryCollection = "inductor";

  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;
  const { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (error !== undefined) {
    return (
      <div>
        An error occurred while fetching data, perhaps there are too many
        results with your choice of time range and granularity?
      </div>
    );
  }
  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from Rockset
  const startTime = dayjs(
    queryParams.find((p) => p.name === "startTime")?.value
  ).startOf(granularity);
  const stopTime = dayjs(
    queryParams.find((p) => p.name === "stopTime")?.value
  ).startOf(granularity);

  const passModels = getPassModels(data);

  const timeFieldName = "granularity_bucket";
  const groupByFieldName = "test_name";

  const passrate = computePassrate(data, passModels);
  const series = seriesWithInterpolatedTimes(
    passrate,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    timeFieldName,
    "passrate",
  );

  return (
    <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
      <TimeSeriesPanelWithData
        data={passrate}
        series={series}
        title={"Passrate"}
        yAxisLabel={"%"}
        groupByFieldName={groupByFieldName}
        yAxisRenderer={(unit) => {
          return `${unit * 100} %`;
        }}
      />
    </Grid>
  );
}

export default function Page() {
  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [granularity, setGranularity] = useState<Granularity>("day");

  const queryParams: RocksetParam[] = [
    {
      name: "timezone",
      type: "string",
      value: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
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
    {
      name: "granularity",
      type: "string",
      value: granularity,
    },
  ];

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          TorchDynamo Performance DashBoard
        </Typography>
        <TimeRangePicker
          startTime={startTime}
          stopTime={stopTime}
          setStartTime={setStartTime}
          setStopTime={setStopTime}
          defaultValue={LAST_WEEK}
        />
        <GranularityPicker
          granularity={granularity}
          setGranularity={setGranularity}
        />
      </Stack>

      <Grid item xs={6} height={ROW_HEIGHT + ROW_GAP}>
        <PerformanceGraphs
          queryParams={queryParams}
          granularity={granularity}
        />
      </Grid>
    </div>
  );
}
