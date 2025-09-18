import { Alert, Grid, Link } from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import type { ArtifactFile } from "lib/benchmark/llms/utils/artifacts";
import { useArtifacts } from "lib/benchmark/llms/utils/artifacts";

type ArtifactRow = ArtifactFile;

const columns: GridColDef<ArtifactRow>[] = [
  {
    field: "date",
    headerName: "Date",
    flex: 0.8,
    renderCell: (params) => params.row.date || "—",
  },
  {
    field: "modelName",
    headerName: "Model name",
    flex: 1.1,
    renderCell: (params) => (
      <span style={{ overflowWrap: "anywhere" }}>
        {params.row.modelName || "—"}
      </span>
    ),
  },
  {
    field: "commitHash",
    headerName: "Commit Hash",
    flex: 1.2,
    renderCell: (params) => (
      <span style={{ overflowWrap: "anywhere" }}>
        {params.row.commitHash || "—"}
      </span>
    ),
  },
  {
    field: "workflowId",
    headerName: "Github workflow id",
    flex: 1.2,
    renderCell: (params) => (
      <span style={{ overflowWrap: "anywhere" }}>
        {params.row.workflowId || "—"}
      </span>
    ),
  },
  {
    field: "fileName",
    headerName: "Profiler trace",
    flex: 1.6,
    renderCell: (params) => (
      <Link
        href={params.row.url}
        target="_blank"
        rel="noopener noreferrer"
        underline="hover"
        sx={{ overflowWrap: "anywhere" }}
      >
        {params.row.fileName || params.row.key}
      </Link>
    ),
  },
];

type VllmArtifactsTableProps = {
  selectedModelName: string;
};

export function VllmArtifactsTable({
  selectedModelName,
}: VllmArtifactsTableProps) {
  const { data, error } = useArtifacts({
    prefix: "vllm-project/vllm/",
  });

  // TODO: Currently, we only support vLLM traces for opt-125m.
  // In the future, we should refactor this to support any model.
  if (selectedModelName !== "facebook/opt-125m") {
    return null;
  }

  if (error) {
    return (
      <Grid container spacing={10} sx={{ mt: 4 }}>
        <Grid size={{ xs: 12, lg: 11.8 }}>
          <Alert severity="error">
            Unable to load recent vLLM trace artifacts.
          </Alert>
        </Grid>
      </Grid>
    );
  }

  if (data && data.files.length === 0) {
    return null;
  }

  const tableData = data ? data.files : undefined;

  return (
    <Grid container spacing={10} sx={{ mt: 4 }}>
      <Grid size={{ xs: 12, lg: 11.8 }}>
        <TablePanelWithData
          title={"vLLM Profiling Traces"}
          data={tableData}
          columns={columns}
          dataGridProps={{
            getRowId: (row: ArtifactRow) => row.key,
            disableColumnMenu: true,
            disableRowSelectionOnClick: true,
          }}
          showFooter={true}
          disableAutoPageSize={true}
          customStyle={{
            maxHeight: 600,
          }}
        />
      </Grid>
    </Grid>
  );
}
