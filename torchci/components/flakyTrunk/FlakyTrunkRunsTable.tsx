import CloseIcon from "@mui/icons-material/Close";
import { Chip, IconButton, Link, Stack } from "@mui/material";
import { GridColDef } from "@mui/x-data-grid";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { fetcher } from "lib/GeneralUtils";
import useSWR from "swr";
import { FLAKY_TRUNK_REPO, SelectedEntity } from "./common";
dayjs.extend(utc);

// MUI palette color per category chip — palette keys stay theme-aware in both
// dark and light mode (no hardcoded colors).
const CATEGORY_CHIP_COLOR: { [key: string]: "warning" | "info" | "default" } = {
  "Infra flake": "warning",
  "Job flake": "info",
};

const COLUMNS: GridColDef[] = [
  {
    field: "head_sha",
    headerName: "Commit",
    minWidth: 90,
    renderCell: (params: any) => (
      <Link
        href={`https://github.com/${FLAKY_TRUNK_REPO}/commit/${params.value}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        {String(params.value ?? "").slice(0, 7)}
      </Link>
    ),
  },
  { field: "job_name", headerName: "Job", flex: 3, minWidth: 320 },
  { field: "workflow_name", headerName: "Workflow", flex: 1, minWidth: 160 },
  {
    field: "category",
    headerName: "Category",
    minWidth: 120,
    renderCell: (params: any) => (
      <Chip
        label={params.value}
        size="small"
        variant="outlined"
        color={CATEGORY_CHIP_COLOR[params.value] ?? "default"}
      />
    ),
  },
  { field: "runner_label", headerName: "Runner label", flex: 1, minWidth: 180 },
  {
    field: "started_at",
    headerName: "Started",
    minWidth: 150,
    valueFormatter: (value: any) =>
      value ? dayjs.utc(value).format("YYYY-MM-DD HH:mm") : "-",
  },
  {
    field: "html_url",
    headerName: "Job",
    minWidth: 100,
    sortable: false,
    renderCell: (params: any) =>
      params.value ? (
        <Link href={params.value} target="_blank" rel="noopener noreferrer">
          View job
        </Link>
      ) : null,
  },
];

export default function FlakyTrunkRunsTable({
  entity,
  startTime,
  stopTime,
  onClose,
  autoRefresh,
}: {
  entity: SelectedEntity;
  startTime: string;
  stopTime: string;
  onClose: () => void;
  autoRefresh: boolean;
}) {
  const url = `/api/clickhouse/flaky_trunk_entity_runs?parameters=${encodeURIComponent(
    JSON.stringify({
      startTime,
      stopTime,
      repo: FLAKY_TRUNK_REPO,
      entityType: entity.type,
      entityValue: entity.value,
    })
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: autoRefresh ? 5 * 60 * 1000 : 0,
  });

  const title = (
    <Stack direction="row" alignItems="center" spacing={1}>
      <span>{`Flaky runs — ${entity.value}`}</span>
      <IconButton size="small" onClick={onClose} aria-label="close">
        <CloseIcon fontSize="inherit" />
      </IconButton>
    </Stack>
  );

  return (
    <TablePanelWithData
      title={title}
      data={data}
      columns={COLUMNS}
      showFooter={true}
      dataGridProps={{ getRowId: (row: any) => row.id }}
    />
  );
}
