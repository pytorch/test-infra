import { Typography } from "@mui/material";
import { DataGrid, GridColDef, GridRowModel } from "@mui/x-data-grid";
import { useMemo } from "react";
import { ComparisonTableConfig } from "../../../helper";
import { getComparisionTableConlumnRendering } from "./ComparisonTableColumnRendering";
import {
  getComparisonTableRowDefinition,
  SnapshotRow,
} from "./ComparisonTableHelpers";

export function ComparisonTable({
  data,
  lWorkflowId,
  rWorkflowId,
  config,
  columnOrder,
  title = "Group",
}: {
  data: SnapshotRow[];
  lWorkflowId: string | null;
  rWorkflowId: string | null;
  config: ComparisonTableConfig;
  columnOrder?: string[]; // optional preferred ordering of columns
  title?: string;
}) {
  // group raw data into rows, each row contains all values across workflowIds
  const rows: GridRowModel[] = useMemo(() => {
    return getComparisonTableRowDefinition(config, data);
  }, [data, config.nameKey]);

  // union of all column ids
  const allColumns = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) =>
      Object.values(r.byWorkflow).forEach((cols) => {
        Object.keys(cols ?? {}).forEach((k) => s.add(k));
      })
    );
    const auto = Array.from(s).sort();
    if (!columnOrder || columnOrder.length === 0) return auto;
    const head = columnOrder.filter((c) => s.has(c));
    const tail = auto.filter((c) => !head.includes(c));
    return [...head, ...tail];
  }, [rows, columnOrder]);

  // Form the columns
  const columns: GridColDef[] = useMemo(
    () =>
      getComparisionTableConlumnRendering(
        allColumns,
        lWorkflowId,
        rWorkflowId,
        config
      ),
    [allColumns, lWorkflowId, rWorkflowId, title]
  );

  return (
    <>
      <Typography variant="h6">{title.toUpperCase()}</Typography>
      <Typography variant="body2">
        {lWorkflowId} - {rWorkflowId}
      </Typography>
      <DataGrid
        density="compact"
        disableRowSelectionOnClick
        rows={rows}
        columns={columns}
        getRowId={(r) => r.id}
        sx={{
          "& .MuiDataGrid-cell": {
            py: 0, // less vertical padding
            fontSize: "0.75rem",
          },
          "& .MuiDataGrid-columnHeaders": {
            minHeight: 32,
            maxHeight: 32,
            lineHeight: "32px",
            fontSize: "0.75rem",
          },
          "& .MuiDataGrid-row": {
            minHeight: 32,
            maxHeight: 32,
          },
        }}
        hideFooter
      />
    </>
  );
}
