import { Typography } from "@mui/material";
import { DataGrid, GridColDef, GridRowModel } from "@mui/x-data-grid";
import { SelectionDialog } from "components/benchmark/v3/components/common/SelectionDialog";
import { useMemo, useState } from "react";
import { ComparisonTableConfig } from "../../../helper";
import { getComparisionTableConlumnRendering } from "./ComparisonTableColumnRendering";
import { SnapshotRow, ToComparisonTableRow } from "./ComparisonTableHelpers";

export function ComparisonTable({
  data,
  lWorkflowId,
  rWorkflowId,
  config,
  columnOrder,
  title = "Group",
  onSelect,
}: {
  data: SnapshotRow[];
  lWorkflowId: string | null;
  rWorkflowId: string | null;
  config: ComparisonTableConfig;
  columnOrder?: string[]; // optional preferred ordering of columns
  title?: string;
  onSelect?: (payload: any) => void;
}) {
  // group raw data into rows, each row contains all values across workflowIds
  const rows: GridRowModel[] = useMemo(() => {
    return ToComparisonTableRow(config, data);
  }, [data]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedData, setSelectedData] = useState<any>(undefined);

  const onClick = (data: any) => {
    setSelectedData(data);
    setDialogOpen(true);
  };

  const onConfirm = () => {
    onSelect?.(selectedData);
  };

  // iterate the column map in row data, and get all column names
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
        config,
        onClick
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
        initialState={{
          sorting: {
            sortModel: [{ field: "name", sort: "asc" }],
          },
        }}
        getRowId={(r) => {
          return r.id;
        }}
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
      <SelectionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        leftMeta={selectedData?.left}
        rightMeta={selectedData?.right}
        onSelect={onConfirm}
        other={{ parent: "comparisonTable" }}
        enabled={config.enableDialog ?? false}
        config={config.customizedConfirmDialog}
      />
    </>
  );
}
