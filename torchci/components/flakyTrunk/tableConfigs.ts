import { GridColDef } from "@mui/x-data-grid";
import { EntityKey, numCol, pctCol } from "./common";

export interface EntityConfig {
  label: string;
  queryName: string;
  columns: GridColDef[];
  getRowId: (_row: any) => string;
  defaultSortField: string;
}

export const ENTITY_CONFIGS: Record<EntityKey, EntityConfig> = {
  jobs: {
    label: "Jobs",
    queryName: "flaky_trunk_jobs",
    getRowId: (row) => row.job_name,
    defaultSortField: "flake_rate_wilson_lb",
    columns: [
      { field: "job_name", headerName: "Job", flex: 4, minWidth: 320 },
      numCol("total_runs", "Runs"),
      numCol("green", "Green"),
      numCol("red", "Red"),
      numCol("flake", "Flake"),
      numCol("test_flake", "Test flake"),
      numCol("infra_flake", "Infra flake"),
      numCol("real", "Real"),
      numCol("unknown", "Unknown"),
      pctCol("flake_rate", "Flake rate", "flake / (green + flake)"),
      pctCol(
        "flake_rate_wilson_lb",
        "Wilson LB",
        "95% Wilson score lower bound of the flake rate (default sort)"
      ),
      pctCol("pct_reds_flake", "% reds flaky", "flake / red"),
    ],
  },
  labels: {
    label: "Runner labels",
    queryName: "flaky_trunk_runner_labels",
    getRowId: (row) => row.label,
    defaultSortField: "flake_rate_wilson_lb",
    columns: [
      { field: "label", headerName: "Runner label", flex: 3, minWidth: 260 },
      numCol("total_runs", "Runs"),
      numCol("red", "Red"),
      numCol("infra_flake", "Infra flake"),
      pctCol("flake_rate", "Infra-flake rate", "infra_flake / total_runs"),
      pctCol(
        "flake_rate_wilson_lb",
        "Wilson LB",
        "95% Wilson score lower bound of the infra-flake rate (default sort)"
      ),
      pctCol(
        "works_elsewhere_pct",
        "Works elsewhere",
        "Of infra-flakes on this label, share where the same job passed on another label"
      ),
      numCol("distinct_jobs_hit", "Distinct jobs"),
    ],
  },
};
