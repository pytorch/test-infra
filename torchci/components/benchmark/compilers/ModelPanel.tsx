import { Grid2 } from "@mui/material";
import { GridCellParams, GridRenderCellParams } from "@mui/x-data-grid";
import { LOG_PREFIX, SHA_DISPLAY_LENGTH } from "components/benchmark/common";
import {
  BranchAndCommitPerfData,
  COMPRESSION_RATIO_THRESHOLD,
  DIFF_HEADER,
  PASSING_ACCURACY,
  PEAK_MEMORY_USAGE_RELATIVE_THRESHOLD,
  RELATIVE_THRESHOLD,
  SPEEDUP_THRESHOLD,
} from "components/benchmark/compilers/common";
import styles from "components/metrics.module.css";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { CompilerPerformanceData } from "lib/types";

const ROW_GAP = 30;
const ROW_HEIGHT = 48;
const MIN_ENTRIES = 10;

// The number of digit after decimal to display on the detail page
const SCALE = 4;

// Headers
const ACCURACY_HEADER = "Accuracy";
const SPEEDUP_HEADER = `Perf. speedup (threshold = ${SPEEDUP_THRESHOLD}x)`;
const ABS_LATENCY_HEADER = `Abs. execution time (millisecond)`;
const COMPILATION_LATENCY_HEADER = `Compilation latency (seconds)`;
const MEMORY_HEADER = `Peak mem compress ratio (threshold = ${COMPRESSION_RATIO_THRESHOLD}x)`;
const PEAK_MEMORY_USAGE_HEADER = `Peak dynamo mem usage (GB)`;

export function ModelPanel({
  dashboard,
  startTime,
  stopTime,
  granularity,
  suite,
  mode,
  dtype,
  deviceName,
  compiler,
  model,
  lPerfData,
  rPerfData,
}: {
  dashboard: string;
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  granularity: Granularity;
  suite: string;
  mode: string;
  dtype: string;
  deviceName: string;
  compiler: string;
  model: string;
  lPerfData: BranchAndCommitPerfData;
  rPerfData: BranchAndCommitPerfData;
}) {
  const lBranch = lPerfData.branch;
  const lCommit = lPerfData.commit;
  const lData = lPerfData.data;
  const rBranch = rPerfData.branch;
  const rCommit = rPerfData.commit;
  const rData = rPerfData.data;

  const dataGroupedByModel: { [k: string]: any } = {};
  lData.forEach((record: CompilerPerformanceData) => {
    dataGroupedByModel[record.name] = {
      l: record,
    };
  });

  // Combine with right data
  if (lCommit !== rCommit && rData !== undefined) {
    rData.forEach((record: CompilerPerformanceData) => {
      if (record.name in dataGroupedByModel) {
        dataGroupedByModel[record.name]["r"] = record;
      } else {
        dataGroupedByModel[record.name] = {
          r: record,
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

      // Accuracy
      accuracy: {
        l: hasL ? record["l"]["accuracy"] : undefined,
        r: hasR ? record["r"]["accuracy"] : undefined,
      },

      // Speedup
      speedup: {
        l: hasL ? record["l"]["speedup"] : 0,
        r: hasR ? record["r"]["speedup"] : 0,
      },

      // Compilation latency
      compilation_latency: {
        l: hasL ? record["l"]["compilation_latency"] : 0,
        r: hasR ? record["r"]["compilation_latency"] : 0,
      },

      // Compression ratio
      compression_ratio: {
        l: hasL ? record["l"]["compression_ratio"] : 0,
        r: hasR ? record["r"]["compression_ratio"] : 0,
      },

      // Peak memory usage
      dynamo_peak_mem: {
        l: hasL ? record["l"]["dynamo_peak_mem"] : 0,
        r: hasR ? record["r"]["dynamo_peak_mem"] : 0,
      },

      // Absolute execution time
      abs_latency: {
        l: hasL ? record["l"]["abs_latency"] : 0,
        r: hasR ? record["r"]["abs_latency"] : 0,
      },
    };
  });

  const minEntries = data.length > MIN_ENTRIES ? data.length : MIN_ENTRIES;
  return (
    <Grid2 container spacing={2} style={{ height: "100%" }}>
      <Grid2
        size={{ xs: 12, lg: 12 }}
        height={minEntries * ROW_HEIGHT + ROW_GAP}
      >
        <TablePanelWithData
          title={"Models"}
          data={data}
          columns={[
            {
              field: "metadata",
              headerName: "Name",
              flex: 1,
              cellClassName: (params: GridCellParams<any, any>) => {
                const name = params.value.name;
                if (name === undefined) {
                  return "";
                }

                return model !== undefined && name === model
                  ? styles.selectedRow
                  : "";
              },
              renderCell: (params: GridRenderCellParams<any>) => {
                const name = params.value.name;
                if (name === undefined) {
                  return `Invalid model name ${name}`;
                }

                const lLog =
                  params.value.l !== undefined
                    ? `${LOG_PREFIX}/${params.value.l}`
                    : undefined;
                const rLog =
                  params.value.r !== undefined
                    ? `${LOG_PREFIX}/${params.value.r}`
                    : undefined;

                const encodedName = encodeURIComponent(name);
                const url = `/benchmark/${suite}/${compiler}?dashboard=${dashboard}&startTime=${startTime}&stopTime=${stopTime}&granularity=${granularity}&mode=${mode}&model=${encodedName}&dtype=${dtype}&deviceName=${encodeURIComponent(
                  deviceName
                )}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}`;

                if (lLog === undefined) {
                  return (
                    <a href={url}>
                      <b>{name}</b>
                    </a>
                  );
                } else if (lLog === rLog) {
                  return (
                    <>
                      <a href={url}>
                        <b>{name}</b>
                      </a>
                      &nbsp;(
                      <a target="_blank" rel="noreferrer" href={lLog}>
                        <u>{lCommit.substr(0, SHA_DISPLAY_LENGTH)}</u>
                      </a>
                      )
                    </>
                  );
                }

                return (
                  <>
                    <a href={url}>
                      <b>{name}</b>
                    </a>
                    &nbsp;(
                    <a target="_blank" rel="noreferrer" href={rLog}>
                      <u>{rCommit.substr(0, SHA_DISPLAY_LENGTH)}</u>
                    </a>{" "}
                    →{" "}
                    <a target="_blank" rel="noreferrer" href={lLog}>
                      <u>{lCommit.substr(0, SHA_DISPLAY_LENGTH)}</u>
                    </a>
                    )
                  </>
                );
              },
            },
            {
              field: "accuracy",
              headerName:
                lCommit === rCommit
                  ? ACCURACY_HEADER
                  : `${ACCURACY_HEADER}: ${DIFF_HEADER}`,
              flex: 1,
              cellClassName: (params: GridCellParams<any, any>) => {
                const v = params.value;
                if (v === undefined || v.r == undefined) {
                  return "";
                }

                if (lCommit === rCommit) {
                  return PASSING_ACCURACY.includes(v.l) ? "" : styles.warning;
                } else {
                  if (
                    PASSING_ACCURACY.includes(v.l) &&
                    !PASSING_ACCURACY.includes(v.r)
                  ) {
                    return styles.ok;
                  }

                  if (
                    !PASSING_ACCURACY.includes(v.l) &&
                    PASSING_ACCURACY.includes(v.r)
                  ) {
                    return styles.error;
                  }

                  if (v.l === v.r) {
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

                if (v.r === undefined) {
                  return (
                    <>
                      {v.l} (<strong>NEW!</strong>)
                    </>
                  );
                } else if (lCommit === rCommit || v.l === v.r) {
                  return v.l;
                } else {
                  return `${v.r} → ${v.l}`;
                }
              },
            },
            {
              field: "speedup",
              headerName: SPEEDUP_HEADER,
              flex: 1,
              cellClassName: (params: GridCellParams<any, any>) => {
                const v = params.value;
                if (v === undefined || v.r === 0) {
                  return "";
                }

                const l = Number(v.l);
                const r = Number(v.r);

                if (lCommit === rCommit) {
                  return l >= SPEEDUP_THRESHOLD ? "" : styles.warning;
                } else {
                  // l is the new value, r is the old value

                  if (l === r) {
                    // 0 means the model isn't run at all
                    return "";
                  }

                  // It didn't error in the past, but now it does error
                  if (l === 0) {
                    return styles.error;
                  }

                  // Increasing more than x%
                  if (l - r > RELATIVE_THRESHOLD * r) {
                    return styles.ok;
                  }

                  // Decreasing more than x%
                  if (r - l > RELATIVE_THRESHOLD * r) {
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

                const l = Number(v.l).toFixed(SCALE);
                const r = Number(v.r).toFixed(SCALE);

                if (lCommit === rCommit || l === r || v.r === 0) {
                  return l;
                } else {
                  return `${r} → ${l}`;
                }
              },
            },
            {
              field: "compilation_latency",
              headerName: COMPILATION_LATENCY_HEADER,
              flex: 1,
              cellClassName: (params: GridCellParams<any, any>) => {
                const v = params.value;
                if (v === undefined || v.r === 0) {
                  return "";
                }

                const l = Number(v.l);
                const r = Number(v.r);

                if (lCommit === rCommit) {
                  return "";
                } else {
                  if (l === 0 || l === r) {
                    // 0 means the model isn't run at all
                    return "";
                  }

                  // Decreasing more than x%
                  if (r - l > RELATIVE_THRESHOLD * r) {
                    return styles.ok;
                  }

                  // Increasing more than x%
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

                const l = Number(v.l).toFixed(0);
                const r = Number(v.r).toFixed(0);

                if (lCommit === rCommit || l === r || v.r === 0) {
                  return l;
                } else {
                  return `${r} → ${l}`;
                }
              },
            },
            {
              field: "compression_ratio",
              headerName: MEMORY_HEADER,
              flex: 1,
              cellClassName: (params: GridCellParams<any, any>) => {
                const v = params.value;
                if (v === undefined || v.r === 0) {
                  return "";
                }

                const l = Number(v.l);
                const r = Number(v.r);

                if (lCommit === rCommit) {
                  return l >= COMPRESSION_RATIO_THRESHOLD ? "" : styles.warning;
                } else {
                  if (l === 0 || l === r) {
                    // 0 means the model isn't run at all
                    return "";
                  }

                  // Increasing more than x%
                  if (l - r > RELATIVE_THRESHOLD * r) {
                    return styles.ok;
                  }

                  // Decreasing more than x%
                  if (r - l > RELATIVE_THRESHOLD * r) {
                    return styles.error;
                  }

                  if (l < COMPRESSION_RATIO_THRESHOLD) {
                    return styles.warning;
                  }
                }

                return "";
              },
              renderCell: (params: GridRenderCellParams<any>) => {
                const v = params.value;
                if (v === undefined) {
                  return "";
                }

                const l = Number(v.l).toFixed(SCALE);
                const r = Number(v.r).toFixed(SCALE);

                if (lCommit === rCommit || l === r || v.r === 0) {
                  return l;
                } else {
                  return `${r} → ${l}`;
                }
              },
            },
            {
              field: "abs_latency",
              headerName: ABS_LATENCY_HEADER,
              flex: 1,
              cellClassName: (params: GridCellParams<any, any>) => {
                const v = params.value;
                if (v === undefined || v.r === 0) {
                  return "";
                }

                const l = Number(v.l);
                const r = Number(v.r);

                if (lCommit === rCommit) {
                  return "";
                } else {
                  if (l === 0 || l === r) {
                    // 0 means the model isn't run at all
                    return "";
                  }

                  // Decreasing more than x%
                  if (r - l > RELATIVE_THRESHOLD * r) {
                    return styles.ok;
                  }

                  // Increasing more than x%
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

                const l = Number(v.l).toFixed(SCALE);
                const r = Number(v.r).toFixed(SCALE);

                if (lCommit === rCommit || l === r || v.r === 0) {
                  return l;
                } else {
                  return `${r} → ${l}`;
                }
              },
            },
            {
              field: "dynamo_peak_mem",
              headerName: PEAK_MEMORY_USAGE_HEADER,
              flex: 1,
              cellClassName: (params: GridCellParams<any, any>) => {
                const v = params.value;
                if (v === undefined || v.r === 0) {
                  return "";
                }

                const l = Number(v.l);
                const r = Number(v.r);

                if (lCommit === rCommit) {
                  return "";
                } else {
                  if (l === 0 || l === r) {
                    // 0 means the model isn't run at all
                    return "";
                  }

                  // Decreasing more than x%
                  if (r - l > PEAK_MEMORY_USAGE_RELATIVE_THRESHOLD * r) {
                    return styles.ok;
                  }

                  // Increasing more than x%
                  if (l - r > PEAK_MEMORY_USAGE_RELATIVE_THRESHOLD * r) {
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

                const l = Number(v.l).toFixed(2);
                const r = Number(v.r).toFixed(2);

                if (lCommit === rCommit || l === r || v.r === 0) {
                  return l;
                } else {
                  return `${r} → ${l}`;
                }
              },
            },
          ]}
          dataGridProps={{ getRowId: (el: any) => el.name }}
        />
      </Grid2>
    </Grid2>
  );
}
