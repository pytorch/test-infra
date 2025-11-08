import { Button, Tooltip, Typography } from "@mui/material";
import { Box } from "@mui/system";
import {
  DataGrid,
  GridColDef,
  GridRenderCellParams,
  useGridApiRef,
} from "@mui/x-data-grid";
import { RenderRawContent } from "components/benchmark_v3/components/common/RawContentDialog";
import Link from "next/link";
import { useMemo } from "react";
import {
  formatHeaderName,
  getBenchmarkTimeSeriesComparisionTableRenderingConfig,
  renderBasedOnUnitConifg,
} from "../helper";
import { groupKeyAndLabel } from "./BenchmarkTimeSeriesComparisonSection/BenchmarkTimeSeriesComparisonTable/ComparisonTableHelpers";

const GOOD_COLOR = "#e8f5e9"; // green[50]
export default function BenchmarkSingleDataTable({
  config,
  data,
  title,
  isDebug = false,
}: {
  config: any;
  data: any;
  title?: {
    text: string;
    description?: string;
  };
  isDebug?: boolean;
}) {
  const apiRef = useGridApiRef();

  const rows: any[] = useMemo(() => {
    return ToRawTableRow(config, data);
  }, [data]);

  const allColumns = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) =>
      r.rowItem.forEach((i: any) => {
        Object.keys(i ?? {}).forEach((k) => {
          const groupItem = i[k];
          // helps debuging if the group item has more than one data item
          if (groupItem?.data?.length > 1) {
            groupItem.data.forEach((d: any, idx: number) => {
              s.add(`${k}||${idx}`);
            });
          } else {
            s.add(k);
          }
        });
      })
    );
    const auto = Array.from(s).sort();
    return auto;
  }, [rows]);

  const columns: GridColDef[] = useMemo(
    () => getTableConlumnRendering(config, allColumns),
    [allColumns, config]
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
      <Typography variant="h6">{title?.text}</Typography>
      {title?.description && (
        <Typography variant="body2">{title.description}</Typography>
      )}
      {isDebug && (
        <RenderRawContent
          data={rows}
          title="Report Raw Json"
          buttonName="View Full Raw Data"
          type="json"
        />
      )}
      <Button
        onClick={() =>
          apiRef?.current?.exportDataAsCsv({
            allColumns: true,
            utf8WithBom: true,
            fileName: "benchmark_raw_data",
          })
        }
      >
        Download CSV
      </Button>
      <DataGrid
        density="compact"
        apiRef={apiRef}
        rows={rows}
        columns={columns}
        pageSizeOptions={[25, 50, 100]}
        initialState={{
          sorting: {
            sortModel: [{ field: "timestamp", sort: "asc" }],
          },
          pagination: {
            paginationModel: { pageSize: 25 },
          },
          columns: {
            columnVisibilityModel: columnVisibilityModel,
          },
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
    </Box>
  );
}

/**
 * function to get the table column rendering logics
 *
 * @param config
 * @param metricFields
 * @returns
 */
function getTableConlumnRendering(
  config: any,
  metricFields: string[] = []
): GridColDef[] {
  const metadataColumns: any[] = [
    {
      field: "workflow_run",
      headerName: "Workflow Run",
      minWidth: 140,
      valueGetter: (_value: any, row: any) => {
        const wf = row?.workflow_id ?? "";
        const job = row?.job_id ?? "";
        return `${wf}/${job}`;
      },
      valueFormatter: (value: any, row: any) => {
        return value ?? "";
      },
      renderCell: (params: GridRenderCellParams<any>) => {
        const tooltipText = `navigate to github page for job ${params.value}
        }`;
        return (
          <Tooltip title={tooltipText}>
            <Link href={params.row.job_url} target="_blank" rel="noopener">
              {params.value}
            </Link>
          </Tooltip>
        );
      },
    },
    {
      field: "commit",
      headerName: "Commit",
      renderCell: (params: GridRenderCellParams<any>) => {
        const tooltipText = `navigate to job run in hud commit page`;
        return (
          <Tooltip title={tooltipText}>
            <Link href={params.row.commit_url} target="_blank" rel="noopener">
              <span
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                }}
              >
                {String(params.value)}
              </span>
            </Link>
          </Tooltip>
        );
      },
    },
  ];

  const metadata = config?.extraMetadata ?? [];
  const metadataCols: GridColDef[] = metadata
    .filter((k: any) => !!k.field) // skip fields that are not defined
    .map((k: any) => ({
      field: k.field,
      headerName: k.displayName ?? k.field,
      renderCell: (p: any) => (
        <Typography variant="body2">{p.row[k.field]}</Typography>
      ),
    }));

  const metricCols: GridColDef[] = metricFields.map((field) => ({
    field,
    headerName: formatHeaderName(
      field,
      config?.renderOptions?.tableRenderingBook
    ),
    flex: 0.5,
    sortable: false,
    filterable: false,
    valueGetter: (_value: any, row: any) => {
      const data = row.rowItem;
      if (data.length == 0) {
        return undefined;
      }
      let fieldName = field;
      let idx = 0;
      if (field.split("||").length > 1) {
        idx = Number(field.split("||")[1]);
        fieldName = field.split("||")[0];
      }
      const value = data[0][fieldName]?.data[idx]?.value;
      return value;
    },
    valueFormatter: (value: any, row: any) => {
      let fieldName = field;
      const rc = getBenchmarkTimeSeriesComparisionTableRenderingConfig(
        fieldName,
        config
      );
      return renderBasedOnUnitConifg(value, rc?.unit);
    },
    renderCell: (params: GridRenderCellParams<any>) => {
      if (config?.renderOptions?.highlightPolicy) {
        const policy = config?.renderOptions?.highlightPolicy;
        return renderHighlight(policy, params);
      }
      return <Box>{params.formattedValue ?? ""}</Box>;
    },
  }));

  return [...metadataColumns, ...metadataCols, ...metricCols];
}

function renderHighlight(
  highlightPolicy: any,
  params: GridRenderCellParams<any>
) {
  if (highlightPolicy.direction != "row") {
    return <Box>{params.formattedValue ?? ""}</Box>;
  }
  const policy = highlightPolicy?.policy ?? "max";
  const regex = highlightPolicy?.regex;
  const highlighColor = highlightPolicy?.color ?? GOOD_COLOR;
  const highlight = shouldHighlightCellByRowExtrema(params, policy, regex);
  return (
    <Box
      sx={{
        bgcolor: highlight ? highlighColor : "transparent",
        fontWeight: highlight ? 600 : "normal",
        px: 0.5,
        py: 0.25,
        borderRadius: 1,
      }}
    >
      {params.formattedValue ?? params.value ?? ""}
    </Box>
  );
}

/**
 * Transform the data into a table row item for rendering
 * @param config
 * @param data
 * @returns
 */
export function ToRawTableRow(config: any, data: any) {
  const m = new Map<string, any>();
  for (const d of data ?? []) {
    const i = d.group_info;
    const wf = String(i?.workflow_id ?? "");
    const jobId = String(i?.job_id ?? "");
    const sourceRepo = i?.repo ?? "";
    const hudCommitUrl = `/${sourceRepo}/commit/${
      i?.commit ?? ""
    }#${jobId}-box`;
    const gitRepoUrl = `https://github.com/${sourceRepo}`;
    const jobUrl = `${gitRepoUrl}/actions/runs/${wf}/job/${jobId}`;
    const rawData = d.data ?? [];
    const { key } = groupKeyAndLabel(i);
    if (!m.has(key)) {
      m.set(key, {
        ...i,
        job_id: jobId,
        workflow_id: wf,
        commit: i?.commit ?? "",
        commit_url: hudCommitUrl,
        job_url: jobUrl,
        repo: String(i?.repo ?? ""),
        timestamp: i?.granularity_bucket ?? "",
        id: key,
        rowItem: [],
      });
    }
    m.get(key)!.rowItem.push(rawData);
  }
  return Array.from(m.values());
}

export function shouldHighlightCellByRowExtrema(
  params: GridRenderCellParams<any>,
  policy: "min" | "max",
  regexString?: string
): boolean {
  const rowItems = params.row?.rowItem;
  if (!Array.isArray(rowItems) || rowItems.length === 0) return false;

  // parse "field||idx" -> base name + index
  const [baseField, idxStr] = String(params.field).split("||");
  const idx = Number.isFinite(Number(idxStr)) ? Number(idxStr) : 0;

  // flatten rowItem[0]
  const root = rowItems[0] ?? {};
  const flattened: Record<string, number> = {};

  for (const key of Object.keys(root)) {
    const arr = root[key]?.data;
    if (!Array.isArray(arr) || arr.length <= idx) continue;
    const v = arr[idx]?.value;
    if (typeof v === "number" && Number.isFinite(v)) {
      flattened[key] = v;
    }
  }

  const current = flattened[baseField];

  if (current == null) return false;

  // optional regex filter
  let regex: RegExp | null = null;
  if (regexString) {
    try {
      regex = new RegExp(regexString);
    } catch {
      regex = null;
    }
  }

  const entries = Object.entries(flattened).filter(([k]) =>
    regex ? regex.test(k) : true
  );

  if (entries.length === 0) return false;

  const values = entries.map(([, v]) => v);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);

  return policy === "min" ? current === minV : current === maxV;
}
