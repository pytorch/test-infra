import { Grid } from "@mui/material";
import { percentFormatter } from "components/flakyTrunk/common";
import QualityTile, {
  TILE_SPAN,
} from "components/greenlight/quality/QualityTile";
import { NO_DATA_IN_WINDOW } from "lib/greenlight/qualityFigures";
import {
  ciSaved,
  countedRange,
  hoursText,
  minutesText,
  NOTHING_TO_MEASURE,
  sectionLimits,
  TD_QUERIES,
  TdParams,
} from "lib/targetDeterminator";
import {
  num,
  type PushWaitRow,
  ratio,
  type SavingsRow,
} from "lib/targetDeterminatorRows";
import { TdSection, useTdTotalQuery } from "./TdPanel";
import { TdCharts, TdChartsState, tileToggle } from "./TdTrends";

// Below this share of PR jobs with a main baseline, the estimate describes too
// small a slice of PR CI to stand for it.
const MIN_BASELINE_COVERAGE = 0.5;

export default function SavingsSection({
  params,
  charts,
}: {
  params: TdParams;
  charts: TdChartsState;
}) {
  const range = countedRange(params, sectionLimits().savings);
  const savings = useTdTotalQuery<SavingsRow>(TD_QUERIES.savings, range.params);
  const pushWait = useTdTotalQuery<PushWaitRow>(
    TD_QUERIES.pushWait,
    range.params
  );

  const total = savings.total;
  const wait = pushWait.total;
  const jobs = num(total?.jobs) ?? 0;
  const unmatched = num(total?.unmatched_jobs) ?? 0;
  const coverage = ratio(jobs, jobs + unmatched);
  const lowCoverage = coverage !== null && coverage < MIN_BASELINE_COVERAGE;
  const saved = lowCoverage ? null : ciSaved(total);
  const pushes = num(wait?.pushes) ?? 0;

  return (
    <TdSection
      title="Time and CI saved"
      range={range}
      intro={
        "How much CI time TD saves on pull requests, and how much sooner " +
        "contributors hear back. Full-suite figures are estimates: each PR " +
        "test job is compared with the same job on main, where every test runs."
      }
    >
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="CI time saved (estimated)"
          {...tileToggle(charts, "ciSaved")}
          loading={savings.loading}
          error={savings.tileError}
          value={saved === null ? "-" : percentFormatter(saved)}
          sub={
            jobs === 0
              ? NO_DATA_IN_WINDOW
              : lowCoverage
              ? "Too few jobs to estimate"
              : saved === null
              ? NOTHING_TO_MEASURE
              : undefined
          }
          caveat="How much test machine time pull requests save by running only the tests most likely to fail instead of every test. Higher is better."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Typical PR test job"
          {...tileToggle(charts, "typicalJob")}
          loading={savings.loading}
          error={savings.tileError}
          value={jobs === 0 ? "-" : minutesText(total?.pr_median_min)}
          sub={
            jobs === 0
              ? NO_DATA_IN_WINDOW
              : `vs ${minutesText(total?.full_median_min)} with every test`
          }
          caveat="How long a typical pull request test job takes, next to the same job running every test."
        />
      </Grid>
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
          caveat="Average machine time of the test jobs of one pull request push, next to an estimate with every test running."
        />
      </Grid>
      <TdCharts
        charts={charts}
        keys={["ciSaved", "typicalJob", "ttgSaved", "hoursPerPush"]}
        sources={{
          savings: { ...savings, window: range },
          pushWait: { ...pushWait, window: range },
        }}
      />
    </TdSection>
  );
}
