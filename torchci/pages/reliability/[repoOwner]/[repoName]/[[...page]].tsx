import { Grid2, Paper, Skeleton, Stack, Typography } from "@mui/material";
import { GridCellParams, GridRenderCellParams } from "@mui/x-data-grid";
import GranularityPicker from "components/GranularityPicker";
import styles from "components/hud.module.css";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import {
  getTooltipMarker,
  Granularity,
  seriesWithInterpolatedTimes,
} from "components/metrics/panels/TimeSeriesPanel";
import { formatTimeForCharts } from "components/TimeUtils";
import dayjs from "dayjs";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { fetcher } from "lib/GeneralUtils";
import { approximateFailureByTypePercent } from "lib/metricUtils";
import { JobAnnotation } from "lib/types";
import { useRouter } from "next/router";
import { useCallback, useState } from "react";
import useSWR from "swr";
import { TimeRangePicker } from "../../../metrics";

const PRIMARY_WORKFLOWS = ["lint", "pull", "trunk"];
const SECONDARY_WORKFLOWS = ["periodic", "inductor"];
const UNSTABLE_WORKFLOWS = ["unstable"];
const LAST_WEEK = 7;
const ROW_HEIGHT = 340;
const ROW_GAP = 30;
const URL_PREFIX = `/reliability/pytorch/pytorch?jobName=`;

// Specialized version of TablePanel for reliability metrics
function GroupReliabilityPanel({
  title,
  queryName,
  queryParams,
  metricHeaderName,
  metricName,
  filter,
}: {
  title: string;
  queryName: string;
  queryParams: { [key: string]: any };
  metricHeaderName: string;
  metricName: string;
  filter: any;
}) {
  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000,
  });

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const failuresByTypes = Object.entries(approximateFailureByTypePercent(data))
    .map((item) => {
      const jobName = item[0];
      const percent = item[1];

      const brokenTrunk = percent[JobAnnotation.BROKEN_TRUNK];
      const infraBroken = percent[JobAnnotation.INFRA_BROKEN];
      const testFlake = percent[JobAnnotation.TEST_FLAKE];

      return {
        name: jobName,
        [metricName]: brokenTrunk + testFlake,
        [JobAnnotation.BROKEN_TRUNK]: brokenTrunk,
        [JobAnnotation.INFRA_BROKEN]: infraBroken,
        [JobAnnotation.TEST_FLAKE]: testFlake,
      };
    })
    .sort((a, b) => Number(b[metricName]) - Number(a[metricName]));

  return (
    <TablePanelWithData
      title={title}
      data={failuresByTypes}
      columns={[
        {
          field: metricName,
          headerName: metricHeaderName,
          flex: 1,
          valueFormatter: (value) => {
            return Number(value).toFixed(2);
          },
        },
        {
          field: JobAnnotation.BROKEN_TRUNK,
          headerName: "~Broken Trunk %",
          flex: 1,
          valueFormatter: (value) => {
            return Number(value).toFixed(2);
          },
        },
        {
          field: JobAnnotation.TEST_FLAKE,
          headerName: "~Flaky %",
          flex: 1,
          valueFormatter: (value) => {
            return Number(value).toFixed(2);
          },
        },
        {
          field: JobAnnotation.INFRA_BROKEN,
          headerName: "~Outage %",
          flex: 1,
          valueFormatter: (value) => {
            return Number(value).toFixed(2);
          },
        },
        {
          field: "name",
          headerName: "Name",
          flex: 5,
          // valueFormatter only treat the return value as string, so we need
          // to use renderCell here to get the JSX
          renderCell: (params: GridRenderCellParams<any, string>) => {
            const jobName = params.value;
            if (jobName === undefined) {
              return `Invalid job name ${jobName}`;
            }

            const encodedJobName = encodeURIComponent(jobName);
            return <a href={URL_PREFIX + encodedJobName}>{jobName}</a>;
          },
          cellClassName: (params: GridCellParams<any, string>) => {
            const jobName = params.value;
            if (jobName === undefined) {
              return "";
            }

            return filter.has(jobName) ? styles.selectedRow : "";
          },
        },
      ]}
      dataGridProps={{ getRowId: (el: any) => el.name }}
    />
  );
}

function GraphPanel({
  series,
  title,
}: {
  series: Array<any>;
  title: string;
}): JSX.Element {
  const options: EChartsOption = {
    title: { text: title },
    grid: { top: 48, right: 200, bottom: 24, left: 48 },
    xAxis: { type: "time" },
    yAxis: {
      type: "value",
      min: 0,
      max: 100,
    },
    series,
    legend: {
      orient: "vertical",
      right: 10,
      top: "center",
      type: "scroll",
      textStyle: {
        overflow: "breakAll",
        width: "150",
      },
    },
    tooltip: {
      trigger: "item",
      formatter: (params: any) =>
        `${params.seriesName}` +
        `<br/>${formatTimeForCharts(params.value[0])}<br/>` +
        `${getTooltipMarker(params.color)}` +
        `<b>${params.value[1]}</b>`,
    },
  };

  return (
    <ReactECharts
      style={{ height: "100%", width: "100%" }}
      option={options}
      notMerge={true}
    />
  );
}

function Graphs({
  queryParams,
  granularity,
  checkboxRef,
  filter,
  toggleFilter,
}: {
  queryParams: { [key: string]: any };
  granularity: Granularity;
  checkboxRef: any;
  filter: any;
  toggleFilter: any;
}) {
  const queryName = "master_commit_red_percent_groups";
  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
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
  // align with the data we get from the database
  const startTime = dayjs(queryParams["startTime"]).startOf(granularity);
  const stopTime = dayjs(queryParams["stopTime"]).startOf(granularity);

  const redFieldName = "red";
  const timeFieldName = "granularity_bucket";
  const groupByFieldName = "name";

  const redPercentages = seriesWithInterpolatedTimes(
    data,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    timeFieldName,
    redFieldName
  );
  const displayRedPercentages = redPercentages.filter((item: any) =>
    filter.has(item["name"])
  );

  return (
    <Grid2 container spacing={2}>
      <Grid2 size={{ xs: 9 }} height={ROW_HEIGHT}>
        <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
          <GraphPanel title={"%"} series={displayRedPercentages} />
        </Paper>
      </Grid2>
      <Grid2 size={{ xs: 3 }} height={ROW_HEIGHT}>
        <div
          style={{ overflow: "auto", height: ROW_HEIGHT, fontSize: "15px" }}
          ref={checkboxRef}
        >
          {redPercentages.map((job) => (
            <div
              key={job["name"]}
              className={
                filter.has(job[groupByFieldName]) ? styles.selectedRow : ""
              }
            >
              <input
                type="checkbox"
                id={job[groupByFieldName]}
                onChange={toggleFilter}
                checked={filter.has(job[groupByFieldName])}
              />
              <label htmlFor={job[groupByFieldName]}>
                <a
                  href={URL_PREFIX + encodeURIComponent(job[groupByFieldName])}
                >
                  {job[groupByFieldName]}
                </a>
              </label>
            </div>
          ))}
        </div>
      </Grid2>
    </Grid2>
  );
}

export default function Page() {
  const router = useRouter();
  const jobName: string = (router.query.jobName as string) ?? "none";

  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [timeRange, setTimeRange] = useState<number>(LAST_WEEK);
  const [granularity, setGranularity] = useState<Granularity>("day");

  const [filter, setFilter] = useState(new Set());
  function toggleFilter(e: any) {
    var jobName = e.target.id;
    const next = new Set(filter);
    if (filter.has(jobName)) {
      next.delete(jobName);
    } else {
      next.add(jobName);
    }
    setFilter(next);
  }

  const queryParams: { [key: string]: any } = {
    granularity: granularity,
    startTime: dayjs(startTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: dayjs(stopTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
  };

  const allWorkflows =
    PRIMARY_WORKFLOWS.concat(SECONDARY_WORKFLOWS).concat(UNSTABLE_WORKFLOWS);

  const checkboxRef = useCallback(() => {
    const selectedJob = document.getElementById(jobName);
    if (selectedJob != undefined) {
      selectedJob.click();
    }
  }, [jobName]);

  const queryName = "master_commit_red_jobs";
  const metricName = "red";
  const metricHeaderName = "Failures %";

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          Failures
        </Typography>
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
        <GranularityPicker
          granularity={granularity}
          setGranularity={setGranularity}
        />
      </Stack>

      <Grid2 size={{ xs: 6 }} height={ROW_HEIGHT + ROW_GAP}>
        <Graphs
          queryParams={{
            workflowNames: allWorkflows,
            ...queryParams,
          }}
          granularity={granularity}
          checkboxRef={checkboxRef}
          filter={filter}
          toggleFilter={toggleFilter}
        />
      </Grid2>

      <Grid2 container spacing={2}>
        <Grid2 size={{ xs: 6 }} height={ROW_HEIGHT}>
          <GroupReliabilityPanel
            title={`Primary jobs (${PRIMARY_WORKFLOWS.join(", ")})`}
            queryName={queryName}
            queryParams={{
              workflowNames: PRIMARY_WORKFLOWS,
              ...queryParams,
            }}
            metricName={metricName}
            metricHeaderName={metricHeaderName}
            filter={filter}
          />
        </Grid2>

        <Grid2 size={{ xs: 6 }} height={ROW_HEIGHT}>
          <GroupReliabilityPanel
            title={`Secondary jobs (${SECONDARY_WORKFLOWS.join(", ")})`}
            queryName={queryName}
            queryParams={{
              workflowNames: SECONDARY_WORKFLOWS,
              ...queryParams,
            }}
            metricName={metricName}
            metricHeaderName={metricHeaderName}
            filter={filter}
          />
        </Grid2>

        <Grid2 size={{ xs: 6 }} height={ROW_HEIGHT}>
          <GroupReliabilityPanel
            title={"Unstable jobs"}
            queryName={queryName}
            queryParams={{
              workflowNames: UNSTABLE_WORKFLOWS,
              ...queryParams,
            }}
            metricName={metricName}
            metricHeaderName={metricHeaderName}
            filter={filter}
          />
        </Grid2>
      </Grid2>
    </div>
  );
}
