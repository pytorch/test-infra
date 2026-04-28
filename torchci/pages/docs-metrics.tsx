import { Divider, Grid, Paper, Stack, Typography } from "@mui/material";
import { durationDisplay } from "components/common/TimeUtils";
import ScalarPanel from "components/metrics/panels/ScalarPanel";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { TimeRangePicker } from "pages/metrics";
import { useState } from "react";

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
        </Grid>

        <Grid size={{ xs: 12, lg: 3 }} height={ROW_HEIGHT / 2}>
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
        </Grid>

        <Grid size={{ xs: 12, lg: 3 }} height={ROW_HEIGHT / 2}>
          <ScalarPanel
            title={"Python PR build time"}
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
        </Grid>

        <Grid size={{ xs: 12, lg: 3 }} height={ROW_HEIGHT / 2}>
          <ScalarPanel
            title={"C++ PR build time"}
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
        </Grid>

        <SectionHeader title="Build Duration" />

        <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
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
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
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
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
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
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
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
        </Grid>

        <SectionHeader title="Build Success Rate" />

        <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
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
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
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
        </Grid>
      </Grid>
    </Paper>
  );
}
