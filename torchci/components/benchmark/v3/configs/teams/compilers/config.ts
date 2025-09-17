import {
  DEFAULT_DEVICE_NAME,
  DISPLAY_NAMES_TO_ARCH_NAMES,
  DISPLAY_NAMES_TO_DEVICE_NAMES,
} from "components/benchmark/compilers/common";
import { SUITES } from "components/benchmark/compilers/SuitePicker";
import { DEFAULT_MODE, MODES } from "components/benchmark/ModeAndDTypePicker";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { REQUIRED_COMPLIER_LIST_COMMITS_KEYS } from "lib/benchmark/api_helper/compilers/type";
import { BenchmarkUIConfig } from "../../configBook";
import {
  QueryParameterConverter,
  QueryParameterConverterInputs,
} from "../../utils/dataBindingRegistration";
dayjs.extend(utc);

export const compilerQueryParameterConverter: QueryParameterConverter = (
  inputs: QueryParameterConverterInputs
) => {
  const i = inputs;
  const f = i.filters;
  return {
    commits: i.commits ?? [],
    branches: i.branches ?? [],
    compilers: [],
    arch: DISPLAY_NAMES_TO_ARCH_NAMES[f.deviceName],
    device: DISPLAY_NAMES_TO_DEVICE_NAMES[f.deviceName],
    dtype: f.dtype === "none" ? "" : f.dtype,
    granularity: "hour",
    mode: f.mode,
    startTime: dayjs.utc(i.timeRange.start).format("YYYY-MM-DDTHH:mm:ss"),
    stopTime: dayjs.utc(i.timeRange.end).format("YYYY-MM-DDTHH:mm:ss"),
    suites: f.suite ?? Object.keys(SUITES),
  };
};

export const COMPILTER_PRECOMPUTE_BENCHMARK_ID = "compiler_precompute";

// The initial config for the compiler benchmark regression page
export const COMPILTER_PRECOMPUTE_BENCHMARK_INITIAL = {
  benchmarkId: COMPILTER_PRECOMPUTE_BENCHMARK_ID,
  // (elainewy): todo change this to json-friend config
  time: {
    start: dayjs.utc().startOf("day").subtract(7, "day"),
    end: dayjs.utc().endOf("day"),
  },
  filters: {
    repo: "pytorch/pytorch",
    benchmarkName: "compiler",
    backend: "",
    mode: DEFAULT_MODE,
    dtype: MODES[DEFAULT_MODE],
    deviceName: DEFAULT_DEVICE_NAME,
    device: "cuda",
    arch: "h100",
  },
  lbranch: "main",
  rbranch: "main",
};

// main config for the compiler benchmark regression page
export const CompilerPrecomputeBenchmarkUIConfig: BenchmarkUIConfig = {
  benchmarkId: COMPILTER_PRECOMPUTE_BENCHMARK_ID,
  apiId: COMPILTER_PRECOMPUTE_BENCHMARK_ID,
  benchmarkName: "Compiler Inductor Regression Tracking",
  dataBinding: {
    initial: COMPILTER_PRECOMPUTE_BENCHMARK_INITIAL,
    required_filter_fields: REQUIRED_COMPLIER_LIST_COMMITS_KEYS,
    filter_options: {
      customizedDropdown: {
        type: "component",
        id: "CompilerSearchBarDropdowns",
      },
    },
    query_params: {
      type: "converter",
      id: "compilerDataRenderConverter",
    },
  },
  dataRender: {
    type: "fanout",
    renders: [
      {
        type: "FanoutBenchmarkTimeSeriesChartSection",
        config: {
          groupByFields: ["suite"],
          chartGroup: {
            type: "line",
            groupByFields: ["metric"],
            lineKey: ["compiler"],
            chart: {
              renderOptions: {
                lineMapping: {
                  passrate: { type: "percent", scale: 100 },
                },
              },
            },
          },
        },
      },
      {
        type: "FanoutBenchmarkTimeSeriesComparisonTableSection",
        config: {
          groupByFields: ["metric"],
          tableConfig: {
            nameKey: "compiler",
          },
        },
      },
    ],
  },
};
