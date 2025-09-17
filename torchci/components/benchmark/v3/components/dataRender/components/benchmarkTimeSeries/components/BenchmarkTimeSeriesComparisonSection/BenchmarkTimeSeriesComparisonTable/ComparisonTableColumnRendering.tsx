import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { IconButton, Tooltip, Typography } from "@mui/material";
import { Box } from "@mui/system";
import {
  GridColDef,
  GridRenderCellParams,
  GridRowModel,
} from "@mui/x-data-grid";
import { asNumber, valOf } from "./ComparisonTableHelpers";

/**
 *
 * @param allColumns
 * @param lWorkflowId
 * @param rWorkflowId
 * @returns
 */
export function getComparisionTableConlumnRendering(
  columnsFields: string[],
  lWorkflowId: string | null,
  rWorkflowId: string | null
): GridColDef[] {
  const nameCol: GridColDef = {
    field: "name",
    headerName: "Name",
    flex: 1.2,
    sortable: false,
    filterable: false,
    renderCell: (p) => <Typography variant="body2">{p.row.name}</Typography>,
  };
  const metricCols: GridColDef[] = columnsFields.map((field) => ({
    field,
    headerName: field,
    flex: 1,
    sortable: false,
    filterable: false,
    renderCell: (params: GridRenderCellParams<any, GridRowModel>) => (
      <ComparisonTableValueCell
        field={field}
        row={params.row}
        lWorkflowId={lWorkflowId}
        rWorkflowId={rWorkflowId}
      />
    ),
  }));
  const labelCol: GridColDef = {
    field: "label",
    headerName: "Label",
    flex: 1.2,
    sortable: false,
    filterable: false,
    renderCell: (p) => (
      <Tooltip title={p.row.label} arrow>
        <IconButton size="small">
          <InfoOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    ),
  };
  return [nameCol, ...metricCols, labelCol];
}

/** Colors */
const VIOLATE_RULE_COLOR = "#ffebee"; // red[50]
const IMPROVEMENT_COLOR = "#e8f5e9"; // green[50]

/**
 *
 * @returns
 */
export function ComparisonTableValueCell({
  field,
  row,
  lWorkflowId,
  rWorkflowId,
}: {
  field: string;
  row: GridRowModel;
  lWorkflowId: string | null;
  rWorkflowId: string | null;
}) {
  // If your value is directly rows[col], drop `.data?.[0]`
  const L = valOf(
    lWorkflowId
      ? row.byWorkflow[lWorkflowId]?.[field]?.data?.[0] ??
          row.byWorkflow[lWorkflowId]?.[field]
      : undefined
  );
  const R = valOf(
    rWorkflowId
      ? row.byWorkflow[rWorkflowId]?.[field]?.data?.[0] ??
          row.byWorkflow[rWorkflowId]?.[field]
      : undefined
  );

  const fmt = (v: any) =>
    v == null ? "—" : typeof v === "number" ? Number(v).toFixed(2) : String(v);
  const ln = asNumber(L);
  const rn = asNumber(R);
  const d = ln != null && rn != null ? rn - ln : null;
  const dStr = d == null ? "—" : `${d >= 0 ? "+" : ""}${Number(d.toFixed(3))}`;

  const bg =
    d == null || d === 0
      ? undefined
      : d > 0
      ? IMPROVEMENT_COLOR
      : VIOLATE_RULE_COLOR;

  const text =
    L == null && R == null
      ? "N/A"
      : L == null
      ? `N/A→${fmt(R)}`
      : R == null
      ? `${fmt(L)}→N/A`
      : L === R
      ? `${fmt(L)}`
      : `${fmt(L)}→${fmt(R)} (${dStr})`;

  return (
    <Box sx={{ bgcolor: bg, borderRadius: 1, px: 0.5, py: 0.25 }}>
      <Typography variant="body2">{text}</Typography>
    </Box>
  );
}
