import { Grid, Link, Paper, useTheme } from "@mui/material";
import { GridColDef, GridRenderCellParams } from "@mui/x-data-grid";
import QualityTile, {
  TILE_SPAN,
} from "components/greenlight/quality/QualityTile";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import {
  commitUrl,
  CurvePoint,
  fractionText,
  HORIZON_DAYS,
  num,
  RankRow,
  ratio,
  recallCurve,
  TD_CUT_PCT,
  TD_QUERIES,
  totalError,
  totalRow,
  useTdQuery,
} from "lib/targetDeterminator";
import { useMemo } from "react";
import { CHART_HEIGHT, TablePaper, TdPanel, TdSection } from "./TdPanel";

const MISS_COLUMNS: GridColDef[] = [
  { field: "landed_at", headerName: "Landed (UTC)", width: 160 },
  { field: "test_file", headerName: "Test file", flex: 1, minWidth: 260 },
  { field: "config", headerName: "Job config", flex: 1, minWidth: 260 },
  {
    field: "rank_pct",
    headerName: "TD rank (top %)",
    type: "number",
    width: 140,
    valueGetter: (value: unknown) => num(value),
  },
  {
    field: "sha",
    headerName: "Commit",
    width: 120,
    sortable: false,
    renderCell: (params: GridRenderCellParams<RankRow>) => {
      const url = commitUrl(params.row.sha);
      return url === undefined ? (
        params.row.sha
      ) : (
        <Link href={url} target="_blank" rel="noreferrer">
          {params.row.sha.slice(0, 10)}
        </Link>
      );
    },
  },
];

function curveOption(points: CurvePoint[]): EChartsOption {
  return {
    title: { text: "Share of new trunk failures inside TD's top N%" },
    grid: { top: 60, right: 32, bottom: 48, left: 56 },
    tooltip: {
      trigger: "axis",
      valueFormatter: (value) => `${Number(value).toFixed(1)}%`,
    },
    xAxis: {
      type: "value",
      min: 0,
      max: 100,
      name: "Top N% of TD's ranking",
      nameLocation: "middle",
      nameGap: 28,
      axisLabel: { formatter: "{value}%" },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: 100,
      axisLabel: { formatter: "{value}%" },
    },
    series: [
      {
        name: "Failures inside the top N%",
        type: "line",
        showSymbol: false,
        data: points.map((point) => [point.pct, point.share * 100]),
        markLine: {
          symbol: "none",
          label: { formatter: `TD's cut (${TD_CUT_PCT}%)` },
          data: [{ xAxis: TD_CUT_PCT }],
        },
      },
    ],
  };
}

export default function RankingSection({
  params,
  windowDays,
}: {
  params: Record<string, unknown>;
  windowDays: number;
}) {
  const theme = useTheme();
  const ranks = useTdQuery<RankRow>(TD_QUERIES.ranks, params);
  const trunk = totalRow(ranks.rows, (row) => row.population === "trunk_new");
  const prOrder = totalRow(ranks.rows, (row) => row.population === "pr_order");
  const trunkError = totalError(TD_QUERIES.ranks, ranks, trunk);
  const prError = totalError(TD_QUERIES.ranks, ranks, prOrder);
  const failures = num(trunk?.failures) ?? 0;
  const insideCut = num(trunk?.inside_cut) ?? 0;
  const secondHalf = num(trunk?.second_half) ?? 0;
  const prFailures = num(prOrder?.failures) ?? 0;
  const prMedian = num(prOrder?.median_pct);

  const points = useMemo(() => recallCurve(ranks.rows), [ranks.rows]);
  const misses = useMemo(
    () =>
      ranks.rows
        .filter((row) => row.grain === "miss")
        .map((row, i) => ({
          ...row,
          id: `${row.sha}-${row.config}-${row.test_file}-${i}`,
        })),
    [ranks.rows]
  );
  const noFailures = "No new trunk failures with a TD ranking in this window.";

  return (
    <TdSection
      title="Is TD picking the right tests?"
      windowDays={windowDays}
      horizonDays={HORIZON_DAYS.ranks}
      intro={
        "TD ranks every test by how likely it is to fail and runs the top " +
        `${TD_CUT_PCT}% on PRs. Main runs every test, so a new failure on ` +
        "main shows where TD had ranked the failing test: if TD had run on " +
        "that trunk commit, would the test have been inside its cut?"
      }
    >
      <Grid size={TILE_SPAN}>
        <QualityTile
          label={`New trunk failures inside TD's ${TD_CUT_PCT}% cut`}
          loading={ranks.loading}
          error={trunkError}
          value={fractionText(ratio(insideCut, failures))}
          sub={
            failures === 0
              ? noFailures
              : `${insideCut.toLocaleString()} of ${failures.toLocaleString()} failures, if TD had run on those trunk commits.`
          }
          caveat="Failing test files on single-commit main pushes, confirmed by a second failing run and passing just before the push, ranked by TD against the push's own diff. A trend for comparing TD changes, not PR recall: failures TD catches on PRs never reach main, and the ranking on main lacks the PR-only signals."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Caught by the second half of TD's picks"
          loading={ranks.loading}
          error={trunkError}
          value={fractionText(ratio(secondHalf, failures))}
          sub={
            failures === 0
              ? noFailures
              : `${secondHalf.toLocaleString()} of ${failures.toLocaleString()} new trunk failures ranked between the top ${
                  TD_CUT_PCT / 2
                }% and the top ${TD_CUT_PCT}%: what the last half of TD's test budget buys.`
          }
          caveat="Same failures as the tile before. A small share means TD could run fewer tests and still catch most failures; a large one means the budget matters."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="How early TD runs a failing test on PRs"
          loading={ranks.loading}
          error={prError}
          value={
            prMedian === null || prFailures === 0
              ? "-"
              : `top ${prMedian.toFixed(0)}%`
          }
          sub={
            prFailures === 0
              ? "No failing PR jobs with TD on in this window."
              : `Median position of the first failing test within TD's picks, over ${prFailures.toLocaleString()} failing PR jobs.`
          }
          caveat="Lower is better: the failing test runs earlier and the contributor sees red sooner. Only the first failure of each job counts, because a PR job stops at its first failing test file."
        />
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }} height={CHART_HEIGHT}>
        <TdPanel
          title="Share of new trunk failures inside TD's top N%"
          height={CHART_HEIGHT}
          loading={ranks.loading}
          error={ranks.error}
          emptyText={points.length === 0 ? noFailures : undefined}
        >
          <Paper elevation={3} sx={{ p: 2, height: CHART_HEIGHT }}>
            <ReactECharts
              option={curveOption(points)}
              theme={theme.palette.mode === "dark" ? "dark-hud" : undefined}
              notMerge={true}
              style={{ height: "100%", width: "100%" }}
            />
          </Paper>
        </TdPanel>
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }} height={CHART_HEIGHT}>
        <TdPanel
          title="New trunk failures outside TD's cut"
          height={CHART_HEIGHT}
          loading={ranks.loading}
          error={ranks.error}
          emptyText={
            misses.length === 0
              ? "No new trunk failures outside TD's cut in this window."
              : undefined
          }
        >
          <TablePaper height={CHART_HEIGHT}>
            <TablePanelWithData
              title={`New trunk failures outside TD's cut: newest ${misses.length.toLocaleString()} of ${(
                failures - insideCut
              ).toLocaleString()}`}
              data={misses}
              columns={MISS_COLUMNS}
              showFooter={true}
              dataGridProps={{
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
