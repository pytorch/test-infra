import { Grid } from "@mui/material";
import { percentFormatter } from "components/flakyTrunk/common";
import QualityTile, {
  TILE_SPAN,
} from "components/greenlight/quality/QualityTile";
import { NO_DATA_IN_WINDOW } from "lib/greenlight/qualityFigures";
import {
  countedRange,
  hoursText,
  minutesText,
  savedShare,
  sectionLimits,
  TD_QUERIES,
  TD_SCOPE,
  TdParams,
  type TdWorkflow,
} from "lib/targetDeterminator";
import {
  num,
  type PushWaitRow,
  type SavingsRow,
  workflowError,
  workflowRow,
} from "lib/targetDeterminatorRows";
import {
  WORKFLOW_CHART_KEYS,
  workflowChartKey,
} from "lib/targetDeterminatorTrends";
import { TdSection, useTdTotalQuery } from "./TdPanel";
import { TdCharts, TdChartsState, tileToggle } from "./TdTrends";

const WORKFLOW_RUNS: Record<TdWorkflow, string> = {
  pull: "which runs on every pull request push",
  trunk: "which runs on a pull request labelled ciflow/trunk",
};

export function useSavingsData(params: TdParams, now: number) {
  const range = countedRange(params, sectionLimits(now).savings, now);
  return {
    range,
    savings: useTdTotalQuery<SavingsRow>(TD_QUERIES.savings, range.params),
    pushWait: useTdTotalQuery<PushWaitRow>(TD_QUERIES.pushWait, range.params),
  };
}

export type SavingsData = ReturnType<typeof useSavingsData>;

export default function SavingsSection({
  data,
  charts,
}: {
  data: SavingsData;
  charts: TdChartsState;
}) {
  const { range, savings, pushWait } = data;
  const workflowTileError =
    savings.tileError ??
    workflowError(TD_QUERIES.savings, savings.rows, savings.total);
  const wait = pushWait.total;
  const pushes = num(wait?.pushes) ?? 0;

  return (
    <TdSection
      title="Time and CI saved"
      range={range}
      intro={
        "How much CI time TD saves on pull requests, and how much sooner " +
        "contributors hear back. Full-suite figures are estimates: each PR " +
        "test job is compared with the same job on main, where every test " +
        "runs. Pull runs on every pull request push; trunk runs when a pull " +
        "request is labelled ciflow/trunk. Time to green and hours per push " +
        "are measured on the pull workflow."
      }
    >
      {TD_SCOPE.tdWorkflows.map((workflow) => {
        const share = savedShare(workflowRow(savings.rows, workflow));
        return (
          <Grid key={workflow} size={TILE_SPAN}>
            <QualityTile
              label={`CI time saved, ${workflow} workflow (estimated)`}
              {...tileToggle(
                charts,
                workflowChartKey("workflowSaved", workflow)
              )}
              loading={savings.loading}
              error={workflowTileError}
              value={percentFormatter(share.value)}
              sub={share.sub}
              caveat={`Test machine time saved on the ${workflow} workflow, ${WORKFLOW_RUNS[workflow]}. Higher is better.`}
            />
          </Grid>
        );
      })}
      {TD_SCOPE.tdWorkflows.map((workflow) => {
        const row = workflowRow(savings.rows, workflow);
        const jobs = num(row?.jobs) ?? 0;
        return (
          <Grid key={workflow} size={TILE_SPAN}>
            <QualityTile
              label={`Typical ${workflow} workflow test job`}
              {...tileToggle(charts, workflowChartKey("workflowJob", workflow))}
              loading={savings.loading}
              error={workflowTileError}
              value={jobs === 0 ? "-" : minutesText(row?.pr_median_min)}
              sub={
                jobs === 0
                  ? NO_DATA_IN_WINDOW
                  : `vs ${minutesText(row?.full_median_min)} with every test`
              }
              caveat={`How long a typical ${workflow} workflow test job takes on a pull request, next to the same job running every test. Its chart also shows the slowest tenth.`}
            />
          </Grid>
        );
      })}
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Time to green saved (estimated)"
          {...tileToggle(charts, "ttgSaved")}
          loading={pushWait.loading}
          error={pushWait.tileError}
          value={pushes === 0 ? "-" : minutesText(wait?.saved_median_min)}
          sub={pushes === 0 ? NO_DATA_IN_WINDOW : undefined}
          caveat="How much sooner a typical pull request's tests all pass because fewer tests run."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Test-job hours per PR push"
          {...tileToggle(charts, "hoursPerPush")}
          loading={pushWait.loading}
          error={pushWait.tileError}
          value={pushes === 0 ? "-" : hoursText(wait?.hours_per_push)}
          sub={
            pushes === 0
              ? NO_DATA_IN_WINDOW
              : `vs ${hoursText(
                  wait?.est_hours_per_push
                )} estimated with every test`
          }
          caveat="Average machine time of the test jobs of one green pull request push, next to an estimate with every test running."
        />
      </Grid>
      <TdCharts
        charts={charts}
        keys={[...WORKFLOW_CHART_KEYS, "ttgSaved", "hoursPerPush"]}
        sources={{
          savings: { ...savings, window: range },
          pushWait: { ...pushWait, window: range },
        }}
      />
    </TdSection>
  );
}
