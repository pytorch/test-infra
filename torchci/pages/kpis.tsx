import { Grid } from "@mui/material";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { useState } from "react";

const ROW_HEIGHT = 240;

export default function Kpis() {
  // Looking at data from the past six months
  const [startTime, _setStartTime] = useState(dayjs().subtract(6, "month"));
  const [stopTime, _setStopTime] = useState(dayjs());

  const clickhouseTimeParams = {
    startTime: startTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: stopTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
  };

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"% of commits red on trunk (Weekly)"}
          queryName={"master_commit_red_percent"}
          queryParams={{
            ...clickhouseTimeParams,
            granularity: "week",
            workflowNames: ["lint", "pull", "trunk"],
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

      <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"# of force merges (Weekly)"}
          queryName={"number_of_force_pushes_historical"}
          queryParams={clickhouseTimeParams}
          granularity={"week"}
          timeFieldName={"bucket"}
          yAxisFieldName={"count"}
          yAxisRenderer={(unit) => `${unit}`}
        />
      </Grid>

      <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"Time to Red Signal - (Weekly, pull workflow)"}
          queryName={"ttrs_percentiles"}
          queryParams={{
            ...clickhouseTimeParams,
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

      <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"% of force merges (Weekly, 2 week rolling avg)"}
          queryName={"weekly_force_merge_stats"}
          queryParams={{
            ...clickhouseTimeParams,
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

      <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"Avg time-to-signal - E2E (Weekly)"}
          queryName={"time_to_signal"}
          queryParams={clickhouseTimeParams}
          granularity={"week"}
          timeFieldName={"week_bucket"}
          yAxisFieldName={"avg_tts"}
          yAxisLabel={"Hours"}
          yAxisRenderer={(unit) => `${unit}`}
          groupByFieldName="branch"
        />
      </Grid>

      <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"# of reverts (2 week moving avg)"}
          queryName={"num_reverts"}
          queryParams={clickhouseTimeParams}
          granularity={"week"}
          timeFieldName={"bucket"}
          yAxisFieldName={"num"}
          yAxisRenderer={(unit) => `${unit}`}
          groupByFieldName={"code"}
        />
      </Grid>

      <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"viable/strict lag (Daily)"}
          queryName={"strict_lag_historical"}
          queryParams={{
            ...clickhouseTimeParams,
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

      <Grid item xs={6} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"Weekly external PR count (4 week moving average)"}
          queryName={"external_contribution_stats"}
          queryParams={clickhouseTimeParams}
          granularity={"week"}
          timeFieldName={"granularity_bucket"}
          yAxisFieldName={"pr_count"}
          yAxisRenderer={(value) => value}
          additionalOptions={{ yAxis: { scale: true } }}
        />
      </Grid>

      <Grid item xs={6} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"Monthly external PR count"}
          queryName={"monthly_contribution_stats"}
          queryParams={clickhouseTimeParams}
          granularity={"month"}
          timeFieldName={"year_and_month"}
          timeFieldDisplayFormat={"MMMM YYYY"}
          yAxisFieldName={"pr_count"}
          yAxisRenderer={(value) => value}
          additionalOptions={{ yAxis: { scale: true } }}
        />
      </Grid>

      <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={"Total number of open disabled tests (Daily)"}
          queryName={"disabled_test_historical"}
          queryParams={{ ...clickhouseTimeParams, repo: "pytorch/pytorch" }}
          granularity={"day"}
          timeFieldName={"granularity_bucket"}
          yAxisFieldName={"number_of_open_disabled_tests"}
          yAxisRenderer={(duration) => duration}
        />
      </Grid>
    </Grid>
  );
}
