import { Alert, Grid, Link } from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { LAST_N_DAYS } from "components/benchmark/common";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import {
  DEFAULT_ARCH_NAME,
  DEFAULT_DEVICE_NAME,
  DEFAULT_MODEL_NAME,
} from "lib/benchmark/llms/common";
import { LLMsBenchmarkProps } from "lib/benchmark/llms/types/dashboardProps";
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
    headerName: "Model Name",
    flex: 1.1,
    renderCell: (params) => (
      <span style={{ overflowWrap: "anywhere" }}>
        {params.row.modelName || "—"}
      </span>
    ),
  },
  {
    field: "deviceType",
    headerName: "Device Type",
    flex: 0.8,
    renderCell: (params) => (
      <span style={{ overflowWrap: "anywhere" }}>
        {params.row.deviceType || "—"}
      </span>
    ),
  },
  {
    field: "deviceName",
    headerName: "Device Name",
    flex: 1.1,
    renderCell: (params) => (
      <span style={{ overflowWrap: "anywhere" }}>
        {params.row.deviceName || "—"}
      </span>
    ),
  },
  {
    field: "commitHash",
    headerName: "Commit Hash",
    flex: 1.0,
    renderCell: (params) => (
      <span style={{ overflowWrap: "anywhere" }}>
        {params.row.commitHash || "—"}
      </span>
    ),
  },
  {
    field: "workflowId",
    headerName: "Workflow ID",
    flex: 1.0,
    renderCell: (params) => (
      <span style={{ overflowWrap: "anywhere" }}>
        {params.row.workflowId || "—"}
      </span>
    ),
  },
  {
    field: "fileName",
    headerName: "Profiler Trace",
    flex: 1.4,
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
  props: LLMsBenchmarkProps;
};

export function VllmArtifactsTable({ props }: VllmArtifactsTableProps) {
  // Parse deviceName which is in format "deviceType (architecture)"
  // e.g., "cuda (NVIDIA B200)" -> deviceType: "cuda", deviceName: "NVIDIA B200"
  const deviceName =
    props.deviceName === DEFAULT_DEVICE_NAME ? "" : props.deviceName;
  const archName = props.archName === DEFAULT_ARCH_NAME ? "" : props.archName;

  let device = "";
  let arch = "";
  if (archName === "") {
    // All the dashboards currently put device and arch into the same field in
    // device (arch) format, i.e. cuda (NVIDIA B200). So, we need to extract
    // the arch name here to use it in the query
    const deviceArchRegex = /^(.+)\s+\((.+)\)$/;
    const m = deviceName.match(deviceArchRegex);

    if (m !== null && m[1] !== undefined && m[2] !== undefined) {
      device = m[1]; // e.g., "cuda"
      // Extract just the architecture name from "NVIDIA B200" -> "B200"
      const archParts = m[2].split(" ");
      arch = archParts.length > 1 ? archParts[archParts.length - 1] : m[2];
    } else {
      device = deviceName;
      arch = archName;
    }
  } else {
    // If both device and arch are set, we just need to use them as they are
    device = deviceName;
    arch = archName;
  }

  // Replace "/" with "_" in model name for S3 path compatibility
  const processedModelName =
    props.modelName !== DEFAULT_MODEL_NAME && props.modelName
      ? props.modelName.replace(/\//g, "_")
      : undefined;

  const { data, error } = useArtifacts({
    prefix: "vllm-project/vllm/",
    modelName: processedModelName,
    deviceType: device !== "" ? device : undefined,
    deviceName: arch !== "" ? arch : undefined,
    lookbackDays: props.timeRange > 0 ? props.timeRange : LAST_N_DAYS,
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
