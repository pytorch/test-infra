import {
  Box,
  Divider,
  Grid,
  Link,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { GridColDef, GridRenderCellParams } from "@mui/x-data-grid";
import { durationDisplay } from "components/common/TimeUtils";
import ScalarPanel from "components/metrics/panels/ScalarPanel";
import TablePanel from "components/metrics/panels/TablePanel";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { TimeRangePicker } from "pages/metrics";
import { ReactNode, useState } from "react";
import useSWR from "swr";

const ROW_HEIGHT = 340;

const PYTHON_JOB_NAMES = [
  "docs push / build-docs-python-true",
  "linux-docs / build-docs-python-false",
];

const CPP_JOB_NAMES = [
  "docs push / build-docs-cpp-true",
  "linux-docs / build-docs-cpp-false",
];

const ALL_JOB_NAMES = [...PYTHON_JOB_NAMES, ...CPP_JOB_NAMES];

const ghFetcher = (url: string) => fetch(url).then((res) => res.json());

function formatRepoSize(sizeKB: number): string {
  const estimatedKB = Math.round(sizeKB * 1.6);
  if (estimatedKB >= 1024 * 1024)
    return `~${(estimatedKB / (1024 * 1024)).toFixed(1)} GB`;
  if (estimatedKB >= 1024) return `~${(estimatedKB / 1024).toFixed(0)} MB`;
  return `~${estimatedKB} KB`;
}

function repoSizeColor(sizeKB: number): string {
  const estimatedGB = (sizeKB * 1.6) / (1024 * 1024);
  if (estimatedGB >= 8) return "#ee6666";
  if (estimatedGB >= 5) return "#eeaa44";
  return "inherit";
}

function RepoSizePanel({ owner, repo }: { owner: string; repo: string }) {
  const { data } = useSWR(
    `https://api.github.com/repos/${owner}/${repo}`,
    ghFetcher,
    { refreshInterval: 60 * 60 * 1000 }
  );
  const size = data?.size;
  return (
    <Paper sx={{ p: 2 }} elevation={3}>
      <Box sx={{ display: "flex", flexDirection: "column" }}>
        <Typography sx={{ fontSize: "1rem", fontWeight: "bold" }}>
          {owner}/{repo} size (est.)
        </Typography>
        <Typography
          sx={{
            fontSize: "4rem",
            my: "auto",
            alignSelf: "center",
            color: size !== undefined ? repoSizeColor(size) : "inherit",
          }}
        >
          {size !== undefined ? formatRepoSize(size) : "..."}
        </Typography>
      </Box>
    </Paper>
  );
}

function trendRenderer(data: Record<string, number>[]) {
  const row = data?.[0];
  if (!row) return undefined;
  const { duration_seconds, avg_duration_seconds } = row;
  if (!duration_seconds || !avg_duration_seconds) return undefined;
  return { duration_seconds, avg_duration_seconds };
}

function formatWithTrend(value: {
  duration_seconds: number;
  avg_duration_seconds: number;
}) {
  const pctChange =
    ((value.duration_seconds - value.avg_duration_seconds) /
      value.avg_duration_seconds) *
    100;
  const arrow = pctChange > 5 ? " ↑" : pctChange < -5 ? " ↓" : "";
  return `${durationDisplay(value.duration_seconds)}${arrow}`;
}

const SLOWEST_BUILDS_COLUMNS: GridColDef[] = [
  {
    field: "sha",
    headerName: "Commit / PR",
    flex: 1.5,
    renderCell: (params: GridRenderCellParams) => (
      <Stack direction="row" spacing={1}>
        <Link
          href={`https://github.com/pytorch/pytorch/commit/${params.value}`}
          target="_blank"
          rel="noopener"
        >
          {(params.value as string).substring(0, 7)}
        </Link>
        <Link href={params.row.job_url} target="_blank" rel="noopener">
          job
        </Link>
      </Stack>
    ),
  },
  {
    field: "job_name",
    headerName: "Job",
    flex: 2,
  },
  {
    field: "duration_minutes",
    headerName: "Duration (min)",
    flex: 1,
    type: "number",
  },
  {
    field: "completed_at",
    headerName: "Completed",
    flex: 1.5,
  },
];

function SectionHeader({ title }: { title: string }) {
  return (
    <Grid size={{ xs: 12 }}>
      <Divider sx={{ mt: 3, mb: 1 }} />
      <Typography fontSize="1.5rem" fontWeight="bold">
        {title}
      </Typography>
    </Grid>
  );
}

function WithTooltip({ tip, children }: { tip: string; children: ReactNode }) {
  return (
    <Tooltip title={tip} arrow placement="top">
      <div style={{ height: "100%" }}>{children}</div>
    </Tooltip>
  );
}

export default function DocsMetrics() {
  const [timeRange, setTimeRange] = useState(90);
  const [startTime, setStartTime] = useState(dayjs().subtract(90, "day"));
  const [stopTime, setStopTime] = useState(dayjs());

  const timeParams = {
    startTime: startTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: stopTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
  };

  return (
    <Paper sx={{ p: 3, m: 2 }}>
      <Stack direction="row" spacing={2} sx={{ mb: 3 }} alignItems="center">
        <Typography fontSize="2rem" fontWeight="bold">
          Docs Build Metrics
        </Typography>
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
      </Stack>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 3 }} height={ROW_HEIGHT / 2}>
          <WithTooltip tip="Time since the last successful nightly Python docs push to pytorch.org. Turns red after 3 days.">
            <ScalarPanel
              title={"Last Python docs push"}
              queryName={"last_successful_jobs"}
              metricName={"last_success_seconds_ago"}
              getValue={(data: Record<string, number>[]) =>
                data?.[0]?.last_success_seconds_ago || ">60d"
              }
              valueRenderer={(value: number | string) =>
                value === ">60d" ? value : durationDisplay(value as number)
              }
              queryParams={{
                jobNames: ["docs push / build-docs-python-true"],
              }}
              badThreshold={(value: number | string) =>
                value === ">60d" || (value as number) > 3 * 24 * 60 * 60
              }
            />
          </WithTooltip>
        </Grid>

        <Grid size={{ xs: 12, lg: 3 }} height={ROW_HEIGHT / 2}>
          <WithTooltip tip="Time since the last successful nightly C++ docs push to pytorch.org. Turns red after 3 days.">
            <ScalarPanel
              title={"Last C++ docs push"}
              queryName={"last_successful_jobs"}
              metricName={"last_success_seconds_ago"}
              getValue={(data: Record<string, number>[]) =>
                data?.[0]?.last_success_seconds_ago || ">60d"
              }
              valueRenderer={(value: number | string) =>
                value === ">60d" ? value : durationDisplay(value as number)
              }
              queryParams={{
                jobNames: ["docs push / build-docs-cpp-true"],
              }}
              badThreshold={(value: number | string) =>
                value === ">60d" || (value as number) > 3 * 24 * 60 * 60
              }
            />
          </WithTooltip>
        </Grid>

        <Grid size={{ xs: 12, lg: 3 }} height={ROW_HEIGHT / 2}>
          <WithTooltip tip="7-day average Python docs PR build time. Arrow shows trend vs prior 7 days. Turns red above 45 minutes.">
            <ScalarPanel
              title={"Python PR build (7d avg)"}
              queryName={"docs_latest_build_duration"}
              metricName={"duration_seconds"}
              getValue={trendRenderer}
              valueRenderer={formatWithTrend}
              queryParams={{
                jobNames: ["linux-docs / build-docs-python-false"],
              }}
              badThreshold={(value: { duration_seconds: number }) =>
                value.duration_seconds > 45 * 60
              }
            />
          </WithTooltip>
        </Grid>

        <Grid size={{ xs: 12, lg: 3 }} height={ROW_HEIGHT / 2}>
          <WithTooltip tip="7-day average C++ docs PR build time. Arrow shows trend vs prior 7 days. Turns red above 45 minutes.">
            <ScalarPanel
              title={"C++ PR build (7d avg)"}
              queryName={"docs_latest_build_duration"}
              metricName={"duration_seconds"}
              getValue={trendRenderer}
              valueRenderer={formatWithTrend}
              queryParams={{
                jobNames: ["linux-docs / build-docs-cpp-false"],
              }}
              badThreshold={(value: { duration_seconds: number }) =>
                value.duration_seconds > 45 * 60
              }
            />
          </WithTooltip>
        </Grid>

        <Grid size={{ xs: 12, lg: 3 }} height={ROW_HEIGHT / 2}>
          <WithTooltip tip="Size of pytorch/docs repo (GitHub API estimate, ~40% lower than actual disk usage). Useful for tracking growth over time. Yellow at 5GB, red at 8GB.">
            <RepoSizePanel owner="pytorch" repo="docs" />
          </WithTooltip>
        </Grid>

        <SectionHeader title="Build Duration" />

        <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
          <WithTooltip tip="Average daily build duration for Python docs (push=true nightly vs push=false PR builds). Sphinx parallelism depends on runner core count.">
            <TimeSeriesPanel
              title={"Python docs build duration (Daily avg)"}
              queryName={"docs_build_duration_trend"}
              queryParams={{
                ...timeParams,
                granularity: "day",
                jobNames: PYTHON_JOB_NAMES,
              }}
              granularity={"day"}
              timeFieldName={"granularity_bucket"}
              yAxisFieldName={"avg_duration_minutes"}
              yAxisLabel={"Minutes"}
              yAxisRenderer={(value: number) => `${value}m`}
              groupByFieldName={"job_name"}
              dataReader={(data: Record<string, number>[]) =>
                data.map((d) => ({
                  ...d,
                  avg_duration_minutes: Math.round(d.avg_duration_seconds / 60),
                }))
              }
            />
          </WithTooltip>
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
          <WithTooltip tip="Average daily build duration for C++ docs. C++ builds run on larger runners (12xlarge) due to high memory usage from Doxygen/Breathe.">
            <TimeSeriesPanel
              title={"C++ docs build duration (Daily avg)"}
              queryName={"docs_build_duration_trend"}
              queryParams={{
                ...timeParams,
                granularity: "day",
                jobNames: CPP_JOB_NAMES,
              }}
              granularity={"day"}
              timeFieldName={"granularity_bucket"}
              yAxisFieldName={"avg_duration_minutes"}
              yAxisLabel={"Minutes"}
              yAxisRenderer={(value: number) => `${value}m`}
              groupByFieldName={"job_name"}
              dataReader={(data: Record<string, number>[]) =>
                data.map((d) => ({
                  ...d,
                  avg_duration_minutes: Math.round(d.avg_duration_seconds / 60),
                }))
              }
            />
          </WithTooltip>
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
          <WithTooltip tip="Weekly average build duration across all 4 docs jobs (Python + C++, push + PR). Useful for spotting overall trends.">
            <TimeSeriesPanel
              title={"All docs build duration (Weekly avg)"}
              queryName={"docs_build_duration_trend"}
              queryParams={{
                ...timeParams,
                granularity: "week",
                jobNames: ALL_JOB_NAMES,
              }}
              granularity={"week"}
              timeFieldName={"granularity_bucket"}
              yAxisFieldName={"avg_duration_minutes"}
              yAxisLabel={"Minutes"}
              yAxisRenderer={(value: number) => `${value}m`}
              groupByFieldName={"job_name"}
              dataReader={(data: Record<string, number>[]) =>
                data.map((d) => ({
                  ...d,
                  avg_duration_minutes: Math.round(d.avg_duration_seconds / 60),
                }))
              }
            />
          </WithTooltip>
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
          <WithTooltip tip="Maximum build duration per week. Spikes here indicate individual builds that took unusually long, possibly due to new docs content or infrastructure issues.">
            <TimeSeriesPanel
              title={"Max build duration (Weekly)"}
              queryName={"docs_build_duration_trend"}
              queryParams={{
                ...timeParams,
                granularity: "week",
                jobNames: ALL_JOB_NAMES,
              }}
              granularity={"week"}
              timeFieldName={"granularity_bucket"}
              yAxisFieldName={"max_duration_minutes"}
              yAxisLabel={"Minutes"}
              yAxisRenderer={(value: number) => `${value}m`}
              groupByFieldName={"job_name"}
              dataReader={(data: Record<string, number>[]) =>
                data.map((d) => ({
                  ...d,
                  max_duration_minutes: Math.round(d.max_duration_seconds / 60),
                }))
              }
            />
          </WithTooltip>
        </Grid>

        <SectionHeader title="Build Success Rate" />

        <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
          <WithTooltip tip="Percentage of Python docs builds that succeed each week. Covers both nightly push and PR builds.">
            <TimeSeriesPanel
              title={"Python docs build success rate (Weekly)"}
              queryName={"docs_build_success_rate"}
              queryParams={{
                ...timeParams,
                granularity: "week",
                jobNames: PYTHON_JOB_NAMES,
              }}
              granularity={"week"}
              timeFieldName={"granularity_bucket"}
              yAxisFieldName={"success_rate"}
              yAxisLabel={"%"}
              yAxisRenderer={(value: number) => `${value}%`}
              groupByFieldName={"job_name"}
            />
          </WithTooltip>
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
          <WithTooltip tip="Percentage of C++ docs builds that succeed each week. C++ builds are more prone to OOM failures on smaller runners.">
            <TimeSeriesPanel
              title={"C++ docs build success rate (Weekly)"}
              queryName={"docs_build_success_rate"}
              queryParams={{
                ...timeParams,
                granularity: "week",
                jobNames: CPP_JOB_NAMES,
              }}
              granularity={"week"}
              timeFieldName={"granularity_bucket"}
              yAxisFieldName={"success_rate"}
              yAxisLabel={"%"}
              yAxisRenderer={(value: number) => `${value}%`}
              groupByFieldName={"job_name"}
            />
          </WithTooltip>
        </Grid>

        <SectionHeader title="Slowest PR Builds" />

        <Grid size={{ xs: 12 }} height={ROW_HEIGHT + 100}>
          <WithTooltip tip="Top 20 slowest docs PR builds in the selected time range. Click the PR number to see what docs changes caused the slow build.">
            <TablePanel
              title={""}
              queryName={"docs_slowest_pr_builds"}
              queryParams={{
                ...timeParams,
                jobNames: [
                  "linux-docs / build-docs-python-false",
                  "linux-docs / build-docs-cpp-false",
                ],
                limit: 20,
              }}
              columns={SLOWEST_BUILDS_COLUMNS}
              dataGridProps={{
                getRowId: (row: Record<string, string>) =>
                  `${row.sha}-${row.job_name}`,
                initialState: {
                  sorting: {
                    sortModel: [{ field: "duration_minutes", sort: "desc" }],
                  },
                },
              }}
              showFooter={true}
            />
          </WithTooltip>
        </Grid>
      </Grid>
    </Paper>
  );
}
