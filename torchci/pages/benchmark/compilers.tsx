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
  Divider,
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

const ROW_HEIGHT = 245;
const ROW_GAP = 30;
const PASSRATE_DISPLAY_NAME_REGEX = new RegExp("^([0-9]+)%,\\s.+$");

export const LAST_N_DAYS = 7;
export const HUD_PREFIX = "/pytorch/pytorch/commit";
export const TIME_FIELD_NAME = "granularity_bucket";
export const MAIN_BRANCH = "master";
export const LOG_PREFIX = "https://ossci-raw-job-status.s3.amazonaws.com/log";
export const JOB_NAME_REGEX = new RegExp(
  ".+\\s/\\stest\\s\\(inductor_(.+)_perf, ([0-9]+), ([0-9]+), (.+)\\)"
);

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
export const MODES = ["training", "inference"];
export const DTYPES = ["amp"];
export const PASSING_ACCURACY = ["pass", "pass_due_to_skip", "eager_variation"];

// Thresholds
export const ACCURACY_THRESHOLD = 90.0;
export const SPEEDUP_THRESHOLD = 0.95;
export const COMPILATION_lATENCY_THRESHOLD_IN_SECONDS = 120;
export const COMPRESSION_RATIO_THRESHOLD = 0.9;

// Headers
export const DIFF_HEADER = "New value (L) ← Base value (R)";
const PASSRATE_HEADER = `Passrate (threshold = ${ACCURACY_THRESHOLD}%)`;
const GEOMEAN_HEADER = `Geometric mean speedup (threshold = ${SPEEDUP_THRESHOLD}x)`;
const COMPILATION_LATENCY_HEADER = `Mean compilation time (seconds) (threshold = ${COMPILATION_lATENCY_THRESHOLD_IN_SECONDS}s)`;
const MEMORY_HEADER = `Peak memory footprint compression ratio (threshold = ${COMPRESSION_RATIO_THRESHOLD}x)`;

function getPassingModels(data: CompilerPerformanceData[]) {
  const models: { [k: string]: any } = {};

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

    if (!(bucket in models)) {
      models[bucket] = {};
    }

    if (!(workflowId in models[bucket])) {
      models[bucket][workflowId] = {};
    }

    if (!(suite in models[bucket][workflowId])) {
      models[bucket][workflowId][suite] = {};
    }

    if (!(compiler in models[bucket][workflowId][suite])) {
      models[bucket][workflowId][suite][compiler] = new Set<string>();
    }

    if (PASSING_ACCURACY.includes(accuracy)) {
      models[bucket][workflowId][suite][compiler].add(model);
    }
  });

  return models;
}

function isPass(
  bucket: string,
  workflowId: number,
  suite: string,
  compiler: string,
  model: string,
  passingModels: { [k: string]: any }
) {
  return passingModels[bucket][workflowId][suite][compiler].has(model);
}

function computePassrate(
  data: CompilerPerformanceData[],
  passingModels: { [k: string]: any }
) {
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

    if (isPass(bucket, workflowId, suite, compiler, model, passingModels)) {
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

function computeGeomean(
  data: CompilerPerformanceData[],
  passingModels: { [k: string]: any }
) {
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
      isPass(bucket, workflowId, suite, compiler, model, passingModels) &&
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

function computeCompilationTime(
  data: CompilerPerformanceData[],
  passingModels: { [k: string]: any }
) {
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
      isPass(bucket, workflowId, suite, compiler, model, passingModels) &&
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
  data: CompilerPerformanceData[],
  passingModels: { [k: string]: any }
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
      isPass(bucket, workflowId, suite, compiler, model, passingModels) &&
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

export function ModePicker({ mode, setMode }: { mode: string; setMode: any }) {
  function handleChange(e: SelectChangeEvent<string>) {
    setMode(e.target.value);
  }

  return (
    <>
      <FormControl>
        <InputLabel id="mode-picker-input-label">Mode</InputLabel>
        <Select
          value={mode}
          label="Mode"
          labelId="mode-picker-select-label"
          onChange={handleChange}
          id="mode-picker-select"
        >
          {MODES.map((mode) => (
            <MenuItem key={mode} value={mode}>
              {mode}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </>
  );
}

export function DTypePicker({
  dtype,
  setDType,
}: {
  dtype: string;
  setDType: any;
}) {
  function handleChange(e: SelectChangeEvent<string>) {
    setDType(e.target.value);
  }

  return (
    <>
      <FormControl>
        <InputLabel id="dtype-picker-input-label">Precision</InputLabel>
        <Select
          value={dtype}
          label="Precision"
          labelId="dtype-picker-select-label"
          onChange={handleChange}
          id="dtype-picker-select"
        >
          {DTYPES.map((dtype) => (
            <MenuItem key={dtype} value={dtype}>
              {dtype}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </>
  );
}

export function BranchAndCommitPicker({
  queryParams,
  branch,
  setBranch,
  commit,
  setCommit,
  titlePrefix,
  fallbackIndex,
}: {
  queryParams: RocksetParam[];
  branch: string;
  setBranch: any;
  commit: string;
  setCommit: any;
  titlePrefix: string;
  fallbackIndex: number;
}) {
  const queryName = "compilers_benchmark_performance_branches";
  const queryCollection = "inductor";

  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  useEffect(() => {
    if (data !== undefined && (commit === undefined || commit === "")) {
      setCommit(
        data.filter((r: any) => r.head_branch === branch)[fallbackIndex]
          .head_sha
      );
    }
  }, [data]);

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

  function handleBranchChange(e: SelectChangeEvent<string>) {
    const branch: string = e.target.value;
    setBranch(branch);
    setCommit(data.filter((r: any) => r.head_branch === branch)[0].head_sha);
  }

  function handleCommitChange(e: SelectChangeEvent<string>) {
    setCommit(e.target.value);
  }

  return (
    <div>
      <FormControl>
        <InputLabel id={`branch-picker-input-label-${commit}`}>
          Branch
        </InputLabel>
        <Select
          value={branch}
          label="Branch"
          labelId={`branch-picker-select-label-${commit}`}
          onChange={handleBranchChange}
          id={`branch-picker-select-${commit}`}
        >
          <MenuItem value={MAIN_BRANCH}>main</MenuItem>
          {data
            .filter((r: any) => r.head_branch !== MAIN_BRANCH)
            .map((r: any) => (
              <MenuItem
                key={`${r.head_branch}-${commit}`}
                value={r.head_branch}
              >
                {r.head_branch}
              </MenuItem>
            ))}
        </Select>
      </FormControl>

      <FormControl>
        <InputLabel id={`commit-picker-input-label-${commit}`}>
          {titlePrefix} Commit
        </InputLabel>
        <Select
          value={commit}
          label="Commit"
          labelId={`commit-picker-select-label-${commit}`}
          onChange={handleCommitChange}
          id={`commit-picker-select-${commit}`}
        >
          {data
            .filter((r: any) => r.head_branch === branch)
            .map((r: any) => (
              <MenuItem key={r.head_sha} value={r.head_sha}>
                {r.head_sha.substring(0, 7)} (
                {dayjs(r.event_time).format("YYYY/MM/DD")})
              </MenuItem>
            ))}
        </Select>
      </FormControl>
    </div>
  );
}

export function LogLinks({
  key,
  suite,
  logs,
}: {
  key: string;
  suite: string;
  logs: any;
}) {
  return (
    <>
      {" "}
      {SUITES[suite]} (
      {logs.map((log: any) => (
        <a key={`${key}-${log.index}`} href={log.url}>
          #{log.index}
          {log.index === log.total ? "" : ", "}
        </a>
      ))}
      )
    </>
  );
}

function CommitPanel({
  branch,
  commit,
  workflowId,
  date,
}: {
  branch: string;
  commit: string;
  workflowId: number;
  date: string;
}) {
  const queryCollection = "commons";
  const queryName = "get_workflow_jobs";

  // Fetch the job ID to generate the link to its CI logs
  const queryParams: RocksetParam[] = [
    {
      name: "workflowId",
      type: "int",
      value: workflowId,
    },
  ];
  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (data === undefined || data.length === 0) {
    return <></>;
  }

  const logsBySuite: { [k: string]: any } = {};
  data.forEach((record: any) => {
    const id = record.id;
    const url = `${LOG_PREFIX}/${id}`;

    const name = record.name;
    // Extract the shard ID
    const m = name.match(JOB_NAME_REGEX);
    if (m === null) {
      return;
    }

    const suite = m[1];
    const index = m[2];
    const total = m[3];

    if (!(suite in logsBySuite)) {
      logsBySuite[suite] = [];
    }
    logsBySuite[suite].push({
      index: index,
      total: total,
      url: url,
    });
  });

  return (
    <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
      <Typography fontSize={"1rem"} fontStyle={"italic"}>
        *This report was generated by CI running on PyTorch {branch} branch at
        commit{" "}
        <a href={`${HUD_PREFIX}/${commit}#inductor-a100-perf-nightly`}>
          {commit.substring(0, 7)}
        </a>{" "}
        on {dayjs(date).format("YYYY/MM/DD")}. The running logs per shard are:{" "}
        {Object.keys(SUITES).map((suite: string) => {
          // Hack alert: The test configuration uses timm instead of timm_model as its output
          const name = suite.includes("timm") ? "timm" : suite;
          return (
            <LogLinks
              key={`log-${name}`}
              suite={suite}
              logs={logsBySuite[name]}
            />
          );
        })}
        .
      </Typography>
    </Stack>
  );
}

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

function SummaryPanel({
  mode,
  dtype,
  lBranch,
  lCommit,
  lData,
  rBranch,
  rCommit,
  rData,
}: {
  mode: string;
  dtype: string;
  lBranch: string;
  lCommit: string;
  lData: CompilerPerformanceData[];
  rBranch: string;
  rCommit: string;
  rData: CompilerPerformanceData[];
}) {
  const fields: { [k: string]: any } = {
    passrate_display: computePassrate,
    geomean: computeGeomean,
    compilation_latency: computeCompilationTime,
    compression_ratio: computeMemoryCompressionRatio,
  };
  // The left
  const [lPassrate, lGeomean, lCompTime, lMemory] = processSummaryData(
    lData,
    fields
  );
  // and the right
  const [rPassrate, rGeomean, rCompTime, rMemory] = processSummaryData(
    rData,
    fields
  );

  const suites = Object.keys(SUITES);
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
      headerName: "Compiler",
      flex: 1,
    },
  ];

  return (
    <div>
      <Grid container spacing={2} height={ROW_HEIGHT * 2 + ROW_GAP}>
        <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
          <TablePanelWithData
            title={
              lCommit === rCommit
                ? PASSRATE_HEADER
                : `${PASSRATE_HEADER} ${DIFF_HEADER}`
            }
            data={Object.values(passrate).sort((a: any, b: any) =>
              a["compiler"].localeCompare(b["compiler"])
            )}
            columns={columns.concat(
              suites.map((suite: string) => {
                return {
                  field: suite,
                  headerName: SUITES[suite],
                  flex: 1,
                  renderCell: (params: GridRenderCellParams<any>) => {
                    const v = params.value;
                    if (v === undefined) {
                      return "";
                    }

                    const url = `/benchmark/${suite}/${
                      DISPLAY_NAMES_TO_COMPILER_NAMES[params.row.compiler] ??
                      params.row.compiler
                    }?mode=${mode}&dtype=${dtype}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}`;

                    const l = extractPercentage(v.l);
                    const r = extractPercentage(v.r);

                    if (l === undefined) {
                      return "";
                    }

                    if (lCommit === rCommit) {
                      return <a href={url}>{v.l}</a>;
                    } else {
                      return (
                        <a href={url}>
                          {v.l} ← {v.r}{" "}
                          {Number(l) < Number(r) ? "\uD83D\uDD3B" : ""}
                        </a>
                      );
                    }
                  },
                  cellClassName: (params: GridCellParams<any>) => {
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
                      if (l >= ACCURACY_THRESHOLD && r < ACCURACY_THRESHOLD) {
                        return styles.ok;
                      }

                      if (l < ACCURACY_THRESHOLD && r >= ACCURACY_THRESHOLD) {
                        return styles.error;
                      }

                      if (l === r) {
                        return "";
                      }

                      if (l < ACCURACY_THRESHOLD && r < ACCURACY_THRESHOLD) {
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
        </Grid>

        <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
          <TablePanelWithData
            title={GEOMEAN_HEADER}
            data={Object.values(geomean).sort((a: any, b: any) =>
              a["compiler"].localeCompare(b["compiler"])
            )}
            columns={columns.concat(
              suites.map((suite: string) => {
                return {
                  field: suite,
                  headerName: SUITES[suite],
                  flex: 1,
                  renderCell: (params: GridRenderCellParams<any>) => {
                    const v = params.value;
                    if (v === undefined) {
                      return "";
                    }

                    const url = `/benchmark/${suite}/${
                      DISPLAY_NAMES_TO_COMPILER_NAMES[params.row.compiler] ??
                      params.row.compiler
                    }?mode=${mode}&dtype=${dtype}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}`;

                    const l = Number(v.l).toFixed(2);
                    const r = Number(v.r).toFixed(2);

                    if (lCommit === rCommit) {
                      return <a href={url}>{l}x</a>;
                    } else {
                      return (
                        <a href={url}>
                          {l}x ← {r}x{" "}
                          {Number(l) < Number(r) ? "\uD83D\uDD3B" : ""}
                        </a>
                      );
                    }
                  },
                  cellClassName: (params: GridCellParams<any>) => {
                    const v = params.value;
                    if (v === undefined) {
                      return "";
                    }

                    const l = Number(v.l);
                    const r = Number(v.r);

                    if (lCommit === rCommit) {
                      return l >= SPEEDUP_THRESHOLD ? "" : styles.warning;
                    } else {
                      if (l >= SPEEDUP_THRESHOLD && r < SPEEDUP_THRESHOLD) {
                        return styles.ok;
                      }

                      if (l < SPEEDUP_THRESHOLD && r >= SPEEDUP_THRESHOLD) {
                        return styles.error;
                      }

                      if (l === r) {
                        return "";
                      }

                      if (l < SPEEDUP_THRESHOLD && r < SPEEDUP_THRESHOLD) {
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
        </Grid>

        <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
          <TablePanelWithData
            title={COMPILATION_LATENCY_HEADER}
            data={Object.values(compTime).sort((a: any, b: any) =>
              a["compiler"].localeCompare(b["compiler"])
            )}
            columns={columns.concat(
              suites.map((suite: string) => {
                return {
                  field: suite,
                  headerName: SUITES[suite],
                  flex: 1,
                  renderCell: (params: GridRenderCellParams<any>) => {
                    const v = params.value;
                    if (v === undefined) {
                      return "";
                    }

                    const url = `/benchmark/${suite}/${
                      DISPLAY_NAMES_TO_COMPILER_NAMES[params.row.compiler] ??
                      params.row.compiler
                    }?mode=${mode}&dtype=${dtype}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}`;

                    const l = Number(v.l).toFixed(0);
                    const r = Number(v.r).toFixed(0);

                    if (lCommit === rCommit) {
                      return <a href={url}>{l}s</a>;
                    } else {
                      return (
                        <a href={url}>
                          {l}s ← {r}s{" "}
                          {Number(l) > Number(r) && Number(r) != 0
                            ? "\uD83D\uDD3A"
                            : ""}
                        </a>
                      );
                    }
                  },
                  cellClassName: (params: GridCellParams<any>) => {
                    const v = params.value;
                    if (v === undefined) {
                      return "";
                    }

                    const l = Number(v.l);
                    const r = Number(v.r);

                    if (lCommit === rCommit) {
                      return l > COMPILATION_lATENCY_THRESHOLD_IN_SECONDS
                        ? styles.warning
                        : "";
                    } else {
                      if (
                        l <= COMPILATION_lATENCY_THRESHOLD_IN_SECONDS &&
                        r > COMPILATION_lATENCY_THRESHOLD_IN_SECONDS
                      ) {
                        return styles.ok;
                      }

                      if (
                        l > COMPILATION_lATENCY_THRESHOLD_IN_SECONDS &&
                        r <= COMPILATION_lATENCY_THRESHOLD_IN_SECONDS
                      ) {
                        return styles.error;
                      }

                      if (l === r) {
                        return "";
                      }

                      if (
                        l > COMPILATION_lATENCY_THRESHOLD_IN_SECONDS &&
                        r > COMPILATION_lATENCY_THRESHOLD_IN_SECONDS
                      ) {
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
        </Grid>

        <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
          <TablePanelWithData
            title={MEMORY_HEADER}
            data={Object.values(memory).sort((a: any, b: any) =>
              a["compiler"].localeCompare(b["compiler"])
            )}
            columns={columns.concat(
              suites.map((suite: string) => {
                return {
                  field: suite,
                  headerName: SUITES[suite],
                  flex: 1,
                  renderCell: (params: GridRenderCellParams<any>) => {
                    const v = params.value;
                    if (v === undefined) {
                      return "";
                    }

                    const url = `/benchmark/${suite}/${
                      DISPLAY_NAMES_TO_COMPILER_NAMES[params.row.compiler] ??
                      params.row.compiler
                    }?mode=${mode}&dtype=${dtype}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}`;

                    const l = Number(v.l).toFixed(2);
                    const r = Number(v.r).toFixed(2);

                    if (lCommit === rCommit) {
                      return <a href={url}>{l}x</a>;
                    } else {
                      return (
                        <a href={url}>
                          {l}x ← {r}x{" "}
                          {Number(l) < Number(r) ? "\uD83D\uDD3B" : ""}
                        </a>
                      );
                    }
                  },
                  cellClassName: (params: GridCellParams<any>) => {
                    const v = params.value;
                    if (v === undefined) {
                      return "";
                    }

                    const l = Number(v.l);
                    const r = Number(v.r);

                    if (lCommit === rCommit) {
                      return l >= COMPRESSION_RATIO_THRESHOLD
                        ? ""
                        : styles.warning;
                    } else {
                      if (
                        l >= COMPRESSION_RATIO_THRESHOLD &&
                        r < COMPRESSION_RATIO_THRESHOLD
                      ) {
                        return styles.ok;
                      }

                      if (
                        l < COMPRESSION_RATIO_THRESHOLD &&
                        r >= COMPRESSION_RATIO_THRESHOLD
                      ) {
                        return styles.error;
                      }

                      if (l === r) {
                        return "";
                      }

                      if (
                        l < COMPRESSION_RATIO_THRESHOLD &&
                        r < COMPRESSION_RATIO_THRESHOLD
                      ) {
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
        </Grid>
      </Grid>
    </div>
  );
}

function GraphPanel({
  queryParams,
  granularity,
  suite,
  branch,
}: {
  queryParams: RocksetParam[];
  granularity: Granularity;
  suite: string;
  branch: string;
}) {
  const queryCollection = "inductor";
  const queryName = "compilers_benchmark_performance";

  const queryParamsWithSuite: RocksetParam[] = [
    {
      name: "suites",
      type: "string",
      value: suite,
    },
    {
      name: "branch",
      type: "string",
      value: branch,
    },
    ...queryParams,
  ];
  // NB: Querying data for all the suites blows up the response from Rockset over
  // the lambda reponse body limit of 6MB. So I need to split up the query here
  // into multiple smaller ones to keep them under the limit
  //
  // See more:
  // * https://nextjs.org/docs/messages/api-routes-body-size-limit
  // * https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithSuite)
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

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from Rockset
  const startTime = dayjs(
    queryParams.find((p) => p.name === "startTime")?.value
  ).startOf(granularity);
  const stopTime = dayjs(
    queryParams.find((p) => p.name === "stopTime")?.value
  ).startOf(granularity);

  // Compute the metrics for all passing models
  const models = getPassingModels(data);
  const groupByFieldName = "compiler";

  // Accuracy
  const passrate = computePassrate(data, models);
  const passrateSeries = seriesWithInterpolatedTimes(
    passrate,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "passrate",
    false
  );

  // Geomean speedup
  const geomean = computeGeomean(data, models);
  const geomeanSeries = seriesWithInterpolatedTimes(
    geomean,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "geomean",
    false
  );

  // Compilation time
  const compTime = computeCompilationTime(data, models);
  const compTimeSeries = seriesWithInterpolatedTimes(
    compTime,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "compilation_latency",
    false
  );

  // Memory compression ratio
  const memory = computeMemoryCompressionRatio(data, models);
  const memorySeries = seriesWithInterpolatedTimes(
    memory,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "compression_ratio",
    false
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

function Report({
  queryParams,
  granularity,
  suite,
  mode,
  dtype,
  lBranch,
  lCommit,
  rBranch,
  rCommit,
}: {
  queryParams: RocksetParam[];
  granularity: Granularity;
  suite: string;
  mode: string;
  dtype: string;
  lBranch: string;
  lCommit: string;
  rBranch: string;
  rCommit: string;
}) {
  const queryCollection = "inductor";
  const queryName = "compilers_benchmark_performance";

  const queryParamsWithL: RocksetParam[] = [
    {
      name: "suites",
      type: "string",
      value: Object.keys(SUITES).join(","),
    },
    {
      name: "branch",
      type: "string",
      value: lBranch,
    },
    {
      name: "commits",
      type: "string",
      value: lCommit,
    },
    ...queryParams,
  ];
  const lUrl = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithL)
  )}`;

  const { data: lData, error: lError } = useSWR(lUrl, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  const queryParamsWithR: RocksetParam[] = [
    {
      name: "suites",
      type: "string",
      value: Object.keys(SUITES).join(","),
    },
    {
      name: "branch",
      type: "string",
      value: rBranch,
    },
    {
      name: "commits",
      type: "string",
      value: rCommit,
    },
    ...queryParams,
  ];
  const rUrl = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithR)
  )}`;

  const { data: rData, error: rError } = useSWR(rUrl, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (
    lData === undefined ||
    lData.length === 0 ||
    rData === undefined ||
    rData.length === 0
  ) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  return (
    <div>
      <CommitPanel
        branch={lBranch}
        commit={lCommit}
        workflowId={lData[0].workflow_id}
        date={lData[0].granularity_bucket}
      />
      <SummaryPanel
        mode={mode}
        dtype={dtype}
        lBranch={lBranch}
        lCommit={lCommit}
        lData={lData}
        rBranch={rBranch}
        rCommit={rCommit}
        rData={rData}
      />
      <GraphPanel
        queryParams={queryParams}
        granularity={granularity}
        suite={suite}
        branch={lBranch}
      />
    </div>
  );
}

export default function Page() {
  const [startTime, setStartTime] = useState(
    dayjs().subtract(LAST_N_DAYS, "day")
  );
  const [stopTime, setStopTime] = useState(dayjs());
  const [granularity, setGranularity] = useState<Granularity>("hour");
  const [suite, setSuite] = useState<string>(Object.keys(SUITES)[0]);
  const [mode, setMode] = useState<string>(MODES[0]);
  const [dtype, setDType] = useState<string>(DTYPES[0]);
  const [lBranch, setLBranch] = useState<string>(MAIN_BRANCH);
  const [lCommit, setLCommit] = useState<string>("");
  const [rBranch, setRBranch] = useState<string>(MAIN_BRANCH);
  const [rCommit, setRCommit] = useState<string>("");

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
      name: "mode",
      type: "string",
      value: mode,
    },
    {
      name: "dtypes",
      type: "string",
      value: dtype,
    },
  ];

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          TorchInductor Performance DashBoard
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
        <SuitePicker suite={suite} setSuite={setSuite} />
        <ModePicker mode={mode} setMode={setMode} />
        <DTypePicker dtype={dtype} setDType={setDType} />
        <BranchAndCommitPicker
          branch={lBranch}
          setBranch={setLBranch}
          commit={lCommit}
          setCommit={setLCommit}
          queryParams={queryParams}
          titlePrefix={"New"}
          fallbackIndex={0} // Default to the latest commit
        />
        <Divider orientation="vertical" flexItem>
          Diff
        </Divider>
        <BranchAndCommitPicker
          branch={rBranch}
          setBranch={setRBranch}
          commit={rCommit}
          setCommit={setRCommit}
          queryParams={queryParams}
          titlePrefix={"Base"}
          fallbackIndex={1} // Default to the next to latest commit
        />
      </Stack>

      <Grid item xs={12}>
        <Report
          queryParams={queryParams}
          granularity={granularity}
          suite={suite}
          mode={mode}
          dtype={dtype}
          lBranch={lBranch}
          lCommit={lCommit}
          rBranch={rBranch}
          rCommit={rCommit}
        />
      </Grid>
    </div>
  );
}
