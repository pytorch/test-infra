import { Grid2 } from "@mui/material";
import { GridCellParams, GridRenderCellParams } from "@mui/x-data-grid";
import {
  ACCURACY_THRESHOLD,
  BranchAndCommitPerfData,
  COMPRESSION_RATIO_THRESHOLD,
  DIFF_HEADER,
  DISPLAY_NAMES_TO_COMPILER_NAMES,
  HELP_LINK,
  RELATIVE_THRESHOLD,
  SCALE,
  SPEEDUP_THRESHOLD,
} from "components/benchmark/compilers/common";
import styles from "components/metrics.module.css";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import {
  computeCompilationTime,
  computeGeomean,
  computeMemoryCompressionRatio,
  computePassrate,
  computePeakMemoryUsage,
  getPassingModels,
} from "lib/benchmark/compilerUtils";
import { CompilerPerformanceData } from "lib/types";

const ROW_GAP = 100;
const ROW_HEIGHT = 38;
const PASSRATE_DISPLAY_NAME_REGEX = new RegExp("^([0-9]+)%,\\s.+$");
const PASSRATE_HEADER = `Passrate (threshold = ${ACCURACY_THRESHOLD}%)`;
const GEOMEAN_HEADER = `Geometric mean speedup (threshold = ${SPEEDUP_THRESHOLD}x)`;
const COMPILATION_LATENCY_HEADER = `Mean compilation time (seconds)`;
const MEMORY_HEADER = `Peak memory footprint compression ratio (threshold = ${COMPRESSION_RATIO_THRESHOLD}x)`;

function groupRecords(data: CompilerPerformanceData[], fieldName: string) {
  const records: { [k: string]: any } = {};

  data.forEach((r: any) => {
    const compiler = r.compiler;
    const suite = r.suite;

    if (!(compiler in records)) {
      records[compiler] = {
        compiler: compiler,
      };
    }

    records[compiler][suite] = r[fieldName];
  });

  return records;
}

function processSummaryData(
  data: CompilerPerformanceData[],
  fields: { [k: string]: any }
) {
  // Compute the metrics for the passing models
  const models = getPassingModels(data);
  return Object.keys(fields).map((n: string) =>
    groupRecords(fields[n](data, models), n)
  );
}

function combineLeftAndRight(
  lCommit: string,
  lData: { [k: string]: any },
  rCommit: string,
  rData: { [k: string]: any },
  suites: string[]
) {
  const data: { [k: string]: any } = {};
  Object.keys(lData).forEach((compiler: string) => {
    data[compiler] = {
      compiler: compiler,
    };
    suites.forEach((suite: string) => {
      data[compiler][suite] = {
        l: lData[compiler][suite],
        r: "",
      };
    });
  });

  // Combine with right data
  if (lCommit !== rCommit) {
    Object.keys(rData).forEach((compiler: string) => {
      if (!(compiler in data)) {
        data[compiler] = {
          compiler: compiler,
        };
        suites.forEach((suite: string) => {
          data[compiler][suite] = {
            l: "",
            r: rData[compiler][suite],
          };
        });
        return;
      }

      suites.forEach((suite: string) => {
        if (!(suite in data[compiler])) {
          data[compiler][suite] = {
            l: "",
          };
        }

        data[compiler][suite]["r"] = rData[compiler][suite];
      });
    });
  }

  return data;
}

function extractPercentage(value: string) {
  if (value === undefined) {
    return;
  }

  const m = value.match(PASSRATE_DISPLAY_NAME_REGEX);
  if (m === null) {
    return;
  }

  return Number(m[1]);
}

export function SummaryPanel({
  dashboard,
  startTime,
  stopTime,
  granularity,
  mode,
  dtype,
  deviceName,
  lPerfData,
  rPerfData,
  all_suites,
}: {
  dashboard: string;
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  granularity: Granularity;
  mode: string;
  dtype: string;
  deviceName: string;
  lPerfData: BranchAndCommitPerfData;
  rPerfData: BranchAndCommitPerfData;
  all_suites: { [key: string]: string };
}) {
  const fields: { [k: string]: any } = {
    passrate_display: computePassrate,
    geomean: computeGeomean,
    compilation_latency: computeCompilationTime,
    compression_ratio: computeMemoryCompressionRatio,
    dynamo_peak_mem: computePeakMemoryUsage,
  };
  // The left
  const lBranch = lPerfData.branch;
  const lCommit = lPerfData.commit;
  const [lPassrate, lGeomean, lCompTime, lMemory] = processSummaryData(
    lPerfData.data,
    fields
  );
  // and the right
  const rBranch = rPerfData.branch;
  const rCommit = rPerfData.commit;
  const [rPassrate, rGeomean, rCompTime, rMemory] = processSummaryData(
    rPerfData.data,
    fields
  );

  const suites = Object.keys(all_suites);

  // Combine both sides
  const passrate = combineLeftAndRight(
    lCommit,
    lPassrate,
    rCommit,
    rPassrate,
    suites
  );
  const geomean = combineLeftAndRight(
    lCommit,
    lGeomean,
    rCommit,
    rGeomean,
    suites
  );
  const compTime = combineLeftAndRight(
    lCommit,
    lCompTime,
    rCommit,
    rCompTime,
    suites
  );
  const memory = combineLeftAndRight(
    lCommit,
    lMemory,
    rCommit,
    rMemory,
    suites
  );

  const columns = [
    {
      field: "compiler",
      headerName: "Inductor config",
      flex: 1,
    },
  ];

  return (
    <div>
      <Grid2 container spacing={2} style={{ height: "100%" }}>
        <Grid2
          size={{ xs: 12, lg: 6 }}
          height={ROW_HEIGHT * Object.keys(passrate).length + ROW_GAP}
        >
          <TablePanelWithData
            title={
              lCommit === rCommit
                ? PASSRATE_HEADER
                : `${PASSRATE_HEADER} ${DIFF_HEADER}`
            }
            helpLink={HELP_LINK}
            data={Object.values(passrate).sort((a: any, b: any) =>
              a["compiler"].localeCompare(b["compiler"])
            )}
            columns={columns.concat(
              suites.map((suite: string) => {
                return {
                  field: suite,
                  headerName: all_suites[suite],
                  flex: 1,
                  renderCell: (params: GridRenderCellParams<any>) => {
                    const v = params.value;
                    if (v === undefined) {
                      return "";
                    }

                    const url = `/benchmark/${suite}/${
                      DISPLAY_NAMES_TO_COMPILER_NAMES[params.row.compiler] ??
                      params.row.compiler
                    }?dashboard=${dashboard}&startTime=${startTime}&stopTime=${stopTime}&granularity=${granularity}&mode=${mode}&dtype=${dtype}&deviceName=${encodeURIComponent(
                      deviceName
                    )}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}`;

                    const l = extractPercentage(v.l);
                    const r = extractPercentage(v.r);

                    if (l === undefined) {
                      return "";
                    }

                    if (lCommit === rCommit || l === r || r == undefined) {
                      return <a href={url}>{v.l}</a>;
                    } else {
                      return (
                        <a href={url}>
                          {v.r} → {v.l}
                        </a>
                      );
                    }
                  },
                  cellClassName: (params: GridCellParams<any, any>) => {
                    const v = params.value;
                    if (v === undefined) {
                      return "";
                    }

                    const l = extractPercentage(v.l);
                    const r = extractPercentage(v.r);

                    if (l === undefined) {
                      return "";
                    }

                    if (lCommit === rCommit || r === undefined) {
                      return l >= ACCURACY_THRESHOLD ? "" : styles.warning;
                    } else {
                      if (l === r) {
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

                      if (l < ACCURACY_THRESHOLD) {
                        return styles.warning;
                      }
                    }

                    return "";
                  },
                };
              })
            )}
            dataGridProps={{ getRowId: (el: any) => el.suite + el.compiler }}
          />
        </Grid2>

        <Grid2
          size={{ xs: 12, lg: 6 }}
          height={ROW_HEIGHT * Object.keys(geomean).length + ROW_GAP}
        >
          <TablePanelWithData
            title={GEOMEAN_HEADER}
            helpLink={HELP_LINK}
            data={Object.values(geomean).sort((a: any, b: any) =>
              a["compiler"].localeCompare(b["compiler"])
            )}
            columns={columns.concat(
              suites.map((suite: string) => {
                return {
                  field: suite,
                  headerName: all_suites[suite],
                  flex: 1,
                  renderCell: (params: GridRenderCellParams<any>) => {
                    const v = params.value;
                    if (v === undefined || v.l === undefined || v.l === "") {
                      return "";
                    }

                    const url = `/benchmark/${suite}/${
                      DISPLAY_NAMES_TO_COMPILER_NAMES[params.row.compiler] ??
                      params.row.compiler
                    }?dashboard=${dashboard}&startTime=${startTime}&stopTime=${stopTime}&granularity=${granularity}&mode=${mode}&dtype=${dtype}&deviceName=${encodeURIComponent(
                      deviceName
                    )}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}`;

                    const l = Number(v.l).toFixed(SCALE);
                    const r = Number(v.r).toFixed(SCALE);

                    if (
                      lCommit === rCommit ||
                      l === r ||
                      v.r === undefined ||
                      v.r === ""
                    ) {
                      return <a href={url}>{l}x</a>;
                    } else {
                      return (
                        <a href={url}>
                          {r}x → {l}x
                        </a>
                      );
                    }
                  },
                  cellClassName: (params: GridCellParams<any, any>) => {
                    const v = params.value;
                    if (
                      v === undefined ||
                      v.l === undefined ||
                      v.l === "" ||
                      v.r === undefined ||
                      v.r === ""
                    ) {
                      return "";
                    }

                    const l = Number(v.l);
                    const r = Number(v.r);

                    if (lCommit === rCommit) {
                      return l >= SPEEDUP_THRESHOLD ? "" : styles.warning;
                    } else {
                      if (l === r) {
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

                      if (l < SPEEDUP_THRESHOLD) {
                        return styles.warning;
                      }
                    }

                    return "";
                  },
                };
              })
            )}
            dataGridProps={{ getRowId: (el: any) => el.suite + el.compiler }}
          />
        </Grid2>

        <Grid2
          size={{ xs: 12, lg: 6 }}
          height={ROW_HEIGHT * Object.keys(compTime).length + ROW_GAP}
        >
          <TablePanelWithData
            title={COMPILATION_LATENCY_HEADER}
            helpLink={HELP_LINK}
            data={Object.values(compTime).sort((a: any, b: any) =>
              a["compiler"].localeCompare(b["compiler"])
            )}
            columns={columns.concat(
              suites.map((suite: string) => {
                return {
                  field: suite,
                  headerName: all_suites[suite],
                  flex: 1,
                  renderCell: (params: GridRenderCellParams<any>) => {
                    const v = params.value;
                    if (v === undefined || v.l === undefined || v.l === "") {
                      return "";
                    }

                    const url = `/benchmark/${suite}/${
                      DISPLAY_NAMES_TO_COMPILER_NAMES[params.row.compiler] ??
                      params.row.compiler
                    }?dashboard=${dashboard}&startTime=${startTime}&stopTime=${stopTime}&granularity=${granularity}&mode=${mode}&dtype=${dtype}&deviceName=${encodeURIComponent(
                      deviceName
                    )}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}`;

                    const l = Number(v.l).toFixed(0);
                    const r = Number(v.r).toFixed(0);

                    if (
                      lCommit === rCommit ||
                      l === r ||
                      v.r === undefined ||
                      v.r === ""
                    ) {
                      return <a href={url}>{l}s</a>;
                    } else {
                      return (
                        <a href={url}>
                          {r}s → {l}s
                        </a>
                      );
                    }
                  },
                  cellClassName: (params: GridCellParams<any, any>) => {
                    const v = params.value;
                    if (
                      v === undefined ||
                      v.l === undefined ||
                      v.l === "" ||
                      v.r === undefined ||
                      v.r === ""
                    ) {
                      return "";
                    }

                    const l = Number(v.l);
                    const r = Number(v.r);

                    if (lCommit === rCommit) {
                      return "";
                    } else {
                      if (l === r) {
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
                };
              })
            )}
            dataGridProps={{ getRowId: (el: any) => el.suite + el.compiler }}
          />
        </Grid2>

        <Grid2
          size={{ xs: 12, lg: 6 }}
          height={ROW_HEIGHT * Object.keys(memory).length + ROW_GAP}
        >
          <TablePanelWithData
            title={MEMORY_HEADER}
            helpLink={HELP_LINK}
            data={Object.values(memory).sort((a: any, b: any) =>
              a["compiler"].localeCompare(b["compiler"])
            )}
            columns={columns.concat(
              suites.map((suite: string) => {
                return {
                  field: suite,
                  headerName: all_suites[suite],
                  flex: 1,
                  renderCell: (params: GridRenderCellParams<any>) => {
                    const v = params.value;
                    if (v === undefined || v.l === undefined || v.l === "") {
                      return "";
                    }

                    const url = `/benchmark/${suite}/${
                      DISPLAY_NAMES_TO_COMPILER_NAMES[params.row.compiler] ??
                      params.row.compiler
                    }?dashboard=${dashboard}&startTime=${startTime}&stopTime=${stopTime}&granularity=${granularity}&mode=${mode}&dtype=${dtype}&deviceName=${encodeURIComponent(
                      deviceName
                    )}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}`;

                    const l = Number(v.l).toFixed(SCALE);
                    const r = Number(v.r).toFixed(SCALE);

                    if (
                      lCommit === rCommit ||
                      l === r ||
                      v.r === undefined ||
                      v.r === ""
                    ) {
                      return <a href={url}>{l}x</a>;
                    } else {
                      return (
                        <a href={url}>
                          {r}x → {l}x
                        </a>
                      );
                    }
                  },
                  cellClassName: (params: GridCellParams<any, any>) => {
                    const v = params.value;
                    if (
                      v === undefined ||
                      v.l === undefined ||
                      v.l === "" ||
                      v.r === undefined ||
                      v.r === ""
                    ) {
                      return "";
                    }

                    const l = Number(v.l);
                    const r = Number(v.r);

                    if (lCommit === rCommit) {
                      return l >= COMPRESSION_RATIO_THRESHOLD
                        ? ""
                        : styles.warning;
                    } else {
                      if (l === r) {
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
                };
              })
            )}
            dataGridProps={{ getRowId: (el: any) => el.suite + el.compiler }}
          />
        </Grid2>
      </Grid2>
    </div>
  );
}
