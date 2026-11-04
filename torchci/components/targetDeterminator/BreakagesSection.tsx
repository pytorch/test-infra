import { Box, Grid, Link } from "@mui/material";
import { GridColDef, GridRenderCellParams } from "@mui/x-data-grid";
import { percentFormatter } from "components/flakyTrunk/common";
import QualityTile, {
  TILE_SPAN,
} from "components/greenlight/quality/QualityTile";
import {
  breakageChunks,
  breakageStats,
  countedRange,
  DAY_MS,
  dayStart,
  NEW_TEST_CHECK_FROM,
  NEW_TEST_DAYS,
  prUrl,
  REVERT_WINDOW_DAYS,
  sectionLimits,
  TD_QUERIES,
  TD_SCOPE,
  TdParams,
  useTdQuery,
} from "lib/targetDeterminator";
import {
  BreakageOutcome,
  BreakageRow,
  mergeBreakageChunks,
  num,
  OUTCOME_LABELS,
  TEST_OUTCOME_LABELS,
  TestOutcome,
  type Chunk,
  type TdTotalState,
} from "lib/targetDeterminatorRows";
import { ReactNode, useMemo } from "react";
import {
  commitLink,
  TABLE_HEIGHT,
  TdSection,
  TdTable,
  utcColumn,
} from "./TdPanel";
import { TdCharts, TdChartsState, tileToggle } from "./TdTrends";

function lines(items: ReactNode[]) {
  return (
    <Box
      sx={{ py: 0.5, whiteSpace: "normal", maxHeight: 200, overflowY: "auto" }}
    >
      {items.map((item, i) => (
        <div key={i}>{item}</div>
      ))}
    </Box>
  );
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

function breakingTests(row: BreakageRow): ReactNode[] {
  const files = row.test_files ?? [];
  const total = num(row.breaking_tests) ?? files.length;
  const items: ReactNode[] = files.map((file, i) => {
    const outcome = row.test_outcomes?.[i] as TestOutcome | undefined;
    const label =
      outcome === undefined
        ? "unknown"
        : TEST_OUTCOME_LABELS[outcome] ?? outcome;
    return (
      <>
        {file} in {row.test_configs?.[i] ?? "?"}: {label} (PR{" "}
        {prLink(row.test_prs?.[i])})
      </>
    );
  });
  if (total > files.length) {
    items.push(
      `Showing ${files.length.toLocaleString()} of ${total.toLocaleString()} breaking tests.`
    );
  }
  return items;
}

const EVENT_COLUMNS: GridColDef[] = [
  utcColumn("landed_at", "Landed (UTC)"),
  utcColumn("reverted_at", "Reverted (UTC)"),
  {
    field: "landing_sha",
    headerName: "Landed commit",
    width: 120,
    sortable: false,
    renderCell: (params: GridRenderCellParams<BreakageRow>) =>
      commitLink(params.row.landing_sha),
  },
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

const UPPER_BOUND_TEXT = `Before ${NEW_TEST_CHECK_FROM} new tests cannot be told apart from tests TD skipped, so false greens there are an upper bound`;

function useChunk(chunk: Chunk | undefined) {
  return useTdQuery<BreakageRow>(TD_QUERIES.breakages, chunk, {
    tdWorkflows: TD_SCOPE.tdWorkflows,
  });
}

// One SWR entry per chunk, so a closed chunk stays cached while the newest one
// changes. Hooks cannot run in a loop, hence one call per MAX_CHUNKS slot.
function useBreakages(chunks: Chunk[]): TdTotalState<BreakageRow> {
  const states = [
    useChunk(chunks[0]),
    useChunk(chunks[1]),
    useChunk(chunks[2]),
    useChunk(chunks[3]),
    useChunk(chunks[4]),
    useChunk(chunks[5]),
  ];
  return mergeBreakageChunks(TD_QUERIES.breakages, chunks, states);
}

export default function BreakagesSection({
  params,
  charts,
}: {
  params: TdParams;
  charts: TdChartsState;
}) {
  const now = Date.now();
  const { chunks, range } = breakageChunks(
    countedRange(params, sectionLimits(now).breakages, now),
    now
  );
  const breakages = useBreakages(chunks);
  const total = breakages.total;
  const error = breakages.tileError;
  const stats = breakageStats(total);
  const events = num(total?.events) ?? 0;
  const eventRows = useMemo(
    () => breakages.rows.filter((row) => row.grain === "event"),
    [breakages.rows]
  );
  const countedUntil = now - REVERT_WINDOW_DAYS * DAY_MS;
  const upperBound =
    !range.empty && range.start < dayStart(NEW_TEST_CHECK_FROM);
  const upperBoundNote = upperBound ? ` ${UPPER_BOUND_TEXT}.` : "";
  const unknownNote =
    stats.unknown > 0
      ? ` Left out: ${stats.unknown.toLocaleString()} with an unknown cause.`
      : "";
  const noListed =
    "No reverted landings with a traced breaking test in this window.";
  const noEvents =
    range.start >= countedUntil
      ? `None counted yet: landings from the last ${REVERT_WINDOW_DAYS} days may still be reverted${
          eventRows.length > 0 ? ` (${eventRows.length} listed below)` : ""
        }.`
      : noListed;

  return (
    <TdSection
      title="Breakages TD let through"
      range={
        upperBound
          ? {
              ...range,
              note: [range.note, `${UPPER_BOUND_TEXT}.`]
                .filter((note) => note !== undefined)
                .join(" "),
            }
          : range
      }
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
          {...tileToggle(charts, "falseGreens")}
          loading={breakages.loading}
          error={error}
          value={events === 0 ? "-" : stats.falseGreens.toLocaleString()}
          sub={
            events === 0
              ? noEvents
              : stats.known === 0
              ? `No breakage with a known cause.${unknownNote}`
              : `${percentFormatter(
                  stats.share
                )} of ${stats.known.toLocaleString()} breakages with a known cause (95% interval ${percentFormatter(
                  stats.interval?.low
                )} to ${percentFormatter(stats.interval?.high)}); ${
                  stats.perThousandLandings === null
                    ? "no PR landings"
                    : stats.perThousandLandings.toFixed(2)
                } per 1,000 PR landings.${unknownNote}${upperBoundNote}`
          }
          caveat={`A false green is a reverted landing where no breaking test failed on the PR and TD skipped a breaking test file that did not run and pass on the PR in another job, although the job ran and the test first ran in CI at least ${NEW_TEST_DAYS} days before the landing. A reland counts as a second landing. Landraces, tests newer than the PR and jobs that did not run on the PR are not false greens. The share is false greens / (breakages - unknown).`}
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Breakage recall"
          {...tileToggle(charts, "recall")}
          loading={breakages.loading}
          error={error}
          value={percentFormatter(stats.recall)}
          sub={
            events === 0
              ? noEvents
              : stats.recallBase === 0
              ? `No breakage whose test could have run on the PR.${unknownNote}`
              : `TD ran the breaking tests in ${stats.ranOnPr.toLocaleString()} of ${stats.recallBase.toLocaleString()} breakages whose tests could run on the PR. TD skipped at least one breaking test in ${stats.tdSkippedAny.toLocaleString()} breakages.${unknownNote}${
                  upperBound
                    ? ` ${UPPER_BOUND_TEXT}, and recall a lower bound.`
                    : ""
                }`
          }
          caveat="Breakages where TD ran every breaking test that mattered: (failed on the PR + passed on the PR) / (failed on the PR + passed on the PR + false greens). A breaking test that failed on the PR was in front of the author before landing; one that passed on the PR broke only after landing, which is not TD's doing."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Reverted landings traced"
          {...tileToggle(charts, "traced")}
          loading={breakages.loading}
          error={error}
          value={events === 0 ? "-" : events.toLocaleString()}
          sub={
            events === 0
              ? noEvents
              : `Failed on the PR but merged anyway ${
                  num(total?.signal_on_pr) ?? 0
                }, passed on the PR ${
                  num(total?.passed_on_pr) ?? 0
                }, landraces ${
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
      <TdCharts
        charts={charts}
        keys={["falseGreens", "recall", "traced"]}
        sources={{
          breakages: {
            ...breakages,
            window: {
              ...range,
              countedUntil,
              upperBoundBefore: dayStart(NEW_TEST_CHECK_FROM),
            },
          },
        }}
      />
      <Grid size={{ xs: 12 }} height={TABLE_HEIGHT}>
        <TdTable
          title="Reverted landings and their breaking tests"
          state={breakages}
          rows={eventRows}
          columns={EVENT_COLUMNS}
          emptyText={noListed}
          height={TABLE_HEIGHT}
          sortField="landed_at"
          dataGridProps={{
            getRowId: (row: BreakageRow) => row.landing_sha,
            getRowHeight: () => "auto",
          }}
        />
      </Grid>
    </TdSection>
  );
}
