import dayjs from "dayjs";
import { Grid } from "@mui/material";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import {
  BranchAndCommitPerfData,
  LLMsBenchmarkData,
  RELATIVE_THRESHOLD,
} from "components/benchmark/llms/common";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import styles from "components/metrics.module.css";
import { GridRenderCellParams, GridCellParams } from "@mui/x-data-grid";

const ROW_GAP = 100;
const ROW_HEIGHT = 38;

export function SummaryPanel({
  startTime,
  stopTime,
  granularity,
  modelName,
  quantization,
  lPerfData,
  rPerfData,
}: {
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  granularity: Granularity;
  modelName: string;
  quantization: string;
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

  const dataGroupedByModel: { [k: string]: any } = {};
  rData.forEach((record: LLMsBenchmarkData) => {
    dataGroupedByModel[record.name] = {
      r: record,
    };
  });

  // Combine with left (base) data
  if (lCommit !== rCommit && lData !== undefined) {
    lData.forEach((record: LLMsBenchmarkData) => {
      if (record.name in dataGroupedByModel) {
        dataGroupedByModel[record.name]["l"] = record;
      } else {
        dataGroupedByModel[record.name] = {
          l: record,
        };
      }
    });
  }

  // Transform the data into a displayable format
  const data = Object.keys(dataGroupedByModel).map((name: string) => {
    const record = dataGroupedByModel[name];
    const hasL = "l" in record;
    const hasR = "r" in record;

    return {
      // Keep the name as as the row ID as DataGrid requires it
      name: name,

      // The model name and the logs
      metadata: {
        name: name,
        l: hasL ? record["l"]["job_id"] : undefined,
        r: hasR ? record["r"]["job_id"] : undefined,
      },

      // Token per second
      token_per_sec: {
        l: hasL
          ? {
              actual: record["l"]["token_per_sec[actual]"],
              target: record["l"]["token_per_sec[target]"],
            }
          : {
              actual: 0,
              target: 0,
            },
        r: hasR
          ? {
              actual: record["r"]["token_per_sec[actual]"],
              target: record["r"]["token_per_sec[target]"],
            }
          : {
              actual: 0,
              target: 0,
            },
      },

      // Memory bandwidth
      memory_bandwidth: {
        l: hasL
          ? {
              actual: record["l"]["memory_bandwidth[actual]"],
              target: record["l"]["memory_bandwidth[target]"],
            }
          : {
              actual: 0,
              target: 0,
            },
        r: hasR
          ? {
              actual: record["r"]["memory_bandwidth[actual]"],
              target: record["r"]["memory_bandwidth[target]"],
            }
          : {
              actual: 0,
              target: 0,
            },
      },
    };
  });

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
                if (name === undefined) {
                  return `Invalid model name ${name}`;
                }

                const encodedName = encodeURIComponent(name);
                const url = `/benchmark/llms?startTime=${startTime}&stopTime=${stopTime}&granularity=${granularity}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}&quantization=${quantization}&modelName=${encodedName}`;

                return (
                  <a href={url}>
                    <b>
                      {name} ({quantization})
                    </b>
                  </a>
                );
              },
            },
            {
              field: "token_per_sec",
              headerName: "Token per second",
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
                const lPercent = Number((l * 100) / target).toFixed(0);
                const rPercent = Number((r * 100) / target).toFixed(0);

                if (lCommit === rCommit || l === r || v.l === 0) {
                  return `${r} (${rPercent}%) [target = ${target}]`;
                } else {
                  return `${l} (${lPercent}%) → ${r} (${rPercent}%) [target = ${target}]`;
                }
              },
            },
            {
              field: "memory_bandwidth",
              headerName: "Memory bandwidth (GB/s)",
              flex: 1,
              cellClassName: (params: GridCellParams<any>) => {
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
                const lPercent = Number((l * 100) / target).toFixed(0);
                const rPercent = Number((r * 100) / target).toFixed(0);

                if (lCommit === rCommit || l === r || v.l === 0) {
                  return `${r} (${rPercent}%) [target = ${target}]`;
                } else {
                  return `${l} (${lPercent}%) → ${r} (${rPercent}%) [target = ${v.r.target}]`;
                }
              },
            },
          ]}
          dataGridProps={{ getRowId: (el: any) => el.name }}
        />
      </Grid>
    </Grid>
  );
}
