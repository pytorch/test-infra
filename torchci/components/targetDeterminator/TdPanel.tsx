import { Grid, Link, Paper, Skeleton, Stack, Typography } from "@mui/material";
import { GridColDef } from "@mui/x-data-grid";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import { utcStamp } from "lib/greenlight/qualityFigures";
import {
  commitUrl,
  CountedRange,
  rangeText,
  useTdQuery,
} from "lib/targetDeterminator";
import { TdTotalState, totalError, totalRow } from "lib/targetDeterminatorRows";
import { ReactNode } from "react";

export const CHART_HEIGHT = 360;
export const TABLE_HEIGHT = 520;

export function useTdTotalQuery<T extends { grain: string }>(
  queryName: string,
  params: Record<string, unknown>,
  enabled: boolean = true
): TdTotalState<T> {
  const state = useTdQuery<T>(queryName, params, enabled);
  const total = totalRow(state.rows);
  return { ...state, total, tileError: totalError(queryName, state, total) };
}

export function commitLink(sha: string) {
  const url = commitUrl(sha);
  return url === undefined ? (
    sha
  ) : (
    <Link href={url} target="_blank" rel="noreferrer">
      {sha.slice(0, 10)}
    </Link>
  );
}

// The raw ISO string stays the cell value, so sorting stays chronological.
export function utcColumn(field: string, headerName: string): GridColDef {
  return {
    field,
    headerName,
    width: 150,
    valueFormatter: (value: string | null) => utcStamp(value),
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
          : `Counted ${rangeText(range)} (UTC).`}
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

export function TdTable({
  title,
  state,
  rows,
  columns,
  emptyText,
  height,
  sortField,
  dataGridProps,
}: {
  title: string;
  state: { loading: boolean; error?: string };
  rows: object[];
  columns: GridColDef[];
  emptyText: string;
  height: number;
  sortField: string;
  dataGridProps?: object;
}) {
  return (
    <TdPanel
      title={title}
      height={height}
      loading={state.loading}
      error={state.error}
      emptyText={rows.length === 0 ? emptyText : undefined}
    >
      <Paper elevation={3} sx={{ p: 1, height }}>
        <TablePanelWithData
          title={title}
          data={rows}
          columns={columns}
          showFooter={true}
          dataGridProps={{
            initialState: {
              sorting: { sortModel: [{ field: sortField, sort: "desc" }] },
            },
            ...dataGridProps,
          }}
        />
      </Paper>
    </TdPanel>
  );
}
