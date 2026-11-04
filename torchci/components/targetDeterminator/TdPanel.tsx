import { Grid, Paper, Skeleton, Stack, Typography } from "@mui/material";
import { GridColDef } from "@mui/x-data-grid";
import {
  seriesWithInterpolatedTimes,
  TimeSeriesPanelWithData,
} from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { ReactNode } from "react";

dayjs.extend(utc);

export const CHART_HEIGHT = 360;
export const TABLE_HEIGHT = 520;

// The raw ISO string stays the cell value, so sorting stays chronological.
export function utcColumn(field: string, headerName: string): GridColDef {
  return {
    field,
    headerName,
    width: 150,
    valueFormatter: (value: unknown) =>
      typeof value === "string" ? value.replace("T", " ").slice(0, 16) : "-",
  };
}

export function TdSection({
  title,
  intro,
  horizonDays,
  windowDays,
  children,
}: {
  title: string;
  intro: ReactNode;
  horizonDays: number;
  windowDays: number;
  children: ReactNode;
}) {
  return (
    <Stack spacing={2} component="section">
      <Typography variant="h5" component="h2">
        {title}
      </Typography>
      <Typography variant="body1">{intro}</Typography>
      <Typography variant="body2" color="text.secondary">
        {Math.floor(windowDays) > horizonDays
          ? `This section covers at most ${horizonDays} days, so only the ` +
            `most recent ${horizonDays} days of the picked window are counted.`
          : `This section covers windows of up to ${horizonDays} days.`}
      </Typography>
      <Grid container spacing={2}>
        {children}
      </Grid>
    </Stack>
  );
}

// Gates a chart or table on its query: a failed query names itself, a window
// without rows says so, and only real rows reach the chart.
export function TdPanel({
  title,
  loading,
  error,
  emptyText,
  height,
  children,
}: {
  title: string;
  loading: boolean;
  error?: string;
  emptyText?: string;
  height: number;
  children: ReactNode;
}) {
  if (!loading && error === undefined && emptyText === undefined) {
    return <>{children}</>;
  }
  return (
    <Paper elevation={3} sx={{ p: 2, height }}>
      <Typography variant="subtitle2" color="text.secondary">
        {title}
      </Typography>
      {error !== undefined ? (
        <Typography variant="body2" color="error.main" sx={{ mt: 1 }}>
          {error}
        </Typography>
      ) : loading ? (
        <Skeleton variant="rectangular" height={height - 64} sx={{ mt: 1 }} />
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {emptyText}
        </Typography>
      )}
    </Paper>
  );
}

export function TablePaper({
  height,
  children,
}: {
  height: number;
  children: ReactNode;
}) {
  return (
    <Paper elevation={3} sx={{ p: 1, height }}>
      {children}
    </Paper>
  );
}

export interface DailyPoint {
  bucket: string;
  series: string;
  value: number;
}

// Days without rows stay gaps rather than zeros: a missing day is missing data,
// and a zero would read as a measured value.
export function DailyChart({
  title,
  points,
  startTime,
  stopTime,
  yAxisLabel,
  yAxisRenderer,
}: {
  title: string;
  points: DailyPoint[];
  startTime: string;
  stopTime: string;
  yAxisLabel: string;
  yAxisRenderer: (_value: number) => string;
}) {
  const series = seriesWithInterpolatedTimes(
    points,
    dayjs.utc(startTime),
    dayjs.utc(stopTime),
    "day",
    "series",
    "bucket",
    "value",
    false,
    false
  );
  return (
    <TimeSeriesPanelWithData
      data={points}
      series={series}
      title={title}
      groupByFieldName="series"
      legendPadding={180}
      timeFieldDisplayFormat="YYYY-MM-DD"
      yAxisLabel={yAxisLabel}
      yAxisRenderer={yAxisRenderer}
      useUTC={true}
    />
  );
}
