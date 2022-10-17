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

const LASTEST_N_RUNS = 50;
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
  data,
  // Human-readable title of the panel.
  title,
  // What field name to treat as the time value.
  timeFieldName,
  // What field name to put on the y axis.
  yAxisFieldName,
  // What label to put on the y axis.
  yAxisLabel,
}: {
  data: any;
  title: string;
  timeFieldName: string;
  yAxisFieldName: string;
  yAxisLabel?: string;
}) {
  const chartData = [];
  for (const e of data) {
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
  workflowIds,
  jobIds,
}: {
  workflowName: string;
  jobName: string;
  testFile: string;
  testClass: string;
  workflowIds: string[];
  jobIds: string[];
}) {
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
        data={transformedData}
        title={"CPU usage (%)"}
        timeFieldName={"timestamp"}
        yAxisFieldName={"cpu"}
      />

      <DisplayInsights
        data={transformedData}
        title={"Memory usage"}
        timeFieldName={"timestamp"}
        yAxisFieldName={"mem"}
        yAxisLabel={"GB"}
      />

      <DisplayInsights
        data={transformedData}
        title={"GPU usage (%)"}
        timeFieldName={"timestamp"}
        yAxisFieldName={"gpu"}
      />

      <DisplayInsights
        data={transformedData}
        title={"GPU memory usage"}
        timeFieldName={"timestamp"}
        yAxisFieldName={"gpu_mem"}
        yAxisLabel={"GB"}
      />
    </Grid>
  );
}

function GetJobs({
  jobName,
  workflowName,
  testFile,
  testClass,
  workflowId,
  jobId,
  queryParams,
}: {
  jobName: string;
  workflowName?: string;
  testFile?: string;
  testClass?: string;
  workflowId?: string;
  jobId?: string;
  queryParams: RocksetParam[];
}) {
  const queryCollection = "commons";
  const queryName = "test_insights_latest_runs";

  const workflowIds = [];
  const jobIds = [];

  // If there is no workflow and job ID specified, query Rockset for the list of N latest jobs
  if (workflowId == null || jobId == null) {
    const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
      JSON.stringify(queryParams)
    )}`;

    const { data } = useSWR(url, fetcher);
    if (data === undefined || data.length == 0) {
      return (<div></div>);
    }

    for (const e of data) {
      workflowIds.push(e["workflow_id"]);
      jobIds.push(e["job_id"]);
    }
  }
  else {
    workflowIds.push(workflowId);
    jobIds.push(jobId);
  }

  return (
    <Stack direction="column" spacing={2} sx={{ mb: 2 }}>
      <Typography fontSize={"2rem"} fontWeight={"bold"}>
        {jobName}
      </Typography>

      <GetUsage
        workflowName={workflowName}
        jobName={jobName}
        testFile={testFile}
        testClass={testClass}
        workflowIds={workflowIds}
        jobIds={jobIds}
      />
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
  const workflowId = router.query.workflowId as string;
  const jobId = router.query.jobId as string;

  if (jobName === undefined) {
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
    <GetJobs
      jobName={jobName}
      workflowName={workflowName}
      testFile={testFile}
      testClass={testClass}
      workflowId={workflowId}
      jobId={jobId}
      queryParams={queryParams}
    />
  );
}
