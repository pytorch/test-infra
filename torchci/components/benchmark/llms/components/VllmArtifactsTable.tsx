import { Alert, Grid, Link } from "@mui/material";
import type { GridColDef, GridRenderCellParams } from "@mui/x-data-grid";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import type { ArtifactFile } from "lib/benchmark/llms/utils/artifacts";
import { useArtifacts } from "lib/benchmark/llms/utils/artifacts";

type ArtifactRow = ArtifactFile;

const columns: GridColDef<ArtifactRow>[] = [
  {
    field: "date",
    headerName: "Date",
    minWidth: 130,
    flex: 0.8,
    sortable: false,
    filterable: false,
    renderCell: (params: GridRenderCellParams<ArtifactRow, string>) =>
      params.row.date || "—",
  },
  {
    field: "modelName",
    headerName: "Model name",
    minWidth: 160,
    flex: 1.2,
    sortable: false,
    filterable: false,
    renderCell: (params: GridRenderCellParams<ArtifactRow, string>) => (
      <span style={{ overflowWrap: "anywhere" }}>
        {params.row.modelName || "—"}
      </span>
    ),
  },
  {
    field: "commitHash",
    headerName: "Commit Hash",
    minWidth: 220,
    flex: 1.3,
    sortable: false,
    filterable: false,
    renderCell: (params: GridRenderCellParams<ArtifactRow, string>) => (
      <span style={{ overflowWrap: "anywhere" }}>
        {params.row.commitHash || "—"}
      </span>
    ),
  },
  {
    field: "workflowId",
    headerName: "Github workflow id",
    minWidth: 220,
    flex: 1.3,
    sortable: false,
    filterable: false,
    renderCell: (params: GridRenderCellParams<ArtifactRow, string>) => (
      <span style={{ overflowWrap: "anywhere" }}>
        {params.row.workflowId || "—"}
      </span>
    ),
  },
  {
    field: "fileName",
    headerName: "Name of the file",
    minWidth: 240,
    flex: 1.6,
    sortable: false,
    filterable: false,
    renderCell: (params: GridRenderCellParams<ArtifactRow, string>) => (
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

export function VllmArtifactsTable() {
  const { data, error } = useArtifacts({
    prefix: "vllm-project/vllm/",
  });

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
