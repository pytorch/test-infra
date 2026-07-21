import { Grid } from "@mui/material";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { useState } from "react";

const ROW_HEIGHT = 240;

export default function Kpis() {
  // Looking at data from the past six months
  const [startTime, _setStartTime] = useState(dayjs().subtract(6, "month"));
  const [stopTime, _setStopTime] = useState(dayjs());

  const timeParams = {
    startTime: startTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: stopTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
  };

  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"% of commits red on trunk (Weekly)"}
          queryName={"master_commit_red_percent"}
          queryParams={{
            ...timeParams,
            granularity: "week",
            workflowNames: ["lint", "pull", "trunk", "docs-build"],
          }}
          granularity={"week"}
          timeFieldName={"granularity_bucket"}
          yAxisFieldName={"metric"}
          yAxisRenderer={(unit) => {
            return `${unit * 100} %`;
          }}
          groupByFieldName={"name"}
        />
      </Grid>

      <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"# of force merges (Weekly)"}
          queryName={"number_of_force_pushes_historical"}
          queryParams={timeParams}
          granularity={"week"}
          timeFieldName={"bucket"}
          yAxisFieldName={"count"}
          yAxisRenderer={(unit) => `${unit}`}
        />
      </Grid>

      <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"Time to Red Signal - (Weekly, pull workflow)"}
          queryName={"ttrs_percentiles"}
          queryParams={{
            ...timeParams,
            one_bucket: false,
            percentile_to_get: 0,
            workflow: "pull",
          }}
          granularity={"week"}
          timeFieldName={"bucket"}
          yAxisFieldName={"ttrs_mins"}
          yAxisRenderer={(duration) => duration}
          groupByFieldName="percentile"
          // Format data so that we can display all percentiles in the same
          // chart. Goes from 1 row per timestamp with all percentiles in the
          // row to 4 rows per timestamp with one percentile in each row.
          dataReader={(data) => {
            const percentiles = ["p25", "p50", "p75", "p90"];
            return data
              .map((d) =>
                percentiles.map((p) => {
                  return {
                    ...d,
                    percentile: p,
                    ttrs_mins: d[p],
                  };
                })
              )
              .flat();
          }}
        />
      </Grid>

      <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"pull workflow duration per trunk commit (Weekly, hrs)"}
          queryName={"pull_workflow_duration_per_commit"}
          queryParams={{
            ...timeParams,
          }}
          granularity={"week"}
          timeFieldName={"bucket"}
          yAxisFieldName={"value_hours"}
          yAxisLabel={"Hours"}
          yAxisRenderer={(value) => Number(value).toFixed(2)}
          groupByFieldName="series"
          dataReader={(data) => {
            const series = [
              { key: "wallclock_p50", name: "wall-clock p50" },
              { key: "wallclock_p90", name: "wall-clock p90" },
              { key: "longest_job_p50", name: "longest job p50" },
              { key: "longest_job_p90", name: "longest job p90" },
              { key: "build_test_p50", name: "build+test p50" },
              { key: "build_test_p90", name: "build+test p90" },
            ];
            return data
              .map((d) =>
                series.map((s) => ({
                  bucket: d.bucket,
                  series: s.name,
                  value_hours: d[s.key],
                }))
              )
              .flat();
          }}
          additionalOptions={{
            tooltip: {
              trigger: "item",
              formatter: (params: any) => {
                const DESCRIPTIONS: { [key: string]: string } = {
                  "wall-clock":
                    "Total workflow wall-clock (workflow_run updated_at − created_at). Includes per-job queue/runner-wait time.",
                  "longest job":
                    "Longest single job's run time: max(completed_at − started_at). Queue excluded.",
                  "build+test":
                    "max(build-job run) + max(test-job run) across the run. Queue excluded; the two maxes may come from different configs, so this can exceed wall-clock.",
                };
                const name: string = params.seriesName ?? "";
                const metric = name.replace(/ p(?:50|90)$/, "");
                const hrs = Number(params.value[1]).toFixed(2);
                return (
                  `<b>${name}</b><br/>` +
                  `${params.value[0]}<br/>` +
                  `${hrs} h<br/>` +
                  `<span style="font-size:11px;opacity:0.8;">${
                    DESCRIPTIONS[metric] ?? ""
                  }</span>`
                );
              },
            },
          }}
        />
      </Grid>

      <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"% of force merges (Weekly, 2 week rolling avg)"}
          queryName={"weekly_force_merge_stats"}
          queryParams={{
            ...timeParams,
            one_bucket: false,
            merge_type: "",
            granularity: "week",
          }}
          granularity={"week"}
          timeFieldName={"granularity_bucket"}
          yAxisFieldName={"metric"}
          yAxisRenderer={(unit) => {
            return `${unit} %`;
          }}
          groupByFieldName={"name"}
        />
      </Grid>

      <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"Avg time-to-signal - E2E (Weekly)"}
          queryName={"time_to_signal"}
          queryParams={timeParams}
          granularity={"week"}
          timeFieldName={"week_bucket"}
          yAxisFieldName={"avg_tts"}
          yAxisLabel={"Hours"}
          yAxisRenderer={(unit) => `${unit}`}
          groupByFieldName="branch"
        />
      </Grid>

      <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"# of reverts (2 week moving avg)"}
          queryName={"num_reverts"}
          queryParams={timeParams}
          granularity={"week"}
          timeFieldName={"bucket"}
          yAxisFieldName={"num"}
          yAxisRenderer={(unit) => `${unit}`}
          groupByFieldName={"code"}
        />
      </Grid>

      <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"viable/strict lag (Daily)"}
          queryName={"strict_lag_historical"}
          queryParams={{
            ...timeParams,
            // Missing data prior to 2024-10-01 due to migration to ClickHouse
            ...(startTime < dayjs("2024-10-01") && {
              startTime: dayjs("2024-10-01")
                .utc()
                .format("YYYY-MM-DDTHH:mm:ss.SSS"),
            }),
            repoFullName: "pytorch/pytorch",
          }}
          granularity={"day"}
          timeFieldName={"push_time"}
          yAxisFieldName={"diff_hr"}
          yAxisLabel={"Hours"}
          yAxisRenderer={(unit) => `${unit}`}
          // the data is very variable, so set the y axis to be something that makes this chart a bit easier to read
          additionalOptions={{ yAxis: { max: 10 } }}
        />
      </Grid>

      <Grid size={{ xs: 6 }} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"Weekly external PR count (4 week moving average)"}
          queryName={"external_contribution_stats"}
          queryParams={timeParams}
          granularity={"week"}
          timeFieldName={"granularity_bucket"}
          yAxisFieldName={"pr_count"}
          yAxisRenderer={(value) => value}
          additionalOptions={{ yAxis: { scale: true } }}
        />
      </Grid>

      <Grid size={{ xs: 6 }} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"Monthly external PR count"}
          queryName={"monthly_contribution_stats"}
          queryParams={timeParams}
          granularity={"month"}
          timeFieldName={"year_and_month"}
          timeFieldDisplayFormat={"MMMM YYYY"}
          yAxisFieldName={"pr_count"}
          yAxisRenderer={(value) => value}
          additionalOptions={{ yAxis: { scale: true } }}
        />
      </Grid>

      <Grid size={{ xs: 12, lg: 6 }} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"Total number of open disabled tests (Daily)"}
          queryName={"disabled_test_historical"}
          queryParams={{ ...timeParams, repo: "pytorch/pytorch" }}
          granularity={"day"}
          timeFieldName={"day"}
          yAxisFieldName={"count"}
          yAxisRenderer={(duration) => duration}
          fillMissingData={false}
        />
      </Grid>
    </Grid>
  );
}
