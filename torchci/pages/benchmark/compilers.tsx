import dayjs, { Dayjs } from "dayjs";
import ReactECharts from "echarts-for-react";
import { EChartsOption } from "echarts";
import useSWR from "swr";
import _ from "lodash";
import {
  Grid,
  Paper,
  Skeleton,
  Stack,
  Typography,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  SelectChangeEvent,
} from "@mui/material";
import {
  GridValueFormatterParams,
  GridCellParams,
  GridRenderCellParams,
} from "@mui/x-data-grid";
import React from "react";
import { useState, useEffect } from "react";
import { RocksetParam } from "lib/rockset";
import { fetcher } from "lib/GeneralUtils";
import {
  Granularity,
  TimeSeriesPanelWithData,
  seriesWithInterpolatedTimes,
} from "components/metrics/panels/TimeSeriesPanel";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import GranularityPicker from "components/GranularityPicker";
import { TimeRangePicker } from "../metrics";
import { CompilerPerformanceData } from "lib/types";
import styles from "components/metrics.module.css";

const LAST_WEEK = 7;
const ROW_HEIGHT = 245;
const ROW_GAP = 30;
const HUD_PREFIX = "/pytorch/pytorch/commit";
const TIME_FIELD_NAME = "granularity_bucket";

// After https://github.com/pytorch/pytorch/pull/96986, there is no perf data
// for eager and aot_eager because they are not run anymore (not needed)
export const COMPILER_NAMES_TO_DISPLAY_NAMES: { [k: string]: string } = {
  inductor: "inductor_with_cudagraphs",
  inductor_no_cudagraphs: "inductor_default",
};
export const DISPLAY_NAMES_TO_COMPILER_NAMES: { [k: string]: string } = {
  inductor_default: "inductor_no_cudagraphs",
};
export const BLOCKLIST_COMPILERS = ["aot_eager", "eager"];
export const SUITES: { [k: string]: string } = {
  torchbench: "Torchbench",
  huggingface: "Huggingface",
  timm_models: "TIMM models",
};
const PASSRATE_DISPLAY_NAME_REGEX = new RegExp("^([0-9]+)%,\\s.+$");

const ACCURACY_THRESHOLD = 90.0;
const SPEEDUP_THRESHOLD = 0.95;
const COMPILATION_lATENCY_THRESHOLD_IN_SECONDS = 120;
const COMPRESSION_RATIO_THRESHOLD = 0.9;

function getPassModels(data: any) {
  const passModels: { [k: string]: any } = {};

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const model = record.name;
    const accuracy = record.accuracy;

    // Use clear compiler name to avoid confusion about what they do
    const compiler =
      COMPILER_NAMES_TO_DISPLAY_NAMES[record.compiler] ?? record.compiler;
    if (BLOCKLIST_COMPILERS.includes(compiler)) {
      return;
    }

    if (!(bucket in passModels)) {
      passModels[bucket] = {};
    }

    if (!(workflowId in passModels[bucket])) {
      passModels[bucket][workflowId] = {};
    }

    if (!(suite in passModels[bucket][workflowId])) {
      passModels[bucket][workflowId][suite] = {};
    }

    if (!(compiler in passModels[bucket][workflowId][suite])) {
      passModels[bucket][workflowId][suite][compiler] = new Set<string>();
    }

    if (accuracy === "pass" || accuracy === "pass_due_to_skip") {
      passModels[bucket][workflowId][suite][compiler].add(model);
    }
  });

  return passModels;
}

function isPass(
  bucket: string,
  workflowId: number,
  suite: string,
  compiler: string,
  model: string,
  passModels: { [k: string]: any }
) {
  return passModels[bucket][workflowId][suite][compiler].has(model);
}

function computePassrate(data: any, passModels: { [k: string]: any }) {
  const totalCount: { [k: string]: any } = {};
  const passCount: { [k: string]: any } = {};
  const headByBucket: { [k: string]: any } = {};

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const model = record.name;
    const sha = record.head_sha;
    const head = record.head_branch;

    // Use clear compiler name to avoid confusion about what they do
    const compiler =
      COMPILER_NAMES_TO_DISPLAY_NAMES[record.compiler] ?? record.compiler;
    if (BLOCKLIST_COMPILERS.includes(compiler)) {
      return;
    }

    if (!(bucket in totalCount)) {
      totalCount[bucket] = {};
      passCount[bucket] = {};
      headByBucket[bucket] = {};
    }

    if (!(workflowId in totalCount[bucket])) {
      totalCount[bucket][workflowId] = {};
      passCount[bucket][workflowId] = {};
      headByBucket[bucket][workflowId] = {};
    }

    if (!(suite in totalCount[bucket][workflowId])) {
      totalCount[bucket][workflowId][suite] = {};
      passCount[bucket][workflowId][suite] = {};
      headByBucket[bucket][workflowId][suite] = {};
    }

    if (!(compiler in totalCount[bucket][workflowId][suite])) {
      totalCount[bucket][workflowId][suite][compiler] = 0;
      passCount[bucket][workflowId][suite][compiler] = 0;
    }

    if (isPass(bucket, workflowId, suite, compiler, model, passModels)) {
      passCount[bucket][workflowId][suite][compiler] += 1;
    }

    totalCount[bucket][workflowId][suite][compiler] += 1;
    headByBucket[bucket][workflowId][suite][compiler] = [sha, head];
  });

  const passrateBySuite: { [k: string]: any } = {};

  Object.keys(totalCount).forEach((bucket: string) => {
    Object.keys(totalCount[bucket]).forEach((workflowId: string) => {
      Object.keys(totalCount[bucket][workflowId]).forEach((suite: string) => {
        Object.keys(totalCount[bucket][workflowId][suite]).forEach(
          (compiler: string) => {
            const pc = passCount[bucket][workflowId][suite][compiler];
            const tc = totalCount[bucket][workflowId][suite][compiler];
            const p = pc / tc;

            if (!(suite in passrateBySuite)) {
              passrateBySuite[suite] = [];
            }

            passrateBySuite[suite].push({
              granularity_bucket: bucket,
              workflow_id: workflowId,
              head_sha: headByBucket[bucket][workflowId][suite][compiler][0],
              head_breanch:
                headByBucket[bucket][workflowId][suite][compiler][1],
              suite: suite,
              compiler: compiler,
              passrate: p,
              pass_count: pc,
              total_count: tc,
              passrate_display: `${(p * 100).toFixed(0)}%, ${pc}/${tc}`,
            });
          }
        );
      });
    });
  });

  return passrateBySuite;
}

function geomean(data: number[]) {
  if (data.length === 0) {
    return 0.0;
  }

  var gm = 1.0;
  data.forEach((v) => {
    gm *= v;
  });
  return Math.pow(gm, 1.0 / data.length).toFixed(2);
}

function computeGeomean(data: any, passModels: { [k: string]: any }) {
  const speedup: { [k: string]: any } = {};

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const model = record.name;

    // Use clear compiler name to avoid confusion about what they do
    const compiler =
      COMPILER_NAMES_TO_DISPLAY_NAMES[record.compiler] ?? record.compiler;
    if (BLOCKLIST_COMPILERS.includes(compiler)) {
      return;
    }

    if (!(bucket in speedup)) {
      speedup[bucket] = {};
    }

    if (!(workflowId in speedup[bucket])) {
      speedup[bucket][workflowId] = {};
    }

    if (!(suite in speedup[bucket][workflowId])) {
      speedup[bucket][workflowId][suite] = {};
    }

    if (!(compiler in speedup[bucket][workflowId][suite])) {
      speedup[bucket][workflowId][suite][compiler] = [];
    }

    if (
      isPass(bucket, workflowId, suite, compiler, model, passModels) &&
      record.speedup !== 0.0
    ) {
      speedup[bucket][workflowId][suite][compiler].push(record.speedup);
    }
  });

  const geomeanBySuite: { [k: string]: any } = {};

  Object.keys(speedup).forEach((bucket: string) => {
    Object.keys(speedup[bucket]).forEach((workflowId: string) => {
      Object.keys(speedup[bucket][workflowId]).forEach((suite: string) => {
        Object.keys(speedup[bucket][workflowId][suite]).forEach(
          (compiler: string) => {
            const gm = geomean(speedup[bucket][workflowId][suite][compiler]);

            if (!(suite in geomeanBySuite)) {
              geomeanBySuite[suite] = [];
            }

            geomeanBySuite[suite].push({
              granularity_bucket: bucket,
              workflow_id: workflowId,
              suite: suite,
              compiler: compiler,
              geomean: gm,
            });
          }
        );
      });
    });
  });

  return geomeanBySuite;
}

function computeCompilationTime(data: any, passModels: { [k: string]: any }) {
  const compTime: { [k: string]: any } = {};

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const model = record.name;
    const compLatency = record.compilation_latency;

    // Use clear compiler name to avoid confusion about what they do
    const compiler =
      COMPILER_NAMES_TO_DISPLAY_NAMES[record.compiler] ?? record.compiler;
    if (BLOCKLIST_COMPILERS.includes(compiler)) {
      return;
    }

    if (!(bucket in compTime)) {
      compTime[bucket] = {};
    }

    if (!(workflowId in compTime[bucket])) {
      compTime[bucket][workflowId] = {};
    }

    if (!(suite in compTime[bucket][workflowId])) {
      compTime[bucket][workflowId][suite] = {};
    }

    if (!(compiler in compTime[bucket][workflowId][suite])) {
      compTime[bucket][workflowId][suite][compiler] = [];
    }

    if (
      isPass(bucket, workflowId, suite, compiler, model, passModels) &&
      compLatency !== 0.0
    ) {
      compTime[bucket][workflowId][suite][compiler].push(compLatency);
    }
  });

  const compTimeBySuite: { [k: string]: any } = {};

  Object.keys(compTime).forEach((bucket: string) => {
    Object.keys(compTime[bucket]).forEach((workflowId: string) => {
      Object.keys(compTime[bucket][workflowId]).forEach((suite: string) => {
        Object.keys(compTime[bucket][workflowId][suite]).forEach(
          (compiler: string) => {
            const l = compTime[bucket][workflowId][suite][compiler].length;
            const m =
              compTime[bucket][workflowId][suite][compiler].reduce(
                (total: number, v: number) => total + v,
                0
              ) / l;

            if (!(suite in compTimeBySuite)) {
              compTimeBySuite[suite] = [];
            }

            compTimeBySuite[suite].push({
              granularity_bucket: bucket,
              workflow_id: workflowId,
              suite: suite,
              compiler: compiler,
              compilation_latency: m.toFixed(2),
            });
          }
        );
      });
    });
  });

  return compTimeBySuite;
}

function computeMemoryCompressionRatio(
  data: any,
  passModels: { [k: string]: any }
) {
  const memory: { [k: string]: any } = {};

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const model = record.name;
    const compRatio = record.compression_ratio;

    // Use clear compiler name to avoid confusion about what they do
    const compiler =
      COMPILER_NAMES_TO_DISPLAY_NAMES[record.compiler] ?? record.compiler;
    if (BLOCKLIST_COMPILERS.includes(compiler)) {
      return;
    }

    if (!(bucket in memory)) {
      memory[bucket] = {};
    }

    if (!(workflowId in memory[bucket])) {
      memory[bucket][workflowId] = {};
    }

    if (!(suite in memory[bucket][workflowId])) {
      memory[bucket][workflowId][suite] = {};
    }

    if (!(compiler in memory[bucket][workflowId][suite])) {
      memory[bucket][workflowId][suite][compiler] = [];
    }

    if (
      isPass(bucket, workflowId, suite, compiler, model, passModels) &&
      compRatio !== 0.0
    ) {
      memory[bucket][workflowId][suite][compiler].push(compRatio);
    }
  });

  const memoryBySuite: { [k: string]: any } = {};

  Object.keys(memory).forEach((bucket: string) => {
    Object.keys(memory[bucket]).forEach((workflowId: string) => {
      Object.keys(memory[bucket][workflowId]).forEach((suite: string) => {
        Object.keys(memory[bucket][workflowId][suite]).forEach(
          (compiler: string) => {
            const l = memory[bucket][workflowId][suite][compiler].length;
            const m =
              memory[bucket][workflowId][suite][compiler].reduce(
                (total: number, v: number) => total + v,
                0
              ) / l;

            if (!(suite in memoryBySuite)) {
              memoryBySuite[suite] = [];
            }

            memoryBySuite[suite].push({
              granularity_bucket: bucket,
              workflow_id: workflowId,
              suite: suite,
              compiler: compiler,
              compression_ratio: m.toFixed(2),
            });
          }
        );
      });
    });
  });

  return memoryBySuite;
}

function getLatestRecordByCompiler(
  dataBySuite: { [k: string]: any },
  dataFieldName: string
): [{ [k: string]: any }, string] {
  const fieldName = "workflow_id";
  const lastestRecordByCompiler: { [k: string]: any } = {};

  let latestId: string = "";
  let latestBucket: string = "";

  Object.keys(dataBySuite).forEach((k) => {
    const ids = dataBySuite[k].map((v: any) => v[fieldName]).sort();
    latestId = ids[ids.length - 1];

    dataBySuite[k].forEach((r: any) => {
      const compiler = r["compiler"];
      if (!(compiler in lastestRecordByCompiler)) {
        lastestRecordByCompiler[compiler] = {
          compiler: compiler,
        };
      }

      if (r[fieldName] === latestId) {
        const suite = r["suite"];
        lastestRecordByCompiler[compiler][suite] = r[dataFieldName];
        latestBucket = r.granularity_bucket;
      }
    });
  });

  return [lastestRecordByCompiler, latestBucket];
}

export function DTypePicker({
  dtypes,
  setDTypes,
}: {
  dtypes: string;
  setDTypes: any;
}) {
  function handleChange(e: SelectChangeEvent<string>) {
    setDTypes(e.target.value);
  }

  return (
    <>
      <FormControl>
        <InputLabel id="dtypes-picker-select-label">Precision</InputLabel>
        <Select
          value={dtypes}
          label="Precision"
          labelId="dtypes-picker-select-label"
          onChange={handleChange}
          id="dtypes-picker-select"
        >
          <MenuItem value={"amp"}>amp</MenuItem>
          <MenuItem value={"float32"}>float32</MenuItem>
        </Select>
      </FormControl>
    </>
  );
}

function SummaryPanel({
  passrateBySuite,
  geomeanBySuite,
  compTimeBySuite,
  memoryBySuite,
  dtypes,
}: {
  passrateBySuite: { [k: string]: any };
  geomeanBySuite: { [k: string]: any };
  compTimeBySuite: { [k: string]: any };
  memoryBySuite: { [k: string]: any };
  dtypes: string;
}) {
  const [lastestPassrateByCompiler, latestPassrateBucket] =
    getLatestRecordByCompiler(passrateBySuite, "passrate_display");
  const [lastestGeomeanByCompiler, latestGeomeanBucket] =
    getLatestRecordByCompiler(geomeanBySuite, "geomean");
  const [lastestCompTimeByCompiler, latestCompTimeBucket] =
    getLatestRecordByCompiler(compTimeBySuite, "compilation_latency");
  const [lastestMemoryByCompiler, latestMemoryBucket] =
    getLatestRecordByCompiler(memoryBySuite, "compression_ratio");

  const columns = [
    {
      field: "compiler",
      headerName: "Compiler",
      flex: 1,
    },
  ];

  return (
    <Grid container spacing={2} height={ROW_HEIGHT + ROW_GAP}>
      <Grid item xs={12} lg={3}>
        <TablePanelWithData
          title={`Passrate - ${dayjs(latestPassrateBucket).format(
            "YYYY/MM/DD"
          )} (threshold = ${ACCURACY_THRESHOLD}%)`}
          data={Object.values(lastestPassrateByCompiler).sort(
            (a: any, b: any) => a["compiler"].localeCompare(b["compiler"])
          )}
          columns={columns.concat(
            Object.keys(SUITES).map((suite: string) => {
              return {
                field: suite,
                headerName: SUITES[suite],
                flex: 1,
                renderCell: (params: GridRenderCellParams<string>) => {
                  const url = `/benchmark/${suite}/${
                    DISPLAY_NAMES_TO_COMPILER_NAMES[params.row.compiler] ??
                    params.row.compiler
                  }?dtypes=${dtypes}`;
                  return <a href={url}>{params.value}</a>;
                },
                cellClassName: (params: GridCellParams<string>) => {
                  const v = params.value;
                  if (v === undefined) {
                    return "";
                  }

                  const m = v.match(PASSRATE_DISPLAY_NAME_REGEX);
                  if (m === null) {
                    return "";
                  }

                  const p = Number(m[1]);
                  return p < ACCURACY_THRESHOLD ? styles.warning : "";
                },
              };
            })
          )}
          dataGridProps={{ getRowId: (el: any) => el.suite + el.compiler }}
        />
      </Grid>

      <Grid item xs={12} lg={3}>
        <TablePanelWithData
          title={`Geometric mean speedup - ${dayjs(latestGeomeanBucket).format(
            "YYYY/MM/DD"
          )} (threshold = ${SPEEDUP_THRESHOLD}x)`}
          data={Object.values(lastestGeomeanByCompiler).sort((a: any, b: any) =>
            a["compiler"].localeCompare(b["compiler"])
          )}
          columns={columns.concat(
            Object.keys(SUITES).map((suite: string) => {
              return {
                field: suite,
                headerName: SUITES[suite],
                flex: 1,
                renderCell: (params: GridRenderCellParams<string>) => {
                  const url = `/benchmark/${suite}/${
                    DISPLAY_NAMES_TO_COMPILER_NAMES[params.row.compiler] ??
                    params.row.compiler
                  }?dtypes=${dtypes}`;
                  return <a href={url}>{Number(params.value).toFixed(2)}x</a>;
                },
                cellClassName: (params: GridCellParams<string>) => {
                  const v = params.value;
                  if (v === undefined) {
                    return "";
                  }

                  return Number(v) < SPEEDUP_THRESHOLD ? styles.warning : "";
                },
              };
            })
          )}
          dataGridProps={{ getRowId: (el: any) => el.suite + el.compiler }}
        />
      </Grid>

      <Grid item xs={12} lg={3}>
        <TablePanelWithData
          title={`Mean compilation time (seconds) - ${dayjs(
            latestCompTimeBucket
          ).format(
            "YYYY/MM/DD"
          )} (threshold = ${COMPILATION_lATENCY_THRESHOLD_IN_SECONDS}s)`}
          data={Object.values(lastestCompTimeByCompiler).sort(
            (a: any, b: any) => a["compiler"].localeCompare(b["compiler"])
          )}
          columns={columns.concat(
            Object.keys(SUITES).map((suite: string) => {
              return {
                field: suite,
                headerName: SUITES[suite],
                flex: 1,
                renderCell: (params: GridRenderCellParams<string>) => {
                  const url = `/benchmark/${suite}/${
                    DISPLAY_NAMES_TO_COMPILER_NAMES[params.row.compiler] ??
                    params.row.compiler
                  }?dtypes=${dtypes}`;
                  return <a href={url}>{Number(params.value).toFixed(2)}s</a>;
                },
                cellClassName: (params: GridCellParams<string>) => {
                  const v = params.value;
                  if (v === undefined) {
                    return "";
                  }

                  return Number(v) > COMPILATION_lATENCY_THRESHOLD_IN_SECONDS
                    ? styles.warning
                    : "";
                },
              };
            })
          )}
          dataGridProps={{ getRowId: (el: any) => el.suite + el.compiler }}
        />
      </Grid>

      <Grid item xs={12} lg={3}>
        <TablePanelWithData
          title={`Peak memory footprint compression ratio - ${dayjs(
            latestMemoryBucket
          ).format(
            "YYYY/MM/DD"
          )} (threshold = ${COMPRESSION_RATIO_THRESHOLD}x)`}
          data={Object.values(lastestMemoryByCompiler).sort((a: any, b: any) =>
            a["compiler"].localeCompare(b["compiler"])
          )}
          columns={columns.concat(
            Object.keys(SUITES).map((suite: string) => {
              return {
                field: suite,
                headerName: SUITES[suite],
                flex: 1,
                renderCell: (params: GridRenderCellParams<string>) => {
                  const url = `/benchmark/${suite}/${
                    DISPLAY_NAMES_TO_COMPILER_NAMES[params.row.compiler] ??
                    params.row.compiler
                  }?dtypes=${dtypes}`;
                  return <a href={url}>{Number(params.value).toFixed(2)}x</a>;
                },
                cellClassName: (params: GridCellParams<string>) => {
                  const v = params.value;
                  if (v === undefined) {
                    return "";
                  }

                  return Number(v) < COMPRESSION_RATIO_THRESHOLD
                    ? styles.warning
                    : "";
                },
              };
            })
          )}
          dataGridProps={{ getRowId: (el: any) => el.suite + el.compiler }}
        />
      </Grid>
    </Grid>
  );
}

function generateChartSeries(
  dataBySuite: { [k: string]: any },
  dataFieldName: string,
  groupByFieldName: string,
  startTime: Dayjs,
  stopTime: Dayjs,
  granularity: Granularity
) {
  const chartSeries: { [k: string]: any } = {};
  Object.keys(dataBySuite).forEach((key) => {
    chartSeries[key] = seriesWithInterpolatedTimes(
      dataBySuite[key],
      startTime,
      stopTime,
      granularity,
      groupByFieldName,
      TIME_FIELD_NAME,
      dataFieldName
    );
  });

  return chartSeries;
}

function PerformanceGraphs({
  passrateBySuite,
  geomeanBySuite,
  compTimeBySuite,
  memoryBySuite,
  startTime,
  stopTime,
  granularity,
}: {
  passrateBySuite: { [k: string]: any };
  geomeanBySuite: { [k: string]: any };
  compTimeBySuite: { [k: string]: any };
  memoryBySuite: { [k: string]: any };
  startTime: Dayjs;
  stopTime: Dayjs;
  granularity: Granularity;
}) {
  const groupByFieldName = "compiler";

  const passrateSeries = generateChartSeries(
    passrateBySuite,
    "passrate",
    groupByFieldName,
    startTime,
    stopTime,
    granularity
  );
  const geomeanSeries = generateChartSeries(
    geomeanBySuite,
    "geomean",
    groupByFieldName,
    startTime,
    stopTime,
    granularity
  );
  const compTimeSeries = generateChartSeries(
    compTimeBySuite,
    "compilation_latency",
    groupByFieldName,
    startTime,
    stopTime,
    granularity
  );
  const memorySeries = generateChartSeries(
    memoryBySuite,
    "compression_ratio",
    groupByFieldName,
    startTime,
    stopTime,
    granularity
  );

  return (
    <Grid container spacing={2}>
      {Object.keys(SUITES).map((suite: string) => (
        <Grid item xs={12} lg={4} height={ROW_HEIGHT} key={suite}>
          <TimeSeriesPanelWithData
            data={passrateBySuite[suite]}
            series={passrateSeries[suite]}
            title={`Passrate / ${SUITES[suite]}`}
            yAxisLabel={"%"}
            groupByFieldName={groupByFieldName}
            yAxisRenderer={(unit) => {
              return `${(unit * 100).toFixed(0)} %`;
            }}
            additionalOptions={{
              yAxis: {
                min: 0.6,
                max: 1.0,
              },
            }}
          />
        </Grid>
      ))}

      {Object.keys(SUITES).map((suite: string) => (
        <Grid item xs={12} lg={4} height={ROW_HEIGHT} key={suite}>
          <TimeSeriesPanelWithData
            data={geomeanBySuite[suite]}
            series={geomeanSeries[suite]}
            title={`Geomean / ${SUITES[suite]}`}
            groupByFieldName={groupByFieldName}
            yAxisRenderer={(unit) => {
              return `${unit}`;
            }}
          />
        </Grid>
      ))}

      {Object.keys(SUITES).map((suite: string) => (
        <Grid item xs={12} lg={4} height={ROW_HEIGHT} key={suite}>
          <TimeSeriesPanelWithData
            data={compTimeBySuite[suite]}
            series={compTimeSeries[suite]}
            title={`Mean compilation time / ${SUITES[suite]}`}
            groupByFieldName={groupByFieldName}
            yAxisLabel={"second"}
            yAxisRenderer={(unit) => {
              return `${unit}`;
            }}
          />
        </Grid>
      ))}

      {Object.keys(SUITES).map((suite: string) => (
        <Grid item xs={12} lg={4} height={ROW_HEIGHT} key={suite}>
          <TimeSeriesPanelWithData
            data={memoryBySuite[suite]}
            series={memorySeries[suite]}
            title={`Peak memory footprint compression ratio / ${SUITES[suite]}`}
            groupByFieldName={groupByFieldName}
            yAxisRenderer={(unit) => {
              return `${unit}`;
            }}
          />
        </Grid>
      ))}
    </Grid>
  );
}

function BuildSummary({
  passrateBySuite,
}: {
  passrateBySuite: { [k: string]: any };
}) {
  const [lastestShaByCompiler, latestShaBucket] = getLatestRecordByCompiler(
    passrateBySuite,
    "head_sha"
  );

  const suite = "torchbench";
  // Just need the sha of the latest report, all records have the same value
  const latestSha = Object.values(lastestShaByCompiler)[0][suite];

  return (
    <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
      <Typography fontSize={"1rem"} fontStyle={"italic"}>
        *This report was last generated by CI running on PyTorch main branch at
        commit{" "}
        <a href={`${HUD_PREFIX}/${latestSha}#inductor-a100-perf-nightly`}>
          {latestSha.substring(0, 7)}
        </a>
        .
      </Typography>
    </Stack>
  );
}

function Report({
  queryParams,
  granularity,
  dtypes,
}: {
  queryParams: RocksetParam[];
  granularity: Granularity;
  dtypes: string;
}) {
  const queryName = "compilers_benchmark_performance";
  const queryCollection = "inductor";

  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;
  const { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (error !== undefined) {
    console.log(error);
    return (
      <div>
        An error occurred while fetching data, perhaps there are too many
        results with your choice of time range and granularity?
      </div>
    );
  }
  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from Rockset
  const startTime = dayjs(
    queryParams.find((p) => p.name === "startTime")?.value
  ).startOf(granularity);
  const stopTime = dayjs(
    queryParams.find((p) => p.name === "stopTime")?.value
  ).startOf(granularity);

  const passModels = getPassModels(data);
  const passrateBySuite = computePassrate(data, passModels);
  const geomeanBySuite = computeGeomean(data, passModels);
  const compTimeBySuite = computeCompilationTime(data, passModels);
  const memoryBySuite = computeMemoryCompressionRatio(data, passModels);

  return (
    <div>
      <BuildSummary passrateBySuite={passrateBySuite} />
      <SummaryPanel
        passrateBySuite={passrateBySuite}
        geomeanBySuite={geomeanBySuite}
        compTimeBySuite={compTimeBySuite}
        memoryBySuite={memoryBySuite}
        dtypes={dtypes}
      />
      <PerformanceGraphs
        passrateBySuite={passrateBySuite}
        geomeanBySuite={geomeanBySuite}
        compTimeBySuite={compTimeBySuite}
        memoryBySuite={memoryBySuite}
        startTime={startTime}
        stopTime={stopTime}
        granularity={granularity}
      />
    </div>
  );
}

export default function Page() {
  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [dtypes, setDTypes] = useState<string>("amp");

  const queryParams: RocksetParam[] = [
    {
      name: "timezone",
      type: "string",
      value: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    {
      name: "startTime",
      type: "string",
      value: startTime,
    },
    {
      name: "stopTime",
      type: "string",
      value: stopTime,
    },
    {
      name: "granularity",
      type: "string",
      value: granularity,
    },
    {
      name: "dtypes",
      type: "string",
      value: dtypes,
    },
    {
      name: "head",
      type: "string",
      value: "master",
    },
  ];

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          TorchDynamo Performance DashBoard
        </Typography>
        <TimeRangePicker
          startTime={startTime}
          stopTime={stopTime}
          setStartTime={setStartTime}
          setStopTime={setStopTime}
          defaultValue={LAST_WEEK}
        />
        <GranularityPicker
          granularity={granularity}
          setGranularity={setGranularity}
        />
        <DTypePicker dtypes={dtypes} setDTypes={setDTypes} />
      </Stack>

      <Grid item xs={12}>
        <Report
          queryParams={queryParams}
          granularity={granularity}
          dtypes={dtypes}
        />
      </Grid>
    </div>
  );
}
