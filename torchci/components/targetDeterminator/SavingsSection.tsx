import { Grid } from "@mui/material";
import { GridColDef } from "@mui/x-data-grid";
import { percentFormatter } from "components/flakyTrunk/common";
import QualityTile, {
  TILE_SPAN,
} from "components/greenlight/quality/QualityTile";
import {
  ciSaved,
  CLAMP_DAYS,
  countedRange,
  hoursText,
  MIN_MAIN_RUNS,
  minutesText,
  rangeText,
  sectionLimits,
  TD_QUERIES,
  TdParams,
  useTdQuery,
} from "lib/targetDeterminator";
import {
  num,
  type PushWaitRow,
  ratio,
  type SavingsRow,
  type TtrsRow,
} from "lib/targetDeterminatorRows";
import { useMemo } from "react";
import { TABLE_HEIGHT, TdSection, TdTable, useTdTotalQuery } from "./TdPanel";
import { TdCharts, TdChartsState, tileToggle } from "./TdTrends";

// Below this share of PR jobs with a main baseline, the estimate describes too
// small a slice of PR CI to stand for it.
const MIN_BASELINE_COVERAGE = 0.5;

const CONFIG_COLUMNS: GridColDef[] = [
  { field: "config", headerName: "Job config", flex: 1, minWidth: 320 },
  { field: "jobs", headerName: "PR jobs", type: "number", width: 100 },
  {
    field: "prMedian",
    headerName: "PR median (min)",
    type: "number",
    width: 140,
  },
  {
    field: "fullMedian",
    headerName: "Main median (min)",
    type: "number",
    width: 150,
  },
  {
    field: "savedPct",
    headerName: "CI time saved (%)",
    type: "number",
    width: 150,
  },
  {
    field: "hoursSaved",
    headerName: "Hours saved",
    type: "number",
    width: 120,
  },
];

function round1(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

// A config whose PR jobs all lack a main baseline has no medians to show; the
// query fills them with 0.
function configRows(rows: SavingsRow[]) {
  return rows
    .filter((row) => row.grain === "config")
    .map((row) => {
      const jobs = num(row.jobs);
      const measured = jobs !== null && jobs > 0;
      const saved = measured ? ciSaved(row) : null;
      return {
        id: row.config,
        config: row.config,
        jobs,
        prMedian: measured ? round1(num(row.pr_median_min)) : null,
        fullMedian: measured ? round1(num(row.full_median_min)) : null,
        savedPct: round1(saved === null ? null : saved.share * 100),
        hoursSaved: round1(saved === null ? null : saved.hoursSaved),
      };
    });
}

export default function SavingsSection({
  params,
  charts,
}: {
  params: TdParams;
  charts: TdChartsState;
}) {
  const limits = sectionLimits();
  const range = countedRange(params, limits.savings);
  const ttrsRange = countedRange(params, limits.ttrs);
  const queryWindow = {
    startTime: range.startTime,
    stopTime: range.stopTime,
  };
  const savings = useTdTotalQuery<SavingsRow>(
    TD_QUERIES.savings,
    queryWindow,
    !range.empty
  );
  const pushWait = useTdTotalQuery<PushWaitRow>(
    TD_QUERIES.pushWait,
    queryWindow,
    !range.empty
  );
  const ttrsParams = {
    startTime: ttrsRange.startTime,
    stopTime: ttrsRange.stopTime,
    workflow: "pull",
    percentile_to_get: 0.5,
  };
  const ttrs = useTdQuery<TtrsRow>(
    TD_QUERIES.ttrs,
    { ...ttrsParams, one_bucket: true },
    !range.empty && !ttrsRange.empty
  );
  const ttrsTrend = useTdQuery<TtrsRow>(
    TD_QUERIES.ttrs,
    { ...ttrsParams, one_bucket: false },
    !range.empty && !ttrsRange.empty && charts.open.has("ttrs")
  );

  const total = savings.total;
  const wait = pushWait.total;
  const jobs = num(total?.jobs) ?? 0;
  const unmatched = num(total?.unmatched_jobs) ?? 0;
  const coverage = ratio(jobs, jobs + unmatched);
  const lowCoverage = coverage !== null && coverage < MIN_BASELINE_COVERAGE;
  const saved = lowCoverage ? null : ciSaved(total);
  const pushes = num(wait?.pushes) ?? 0;
  const ttrsMinutes = num(ttrs.rows[0]?.custom);

  const configTable = useMemo(() => configRows(savings.rows), [savings.rows]);
  const noJobs = "No completed PR test jobs in this window.";
  const noPushes = "No green PR pushes in this window.";
  const coverageSub = `${jobs.toLocaleString()} PR test jobs compared with main; ${unmatched.toLocaleString()} without a main baseline left out.`;

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
          value={saved === null ? "-" : percentFormatter(saved.share)}
          sub={
            jobs === 0
              ? noJobs
              : lowCoverage
              ? `Too few PR jobs have a main baseline (${percentFormatter(
                  coverage
                )}). ${coverageSub}`
              : saved === null
              ? "No full-suite estimate for these jobs."
              : `${hoursText(
                  saved.hoursSaved
                )} of test-job time saved. ${coverageSub}`
          }
          caveat={`1 - (PR test-job hours / estimated full-suite hours). The estimate gives each PR test job the mean duration of the same job on main pushes; jobs with fewer than ${MIN_MAIN_RUNS} main runs have no baseline and are left out.`}
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
              ? noJobs
              : `vs ${minutesText(
                  total?.full_median_min
                )} for the same jobs on main, where every test runs.`
          }
          caveat="Median duration of completed, successful PR test jobs with TD on, next to the median of the same jobs on main pushes."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Time to green saved (estimated)"
          {...tileToggle(charts, "ttgSaved")}
          loading={pushWait.loading}
          error={pushWait.tileError}
          value={pushes === 0 ? "-" : minutesText(wait?.saved_median_min)}
          sub={
            pushes === 0
              ? noPushes
              : `Median saving per green push, over ${pushes.toLocaleString()} pushes. The median waits from push to the last test job are ${minutesText(
                  wait?.actual_ttg_median_min
                )} actual and ${minutesText(
                  wait?.est_ttg_median_min
                )} estimated without TD; their difference is not the median saving.`
          }
          caveat="Green PR pushes: first attempts where no job, builds included, failed, was cancelled or timed out. The estimate replaces each test job's duration with the same job's mean duration on main."
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
              ? noPushes
              : `vs ${hoursText(
                  wait?.est_hours_per_push
                )} estimated without TD. A proxy for CI cost per PR commit, not dollars.`
          }
          caveat="Test-job machine hours per green PR push, with TD and as estimated with every test running."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Time to first red (median)"
          {...tileToggle(charts, "ttrs")}
          loading={ttrs.loading}
          error={ttrs.error}
          value={ttrsMinutes === null ? "-" : minutesText(ttrsMinutes)}
          sub={
            ttrsMinutes === null
              ? `No failing pull jobs of merged PRs from ${rangeText(
                  ttrsRange
                )}.`
              : `From the start of a failing PR job's test step to the end of its first failing test step, counted ${rangeText(
                  ttrsRange
                )}.`
          }
          caveat={`HUD's Time to Red Signal (TTRS), median, over at most the last ${CLAMP_DAYS.ttrs} days of the window: pull workflow, first attempt, merged PRs. TD orders tests by how likely they are to fail, so a lower value means failures show up sooner.`}
        />
      </Grid>
      <TdCharts
        charts={charts}
        keys={["ciSaved", "typicalJob", "ttgSaved", "hoursPerPush", "ttrs"]}
        sources={{
          savings: { ...savings, window: range },
          pushWait: { ...pushWait, window: range },
          ttrs: { ...ttrsTrend, window: ttrsRange },
        }}
      />
      <Grid size={{ xs: 12 }} height={TABLE_HEIGHT}>
        <TdTable
          title="Savings per job config (for troubleshooting)"
          state={savings}
          rows={configTable}
          columns={CONFIG_COLUMNS}
          emptyText={noJobs}
          height={TABLE_HEIGHT}
          sortField="hoursSaved"
        />
      </Grid>
    </TdSection>
  );
}
