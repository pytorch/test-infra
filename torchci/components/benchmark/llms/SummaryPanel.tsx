import { Grid2 } from "@mui/material";
import { GridCellParams, GridRenderCellParams } from "@mui/x-data-grid";
import {
  BranchAndCommitPerfData,
  IS_INCREASING_METRIC_VALUE_GOOD,
  METRIC_DISPLAY_HEADERS,
  RELATIVE_THRESHOLD,
} from "components/benchmark/llms/common";
import styles from "components/metrics.module.css";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { combineLeftAndRight } from "lib/benchmark/llmUtils";

const ROW_GAP = 100;
const ROW_HEIGHT = 38;

const getDeviceArch = (
  device: string | undefined,
  arch: string | undefined
) => {
  const d = device ? device : "";
  const a = arch ? arch : "";
  return a === "" ? d : `${d} (${a})`;
};

export function SummaryPanel({
  startTime,
  stopTime,
  granularity,
  repoName,
  benchmarkName,
  modelName,
  backendName,
  metricNames,
  archName,
  lPerfData,
  rPerfData,
}: {
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  granularity: Granularity;
  repoName: string;
  benchmarkName: string;
  modelName: string;
  backendName: string;
  metricNames: string[];
  archName: string;
  lPerfData: BranchAndCommitPerfData;
  rPerfData: BranchAndCommitPerfData;
}) {
  // The left (base commit)
  const lBranch = lPerfData.branch;
  const lCommit = lPerfData.commit;
  const lData = lPerfData.data;
  // and the right (new commit)
  const rBranch = rPerfData.branch;
  const rCommit = rPerfData.commit;
  const rData = rPerfData.data;

  const data = combineLeftAndRight(
    repoName,
    benchmarkName,
    lPerfData,
    rPerfData
  );
  console.log(data);
  const columns: any[] = [
    {
      field: "metadata",
      headerName: "Name",
      flex: 1,
      cellClassName: (params: GridCellParams<any, any>) => {
        const model = params.value.model;
        if (model === undefined) {
          return "";
        }

        return modelName !== undefined && model === modelName
          ? styles.selectedRow
          : "";
      },
      valueGetter: (params: any) => {
        return params.model ? params.model : "";
      },
      renderCell: (params: any) => {
        // access the row infomation, the params.value is the value pased by valueGetter, mainly used for sorting, and filtering.
        const metadata = params.row.metadata;

        if (metadata === undefined) {
          return "Invalid model name";
        }
        const model = metadata.model;
        if (model === undefined) {
          return `Invalid model name`;
        }

        const mode =
          metadata.mode !== undefined
            ? `&modeName=${encodeURIComponent(metadata.mode)}`
            : "";
        const dtype =
          metadata.dtype !== undefined
            ? `&dtypeName=${encodeURIComponent(metadata.dtype)}`
            : "";
        const backend =
          metadata.backend !== undefined
            ? `&backendName=${encodeURIComponent(metadata.backend)}`
            : "";
        const deviceName = `${metadata.device} (${metadata.arch})`;

        const url = `/benchmark/llms?startTime=${startTime}&stopTime=${stopTime}&granularity=${granularity}&repoName=${encodeURIComponent(
          repoName
        )}&benchmarkName=${encodeURIComponent(
          benchmarkName
        )}&modelName=${encodeURIComponent(
          model
        )}${backend}${mode}${dtype}&deviceName=${encodeURIComponent(
          deviceName
        )}&archName=${encodeURIComponent(archName)}`;

        const displayName =
          metadata.origins.length !== 0
            ? `${model} (${metadata.origins.join(",")})`
            : model;
        return (
          <a href={url}>
            <b>{displayName}</b>
          </a>
        );
      },
    },
  ];

  const hasMode = data.length > 0 && "mode" in data[0] ? true : false;
  if (hasMode && benchmarkName === "TorchCache Benchmark") {
    columns.push({
      field: "mode",
      headerName: "Mode",
      flex: 1,
      renderCell: (params: GridRenderCellParams<any>) => {
        return `${params.value}`;
      },
    });
  }

  if (repoName === "vllm-project/vllm") {
    columns.push({
      field: "tensor_parallel_size",
      headerName: "Tensor parallel",
      flex: 1,
      renderCell: (params: GridRenderCellParams<any>) => {
        return `${params.value}`;
      },
    });

    columns.push({
      field: "request_rate",
      headerName: "Request rate",
      flex: 1,
      renderCell: (params: GridRenderCellParams<any>) => {
        return `${params.value}`;
      },
    });
  }

  if (
    repoName === "pytorch/pytorch" &&
    benchmarkName === "TorchCache Benchmark"
  ) {
    columns.push({
      field: "is_dynamic",
      headerName: "Is dynamic?",
      flex: 1,
      renderCell: (params: GridRenderCellParams<any>) => {
        return `${params.value}`;
      },
    });
  }

  const hasDtype = data.length > 0 && "dtype" in data[0] ? true : false;
  if (hasDtype) {
    columns.push({
      field: "dtype",
      headerName: "Quantization",
      flex: 1,
      renderCell: (params: GridRenderCellParams<any>) => {
        return `${params.value}`;
      },
    });
  }

  const hasBackend = data.length > 0 && "backend" in data[0] ? true : false;
  if (hasBackend && benchmarkName !== "TorchCache Benchmark") {
    columns.push({
      field: "backend",
      headerName: "Backend",
      flex: 1,
      renderCell: (params: GridRenderCellParams<any>) => {
        return `${params.value}`;
      },
    });
  }

  if (benchmarkName !== "TorchCache Benchmark") {
    // We want to set a custom order for cache benchmark
    const priorityOrder = ["Cold compile time (s)", "Warm compile time (s)", "Speedup (%)"];
    metricNames.sort((x, y) => {
      const indexX = priorityOrder.indexOf(x);
      const indexY = priorityOrder.indexOf(y);

      if (indexX !== -1 && indexY !== -1) {
          return indexX - indexY; // Keep the priority order
      }
      if (indexX !== -1) return -1; // Move priority items to the front
      if (indexY !== -1) return 1;

      return 0; // Keep original order for non-priority items
    });
  }

  columns.push(
    ...[
      {
        field: "device_arch",
        headerName: "Device",
        flex: 1,
        valueGetter: (params: any) => {
          return getDeviceArch(params?.device, params?.arch);
        },
        renderCell: (params: GridRenderCellParams<any>) => {
          return params.value;
        },
      },
      ...metricNames
        .filter((metric: string) => {
          // TODO (huydhn): Just a temp fix, remove this after a few weeks
          return (
            repoName !== "pytorch/pytorch" ||
            benchmarkName !== "TorchCache Benchmark" ||
            (metric !== "speedup" && metric !== "Speedup")
          );
        })
        .map((metric: string) => {
          return {
            field: metric,
            headerName:
              metric in METRIC_DISPLAY_HEADERS
                ? METRIC_DISPLAY_HEADERS[metric]
                : metric,
            flex: 1,
            cellClassName: (params: GridCellParams<any, any>) => {
              const v = params.value;
              if (v === undefined) {
                return "";
              }

              // l is the old (base) value, r is the new value
              const l = v.l.actual;
              const r = v.r.actual;

              if (!v.highlight) {
                return "";
              }

              if (lCommit === rCommit) {
                return "";
              } else {
                if (l === r) {
                  // 0 means the model isn't run at all
                  return "";
                }

                // It didn't error in the past, but now it does error
                if (r === 0) {
                  return styles.error;
                }

                // If it didn't run and now it runs, mark it as green
                if (l === 0) {
                  return styles.ok;
                }

                if (metric in IS_INCREASING_METRIC_VALUE_GOOD) {
                  // Higher value
                  if (r - l > RELATIVE_THRESHOLD * l) {
                    return IS_INCREASING_METRIC_VALUE_GOOD[metric]
                      ? styles.ok
                      : styles.error;
                  }

                  // Lower value
                  if (l - r > RELATIVE_THRESHOLD * r) {
                    return IS_INCREASING_METRIC_VALUE_GOOD[metric]
                      ? styles.error
                      : styles.ok;
                  }
                } else {
                  // No data
                  return "";
                }
              }

              return "";
            },
            renderCell: (params: GridRenderCellParams<any>) => {
              const v = params.value;
              if (v === undefined) {
                return "";
              }

              const l = v.l.actual;
              const r = v.r.actual;

              // Compute the percentage
              const target = v.r.target;
              const lPercent =
                target && target != 0
                  ? `(${Number((l * 100) / target).toFixed(0)}%)`
                  : "";
              const rPercent =
                target && target != 0
                  ? `(${Number((r * 100) / target).toFixed(0)}%)`
                  : "";
              const showTarget =
                target && target != 0 ? `[target = ${target}]` : "";

              if (lCommit === rCommit || !v.highlight) {
                return `${r} ${rPercent} ${showTarget}`;
              } else {
                return `${l} ${lPercent} → ${r} ${rPercent} ${showTarget}`;
              }
            },
          };
        }),
    ]
  );

  // TODO (huydhn): Table bigger than 100 rows requires x-data-grid-pro
  return (
    <Grid2 container spacing={2} style={{ height: "100%" }}>
      <Grid2
        size={{ xs: 12, lg: 12 }}
        height={
          data.length > 90
            ? 90 * ROW_HEIGHT
            : (data.length + 1) * ROW_HEIGHT + ROW_GAP
        }
      >
        <TablePanelWithData
          title={"Models"}
          data={data}
          columns={columns}
          dataGridProps={{ getRowId: (el: any) => el.name }}
          showFooter={true}
        />
      </Grid2>
    </Grid2>
  );
}
