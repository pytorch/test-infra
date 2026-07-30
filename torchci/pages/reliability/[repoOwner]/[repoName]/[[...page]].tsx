import { Grid, Paper, Skeleton, Stack, Typography } from "@mui/material";
import { GridCellParams, GridRenderCellParams } from "@mui/x-data-grid";
import GranularityPicker from "components/common/GranularityPicker";
import { formatTimeForCharts } from "components/common/TimeUtils";
import styles from "components/hud.module.css";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import {
  getTooltipMarker,
  Granularity,
  seriesWithInterpolatedTimes,
} from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { fetcher } from "lib/GeneralUtils";
import {
  approximateFailureByTypePercent,
  computeSoleBlockers,
  soleBlockerCommitRange,
} from "lib/metricUtils";
import { JobAnnotation } from "lib/types";
import { useRouter } from "next/router";
import { useCallback, useState } from "react";
import useSWR from "swr";
import { TimeRangePicker } from "../../../metrics";

const PRIMARY_WORKFLOWS = [
  "lint",
  "pull",
  "trunk",
  "linux-binary-libtorch-release",
  "linux-binary-manywheel",
  "linux-aarch64",
];
const SECONDARY_WORKFLOWS = ["periodic", "inductor"];
const UNSTABLE_WORKFLOWS = ["unstable"];
const LAST_WEEK = 7;
const ROW_HEIGHT = 340;
const ROW_GAP = 30;
const URL_PREFIX = `/reliability/pytorch/pytorch?jobName=`;

// Specialized version of TablePanel for reliability metrics
function GroupReliabilityPanel({
  title,
  subtitle,
  queryName,
  queryParams,
  metricHeaderName,
  metricName,
  filter,
}: {
  title: string;
  // Optional grey line under the title, e.g. the workflows this group covers.
  subtitle?: string;
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

  const titleNode = subtitle ? (
    <>
      {title}
      <Typography
        component="span"
        sx={{
          display: "block",
          fontWeight: 400,
          fontSize: "12px",
          color: "text.secondary",
        }}
      >
        {subtitle}
      </Typography>
    </>
  ) : (
    title
  );

  return (
    <TablePanelWithData
      title={titleNode}
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

// Table of jobs that solely block viable/strict. Unlike the failure-rate panels
// this metric is defined at the commit gate, so it needs its own query
// (viable/strict gating semantics) and client-side aggregation.
function SoleBlockerPanel({
  queryParams,
  filter,
}: {
  queryParams: { [key: string]: any };
  filter: any;
}) {
  const url = `/api/clickhouse/viable_strict_sole_blocker?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000,
  });

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const rows = computeSoleBlockers(data);
  const range = soleBlockerCommitRange(data);

  // Show the actual commit span the percentages were computed over, so the
  // numbers are debuggable ("Last 1 day = commit A .. commit B").
  const commitRef = (c: { sha: string; title: string; time: string }) => (
    <a href={`/pytorch/pytorch/commit/${c.sha}`} title={`${c.sha}\n${c.title}`}>
      {c.sha.substring(0, 7)}
    </a>
  );
  const shortTitle = (t: string) =>
    t.length > 44 ? t.substring(0, 43) + "…" : t;
  const fmt = (t: string) => dayjs(t).format("MM/DD HH:mm");

  const title = (
    <>
      Sole viable/strict blockers
      <Typography
        component="span"
        sx={{
          display: "block",
          fontWeight: 400,
          fontSize: "12px",
          color: "text.secondary",
        }}
      >
        {range.count === 0 || !range.oldest || !range.newest ? (
          "no fully-evaluated commits in range"
        ) : (
          <>
            {range.count} commits · {commitRef(range.oldest)}{" "}
            {shortTitle(range.oldest.title)} ({fmt(range.oldest.time)}) →{" "}
            {commitRef(range.newest)} {shortTitle(range.newest.title)} (
            {fmt(range.newest.time)})
          </>
        )}
      </Typography>
      <Typography
        component="span"
        sx={{
          display: "block",
          fontWeight: 400,
          fontStyle: "italic",
          fontSize: "11px",
          color: "text.secondary",
        }}
      >
        The &quot;By job (all configs)&quot; column folds a job&apos;s configs
        together; it is shared across the job&apos;s rows and is not additive.
      </Typography>
    </>
  );

  return (
    <TablePanelWithData
      title={title}
      data={rows}
      columns={[
        {
          field: "sole",
          headerName: "By config",
          description:
            "% of evaluated commits where this exact config is the only job blocking viable/strict.",
          flex: 1,
          valueFormatter: (value) => {
            return Number(value).toFixed(2);
          },
        },
        {
          field: "soleJobType",
          headerName: "By job (all configs)",
          description:
            "% of evaluated commits where this job is the only thing blocking, via any of its configs. Shared across the job's rows — not additive.",
          flex: 1,
          valueFormatter: (value) => {
            return Number(value).toFixed(2);
          },
        },
        {
          field: "name",
          headerName: "Name",
          flex: 5,
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
      dataGridProps={{
        getRowId: (el: any) => el.name,
        // Group the two percentage columns under one header so they read as
        // "Sole viable/strict blocker %: By config | By job", rather than two
        // near-identically named columns. Name gets its own (untitled) group so
        // every column has a two-row header and it doesn't render with a ragged
        // empty cell above it.
        columnGroupingModel: [
          {
            groupId: "soleBlocking",
            headerName: "Sole viable/strict blocker %",
            children: [{ field: "sole" }, { field: "soleJobType" }],
          },
          {
            groupId: "job",
            headerName: "",
            children: [{ field: "name" }],
          },
        ],
      }}
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
    <Grid container spacing={2}>
      <Grid size={{ xs: 9 }} height={ROW_HEIGHT}>
        <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
          <GraphPanel title={"%"} series={displayRedPercentages} />
        </Paper>
      </Grid>
      <Grid size={{ xs: 3 }} height={ROW_HEIGHT}>
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
      </Grid>
    </Grid>
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
          Reliability
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

      <Grid size={{ xs: 6 }} height={ROW_HEIGHT + ROW_GAP}>
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
      </Grid>

      <Grid container spacing={2}>
        <Grid size={{ xs: 6 }} height={ROW_HEIGHT}>
          <GroupReliabilityPanel
            title={"Viable/strict blocking jobs"}
            subtitle={PRIMARY_WORKFLOWS.join(", ")}
            queryName={queryName}
            queryParams={{
              workflowNames: PRIMARY_WORKFLOWS,
              ...queryParams,
            }}
            metricName={metricName}
            metricHeaderName={metricHeaderName}
            filter={filter}
          />
        </Grid>

        <Grid size={{ xs: 6 }} height={ROW_HEIGHT}>
          <GroupReliabilityPanel
            title={"Non-blocking jobs"}
            subtitle={SECONDARY_WORKFLOWS.join(", ")}
            queryName={queryName}
            queryParams={{
              workflowNames: SECONDARY_WORKFLOWS,
              ...queryParams,
            }}
            metricName={metricName}
            metricHeaderName={metricHeaderName}
            filter={filter}
          />
        </Grid>

        <Grid size={{ xs: 6 }} height={ROW_HEIGHT}>
          <SoleBlockerPanel queryParams={queryParams} filter={filter} />
        </Grid>

        <Grid size={{ xs: 6 }} height={ROW_HEIGHT}>
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
        </Grid>
      </Grid>
    </div>
  );
}
