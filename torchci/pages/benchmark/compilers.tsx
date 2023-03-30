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

const LAST_N_DAYS = 7;
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
export const DTYPES = ["amp", "float32"];
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
  const passrate: any[] = [];

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

    if (!(bucket in totalCount)) {
      totalCount[bucket] = {};
      passCount[bucket] = {};
    }

    if (!(workflowId in totalCount[bucket])) {
      totalCount[bucket][workflowId] = {};
      passCount[bucket][workflowId] = {};
    }

    if (!(suite in totalCount[bucket][workflowId])) {
      totalCount[bucket][workflowId][suite] = {};
      passCount[bucket][workflowId][suite] = {};
    }

    if (!(compiler in totalCount[bucket][workflowId][suite])) {
      totalCount[bucket][workflowId][suite][compiler] = 0;
      passCount[bucket][workflowId][suite][compiler] = 0;
    }

    if (isPass(bucket, workflowId, suite, compiler, model, passModels)) {
      passCount[bucket][workflowId][suite][compiler] += 1;
    }

    totalCount[bucket][workflowId][suite][compiler] += 1;
  });

  Object.keys(totalCount).forEach((bucket: string) => {
    Object.keys(totalCount[bucket]).forEach((workflowId: string) => {
      Object.keys(totalCount[bucket][workflowId]).forEach((suite: string) => {
        Object.keys(totalCount[bucket][workflowId][suite]).forEach(
          (compiler: string) => {
            const pc = passCount[bucket][workflowId][suite][compiler];
            const tc = totalCount[bucket][workflowId][suite][compiler];
            const p = pc / tc;

            passrate.push({
              granularity_bucket: bucket,
              workflow_id: workflowId,
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

  return passrate;
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
  const returnedGeomean: any[] = [];

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

  Object.keys(speedup).forEach((bucket: string) => {
    Object.keys(speedup[bucket]).forEach((workflowId: string) => {
      Object.keys(speedup[bucket][workflowId]).forEach((suite: string) => {
        Object.keys(speedup[bucket][workflowId][suite]).forEach(
          (compiler: string) => {
            const gm = geomean(speedup[bucket][workflowId][suite][compiler]);

            returnedGeomean.push({
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

  return returnedGeomean;
}

function computeCompilationTime(data: any, passModels: { [k: string]: any }) {
  const compTime: { [k: string]: any } = {};
  const returnedCompTime: any[] = [];

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

            returnedCompTime.push({
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

  return returnedCompTime;
}

function computeMemoryCompressionRatio(
  data: any,
  passModels: { [k: string]: any }
) {
  const memory: { [k: string]: any } = {};
  const returnedMemory: any[] = [];

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

            returnedMemory.push({
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

  return returnedMemory;
}

function getRecordByFieldName(
  data: any[],
  fieldName: string
): [{ [k: string]: any }, string] {
  let latestBucket: string = "";
  const lastestRecordByCompiler: { [k: string]: any } = {};

  data.forEach((r: any) => {
    const compiler = r["compiler"];
    const suite = r["suite"];

    if (!(compiler in lastestRecordByCompiler)) {
      lastestRecordByCompiler[compiler] = {
        compiler: compiler,
      };
    }

    lastestRecordByCompiler[compiler][suite] = r[fieldName];
    latestBucket = r.granularity_bucket;
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
        <InputLabel id="dtypes-picker-input-label">Precision</InputLabel>
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

export function SuitePicker({
  suite,
  setSuite,
}: {
  suite: string;
  setSuite: any;
}) {
  function handleChange(e: SelectChangeEvent<string>) {
    setSuite(e.target.value);
  }

  return (
    <>
      <FormControl>
        <InputLabel id="suite-picker-input-label">Suite</InputLabel>
        <Select
          value={suite}
          label="Suite"
          labelId="suite-picker-select-label"
          onChange={handleChange}
          id="suite-picker-select"
        >
          {Object.keys(SUITES).map((suite) => (
            <MenuItem key={suite} value={suite}>
              {SUITES[suite]}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </>
  );
}

export function BranchPicker({
  branch,
  setBranch,
  queryParams,
}: {
  branch: string;
  setBranch: any;
  queryParams: RocksetParam[];
}) {
  const queryName = "compilers_benchmark_performance_branches";
  const queryCollection = "inductor";

  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (error !== undefined) {
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

  function handleChange(e: SelectChangeEvent<string>) {
    setBranch(e.target.value);
  }

  return (
    <>
      <FormControl>
        <InputLabel id="branch-picker-input-label">Branch</InputLabel>
        <Select
          value={branch}
          label="Branch"
          labelId="branch-picker-select-label"
          onChange={handleChange}
          id="branch-picker-select"
        >
          <MenuItem value={"master"}>main</MenuItem>
          {data.map((b: any) => (
            <MenuItem key={b["head_branch"]} value={b["head_branch"]}>
              {b["head_branch"]}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </>
  );
}

function SummaryPanel({
  queryParams,
  workflowId,
  sha,
  dtypes,
  branch,
  startTime,
  stopTime,
}: {
  queryParams: RocksetParam[];
  workflowId: number;
  sha: string;
  dtypes: string;
  branch: string;
  startTime: Dayjs;
  stopTime: Dayjs;
}) {
  const queryName = "compilers_benchmark_performance";
  const queryCollection = "inductor";

  const queryParamsWithID: RocksetParam[] = [
    {
      name: "suite",
      type: "string",
      value: Object.keys(SUITES).join(","),
    },
    {
      name: "workflowId",
      type: "int",
      value: workflowId,
    },
    ...queryParams,
  ];

  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithID)
  )}`;

  const { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (error !== undefined) {
    return (
      <div>
        An error occurred while fetching data, perhaps there are too many
        results with your choice of time range and granularity?
      </div>
    );
  }

  if (data === undefined || data.length === 0) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const passModels = getPassModels(data);
  const passrate = computePassrate(data, passModels);
  const geomean = computeGeomean(data, passModels);
  const compTime = computeCompilationTime(data, passModels);
  const memory = computeMemoryCompressionRatio(data, passModels);

  const [passrateByCompiler, passrateBucket] = getRecordByFieldName(
    passrate,
    "passrate_display"
  );
  const [geomeanByCompiler, geomeanBucket] = getRecordByFieldName(
    geomean,
    "geomean"
  );
  const [compTimeByCompiler, compTimeBucket] = getRecordByFieldName(
    compTime,
    "compilation_latency"
  );
  const [memoryByCompiler, memoryBucket] = getRecordByFieldName(
    memory,
    "compression_ratio"
  );

  const columns = [
    {
      field: "compiler",
      headerName: "Compiler",
      flex: 1,
    },
  ];

  return (
    <div>
      <BuildSummary branch={branch} sha={sha} />
      <Grid container spacing={2} height={ROW_HEIGHT * 2 + ROW_GAP}>
        <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
          <TablePanelWithData
            title={`Passrate - ${dayjs(passrateBucket).format(
              "YYYY/MM/DD"
            )} (threshold = ${ACCURACY_THRESHOLD}%)`}
            data={Object.values(passrateByCompiler).sort((a: any, b: any) =>
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
                    }?dtypes=${dtypes}&branch=${branch}`;
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

        <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
          <TablePanelWithData
            title={`Geometric mean speedup - ${dayjs(geomeanBucket).format(
              "YYYY/MM/DD"
            )} (threshold = ${SPEEDUP_THRESHOLD}x)`}
            data={Object.values(geomeanByCompiler).sort((a: any, b: any) =>
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
                    }?dtypes=${dtypes}&branch=${branch}`;
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

        <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
          <TablePanelWithData
            title={`Mean compilation time (seconds) - ${dayjs(
              compTimeBucket
            ).format(
              "YYYY/MM/DD"
            )} (threshold = ${COMPILATION_lATENCY_THRESHOLD_IN_SECONDS}s)`}
            data={Object.values(compTimeByCompiler).sort((a: any, b: any) =>
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
                    }?dtypes=${dtypes}&branch=${branch}`;
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

        <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
          <TablePanelWithData
            title={`Peak memory footprint compression ratio - ${dayjs(
              memoryBucket
            ).format(
              "YYYY/MM/DD"
            )} (threshold = ${COMPRESSION_RATIO_THRESHOLD}x)`}
            data={Object.values(memoryByCompiler).sort((a: any, b: any) =>
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
                    }?dtypes=${dtypes}&branch=${branch}`;
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
    </div>
  );
}

function generateChartSeries(
  data: any[],
  dataFieldName: string,
  groupByFieldName: string,
  startTime: Dayjs,
  stopTime: Dayjs,
  granularity: Granularity
) {
  return seriesWithInterpolatedTimes(
    data,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    dataFieldName
  );
}

function PerformanceGraphs({
  suite,
  passrate,
  geomean,
  compTime,
  memory,
  startTime,
  stopTime,
  granularity,
}: {
  suite: string;
  passrate: any[];
  geomean: any[];
  compTime: any[];
  memory: any[];
  startTime: Dayjs;
  stopTime: Dayjs;
  granularity: Granularity;
}) {
  const groupByFieldName = "compiler";

  const passrateSeries = generateChartSeries(
    passrate,
    "passrate",
    groupByFieldName,
    startTime,
    stopTime,
    granularity
  );
  const geomeanSeries = generateChartSeries(
    geomean,
    "geomean",
    groupByFieldName,
    startTime,
    stopTime,
    granularity
  );
  const compTimeSeries = generateChartSeries(
    compTime,
    "compilation_latency",
    groupByFieldName,
    startTime,
    stopTime,
    granularity
  );
  const memorySeries = generateChartSeries(
    memory,
    "compression_ratio",
    groupByFieldName,
    startTime,
    stopTime,
    granularity
  );

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={passrate}
          series={passrateSeries}
          title={`Passrate / ${SUITES[suite]}`}
          yAxisLabel={"%"}
          groupByFieldName={groupByFieldName}
          yAxisRenderer={(unit) => {
            return `${(unit * 100).toFixed(0)} %`;
          }}
          additionalOptions={{
            yAxis: {
              scale: true,
            },
          }}
        />
      </Grid>

      <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={geomean}
          series={geomeanSeries}
          title={`Geomean / ${SUITES[suite]}`}
          groupByFieldName={groupByFieldName}
          yAxisRenderer={(unit) => {
            return `${unit}`;
          }}
          additionalOptions={{
            yAxis: {
              scale: true,
            },
          }}
        />
      </Grid>

      <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={compTime}
          series={compTimeSeries}
          title={`Mean compilation time / ${SUITES[suite]}`}
          groupByFieldName={groupByFieldName}
          yAxisLabel={"second"}
          yAxisRenderer={(unit) => {
            return `${unit}`;
          }}
          additionalOptions={{
            yAxis: {
              scale: true,
            },
          }}
        />
      </Grid>

      <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={memory}
          series={memorySeries}
          title={`Peak memory footprint compression ratio / ${SUITES[suite]}`}
          groupByFieldName={groupByFieldName}
          yAxisRenderer={(unit) => {
            return `${unit}`;
          }}
          additionalOptions={{
            yAxis: {
              scale: true,
            },
          }}
        />
      </Grid>
    </Grid>
  );
}

function BuildSummary({ branch, sha }: { branch: string; sha: string }) {
  return (
    <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
      <Typography fontSize={"1rem"} fontStyle={"italic"}>
        *This report was last generated by CI running on PyTorch {branch} branch
        at commit{" "}
        <a href={`${HUD_PREFIX}/${sha}#inductor-a100-perf-nightly`}>
          {sha.substring(0, 7)}
        </a>
        .
      </Typography>
    </Stack>
  );
}

function Report({
  queryParams,
  granularity,
  suite,
  dtypes,
  branch,
}: {
  queryParams: RocksetParam[];
  granularity: Granularity;
  suite: string;
  dtypes: string;
  branch: string;
}) {
  const queryCollection = "inductor";
  const queryParamsWithSuite: RocksetParam[] = [
    {
      name: "suite",
      type: "string",
      value: suite,
    },
    ...queryParams,
  ];

  let queryName = "compilers_benchmark_performance";
  // NB: Querying data for all the suites blows up the response from Rockset over
  // the lambda reponse body limit of 6MB. So I need to split up the query here
  // into multiple smaller ones to keep them under the limit
  //
  // See more:
  // * https://nextjs.org/docs/messages/api-routes-body-size-limit
  // * https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
  let url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithSuite)
  )}`;

  const { data: historicalData, error: historicalError } = useSWR(
    url,
    fetcher,
    {
      refreshInterval: 60 * 60 * 1000, // refresh every hour
    }
  );

  // Get the latest workflow ID for the summary table
  queryName = "compilers_benchmark_performance_latest_runs";
  url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithSuite)
  )}`;

  const { data: workflowData, error: workflowError } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (historicalError !== undefined || workflowError !== undefined) {
    return (
      <div>
        An error occurred while fetching data, perhaps there are too many
        results with your choice of time range and granularity?
      </div>
    );
  }

  if (
    historicalData === undefined ||
    workflowData === undefined ||
    historicalData.length === 0 ||
    workflowData.length === 0
  ) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const passModels = getPassModels(historicalData);
  const passrate = computePassrate(historicalData, passModels);
  const geomean = computeGeomean(historicalData, passModels);
  const compTime = computeCompilationTime(historicalData, passModels);
  const memory = computeMemoryCompressionRatio(historicalData, passModels);

  const latestWorkflowId = workflowData[0]["workflow_id"];
  const latestSha = workflowData[0]["head_sha"];

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from Rockset
  const startTime = dayjs(
    queryParams.find((p) => p.name === "startTime")?.value
  ).startOf(granularity);
  const stopTime = dayjs(
    queryParams.find((p) => p.name === "stopTime")?.value
  ).startOf(granularity);

  return (
    <div>
      <SummaryPanel
        queryParams={queryParams}
        workflowId={latestWorkflowId}
        sha={latestSha}
        dtypes={dtypes}
        branch={branch}
        startTime={startTime}
        stopTime={stopTime}
      />
      <PerformanceGraphs
        suite={suite}
        passrate={passrate}
        geomean={geomean}
        compTime={compTime}
        memory={memory}
        startTime={startTime}
        stopTime={stopTime}
        granularity={granularity}
      />
    </div>
  );
}

export default function Page() {
  const [startTime, setStartTime] = useState(
    dayjs().subtract(LAST_N_DAYS, "day")
  );
  const [stopTime, setStopTime] = useState(dayjs());
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [dtypes, setDTypes] = useState<string>(DTYPES[0]);
  const [suite, setSuite] = useState<string>(Object.keys(SUITES)[0]);
  const [branch, setBranch] = useState<string>("master");

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
      name: "branch",
      type: "string",
      value: branch,
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
          defaultValue={LAST_N_DAYS}
        />
        <GranularityPicker
          granularity={granularity}
          setGranularity={setGranularity}
        />
        <BranchPicker
          branch={branch}
          setBranch={setBranch}
          queryParams={queryParams}
        />
        <SuitePicker suite={suite} setSuite={setSuite} />
        <DTypePicker dtypes={dtypes} setDTypes={setDTypes} />
      </Stack>

      <Grid item xs={12}>
        <Report
          queryParams={queryParams}
          granularity={granularity}
          suite={suite}
          dtypes={dtypes}
          branch={branch}
        />
      </Grid>
    </div>
  );
}
