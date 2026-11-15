import { Box, Grid, Link } from "@mui/material";
import { GridRenderCellParams } from "@mui/x-data-grid";
import { intFormatter } from "components/common/numberFormat";
import { percentFormatter } from "components/flakyTrunk/common";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import { ABSENT, parseStamp } from "lib/greenlight/qualityFigures";
import { minutesText } from "lib/targetDeterminator";
import {
  REFIT_OUTCOME_LABELS,
  refitOutcome,
  RefitRow,
  REPORT_TEXT,
  reportInconsistent,
  reportState,
  runUrl,
  verdict,
} from "lib/targetDeterminatorRefits";
import { num } from "lib/targetDeterminatorRows";
import { useMemo } from "react";
import { TdPanel } from "./TdPanel";

export const RUNS_TABLE_ID = "td-refit-runs";
const RUNS_TITLE = "Daily refits in the counted window";
const TABLE_HEIGHT = 460;

export interface RefitTableRow {
  id: string;
  day: string;
  outcome: string;
  failedStep: string;
  minutes: string;
  report: string;
  pooled: string;
  holdout: string;
  days: string;
  url?: string;
}

// Figures are read only from a report that is present: the query blanks any
// other, and this keeps a missing figure a dash rather than a 0.
export function refitTableRows(rows: RefitRow[], now: number): RefitTableRow[] {
  return rows.map((row) => {
    const outcome = refitOutcome(row);
    const report = reportState(row, now);
    const present = report === "present";
    const healthy = num(row.holdout_healthy);
    const floor = num(row.floor_ratio);
    const attempt = num(row.report_attempt);
    const notes = [
      present && attempt !== num(row.refit_attempt)
        ? `figures from attempt ${attempt}`
        : undefined,
      reportInconsistent(row) ? "inconsistent with the refit job" : undefined,
    ].filter((note) => note !== undefined);
    return {
      id: row.run_id,
      day: parseStamp(row.created_at)?.format("YYYY-MM-DD") ?? ABSENT,
      outcome: REFIT_OUTCOME_LABELS[outcome],
      failedStep:
        outcome === "refit_failed" || outcome === "gate_failed"
          ? row.refit_failed_step || ABSENT
          : ABSENT,
      minutes: minutesText(row.refit_minutes),
      report: [REPORT_TEXT[report], ...notes].join("; "),
      pooled: present
        ? `${percentFormatter(num(row.total_ratio))} (floor ${percentFormatter(
            floor
          )}: ${verdict(row.floor_ok)})`
        : ABSENT,
      holdout: present
        ? `scorer ${intFormatter(
            num(row.holdout_scorer_caught)
          )}, TD ${intFormatter(num(row.holdout_td_caught))} of ${intFormatter(
            num(row.holdout_events)
          )}${healthy === 0 ? " (unsound)" : ""}`
        : ABSENT,
      days: present
        ? `${intFormatter(num(row.days_training))} trained, ${intFormatter(
            num(row.days_missing)
          )} missing (${intFormatter(num(row.days_gaps))} gaps, ${intFormatter(
            num(row.days_unhealthy)
          )} unhealthy)`
        : ABSENT,
      url: runUrl(row.run_id),
    };
  });
}

const COLUMNS = [
  { field: "day", headerName: "Day (UTC)", width: 110 },
  { field: "outcome", headerName: "Outcome", width: 180 },
  { field: "failedStep", headerName: "Failed step", flex: 1, minWidth: 200 },
  { field: "minutes", headerName: "Refit job", width: 100 },
  { field: "report", headerName: "Report", flex: 1, minWidth: 200 },
  {
    field: "pooled",
    headerName: "Scorer / TD recall, pooled",
    flex: 1,
    minWidth: 220,
  },
  { field: "holdout", headerName: "Holdout catches", flex: 1, minWidth: 220 },
  { field: "days", headerName: "Days", flex: 1, minWidth: 260 },
  {
    field: "url",
    headerName: "Run",
    width: 80,
    sortable: false,
    renderCell: (params: GridRenderCellParams<RefitTableRow, string>) =>
      params.value === undefined ? (
        ABSENT
      ) : (
        <Link href={params.value} target="_blank" rel="noreferrer">
          Run
        </Link>
      ),
  },
];

export default function RefitTable({
  rows,
  loading,
  error,
  now,
}: {
  rows: RefitRow[];
  loading: boolean;
  error?: string;
  now: number;
}) {
  const data = useMemo(() => refitTableRows(rows, now), [rows, now]);
  return (
    <Grid size={{ xs: 12 }}>
      <Box id={RUNS_TABLE_ID} height={TABLE_HEIGHT}>
        <TdPanel
          title={RUNS_TITLE}
          height={TABLE_HEIGHT}
          loading={loading}
          error={error}
          emptyText={
            data.length === 0 ? "No refit ran in this range." : undefined
          }
        >
          <TablePanelWithData
            title={RUNS_TITLE}
            data={data}
            columns={COLUMNS}
            showFooter={true}
            dataGridProps={{}}
          />
        </TdPanel>
      </Box>
    </Grid>
  );
}
