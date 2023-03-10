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
const ROW_HEIGHT = 240;
const ROW_GAP = 30;

const COMPILERS = ["eager", "aot_eager", "inductor", "inductor_no_cudagraphs"];
const SUITES = ["torchbench", "huggingface", "timm_models"];

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
    const suite = record.suite;
    const compiler = record.compiler;
    const model = record.name;
    const accuracy = record.accuracy;

    if (!(bucket in passModels)) {
      passModels[bucket] = {};
    }

    if (!(workflowId in passModels[bucket])) {
      passModels[bucket][workflowId] = {};
    }

    if (!(suite in passModels[bucket][workflowId])) {
      passModels[bucket][workflowId][suite] = {};
    }

    if (!(compiler in passModels[bucket][workflowId][suite])) {
      passModels[bucket][workflowId][suite][compiler] = new Set<string>();
    }

    if (accuracy === "pass" || accuracy === "pass_due_to_skip") {
      passModels[bucket][workflowId][suite][compiler].add(model);
    }
  });

  return passModels;
}

function isPass(bucket, workflowId, suite, compiler, model, passModels) {
  return passModels[bucket][workflowId][suite][compiler].has(model);
}

function computePassrate(data: any, passModels) {
  const totalCount = {};
  const passCount = {};

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const compiler = record.compiler;
    const model = record.name;

    if (!(bucket in totalCount)) {
      totalCount[bucket] = {};
      passCount[bucket] = {};
    }

    if (!(workflowId in totalCount[bucket])) {
      totalCount[bucket][workflowId] = {};
      passCount[bucket][workflowId] = {};
    }

    if (!(suite in totalCount[bucket][workflowId])) {
      totalCount[bucket][workflowId][suite] = {};
      passCount[bucket][workflowId][suite] = {};
    }

    if (!(compiler in totalCount[bucket][workflowId][suite])) {
      totalCount[bucket][workflowId][suite][compiler] = 0;
      passCount[bucket][workflowId][suite][compiler] = 0;
    }

    if (isPass(bucket, workflowId, suite, compiler, model, passModels)) {
      passCount[bucket][workflowId][suite][compiler] += 1;
    }

    totalCount[bucket][workflowId][suite][compiler] += 1;
  });

  const passrateBySuite = {};

  Object.keys(totalCount).forEach((bucket: string) => {
    Object.keys(totalCount[bucket]).forEach((workflowId: string) => {
      Object.keys(totalCount[bucket][workflowId]).forEach((suite: string) => {
        Object.keys(totalCount[bucket][workflowId][suite]).forEach(
          (compiler: string) => {
            const p =
              passCount[bucket][workflowId][suite][compiler] /
              totalCount[bucket][workflowId][suite][compiler];

            if (!(suite in passrateBySuite)) {
              passrateBySuite[suite] = [];
            }

            passrateBySuite[suite].push({
              granularity_bucket: bucket,
              compiler: compiler,
              passrate: p,
            });
          }
        );
      });
    });
  });

  return passrateBySuite;
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
  const groupByFieldName = "compiler";

  const passrateBySuite = computePassrate(data, passModels);
  const seriesBySuite = {};
  Object.keys(passrateBySuite).forEach((key) => {
    seriesBySuite[key] = seriesWithInterpolatedTimes(
      passrateBySuite[key],
      startTime,
      stopTime,
      granularity,
      groupByFieldName,
      timeFieldName,
      "passrate"
    );
  });

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} lg={4} height={ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={passrateBySuite["torchbench"]}
          series={seriesBySuite["torchbench"]}
          title={`Passrate / Torchbench`}
          yAxisLabel={"%"}
          groupByFieldName={groupByFieldName}
          yAxisRenderer={(unit) => {
            return `${(unit * 100).toFixed(0)} %`;
          }}
          additionalOptions={{
            yAxis: {
              min: 0.6,
              max: 1.0,
            },
          }}
        />
      </Grid>
      <Grid item xs={12} lg={4} height={ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={passrateBySuite["huggingface"]}
          series={seriesBySuite["huggingface"]}
          title={`Passrate / Huggingface`}
          yAxisLabel={"%"}
          groupByFieldName={groupByFieldName}
          yAxisRenderer={(unit) => {
            return `${(unit * 100).toFixed(0)} %`;
          }}
          additionalOptions={{
            yAxis: {
              min: 0.6,
              max: 1.0,
            },
          }}
        />
      </Grid>
      <Grid item xs={12} lg={4} height={ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={passrateBySuite["timm_models"]}
          series={seriesBySuite["timm_models"]}
          title={`Passrate / TIMM Models`}
          yAxisLabel={"%"}
          groupByFieldName={groupByFieldName}
          yAxisRenderer={(unit) => {
            return `${(unit * 100).toFixed(0)} %`;
          }}
          additionalOptions={{
            yAxis: {
              min: 0.6,
              max: 1.0,
            },
          }}
        />
      </Grid>
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
    {
      name: "dtypes",
      type: "string",
      value: "amp",
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
