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
  BenchmarkComparisonTablePrimaryColumnConfig,
  BenchmarkUnitConfig,
  ComparisonTableConfig,
  fmtFixed2,
  formatHeaderName,
  getBenchmarkTimeSeriesComparisionTableRenderingConfig,
  getBenchmarkTimeSeriesComparisonTableTarget,
  renderBasedOnUnitConifg,
} from "../../../helper";
import { displayNameOf, valOf } from "./ComparisonTableHelpers";

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
  onColumnFieldClick: (data: any) => void = (data: any) => {},
  onPrimaryField?: (data: any) => void
): GridColDef[] {
  const primaryHeaderName = config?.primary?.displayName ?? "Name";

  const primaryFlex = config?.renderOptions?.flex?.primary ?? 1.2;
  // get primary column and apply render logics to it
  const primaryCol: GridColDef = {
    field: "primary",
    flex: primaryFlex,
    headerName: primaryHeaderName,
    minWidth: 50,
    sortable: false,
    filterable: false,
    renderCell: (params: GridRenderCellParams<any, GridRowModel>) => {
      return (
        <ComparisonTablePrimaryFieldValueCell
          params={params}
          primaryFieldConfig={config?.primary}
          onClick={onPrimaryField}
        />
      );
    },
  };

  // get metadata columns from config
  const metadata = config?.extraMetadata ?? [];

  const metadatFlex = config?.renderOptions?.flex?.extraMetadata ?? 0.5;
  const metadataCols: GridColDef[] = metadata
    .filter((k) => !!k.field) // skip fields that are not defined
    .map((k) => ({
      field: k.field,
      headerName: k?.displayName ?? k.field,
      flex: 0.5,
      minWidth: 50,
      sortable: false,
      filterable: false,
      renderCell: (p) => (
        <Typography variant="body2">{p.row[k.field]}</Typography>
      ),
    }));

  const metricsFlex = config?.renderOptions?.flex?.target ?? 1;
  const metricCols: GridColDef[] = columnsFields.map((field) => ({
    field,
    headerName: formatHeaderName(
      field,
      config?.renderOptions?.tableRenderingBook
    ),
    flex: 1,
    minWidth: 50,
    sortable: false,
    filterable: false,
    renderCell: (params: GridRenderCellParams<any, GridRowModel>) => (
      <ComparisonTableColumnFieldValueCell
        field={field}
        row={params.row}
        lWorkflowId={lWorkflowId}
        rWorkflowId={rWorkflowId}
        config={config}
        onClick={onColumnFieldClick}
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
  return [primaryCol, ...metadataCols, ...metricCols, labelCol];
}

/** Colors */
const VIOLATE_RULE_COLOR = "#ffebee"; // red[50]
const IMPROVEMENT_COLOR = "#e8f5e9"; // green[50]
const WARNING_COLOR = "#fff9c4"; // yellow[50]

export function ComparisonTablePrimaryFieldValueCell({
  params,
  primaryFieldConfig,
  onClick = (data: any) => {},
}: {
  params: GridRenderCellParams<any, GridRowModel>;
  primaryFieldConfig?: BenchmarkComparisonTablePrimaryColumnConfig;
  onClick?: (data: any) => void;
}) {
  const type = primaryFieldConfig?.navigation?.type;
  const isNavEnabled = !!type;

  // render text-only primary row field if no navigation configuration
  if (!isNavEnabled) {
    return <Typography variant="body2">{params.row.primary}</Typography>;
  }

  return (
    <Typography
      variant="body2"
      sx={{ cursor: "pointer", color: "primary.main" }}
      onClick={() => {
        onClick({
          config: primaryFieldConfig,
          groupInfo: params.row.groupInfo,
        });
      }}
    >
      {params.row.primary}
    </Typography>
  );
}

/**
 *
 */
export function ComparisonTableColumnFieldValueCell({
  field,
  row,
  lWorkflowId,
  rWorkflowId,
  config,
  onClick,
}: {
  field: string;
  row: GridRowModel;
  lWorkflowId: string | null;
  rWorkflowId: string | null;
  comparisonTargetField?: string;
  config?: ComparisonTableConfig;
  onClick: (data: any) => void;
}) {
  const ldata = lWorkflowId
    ? row.byWorkflow[lWorkflowId]?.[field]?.data?.[0] ??
      row.byWorkflow[lWorkflowId]?.[field]
    : undefined;
  const rdata = rWorkflowId
    ? row.byWorkflow[rWorkflowId]?.[field]?.data?.[0] ??
      row.byWorkflow[rWorkflowId]?.[field]
    : undefined;

  // get raw value of left and right field
  const L = valOf(ldata);
  const R = valOf(rdata);

  const targetField = getBenchmarkTimeSeriesComparisonTableTarget();
  const findFieldValueFromColData =
    ldata?.[targetField] ?? rdata?.[targetField];
  const targetVal = findFieldValueFromColData;

  const { result, text } = getComparisonResult(
    L,
    R,
    ldata,
    rdata,
    targetVal,
    config
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
    case "warning":
      bgColor = WARNING_COLOR;
      break;
    case "neutral":
    default:
      break;
  }

  return (
    <Box sx={{ bgcolor: bgColor, borderRadius: 1, px: 0.5, py: 0.25 }}>
      <Tooltip title={renderComparisonResult(result)}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Typography variant="body2">{text}</Typography>
          {config?.enableDialog && (
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
  config?: ComparisonTableConfig,
  ldisplay?: string,
  rdisplay?: string,
  missingText: string = "N/A"
) {
  if (ldisplay || rdisplay) {
    return `${ldisplay ?? missingText}→${rdisplay ?? missingText}`;
  }
  const rc = getBenchmarkTimeSeriesComparisionTableRenderingConfig(
    targetField,
    config
  );
  return formatTransitionWithUnit(L, R, rc?.unit);
}
export function formatTransitionWithUnit(
  L: any,
  R: any,
  table_unit?: BenchmarkUnitConfig,
  missingText: string = "N/A"
): string {
  const formatValue = (v: any) => {
    if (v == null || v == undefined) return missingText;
    const num = Number(v);
    const isNumeric = !isNaN(num) && v !== "";
    if (isNumeric) {
      return renderBasedOnUnitConifg(fmtFixed2(num), table_unit);
    }
    // non-numeric → render raw
    return String(v);
  };

  if (L == null && R == null) {
    return missingText;
  }

  if (L == null) {
    return `${missingText}→${formatValue(R)}`;
  }
  if (R == null) {
    return `${formatValue(L)}→${missingText}`;
  }

  if (fmtFixed2(L) === fmtFixed2(R)) {
    return formatValue(L);
  }
  return `${formatValue(L)}→${formatValue(R)}`;
}

export function getComparisonResult(
  L: any,
  R: any,
  ldata: any,
  rdata: any,
  targetVal: string,
  config?: ComparisonTableConfig
) {
  // get target field key name, for instance, metric
  // so we can get the comparison policy by get the value of target field

  let policy: BenchmarkComparisonPolicyConfig | undefined = undefined;
  if (targetVal && config?.comparisonPolicy) {
    policy = targetVal ? config.comparisonPolicy[targetVal] : undefined;
  }
  // evaluate the value comparison result, return the comparison report for each field
  const result = evaluateComparison(policy?.target, L, R, policy);

  const ldisplay = displayNameOf(ldata);
  const rdisplay = displayNameOf(rdata);
  const text = getFieldRender(targetVal, L, R, config, ldisplay, rdisplay);

  return {
    result,
    text,
  };
}
