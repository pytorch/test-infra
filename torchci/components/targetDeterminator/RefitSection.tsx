import { Box, Grid, Typography } from "@mui/material";
import { intFormatter } from "components/common/numberFormat";
import { percentFormatter } from "components/flakyTrunk/common";
import QualityTile, {
  TILE_SPAN,
  type TileToggleProps,
} from "components/greenlight/quality/QualityTile";
import { TimeSeriesPanelWithData } from "components/metrics/panels/TimeSeriesPanel";
import type { EChartsOption } from "echarts";
import { NO_DATA_IN_WINDOW, parseStamp } from "lib/greenlight/qualityFigures";
import {
  countedRange,
  CountedRange,
  sectionLimits,
  TD_QUERIES,
  TD_SWR_CONFIG,
  TdParams,
  useTdQuery,
} from "lib/targetDeterminator";
import {
  BUDGET_MAX_AGE_DAYS,
  type BudgetState,
  lastCompleteMonth,
  latestReport,
  type LiveModel,
  MODEL_MAX_AGE_DAYS,
  OUTCOME_TEXT,
  readLiveModel,
  type RefitMonth,
  refitOutcome,
  type RefitRow,
  reportMonths,
} from "lib/targetDeterminatorRefits";
import { num, type TdQueryState } from "lib/targetDeterminatorRows";
import { useState } from "react";
import useSWR from "swr";
import RefitTable, { RUNS_TABLE_ID } from "./RefitTable";
import { CHART_HEIGHT, TdPanel, TdSection } from "./TdPanel";

type RefitView = "months" | "runs";
const MONTHS_CHART_ID = "td-refit-months";
const VIEW_IDS: Record<RefitView, string> = {
  months: MONTHS_CHART_ID,
  runs: RUNS_TABLE_ID,
};
const MONTHS_TITLE = "Walk-forward months of the latest report";
const NO_REPORT = "No report uploaded in this range";

const LIVE_TEXT: Record<LiveModel["state"], string> = {
  loading: "-",
  unknown: "Unknown",
  disabled: "Disabled",
  stale: "Stale",
  usable: "In use",
};
const BUDGET_TEXT: Record<BudgetState, string> = {
  live: "budget live",
  off: "no budget",
  stale: "budget dropped as stale",
  mismatch: "budget file from another refit",
  unusable: "budget file unusable",
  unknown: "budget file unknown",
};

export function liveModelSub(live: LiveModel): string | undefined {
  if (live.state === "loading" || live.state === "unknown") {
    return live.state === "unknown"
      ? "The model files could not be read."
      : undefined;
  }
  if (live.state === "disabled") {
    return `Version ${live.version}, switched off.`;
  }
  const age =
    live.ageDays === null
      ? "not a date"
      : `${live.ageDays} day${live.ageDays === 1 ? "" : "s"} old (UTC)`;
  return live.state === "stale"
    ? `Version ${live.version}, ${age}.`
    : `Version ${live.version}, ${age}; ${BUDGET_TEXT[live.budget]}.`;
}

function useLiveModel(): LiveModel {
  const { data, error } = useSWR(
    "td-scorer-live-model",
    () => readLiveModel(Date.now()),
    TD_SWR_CONFIG
  );
  return error !== undefined
    ? { state: "unknown" }
    : data ?? { state: "loading" };
}

const ratioText = (value: number | null) =>
  value === null ? "-" : value.toFixed(2);

// Series names are fixed here; nothing from a report reaches the chart's HTML
// but numbers and month labels that passed reportMonths' pattern.
const MONTH_SERIES: {
  name: string;
  value: (_m: RefitMonth) => number | null;
}[] = [
  { name: "Scorer / TD recall", value: (m) => m.ratio },
  { name: "Event recall", value: (m) => m.eventRecall },
  { name: "Risk AUC", value: (m) => m.riskAuc },
];

export function monthTooltip(month: RefitMonth | undefined): string {
  if (month === undefined) {
    return "";
  }
  return [
    `<b>${month.month}</b>${month.partial ? " (partial month)" : ""}`,
    ...MONTH_SERIES.map((s) => `${s.name}: ${ratioText(s.value(month))}`),
    `PRs with failures: ${intFormatter(month.prs)}`,
    `Trunk landings caught: ${intFormatter(
      month.trunkCaught
    )} of ${intFormatter(month.trunkLandings)}`,
  ].join("<br/>");
}

export function monthSeries(months: RefitMonth[], floor: number | null) {
  return MONTH_SERIES.map((series, j) => ({
    name: series.name,
    type: "line",
    symbol: "circle",
    symbolSize: 5,
    connectNulls: false,
    data: months.map((m) => ({
      value: [m.start, series.value(m)],
      ...(m.partial ? { symbol: "emptyCircle", symbolSize: 8 } : {}),
    })),
    ...(j === 0 && floor !== null
      ? {
          markLine: {
            silent: true,
            symbol: "none",
            label: { formatter: "Floor" },
            data: [{ yAxis: floor }],
          },
        }
      : {}),
  }));
}

function monthOptions(months: RefitMonth[]): EChartsOption {
  return {
    useUTC: true,
    grid: { containLabel: true },
    yAxis: { min: 0, max: 1 },
    tooltip: {
      trigger: "axis",
      formatter: (params: any) => {
        const items = Array.isArray(params) ? params : [params];
        return monthTooltip(months[items[0]?.dataIndex ?? -1]);
      },
    },
  };
}

function MonthChart({
  report,
  loading,
  error,
}: {
  report: RefitRow | undefined;
  loading: boolean;
  error?: string;
}) {
  const months = report === undefined ? [] : reportMonths(report);
  return (
    <Grid size={{ xs: 12 }}>
      <Box id={MONTHS_CHART_ID}>
        <TdPanel
          title={MONTHS_TITLE}
          height={CHART_HEIGHT}
          loading={loading}
          error={error}
          emptyText={months.length === 0 ? NO_REPORT : undefined}
        >
          <Box sx={{ height: CHART_HEIGHT }}>
            <TimeSeriesPanelWithData
              data={[]}
              series={monthSeries(months, num(report?.floor_ratio))}
              title={MONTHS_TITLE}
              groupByFieldName="series"
              legendPadding={220}
              yAxisLabel="Ratio, recall, AUC"
              yAxisRenderer={(v) => String(v)}
              additionalOptions={monthOptions(months)}
            />
          </Box>
        </TdPanel>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Each point is one UTC month the refit evaluated walking forward, from
          the newest report in the range; a hollow point is a month the refit
          saw only part of. The line marks that report&apos;s floor for the
          recall ratio.
        </Typography>
      </Box>
    </Grid>
  );
}

export interface RefitSectionViewProps {
  range: CountedRange;
  refits: TdQueryState<RefitRow>;
  live: LiveModel;
  open: ReadonlySet<RefitView>;
  onToggle: (_view: RefitView) => void;
  now: number;
}

export function RefitSectionView({
  range,
  refits,
  live,
  open,
  onToggle,
  now,
}: RefitSectionViewProps) {
  const toggle = (view: RefitView): TileToggleProps => ({
    selected: open.has(view),
    onToggle: () => onToggle(view),
    controlsId: VIEW_IDS[view],
  });
  const { loading, error, rows } = refits;
  const empty = rows.length === 0;
  const latest = rows[0];
  const outcome = latest === undefined ? undefined : refitOutcome(latest);
  const published = rows.filter((r) => refitOutcome(r) === "published").length;
  const report = latestReport(rows, now);
  const month =
    report === undefined ? undefined : lastCompleteMonth(reportMonths(report));
  const floor = num(report?.floor_ratio);
  const budgetOn = num(report?.budget_on) === 1;
  const noFigure = empty ? NO_DATA_IN_WINDOW : NO_REPORT;
  const monthSub =
    month === undefined
      ? report === undefined
        ? noFigure
        : "No complete month in the latest report"
      : `${month.month}, ${intFormatter(month.prs)} PRs with failures`;
  const queryProps = { loading, error };

  return (
    <TdSection
      title="Daily scorer refit"
      range={range}
      intro={
        "Every day a workflow in pytorch/test-infra refits the TD scorer on " +
        "recent CI, checks it against TD and pytorch's own code, and " +
        "publishes it to the files pytorch reads. These figures come from the " +
        "refit's own evaluation: they inform, and the workflow's gate decides " +
        "what publishes."
      }
    >
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Live scorer model"
          loading={live.state === "loading"}
          value={LIVE_TEXT[live.state]}
          sub={liveModelSub(live)}
          caveat={`Read now from generated-stats, whatever the picked window. pytorch uses td-scorer.json while it is enabled and at most ${MODEL_MAX_AGE_DAYS} days old, and a test budget only from td-scorer-budget.json of the same refit, at most ${BUDGET_MAX_AGE_DAYS} days old.`}
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Latest refit"
          {...toggle("runs")}
          {...queryProps}
          value={outcome === undefined ? "-" : OUTCOME_TEXT[outcome]}
          sub={
            latest === undefined
              ? NO_DATA_IN_WINDOW
              : [
                  parseStamp(latest.created_at)?.format("YYYY-MM-DD HH:mm"),
                  "UTC",
                  outcome === "refit_failed" || outcome === "gate_failed"
                    ? `at "${latest.refit_failed_step || "unknown step"}"`
                    : undefined,
                ]
                  .filter((part) => part !== undefined)
                  .join(" ")
          }
          caveat="The newest scheduled or manual run on main in the counted window, from its jobs: refit, then pytorch's check, then publish."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Refits published"
          {...toggle("runs")}
          {...queryProps}
          value={empty ? "-" : `${published} of ${rows.length}`}
          sub={empty ? NO_DATA_IN_WINDOW : undefined}
          caveat="Runs in the counted window whose new model reached generated-stats. A run that does not publish leaves the previous model live."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Scorer recall vs TD"
          {...toggle("months")}
          {...queryProps}
          value={percentFormatter(month?.ratio ?? null)}
          sub={
            month === undefined || floor === null
              ? monthSub
              : `${monthSub}; floor ${percentFormatter(floor)}`
          }
          caveat="The scorer's recall of PRs' failures over TD's, at TD's cost, in the latest report's last complete month. The floor is the one that report's gate applied to all months pooled."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Risk AUC"
          {...toggle("months")}
          {...queryProps}
          value={ratioText(month?.riskAuc ?? null)}
          sub={monthSub}
          caveat="How well the risk score ranks PRs that broke tests above PRs that did not, in the latest report's last complete month: 0.5 is chance, 1 is perfect."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Budget retention"
          {...queryProps}
          value={
            report === undefined || !budgetOn
              ? "-"
              : percentFormatter(num(report.budget_retention))
          }
          sub={
            report === undefined
              ? noFigure
              : !budgetOn
              ? "Budget off in the latest report"
              : `floor ${percentFormatter(
                  num(report.budget_retention_floor)
                )}: ${
                  num(report.budget_ok) === 1 ? "met" : "not met"
                }; ${percentFormatter(
                  num(report.budget_seconds_share)
                )} of test time`
          }
          caveat="With the risk-sized test budget, the share of PRs with failures inside TD's picks for which the budgeted cut still catches one, pooled over the latest report's months, against the floor its gate applied."
        />
      </Grid>
      {open.has("months") && (
        <MonthChart report={report} loading={loading} error={error} />
      )}
      {open.has("runs") && (
        <RefitTable rows={rows} loading={loading} error={error} now={now} />
      )}
    </TdSection>
  );
}

export default function RefitSection({ params }: { params: TdParams }) {
  const now = Date.now();
  const range = countedRange(params, sectionLimits(now).refits, now);
  const refits = useTdQuery<RefitRow>(TD_QUERIES.refits, range.params);
  const live = useLiveModel();
  const [open, setOpen] = useState<ReadonlySet<RefitView>>(() => new Set());
  const onToggle = (view: RefitView) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(view)) {
        next.add(view);
      }
      return next;
    });
  return (
    <RefitSectionView
      range={range}
      refits={refits}
      live={live}
      open={open}
      onToggle={onToggle}
      now={now}
    />
  );
}
