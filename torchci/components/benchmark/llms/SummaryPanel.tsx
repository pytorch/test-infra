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

export function SummaryPanel({
  startTime,
  stopTime,
  granularity,
  repoName,
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

  const data = combineLeftAndRight(lPerfData, rPerfData);
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
      renderCell: (params: GridRenderCellParams<any>) => {
        const model = params.value.model;
        if (model === undefined) {
          return `Invalid model name`;
        }

        const dtype =
          params.value.dtype !== undefined
            ? `&dtypeName=${encodeURIComponent(params.value.dtype)}`
            : "";
        const backend =
          params.value.backend !== undefined
            ? `&backendName=${encodeURIComponent(params.value.backend)}`
            : "";
        const deviceName = `${params.value.device} (${params.value.arch})`;

        const url = `/benchmark/llms?startTime=${startTime}&stopTime=${stopTime}&granularity=${granularity}&repoName=${encodeURIComponent(
          repoName
        )}&modelName=${encodeURIComponent(
          model
        )}${backend}${dtype}&deviceName=${encodeURIComponent(
          deviceName
        )}&archName=${encodeURIComponent(archName)}`;

        return (
          <a href={url}>
            <b>{model}</b>
          </a>
        );
      },
    },
  ];

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
  if (hasBackend) {
    columns.push({
      field: "backend",
      headerName: "Backend",
      flex: 1,
      renderCell: (params: GridRenderCellParams<any>) => {
        return `${params.value}`;
      },
    });
  }

  columns.push(
    ...[
      {
        field: "device_arch",
        headerName: "Device",
        flex: 1,
        renderCell: (params: GridRenderCellParams<any>) => {
          const device = params.value.device;
          const arch = params.value.arch;
          return `${device} (${arch})`;
        },
      },
      ...metricNames.map((metric: string) => {
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

            if (lCommit === rCommit || l === r || !v.highlight) {
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
            : data.length * ROW_HEIGHT + ROW_GAP
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
