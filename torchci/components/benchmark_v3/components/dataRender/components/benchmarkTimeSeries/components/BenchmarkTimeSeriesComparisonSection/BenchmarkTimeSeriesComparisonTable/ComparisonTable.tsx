import { Button, Typography } from "@mui/material";
import { Box } from "@mui/system";
import {
  DataGrid,
  GridColDef,
  GridRowModel,
  useGridApiRef,
} from "@mui/x-data-grid";
import { RenderRawContent } from "components/benchmark_v3/components/common/RawContentDialog";
import { SelectionDialog } from "components/benchmark_v3/components/common/SelectionDialog";
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
  title = {
    text: "Comparison Table",
  },
  onSelect,
  onPrimaryFieldSelect,
}: {
  data: SnapshotRow[];
  lWorkflowId: string | null;
  rWorkflowId: string | null;
  config: ComparisonTableConfig;
  columnOrder?: string[]; // optional preferred ordering of columns
  title?: {
    text: string;
    description?: string;
  };
  onSelect?: (payload: any) => void;
  onPrimaryFieldSelect?: (payload: any) => void;
}) {
  const apiRef = useGridApiRef();
  // group raw data into rows, each row contains all values across workflowIds
  const rows: GridRowModel[] = useMemo(() => {
    return ToComparisonTableRow(config, data);
  }, [data]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedData, setSelectedData] = useState<any>(undefined);

  const onColumnFieldClick = (data: any) => {
    setSelectedData(data);
    setDialogOpen(true);
  };

  const onPrimaryFieldClick = (data: any) => {
    onPrimaryFieldSelect?.(data);
  };

  const onColumnFieldConfirm = () => {
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
        onColumnFieldClick,
        onPrimaryFieldClick
      ),
    [allColumns, lWorkflowId, rWorkflowId, title]
  );

  const tableRenderingBook = config?.renderOptions?.tableRenderingBook as
    | Record<string, { hide?: boolean }>
    | undefined;
  const columnVisibilityModel = Object.fromEntries(
    Object.entries(tableRenderingBook ?? {})
      .filter(([_, v]) => v?.hide)
      .map(([k]) => [k, false])
  );

  return (
    <Box>
      <Typography variant="h6">{title.text}</Typography>
      {title.description && (
        <Typography variant="body2">{title.description}</Typography>
      )}
      <Typography variant="body2">
        {lWorkflowId} - {rWorkflowId}
      </Typography>
      <RenderRawContent
        data={data}
        buttonName={"view json"}
        buttonSx={{ lineHeight: 2 }}
        title={"Raw Json"}
      />
      {!config?.disableExport && (
        <Button
          variant="outlined"
          sx={{
            px: 0.5,
            py: 0,
            mx: 1,
            minWidth: "auto",
            lineHeight: 2,
            fontSize: "0.75rem",
            textTransform: "none",
          }}
          onClick={() =>
            apiRef?.current?.exportDataAsCsv({
              allColumns: true,
              utf8WithBom: true,
              fileName: `benchmark_${title.text}_${lWorkflowId}_to_${rWorkflowId}`,
            })
          }
        >
          Download CSV
        </Button>
      )}

      <DataGrid
        apiRef={apiRef}
        density="compact"
        rows={rows}
        columns={columns}
        pageSizeOptions={[25, 50, 100]}
        initialState={{
          sorting: {
            sortModel: [{ field: "name", sort: "asc" }],
          },
          pagination: {
            paginationModel: { pageSize: 25 },
          },
          columns: {
            columnVisibilityModel: columnVisibilityModel,
          },
        }}
        getRowId={(r) => {
          return r.id;
        }}
        sx={{
          "& .MuiDataGrid-virtualScroller": { scrollbarGutter: "stable" },
          "& .MuiDataGrid-cell": {
            py: 0, // less vertical padding
            fontSize: "0.75rem",
          },
          "& .MuiDataGrid-columnHeaders": {
            minHeight: 32,
            lineHeight: "32px",
            fontSize: "0.75rem",
          },
          "& .MuiDataGrid-row": {
            minHeight: 32,
          },
        }}
      />
      <SelectionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        left={selectedData?.left}
        right={selectedData?.right}
        onSelect={onColumnFieldConfirm}
        other={{ parent: "comparisonTable" }}
        enabled={config.enableDialog ?? false}
        config={config.customizedConfirmDialog}
      />
    </Box>
  );
}
