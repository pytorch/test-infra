import { Box, Grid, Link } from "@mui/material";
import { GridColDef, GridRenderCellParams } from "@mui/x-data-grid";
import QualityTile, {
  TILE_SPAN,
} from "components/greenlight/quality/QualityTile";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import {
  BreakageOutcome,
  BreakageRow,
  breakageStats,
  commitUrl,
  fractionText,
  HORIZON_DAYS,
  num,
  OUTCOME_LABELS,
  prUrl,
  REVERT_WINDOW_DAYS,
  TD_QUERIES,
  TEST_OUTCOME_LABELS,
  TestOutcome,
  totalError,
  totalRow,
  useTdQuery,
} from "lib/targetDeterminator";
import { ReactNode, useMemo } from "react";
import { TABLE_HEIGHT, TablePaper, TdPanel, TdSection } from "./TdPanel";

function lines(items: ReactNode[]) {
  return (
    <Box sx={{ py: 0.5, whiteSpace: "normal" }}>
      {items.map((item, i) => (
        <div key={i}>{item}</div>
      ))}
    </Box>
  );
}

function shortSha(sha: string): string {
  return sha.slice(0, 10);
}

function prLink(pr: unknown) {
  const url = prUrl(pr);
  return url === undefined ? (
    String(pr)
  ) : (
    <Link href={url} target="_blank" rel="noreferrer">
      #{num(pr)}
    </Link>
  );
}

function commitLink(sha: string) {
  const url = commitUrl(sha);
  return url === undefined ? (
    sha
  ) : (
    <Link href={url} target="_blank" rel="noreferrer">
      {shortSha(sha)}
    </Link>
  );
}

function breakingTests(row: BreakageRow): ReactNode[] {
  const files = row.test_files ?? [];
  return files.map((file, i) => {
    const outcome = row.test_outcomes?.[i] as TestOutcome | undefined;
    const label =
      outcome === undefined
        ? "unknown"
        : TEST_OUTCOME_LABELS[outcome] ?? outcome;
    return (
      <>
        {file} in {row.test_configs?.[i] ?? "?"}: {label} on{" "}
        {prLink(row.test_prs?.[i])}
      </>
    );
  });
}

const EVENT_COLUMNS: GridColDef[] = [
  { field: "landed_at", headerName: "Landed (UTC)", width: 160 },
  { field: "reverted_at", headerName: "Reverted (UTC)", width: 160 },
  {
    field: "reverted_prs",
    headerName: "Reverted PRs",
    width: 130,
    renderCell: (params: GridRenderCellParams<BreakageRow>) =>
      lines((params.row.reverted_prs ?? []).map(prLink)),
  },
  {
    field: "outcome",
    headerName: "Outcome",
    width: 220,
    valueGetter: (value: BreakageOutcome) => OUTCOME_LABELS[value] ?? value,
  },
  {
    field: "tests",
    headerName: "Breaking tests and what happened on each PR",
    flex: 1,
    minWidth: 420,
    sortable: false,
    renderCell: (params: GridRenderCellParams<BreakageRow>) =>
      lines(breakingTests(params.row)),
  },
  { field: "revert_class", headerName: "Revert reason", width: 120 },
  { field: "stack_size", headerName: "Stack size", type: "number", width: 100 },
  {
    field: "revert_shas",
    headerName: "Revert commits",
    width: 130,
    sortable: false,
    renderCell: (params: GridRenderCellParams<BreakageRow>) =>
      lines((params.row.revert_shas ?? []).map(commitLink)),
  },
  {
    field: "window_closed",
    headerName: "Counted",
    width: 100,
    valueGetter: (value: unknown) => (num(value) === 1 ? "yes" : "not yet"),
  },
];

export default function BreakagesSection({
  params,
  windowDays,
}: {
  params: Record<string, unknown>;
  windowDays: number;
}) {
  const breakages = useTdQuery<BreakageRow>(TD_QUERIES.breakages, params);
  const total = totalRow(breakages.rows);
  const error = totalError(TD_QUERIES.breakages, breakages, total);
  const stats = breakageStats(total);
  const events = num(total?.events) ?? 0;
  const eventRows = useMemo(
    () => breakages.rows.filter((row) => row.grain === "event"),
    [breakages.rows]
  );
  const unknownNote =
    stats.unknown > 0
      ? ` ${stats.unknown.toLocaleString()} breakages with unknown cause left out.`
      : "";
  const noEvents =
    "No reverted landings with a traced breaking test in this window.";

  return (
    <TdSection
      title="Breakages TD let through"
      windowDays={windowDays}
      horizonDays={HORIZON_DAYS.breakages}
      intro={
        "When TD skips a test that would have failed, the PR shows green, " +
        "lands and breaks main, and is reverted: a false green. These are " +
        "landings reverted by the merge bot within " +
        `${REVERT_WINDOW_DAYS} days, traced to the tests that broke. Landings ` +
        `from the last ${REVERT_WINDOW_DAYS} days are listed but not yet counted.`
      }
    >
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="False greens"
          loading={breakages.loading}
          error={error}
          value={events === 0 ? "-" : stats.falseGreens.toLocaleString()}
          sub={
            events === 0
              ? noEvents
              : stats.known === 0
              ? `No breakage with a known cause.${unknownNote}`
              : `${fractionText(
                  stats.share
                )} of ${stats.known.toLocaleString()} breakages with a known cause (95% interval ${fractionText(
                  stats.interval?.low ?? null
                )} to ${fractionText(stats.interval?.high ?? null)}); ${
                  stats.perThousandPrs === null
                    ? "no landed PRs"
                    : stats.perThousandPrs.toFixed(2)
                } per 1,000 landed PRs.${unknownNote}`
          }
          caveat="A false green is a reverted landing whose breaking test did not run on the PR because TD skipped it, although the job ran and the test already existed. Landraces, tests newer than the PR and jobs that did not run on the PR are not false greens."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Breakage recall"
          loading={breakages.loading}
          error={error}
          value={fractionText(stats.recall)}
          sub={
            events === 0
              ? noEvents
              : stats.recallBase === 0
              ? `No breakage whose test could have run on the PR.${unknownNote}`
              : `The breaking test ran on the PR in ${(
                  num(total?.caught_on_pr) ?? 0
                ).toLocaleString()} of ${stats.recallBase.toLocaleString()} breakages whose job ran on the PR.${unknownNote}`
          }
          caveat="Caught on the PR / (caught on the PR + false greens + tests newer than the PR). A breaking test that ran on the PR was in front of the author before landing."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Reverted landings traced"
          loading={breakages.loading}
          error={error}
          value={events === 0 ? "-" : events.toLocaleString()}
          sub={
            events === 0
              ? noEvents
              : `Landraces ${
                  num(total?.landrace) ?? 0
                }, job not run on the PR ${
                  num(total?.not_in_pr_matrix) ?? 0
                }, tests newer than the PR ${num(total?.new_test) ?? 0}. ${
                  num(total?.other_reverts) ?? 0
                } other reverts without a traced test, ${
                  num(total?.ghfirst_reverts) ?? 0
                } internal-first reverts excluded.`
          }
          caveat="Landings whose revert window has closed and whose breaking tests were confirmed by a second failing run on main."
        />
      </Grid>
      <Grid size={{ xs: 12 }} height={TABLE_HEIGHT}>
        <TdPanel
          title="Reverted landings"
          height={TABLE_HEIGHT}
          loading={breakages.loading}
          error={breakages.error}
          emptyText={eventRows.length === 0 ? noEvents : undefined}
        >
          <TablePaper height={TABLE_HEIGHT}>
            <TablePanelWithData
              title="Reverted landings and their breaking tests"
              data={eventRows}
              columns={EVENT_COLUMNS}
              showFooter={true}
              dataGridProps={{
                getRowId: (row: BreakageRow) => row.landing_sha,
                getRowHeight: () => "auto",
                initialState: {
                  sorting: {
                    sortModel: [{ field: "landed_at", sort: "desc" }],
                  },
                },
              }}
            />
          </TablePaper>
        </TdPanel>
      </Grid>
    </TdSection>
  );
}
