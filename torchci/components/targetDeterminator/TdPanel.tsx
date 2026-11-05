import { Grid, Paper, Skeleton, Stack, Typography } from "@mui/material";
import {
  CountedRange,
  countedText,
  TdParams,
  useTdQuery,
} from "lib/targetDeterminator";
import { TdTotalState, totalError, totalRow } from "lib/targetDeterminatorRows";
import { ReactNode } from "react";

export const CHART_HEIGHT = 360;

export function useTdTotalQuery<T extends { grain: string }>(
  queryName: string,
  window: TdParams | undefined
): TdTotalState<T> {
  const state = useTdQuery<T>(queryName, window);
  const total = totalRow(state.rows);
  return {
    ...state,
    total,
    tileError: window === undefined ? undefined : totalError(queryName, state),
  };
}

// What a section counts is the picked window cut to where its data holds,
// which is stated on its face; with nothing left to count it shows no tiles.
export function TdSection({
  title,
  intro,
  range,
  children,
}: {
  title: string;
  intro: ReactNode;
  range: CountedRange;
  children: ReactNode;
}) {
  return (
    <Stack spacing={2} component="section">
      <Typography variant="h5" component="h2">
        {title}
      </Typography>
      <Typography variant="body1">{intro}</Typography>
      <Typography
        variant="body2"
        color={range.empty ? "text.primary" : "text.secondary"}
        role={range.empty ? "status" : undefined}
      >
        {range.empty
          ? "Nothing to count in the picked window."
          : countedText(range)}
        {range.note === undefined ? "" : ` ${range.note}`}
      </Typography>
      {!range.empty && (
        <Grid container spacing={2}>
          {children}
        </Grid>
      )}
    </Stack>
  );
}

// Gates a chart on its query: a failed query names itself, a window
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
