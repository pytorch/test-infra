import dayjs from "dayjs";
import {
  Divider,
  Grid,
  Stack,
  Typography,
} from "@mui/material";
import { useRouter } from "next/router";
import { RocksetParam } from "lib/rockset";
import { fetcher } from "lib/GeneralUtils";
import useSWR from "swr";
import { useState } from "react";
import fetchS3Links from "lib/fetchS3Links";
import { TimeSeriesPanelWithData } from "components/metrics/panels/TimeSeriesPanel";

const LASTEST_N_RUNS = 20;
const ROW_HEIGHT = 240;
const TO_GB = 1024 * 1024 * 1024;

function formatSeries(
  data: any,
) {
  return {
    type: "line",
    symbol: "circle",
    symbolSize: 4,
    data,
    emphasis: {
      focus: "series",
    },
  };
}

function DisplayInsights({
  rocksetData,
  // Human-readable title of the panel.
  title,
  // What field name to treat as the time value.
  timeFieldName,
  // What field name to put on the y axis.
  yAxisFieldName,
  // What label to put on the y axis.
  yAxisLabel,
}: {
  rocksetData: any;
  title: string;
  timeFieldName: string;
  yAxisFieldName: string;
  yAxisLabel?: string;
}) {
  const chartData = [];
  for (const e of rocksetData) {
    chartData.push([e[timeFieldName], e[yAxisFieldName]]);
  }
  const chartSeries = formatSeries(chartData);

  return (
    <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
      <TimeSeriesPanelWithData
        data={chartData}
        series={chartSeries}
        title={title}
        yAxisLabel={yAxisLabel}
        yAxisRenderer={(unit) => `${unit}`}
      />
    </Grid>
  );
}

function GetUsage({
  workflowName,
  jobName,
  testFile,
  testClass,
  rocksetData,
}: {
  workflowName: string;
  jobName: string;
  testFile: string;
  testClass: string;
  rocksetData: any;
}) {
  const workflowIds = [];
  const jobIds = [];

  for (const e of rocksetData) {
    workflowIds.push(e["workflow_id"]);
    jobIds.push(e["job_id"]);
  }

  const params = {
    workflowName: workflowName,
    jobName: jobName,
    testFile: testFile,
    testClass: testClass,
    workflowIds: workflowIds,
    jobIds: jobIds,
  };

  const url = `/api/usage-log-aggregator/lambda?params=${encodeURIComponent(
    JSON.stringify(params)
  )}`;
  const { data } = useSWR(url, fetcher);

  if (data === undefined || data.length == 0) {
    return (<div></div>);
  }

  const transformedData = [];
  // Transform the data a bit to fit into the same rockset schema
  for (var idx in data["timestamp"]) {
    transformedData.push({
      timestamp: data["timestamp"][idx],
      cpu: data["cpu"][idx],
      mem: data["mem"][idx] / TO_GB,
      gpu: data["gpu"][idx],
      gpu_mem: data["gpu_mem"][idx] / TO_GB,
    });
  }

  return (
    <Grid container spacing={2}>
      <DisplayInsights
        rocksetData={transformedData}
        title={"CPU usage (%)"}
        timeFieldName={"timestamp"}
        yAxisFieldName={"cpu"}
      />

      <DisplayInsights
        rocksetData={transformedData}
        title={"Memory usage"}
        timeFieldName={"timestamp"}
        yAxisFieldName={"mem"}
        yAxisLabel={"GB"}
      />

      <DisplayInsights
        rocksetData={transformedData}
        title={"GPU usage (%)"}
        timeFieldName={"timestamp"}
        yAxisFieldName={"gpu"}
      />

      <DisplayInsights
        rocksetData={transformedData}
        title={"GPU memory usage"}
        timeFieldName={"timestamp"}
        yAxisFieldName={"gpu_mem"}
        yAxisLabel={"GB"}
      />
    </Grid>
  );
}

function GetLatestRuns({
  workflowName,
  jobName,
  testFile,
  testClass,
  queryParams,
}: {
  workflowName: string;
  jobName: string;
  testFile: string;
  testClass: string;
  queryParams: RocksetParam[];
}) {
  const queryCollection = "commons";
  const queryName = "test_insights_latest_runs";

  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data } = useSWR(url, fetcher);
  if (data === undefined || data.length == 0) {
    return (<div></div>);
  }

  return (
    <Stack direction="column" spacing={2} sx={{ mb: 2 }}>
      <Typography fontSize={"2rem"} fontWeight={"bold"}>
        {jobName}: {testFile}.{testClass}
      </Typography>

      <Grid container spacing={2}>
        <Grid container spacing={2}>
          <DisplayInsights
            rocksetData={data}
            title={"Test Duration"}
            timeFieldName={"_event_time"}
            yAxisFieldName={"time"}
            yAxisLabel={"Seconds"}
          />

          <DisplayInsights
            rocksetData={data}
            title={"# of tests"}
            timeFieldName={"_event_time"}
            yAxisFieldName={"tests"}
          />

          <DisplayInsights
            rocksetData={data}
            title={"# of test failures"}
            timeFieldName={"_event_time"}
            yAxisFieldName={"failures"}
          />

          <DisplayInsights
            rocksetData={data}
            title={"# of unexpected errors"}
            timeFieldName={"_event_time"}
            yAxisFieldName={"errors"}
          />

          <DisplayInsights
            rocksetData={data}
            title={"# of skipped tests"}
            timeFieldName={"_event_time"}
            yAxisFieldName={"skipped"}
          />
        </Grid>

        <GetUsage
          workflowName={workflowName}
          jobName={jobName}
          testFile={testFile}
          testClass={testClass}
          rocksetData={data}
        />
      </Grid>
    </Stack>
  );
}

export default function Page() {
  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());

  const router = useRouter();
  // Need all these parameters to narrow down the test selection
  const workflowName = router.query.workflowName as string;
  const jobName = router.query.jobName as string;
  const testFile = router.query.testFile as string;
  const testClass = router.query.testClass as string;

  if (workflowName === undefined || jobName === undefined || testFile === undefined || testClass === undefined) {
    return;
  }

  const queryParams: RocksetParam[] = [
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
      name: "workflowName",
      type: "string",
      value: workflowName,
    },
    {
      name: "jobName",
      type: "string",
      value: jobName,
    },
    {
      name: "testFile",
      type: "string",
      value: testFile,
    },
    {
      name: "testClass",
      type: "string",
      value: testClass,
    },
    {
      name: "limit",
      type: "int",
      value: LASTEST_N_RUNS,
    },
  ];

  return (
    <GetLatestRuns
      workflowName={workflowName}
      jobName={jobName}
      testFile={testFile}
      testClass={testClass}
      queryParams={queryParams}
    />
  );
}
