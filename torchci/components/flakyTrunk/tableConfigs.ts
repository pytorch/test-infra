import { GridColDef } from "@mui/x-data-grid";
import { EntityType, numCol, pctCol } from "./common";

export interface FlakyTrunkTableConfig {
  heading: string;
  queryName: string;
  entityType: EntityType;
  columns: GridColDef[];
  getRowId: (_row: any) => string;
  defaultSortField: string;
}

// Column header tooltips. Shared strings live here once so both tables stay in
// sync. flake_rate differs by table (jobs = flake / (green + flake); labels =
// infra_flake / total_runs), so each keeps its own accurate wording.
const COL_DESC = {
  jobsFlakeRate:
    "Flakes ÷ (passes + flakes) — when the code was fine, how often this flaked. Excludes real bugs and unclassified failures.",
  labelsFlakeRate:
    "Infra-flakes ÷ all runs on this label — how often a run on this label was an infra flake.",
  wilson:
    "Confidence-adjusted flakiness rate (Wilson 95% lower bound). Discounts small samples so steady high-volume flakiness outranks 1-of-2 noise. Sorted by this.",
  pctRedsFlake:
    "Flakes ÷ all failures — when it's red, how often that's a false alarm vs a real problem.",
  testFlake:
    "Failures caused by the job's own test/CI unreliability (not a real bug).",
  infraFlake: "Failures caused by the machine/runner/infra (not the code).",
  unclassified:
    "An isolated one-off red we couldn't attribute to flake, regression, or infra outage.",
  realRegression:
    "Persistent break (red across consecutive commits) with a test/code failure — a genuine regression.",
  worksElsewhere:
    "Of this label's infra-flakes, how often the same job passed on a different label. High = likely this pool's fault, not the job's.",
};

const JOBS_TABLE: FlakyTrunkTableConfig = {
  heading: "Flaky jobs",
  queryName: "flaky_trunk_jobs",
  entityType: "job",
  getRowId: (row) => row.job_name,
  defaultSortField: "flake_rate_wilson_lb",
  columns: [
    { field: "job_name", headerName: "Job", flex: 4, minWidth: 320 },
    numCol("total_runs", "Runs"),
    numCol("green", "Green"),
    numCol("red", "Red"),
    numCol("infra_flake", "Infra flake", COL_DESC.infraFlake),
    numCol("test_flake", "Test flake", COL_DESC.testFlake),
    numCol("unclassified", "Unclassified", COL_DESC.unclassified),
    numCol("real_regression", "Real regression", COL_DESC.realRegression),
    pctCol("flake_rate", "Flakiness rate", COL_DESC.jobsFlakeRate),
    pctCol("flake_rate_wilson_lb", "Wilson LB", COL_DESC.wilson),
    pctCol("pct_reds_flake", "% reds flaky", COL_DESC.pctRedsFlake),
  ],
};

const LABELS_TABLE: FlakyTrunkTableConfig = {
  heading: "Flaky instance labels",
  queryName: "flaky_trunk_runner_labels",
  entityType: "label",
  getRowId: (row) => row.label,
  defaultSortField: "flake_rate_wilson_lb",
  columns: [
    { field: "label", headerName: "Runner label", flex: 3, minWidth: 260 },
    numCol("total_runs", "Runs"),
    numCol("red", "Red"),
    numCol("infra_flake", "Infra flake", COL_DESC.infraFlake),
    pctCol("flake_rate", "Infra-flake rate", COL_DESC.labelsFlakeRate),
    pctCol("flake_rate_wilson_lb", "Wilson LB", COL_DESC.wilson),
    pctCol("works_elsewhere_pct", "Works elsewhere", COL_DESC.worksElsewhere),
    numCol("distinct_jobs_hit", "Distinct jobs"),
  ],
};

export const FLAKY_TRUNK_TABLES: FlakyTrunkTableConfig[] = [
  JOBS_TABLE,
  LABELS_TABLE,
];
