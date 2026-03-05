import {
  Button,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
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

// View mode type for switching between displayName and displayNameAlt
export type ViewMode = "default" | "alternate";

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
  const [viewMode, setViewMode] = useState<ViewMode>("default");

  // Check if view switch is enabled
  const enableViewSwitch = config?.renderOptions?.enableViewSwitch ?? false;
  const viewSwitchConfig = config?.renderOptions?.viewSwitchLabels ?? {
    default: { label: "Detailed", field: "displayName" },
    alternate: { label: "Simple", field: "displayNameAlt" },
  };

  const handleViewModeChange = (
    _event: React.MouseEvent<HTMLElement>,
    newMode: ViewMode | null
  ) => {
    if (newMode !== null) {
      setViewMode(newMode);
    }
  };

  // Get the current field name based on view mode
  const currentDisplayField =
    viewMode === "default"
      ? viewSwitchConfig.default.field ?? "displayName"
      : viewSwitchConfig.alternate.field ?? "displayNameAlt";

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
        onPrimaryFieldClick,
        currentDisplayField
      ),
    [allColumns, lWorkflowId, rWorkflowId, title, currentDisplayField]
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
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 1 }}>
        <Typography variant="h6">{title.text}</Typography>
        {enableViewSwitch && (
          <ToggleButtonGroup
            value={viewMode}
            exclusive
            onChange={handleViewModeChange}
            size="small"
          >
            <ToggleButton
              value="default"
              sx={{ py: 0, px: 1, fontSize: "0.75rem" }}
            >
              {viewSwitchConfig.default.label}
            </ToggleButton>
            <ToggleButton
              value="alternate"
              sx={{ py: 0, px: 1, fontSize: "0.75rem" }}
            >
              {viewSwitchConfig.alternate.label}
            </ToggleButton>
          </ToggleButtonGroup>
        )}
      </Box>
      {title.description && (
        <Typography variant="body2" sx={{ mb: 1 }}>
          {title.description}
        </Typography>
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
