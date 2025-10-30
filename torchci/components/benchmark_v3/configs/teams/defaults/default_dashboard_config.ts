import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { BenchmarkUIConfig } from "lib/benchmark/store/benchmark_config_book";
import { BenchmarkComparisonPolicyConfig } from "../../helpers/RegressionPolicy";
dayjs.extend(utc);

export const DEFAULT_DASHBOARD_ID = "default-dashboard";

export const DEFAULT_LATENCY_POLICY: BenchmarkComparisonPolicyConfig = {
  target: "latency",
  type: "ratio",
  ratioPolicy: {
    badRatio: 1.15,
    goodRatio: 0.85,
    direction: "down",
  },
};
export const DEFAULT_COMPARISON_POLICY = {
  latency: DEFAULT_LATENCY_POLICY,
};

// The initial config for the compiler benchmark regression page
export const DEFAULT_DASHBOARD_BENCHMARK_INITIAL = {
  time: {
    start: dayjs.utc().startOf("day").subtract(7, "day"),
    end: dayjs.utc().endOf("day"),
  },
  filters: {
    // repo: "pytorch/pytorch",
    // benchmarkName: "compiler"
  },
  lbranch: "main",
  rbranch: "main",
};

export const DEFAULT_COMPARISON_TABLE_METADATA_COLUMNS = [
  {
    field: "device",
    displayName: "Hardware type",
  },
  {
    field: "arch",
    displayName: "Hardware model",
  },
  {
    field: "dtype",
    displayName: "Dtype",
  },
  {
    field: "mode",
    displayName: "Mode",
  },
] as const;

export const defaultDashboardBenchmarkUIConfig: BenchmarkUIConfig | any = {
  benchmarkId: DEFAULT_DASHBOARD_ID,
  apiId: DEFAULT_DASHBOARD_ID,
  title: "Default dashboard",
  dataBinding: {
    initial: DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
    required_filter_fields: [],
  },
  dataRender: {
    type: "auto",
    renders: [
      {
        type: "AutoBenchmarkTimeSeriesTable",
        title: "Comparison Table",
        config: {
          primary: {
            fields: ["model"],
            displayName: "Model",
          },
          extraMetadata: DEFAULT_COMPARISON_TABLE_METADATA_COLUMNS,
          comparisonPolicy: DEFAULT_COMPARISON_POLICY,
        },
      },
    ],
  },
};
