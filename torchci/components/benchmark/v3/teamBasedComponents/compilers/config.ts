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
import { TimeRange } from "lib/benchmark/store/benchmark_regression_store";
import { BenchmarkUIConfig, DataParamConverter } from "../../configs/type";
dayjs.extend(utc);

export const compilerDataRenderConverter: DataParamConverter = (
  timeRange: TimeRange,
  branches: string[],
  commits: string[],
  filters: Record<string, any>
) => {
  return {
    commits: commits,
    branches: branches,
    compilers: [],
    arch: DISPLAY_NAMES_TO_ARCH_NAMES[filters.deviceName],
    device: DISPLAY_NAMES_TO_DEVICE_NAMES[filters.deviceName],
    dtype: filters.dtype === "none" ? "" : filters.dtype,
    granularity: "hour",
    mode: filters.mode,
    startTime: dayjs.utc(timeRange.start).format("YYYY-MM-DDTHH:mm:ss"),
    stopTime: dayjs.utc(timeRange.end).format("YYYY-MM-DDTHH:mm:ss"),
    suites: Object.keys(SUITES),
  };
};

export const COMPILTER_PRECOMPUTE_BENCHMARK_ID = "compiler_precompute";

// The initial config for the compiler benchmark regression page
export const COMPILTER_PRECOMPUTE_BENCHMARK_INITIAL = {
  benchmarkId: COMPILTER_PRECOMPUTE_BENCHMARK_ID,
  // (elainewy): todo chang this to json-friend config
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
  benchmarkName: "Compiler Inductor Regression Tracking",
  initial: COMPILTER_PRECOMPUTE_BENCHMARK_INITIAL,
  dataRender: {
    type: "data_param_converter",
    object_id: "compilerDataRenderConverter",
  },
  sidebar: {
    customizedDropdown: {
      type: "component",
      object_id: "CompilerSearchBarDropdowns",
    },
  },
  required_filter_fields: REQUIRED_COMPLIER_LIST_COMMITS_KEYS,
};
