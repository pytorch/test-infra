import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { IconButton, Tooltip, Typography } from "@mui/material";
import { Box } from "@mui/system";
import {
  GridColDef,
  GridRenderCellParams,
  GridRowModel,
} from "@mui/x-data-grid";
import { MoreVertButton } from "components/benchmark_v3/components/common/MoreVertButton";
import {
  BenchmarkComparisonPolicyConfig,
  ComparisonResult,
  evaluateComparison,
} from "components/benchmark_v3/configs/helpers/RegressionPolicy";
import {
  BenchmarkUnitConfig,
  ComparisonTableConfig,
  fmtFixed2,
  getBenchmarkTimeSeriesComparisionTableRenderingConfig,
  getBenchmarkTimeSeriesComparisonTableTarget,
  renderBasedOnUnitConifg,
} from "../../../helper";
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
  rWorkflowId: string | null,
  config: ComparisonTableConfig,
  onClick?: (data: any) => void
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
        config={config}
        onClick={onClick}
      />
    ),
  }));
  const labelCol: GridColDef = {
    field: "label",
    headerName: "Label",
    width: 10,
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
  config,
  onClick = (data: any) => {},
}: {
  field: string;
  row: GridRowModel;
  lWorkflowId: string | null;
  rWorkflowId: string | null;
  comparisonTargetField?: string;
  config?: ComparisonTableConfig;
  onClick?: (data: any) => void;
}) {
  const ldata = lWorkflowId
    ? row.byWorkflow[lWorkflowId]?.[field]?.data?.[0] ??
      row.byWorkflow[lWorkflowId]?.[field]
    : undefined;
  const rdata = rWorkflowId
    ? row.byWorkflow[rWorkflowId]?.[field]?.data?.[0] ??
      row.byWorkflow[rWorkflowId]?.[field]
    : undefined;

  // get rabw value of left and right field
  const L = valOf(ldata);
  const R = valOf(rdata);

  // assume l and r are numbers
  // todo(elainwy): support non-number values (e.g. string)
  const ln = asNumber(L);
  const rn = asNumber(R);

  // get comparison policy for the field
  const targetField = getBenchmarkTimeSeriesComparisonTableTarget();
  let comparisonPolicy: BenchmarkComparisonPolicyConfig | undefined = undefined;
  if (targetField && config?.comparisonPolicy) {
    const fieldValue = row[targetField];
    comparisonPolicy = fieldValue
      ? config?.comparisonPolicy[fieldValue]
      : undefined;
  }
  // evaluate the value comparison result, return the comparison report for each field
  const result = evaluateComparison(
    comparisonPolicy?.target,
    ln,
    rn,
    comparisonPolicy
  );

  // pick background color based on result signals
  let bgColor = "";
  switch (result.verdict) {
    case "good":
      bgColor = IMPROVEMENT_COLOR;
      break;
    case "regression":
      bgColor = VIOLATE_RULE_COLOR;
      break;
    case "neutral":
    default:
      break;
  }

  const targetFieldValue = row[targetField] ?? "";
  const text = getFieldRender(targetFieldValue, L, R, config);
  return (
    <Box sx={{ bgcolor: bgColor, borderRadius: 1, px: 0.5, py: 0.25 }}>
      <Tooltip title={renderComparisonResult(result)}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Typography variant="body2">{text}</Typography>
          {config?.customizedConfirmDialog && (
            <MoreVertButton
              onClick={() => onClick({ left: ldata, right: rdata })}
            />
          )}
        </Box>
      </Tooltip>
    </Box>
  );
}

function renderComparisonResult(result: ComparisonResult) {
  return (
    <Box sx={{ p: 1 }}>
      {Object.entries(result).map(([key, value]) => (
        <Typography key={key} variant="body2" sx={{ whiteSpace: "pre-line" }}>
          <strong>{key}</strong>: {String(value)}
        </Typography>
      ))}
    </Box>
  );
}

export function getFieldRender(
  targetField: string,
  L: any,
  R: any,
  config?: ComparisonTableConfig
) {
  const rc = getBenchmarkTimeSeriesComparisionTableRenderingConfig(
    targetField,
    config
  );
  return formatTransitionWithUnit(L, R, rc?.unit);
}
export function formatTransitionWithUnit(
  L: any,
  R: any,
  table_unit?: BenchmarkUnitConfig
): string {
  const formatValue = (v: any) =>
    v == null ? "N/A" : renderBasedOnUnitConifg(fmtFixed2(v), table_unit);
  if (L == null && R == null) {
    return "N/A";
  }
  if (L == null) {
    return `N/A→${formatValue(R)}`;
  }
  if (R == null) {
    return `${formatValue(L)}→N/A`;
  }
  if (fmtFixed2(L) === fmtFixed2(R)) {
    return formatValue(L);
  }
  return `${formatValue(L)}→${formatValue(R)}`;
}
