import { Grid } from "@mui/material";
import { GridCellParams, GridRenderCellParams } from "@mui/x-data-grid";
import {
  BranchAndCommitPerfData,
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
  modelName,
  metricNames,
  lPerfData,
  rPerfData,
}: {
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  granularity: Granularity;
  modelName: string;
  metricNames: string[];
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
  return (
    <Grid container spacing={2} style={{ height: "100%" }}>
      <Grid item xs={12} lg={12} height={data.length * ROW_HEIGHT + ROW_GAP}>
        <TablePanelWithData
          title={"Models"}
          data={data}
          columns={[
            {
              field: "metadata",
              headerName: "Name",
              flex: 1,
              cellClassName: (params: GridCellParams<any>) => {
                const name = params.value.name;
                if (name === undefined) {
                  return "";
                }

                return modelName !== undefined && name === modelName
                  ? styles.selectedRow
                  : "";
              },
              renderCell: (params: GridRenderCellParams<any>) => {
                const name = params.value.name;
                const dtype = params.value.dtype;
                const deviceArch = `${params.value.device} (${params.value.arch})`;
                if (name === undefined) {
                  return `Invalid model name`;
                }
                if (dtype === undefined) {
                  return `Invalid dtype for model ${name}`;
                }

                const url = `/benchmark/llms?startTime=${startTime}&stopTime=${stopTime}&granularity=${granularity}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}&modelName=${encodeURIComponent(
                  name
                )}&dtypeName=${encodeURIComponent(
                  dtype
                )}&deviceName=${encodeURIComponent(deviceArch)}`;

                const isNewModel =
                  params.value.l === undefined ? "(NEW!) " : "";
                const isModelStopRunning =
                  params.value.r === undefined ? "❌" : "";

                const displayName = name.includes(dtype)
                  ? name
                  : `${name} (${dtype})`;
                return (
                  <a href={url}>
                    {isNewModel}
                    {isModelStopRunning}&nbsp;<b>{displayName}</b>
                  </a>
                );
              },
            },
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
                cellClassName: (params: GridCellParams<any>) => {
                  const v = params.value;
                  if (v === undefined || v.l.actual === 0) {
                    return "";
                  }

                  // l is the old (base) value, r is the new value
                  const l = v.l.actual;
                  const r = v.r.actual;

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

                    // Higher TPS
                    if (r - l > RELATIVE_THRESHOLD * l) {
                      return styles.ok;
                    }

                    // Lower TPS
                    if (l - r > RELATIVE_THRESHOLD * r) {
                      return styles.error;
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
                  const lPercent = target
                    ? `(${Number((l * 100) / target).toFixed(0)}%)`
                    : "";
                  const rPercent = target
                    ? `(${Number((r * 100) / target).toFixed(0)}%)`
                    : "";
                  const isNewModel = l === 0 ? "(NEW!)" : "";

                  if (lCommit === rCommit || l === r) {
                    return `${r} ${rPercent} [target = ${target}]`;
                  } else {
                    return `${l} ${lPercent} → ${r} ${rPercent} [target = ${target}] ${isNewModel} `;
                  }
                },
              };
            }),
          ]}
          dataGridProps={{ getRowId: (el: any) => el.name }}
        />
      </Grid>
    </Grid>
  );
}
