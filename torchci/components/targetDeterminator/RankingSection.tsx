import { Grid, Paper, useTheme } from "@mui/material";
import { GridColDef, GridRenderCellParams } from "@mui/x-data-grid";
import { percentFormatter } from "components/flakyTrunk/common";
import QualityTile, {
  TILE_SPAN,
} from "components/greenlight/quality/QualityTile";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { parseStamp } from "lib/greenlight/qualityFigures";
import {
  countedRange,
  CurvePoint,
  recallCurve,
  sectionLimits,
  SMALL_SAMPLE,
  TD_CUT_PCT,
  TD_QUERIES,
  TdParams,
  wilsonInterval,
} from "lib/targetDeterminator";
import { num, type RankRow, ratio } from "lib/targetDeterminatorRows";
import { useMemo } from "react";
import {
  CHART_HEIGHT,
  commitLink,
  TdPanel,
  TdSection,
  TdTable,
  useTdTotalQuery,
  utcColumn,
} from "./TdPanel";
import { TdCharts, TdChartsState, tileToggle } from "./TdTrends";

const MISS_COLUMNS: GridColDef[] = [
  utcColumn("landed_at", "Landed (UTC)"),
  {
    field: "test_file",
    headerName: "Best-ranked failing test file",
    flex: 1,
    minWidth: 260,
  },
  { field: "config", headerName: "Job config", flex: 1, minWidth: 260 },
  {
    field: "rank_pct",
    headerName: "TD rank (top %)",
    type: "number",
    width: 140,
    valueGetter: (value: unknown) => {
      const pct = num(value);
      return pct === null ? null : Math.round(pct * 10) / 10;
    },
  },
  {
    field: "sha",
    headerName: "Commit",
    width: 120,
    sortable: false,
    renderCell: (params: GridRenderCellParams<RankRow>) =>
      commitLink(params.row.sha),
  },
];

function curveOption(points: CurvePoint[]): EChartsOption {
  return {
    title: { text: "Share of trunk breakages TD would catch at each cut" },
    grid: { top: 60, right: 32, bottom: 48, left: 56 },
    tooltip: {
      trigger: "axis",
      valueFormatter: (value) => `${Number(value).toFixed(1)}%`,
    },
    xAxis: {
      type: "value",
      min: 0,
      max: 100,
      name: "Tests run: top N% of TD's ranking",
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
        name: "Breakages caught inside the top N%",
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
  charts,
}: {
  params: TdParams;
  charts: TdChartsState;
}) {
  const theme = useTheme();
  const range = countedRange(params, sectionLimits().ranks);
  const ranks = useTdTotalQuery<RankRow>(TD_QUERIES.ranks, range.params);
  const total = ranks.total;
  const error = ranks.tileError;
  const landings = num(total?.landings) ?? 0;
  const insideCut = num(total?.inside_cut) ?? 0;
  const secondHalf = num(total?.second_half) ?? 0;
  const failures = num(total?.failures) ?? 0;
  const interval = wilsonInterval(insideCut, landings);

  const points = useMemo(() => recallCurve(ranks.rows), [ranks.rows]);
  const landingRows = useMemo(
    () => ranks.rows.filter((row) => row.grain === "landing"),
    [ranks.rows]
  );
  const misses = useMemo(
    () =>
      landingRows
        .filter((row) => num(row.inside_cut) === 0)
        .map((row, i) => ({ ...row, id: `${row.sha}-${i}` })),
    [landingRows]
  );
  // The query lists the newest landings only; older buckets would undercount.
  const truncated = landingRows.length < landings;
  const oldestListed = landingRows.reduce(
    (oldest, row) =>
      Math.min(oldest, parseStamp(row.landed_at)?.valueOf() ?? Infinity),
    Infinity
  );
  const noLandings = "No trunk breakages with a TD ranking in this window.";
  const sample =
    landings > 0 && landings < SMALL_SAMPLE
      ? ` A small sample: ${landings.toLocaleString()} landings, ${failures.toLocaleString()} failing tests.`
      : "";

  return (
    <TdSection
      title="Is TD picking the right tests?"
      range={range}
      intro={
        "TD ranks every test by how likely it is to fail and runs the top " +
        `${TD_CUT_PCT}% on PRs. Main runs every test, so when a landed PR ` +
        "breaks tests on main we can see where TD had ranked them: if TD had " +
        "run on that trunk commit, would it have caught the breakage? A " +
        "landing counts as caught when any one of its failing tests is inside " +
        "the cut, and a landing that broke many tests counts once."
      }
    >
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Trunk breakages TD would have caught"
          {...tileToggle(charts, "caught")}
          loading={ranks.loading}
          error={error}
          value={percentFormatter(ratio(insideCut, landings))}
          sub={
            landings === 0
              ? noLandings
              : `${insideCut.toLocaleString()} of ${landings.toLocaleString()} landings, if TD had run on those trunk commits (95% interval ${percentFormatter(
                  interval?.low
                )} to ${percentFormatter(interval?.high)}).${sample}`
          }
          caveat="Single-commit main pushes that newly broke tests: failing in two main runs and not failing just before the push. Each is ranked by TD against the push's own diff. A trend for comparing TD changes, not PR recall: breakages TD catches on PRs never reach main, and the ranking on main lacks the PR-only signals."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Caught only by the second half of TD's picks"
          {...tileToggle(charts, "secondHalf")}
          loading={ranks.loading}
          error={error}
          value={percentFormatter(ratio(secondHalf, landings))}
          sub={
            landings === 0
              ? noLandings
              : `${secondHalf.toLocaleString()} of ${landings.toLocaleString()} landings had their best-ranked failing test between the top ${
                  TD_CUT_PCT / 2
                }% and the top ${TD_CUT_PCT}%: what the last half of TD's test budget buys.`
          }
          caveat="Same landings as the tile before. A small share means TD could run fewer tests and still catch most breakages; a large one means the budget matters."
        />
      </Grid>
      <TdCharts
        charts={charts}
        keys={["caught", "secondHalf"]}
        sources={{
          ranks: {
            ...ranks,
            window: {
              ...range,
              countedFrom: truncated ? oldestListed : undefined,
            },
            note: truncated
              ? `Charts the newest ${landingRows.length.toLocaleString()} of ${landings.toLocaleString()} landings.`
              : undefined,
          },
        }}
      />
      <Grid size={{ xs: 12, lg: 6 }} height={CHART_HEIGHT}>
        <TdPanel
          title="Share of trunk breakages TD would catch at each cut"
          height={CHART_HEIGHT}
          loading={ranks.loading}
          error={ranks.error}
          emptyText={points.length === 0 ? noLandings : undefined}
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
        <TdTable
          title={`Trunk breakages outside TD's cut: newest ${misses.length.toLocaleString()} of ${(
            landings - insideCut
          ).toLocaleString()}`}
          state={ranks}
          rows={misses}
          columns={MISS_COLUMNS}
          emptyText="No trunk breakages outside TD's cut in this window."
          height={CHART_HEIGHT}
          sortField="landed_at"
        />
      </Grid>
    </TdSection>
  );
}
