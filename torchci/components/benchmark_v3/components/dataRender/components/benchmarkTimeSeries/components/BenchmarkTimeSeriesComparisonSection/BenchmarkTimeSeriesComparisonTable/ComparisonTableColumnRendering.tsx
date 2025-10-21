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
  getBenchmarkTimeSeriesComparisionTableRenderingConfig,
  getBenchmarkTimeSeriesComparisonTableTarget,
  renderBasedOnUnitConifg,
} from "../../../helper";
import { asNumber, displayNameOf, valOf } from "./ComparisonTableHelpers";

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

  const primaryFlex = config?.renderOptions?.minWidth?.primary ?? 100;
  // get primary column and apply render logics to it
  const primaryCol: GridColDef = {
    field: "primary",
    headerName: primaryHeaderName,
    minWidth: primaryFlex,
    flex: 1,
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

  const metadatFlex = config?.renderOptions?.minWidth?.extraMetadata ?? 80;
  const metadataCols: GridColDef[] = metadata
    .filter((k) => !!k.field) // skip fields that are not defined
    .map((k) => ({
      field: k.field,
      headerName: k.displayName,
      minWidth: metadatFlex,
      sortable: false,
      filterable: false,
      renderCell: (p) => (
        <Typography variant="body2">{p.row[k.field]}</Typography>
      ),
    }));

  const metricsFlex = config?.renderOptions?.minWidth?.target ?? 80;
  const metricCols: GridColDef[] = columnsFields.map((field) => ({
    field,
    headerName: field,
    flex: 0.5,
    minWidth: metricsFlex,
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

  // get rabw value of left and right field
  const L = valOf(ldata);
  const R = valOf(rdata);

  // assume l and r are numbers
  // todo(elainwy): support non-number values (e.g. string)
  const ln = asNumber(L);
  const rn = asNumber(R);

  // get target field key name, for instance, metric
  // so we can get the comparison policy by get the value of target field
  const targetField = getBenchmarkTimeSeriesComparisonTableTarget();

  const findFieldValueFromColData =
    ldata?.[targetField] ?? rdata?.[targetField];
  const targetVal = findFieldValueFromColData;

  let comparisonPolicy: BenchmarkComparisonPolicyConfig | undefined = undefined;
  if (targetVal && config?.comparisonPolicy) {
    comparisonPolicy = targetVal
      ? config?.comparisonPolicy[targetVal]
      : undefined;
  }

  //console.log("ComparisonTableValueCell", ldata, rdata,targetField,row);
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

  const ldisplay = displayNameOf(ldata);
  const rdisplay = displayNameOf(rdata);
  const text = getFieldRender(targetVal, L, R, config, ldisplay, rdisplay);
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
  rdisplay?: string
) {
  if (ldisplay || rdisplay) {
    return `${ldisplay ?? "N/A"}→${rdisplay ?? "N/A"}`;
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
