import { Grid } from "@mui/material";
import { GridCellParams, GridRenderCellParams } from "@mui/x-data-grid";
import {
  BranchAndCommitPerfData,
  LLMsBenchmarkData,
  METRIC_DISPLAY_HEADERS,
  RELATIVE_THRESHOLD,
} from "components/benchmark/llms/common";
import styles from "components/metrics.module.css";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";

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

  const dataGroupedByModel: { [k: string]: any } = {};
  rData.forEach((record: LLMsBenchmarkData) => {
    if (!(record.name in dataGroupedByModel)) {
      dataGroupedByModel[record.name] = {};
    }

    dataGroupedByModel[record.name][record.metric] = {
      r: record,
    };
  });

  // Combine with left (base) data
  if (lCommit !== rCommit && lData !== undefined) {
    lData.forEach((record: LLMsBenchmarkData) => {
      if (!(record.name in dataGroupedByModel)) {
        dataGroupedByModel[record.name] = {};
      }

      if (!(record.metric in dataGroupedByModel[record.name])) {
        dataGroupedByModel[record.name][record.metric] = {};
      }

      dataGroupedByModel[record.name][record.metric]["l"] = record;
    });
  }

  // Transform the data into a displayable format
  const data = Object.keys(dataGroupedByModel).map((name: string) => {
    const row: { [k: string]: any } = {
      // Keep the name as as the row ID as DataGrid requires it
      name: name,
    };

    for (const metric in dataGroupedByModel[name]) {
      const record = dataGroupedByModel[name][metric];
      const hasL = "l" in record;
      const hasR = "r" in record;

      row["metadata"] = {
        name: name,
        l: hasL ? record["l"]["job_id"] : undefined,
        r: hasR ? record["r"]["job_id"] : undefined,
      };

      row[metric] = {
        l: hasL
          ? {
              actual: record["l"].actual,
              target: record["l"].target,
            }
          : {
              actual: 0,
              target: 0,
            },
        r: hasR
          ? {
              actual: record["r"].actual,
              target: record["r"].target,
            }
          : {
              actual: 0,
              target: 0,
            },
      };
    }

    return row;
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
                const url = `/benchmark/llms?startTime=${startTime}&stopTime=${stopTime}&granularity=${granularity}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}&modelName=${encodedName}`;

                return (
                  <a href={url}>
                    <b>{name}</b>
                  </a>
                );
              },
            },
            ...metricNames
              .filter(
                (metric: string) => data.length !== 0 && metric in data[0]
              )
              .map((metric: string) => {
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
                    const lPercent = Number((l * 100) / target).toFixed(0);
                    const rPercent = Number((r * 100) / target).toFixed(0);

                    if (lCommit === rCommit || l === r || v.l === 0) {
                      return `${r} (${rPercent}%) [target = ${target}]`;
                    } else {
                      return `${l} (${lPercent}%) → ${r} (${rPercent}%) [target = ${target}]`;
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
