import { Grid } from "@mui/material";
import { GridColDef } from "@mui/x-data-grid";
import QualityTile, {
  TILE_SPAN,
} from "components/greenlight/quality/QualityTile";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import {
  ciSaved,
  fractionText,
  HORIZON_DAYS,
  hoursText,
  minutesText,
  num,
  PushWaitRow,
  ratio,
  SavingsRow,
  TD_QUERIES,
  totalError,
  totalRow,
  TtrsRow,
  useTdQuery,
} from "lib/targetDeterminator";
import { useMemo } from "react";
import {
  CHART_HEIGHT,
  DailyChart,
  TABLE_HEIGHT,
  TablePaper,
  TdPanel,
  TdSection,
} from "./TdPanel";

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

function configRows(rows: SavingsRow[]) {
  return rows
    .filter((row) => row.grain === "config")
    .map((row) => {
      const saved = ciSaved(row);
      return {
        id: row.config,
        config: row.config,
        jobs: num(row.jobs),
        prMedian: round1(num(row.pr_median_min)),
        fullMedian: round1(num(row.full_median_min)),
        savedPct: round1(saved === null ? null : saved.share * 100),
        hoursSaved: round1(saved === null ? null : saved.hoursSaved),
      };
    });
}

function dailyPoints(rows: SavingsRow[]) {
  return rows
    .filter((row) => row.grain === "day")
    .flatMap((row) => [
      {
        bucket: row.bucket,
        series: "Actual, with TD",
        value: num(row.pr_hours),
      },
      {
        bucket: row.bucket,
        series: "Estimated, full suite",
        value: num(row.est_full_hours),
      },
    ])
    .filter(
      (point): point is { bucket: string; series: string; value: number } =>
        point.value !== null
    );
}

export default function SavingsSection({
  params,
  windowDays,
}: {
  params: Record<string, unknown>;
  windowDays: number;
}) {
  const savings = useTdQuery<SavingsRow>(TD_QUERIES.savings, params);
  const pushWait = useTdQuery<PushWaitRow>(TD_QUERIES.pushWait, params);
  const ttrs = useTdQuery<TtrsRow>(TD_QUERIES.ttrs, {
    startTime: params.startTime,
    stopTime: params.stopTime,
    workflow: "pull",
    one_bucket: true,
    percentile_to_get: 0.5,
  });

  const total = totalRow(savings.rows);
  const wait = totalRow(pushWait.rows);
  const jobs = num(total?.jobs) ?? 0;
  const unmatched = num(total?.unmatched_jobs) ?? 0;
  const coverage = ratio(jobs, jobs + unmatched);
  const lowCoverage = coverage !== null && coverage < MIN_BASELINE_COVERAGE;
  const saved = lowCoverage ? null : ciSaved(total);
  const pushes = num(wait?.pushes) ?? 0;
  const ttrsMinutes = num(ttrs.rows[0]?.custom);

  const configTable = useMemo(() => configRows(savings.rows), [savings.rows]);
  const points = useMemo(() => dailyPoints(savings.rows), [savings.rows]);
  const savingsError = totalError(TD_QUERIES.savings, savings, total);
  const waitError = totalError(TD_QUERIES.pushWait, pushWait, wait);
  const noJobs = "No completed PR test jobs in this window.";
  const coverageSub = `${jobs.toLocaleString()} PR test jobs compared with main; ${unmatched.toLocaleString()} without a main baseline left out.`;

  return (
    <TdSection
      title="Time and CI saved"
      windowDays={windowDays}
      horizonDays={HORIZON_DAYS.savings}
      intro={
        "How much CI time TD saves on pull requests, and how much sooner " +
        "contributors hear back. Full-suite figures are estimates: each PR " +
        "test job is compared with the same job on main, where every test runs."
      }
    >
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="CI time saved (estimated)"
          loading={savings.loading}
          error={savingsError}
          value={saved === null ? "-" : fractionText(saved.share)}
          sub={
            jobs === 0
              ? noJobs
              : lowCoverage
              ? `Too few PR jobs have a main baseline (${fractionText(
                  coverage
                )}). ${coverageSub}`
              : saved === null
              ? "No full-suite estimate for these jobs."
              : `${hoursText(
                  saved.hoursSaved
                )} of test-job time saved. ${coverageSub}`
          }
          caveat="1 - (PR test-job hours / estimated full-suite hours). The estimate gives each PR test job the mean duration of the same job on main pushes; jobs with fewer than 5 main runs have no baseline and are left out."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Typical PR test job"
          loading={savings.loading}
          error={savingsError}
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
          loading={pushWait.loading}
          error={waitError}
          value={pushes === 0 ? "-" : minutesText(wait?.saved_median_min)}
          sub={
            pushes === 0
              ? "No green PR pushes in this window."
              : `Median wait from push to the last test job: ${minutesText(
                  wait?.actual_ttg_median_min
                )} actual vs ${minutesText(
                  wait?.est_ttg_median_min
                )} estimated without TD, over ${pushes.toLocaleString()} green pushes.`
          }
          caveat="Green PR pushes, first attempt only. The estimate replaces each test job's duration with the same job's mean duration on main."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Test-job hours per PR push"
          loading={pushWait.loading}
          error={waitError}
          value={pushes === 0 ? "-" : hoursText(wait?.hours_per_push)}
          sub={
            pushes === 0
              ? "No green PR pushes in this window."
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
          loading={ttrs.loading}
          error={ttrs.error}
          value={ttrsMinutes === null ? "-" : minutesText(ttrsMinutes)}
          sub={
            ttrsMinutes === null
              ? "No failing pull jobs of merged PRs in this window."
              : "From the start of a failing PR job's test step to its first failing test."
          }
          caveat="HUD's Time to Red Signal (TTRS), median, pull workflow, first attempt, merged PRs. TD orders tests by how likely they are to fail, so a lower value means failures show up sooner."
        />
      </Grid>
      <Grid size={{ xs: 12 }} height={CHART_HEIGHT}>
        <TdPanel
          title="PR test-job hours per day"
          height={CHART_HEIGHT}
          loading={savings.loading}
          error={savings.error}
          emptyText={points.length === 0 ? noJobs : undefined}
        >
          <DailyChart
            title="PR test-job hours per day: actual vs estimated full suite"
            points={points}
            startTime={params.startTime as string}
            stopTime={params.stopTime as string}
            yAxisLabel="Hours"
            yAxisRenderer={(value) => Number(value).toFixed(0)}
          />
        </TdPanel>
      </Grid>
      <Grid size={{ xs: 12 }} height={TABLE_HEIGHT}>
        <TdPanel
          title="Savings per job config"
          height={TABLE_HEIGHT}
          loading={savings.loading}
          error={savings.error}
          emptyText={configTable.length === 0 ? noJobs : undefined}
        >
          <TablePaper height={TABLE_HEIGHT}>
            <TablePanelWithData
              title="Savings per job config (for troubleshooting)"
              data={configTable}
              columns={CONFIG_COLUMNS}
              showFooter={true}
              dataGridProps={{
                initialState: {
                  sorting: {
                    sortModel: [{ field: "hoursSaved", sort: "desc" }],
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
