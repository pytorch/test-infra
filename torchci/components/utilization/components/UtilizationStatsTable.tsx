import { Paper } from "@mui/material";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import { StatType } from "../types";

export default function UtilizationStatsTable({ data }: { data: any[] }) {
  const rows = data.map((row) => {
    return {
      id: row.name,
      avg: row.columns.find((col: any) => col.type == StatType.Average)?.value,
      p10: row.columns.find((col: any) => col.type == StatType.P10)?.value,
      p90: row.columns.find((col: any) => col.type == StatType.P90)?.value,
      spike_frequency: row.columns.find(
        (col: any) => col.type == StatType.SpikeFrequency
      )?.value,
      spike_avg_interval: row.columns.find(
        (col: any) => col.type == StatType.SpikeAvgInterval
      )?.value,
    };
  });
  return (
    <Paper sx={{ width: "100%" }}>
      <DataGrid
        density="compact"
        hideFooter={true} // Hide pagination and footer
        rows={rows}
        columns={columns}
        initialState={{ pagination: {} }}
        pageSizeOptions={[5, 10]}
        sx={{ border: 0 }}
        getRowId={(row) => row.id}
      />
    </Paper>
  );
}

const valueFormatter = (value: number) => {
  return `${value.toFixed(2)}%`;
};
const valueFormatterSpike = (value: number) => {
  return `${value.toFixed(2)}%`;
};

const valueFormatterSeconds = (value: number) => {
  return `${value.toFixed(2)}s`;
};

const columns: GridColDef[] = [
  { field: "id", headerName: "Resource Name", minWidth: 200 },
  {
    field: "avg",
    headerName: "Average",
    valueFormatter: valueFormatter,
    minWidth: 150,
  },
  {
    field: "p10",
    headerName: "10th percentile",
    valueFormatter: valueFormatter,
    minWidth: 150,
  },
  {
    field: "p90",
    headerName: "90th percentile",
    valueFormatter: valueFormatter,
    minWidth: 150,
  },
  {
    field: "spike_frequency",
    headerName: "spike freq(above 90%)",
    valueFormatter: valueFormatterSpike,
    minWidth: 200,
  },
  {
    field: "spike_avg_interval",
    headerName: "avg spike interval (above 90%)",
    valueFormatter: valueFormatterSeconds,
    minWidth: 200,
  },
];
