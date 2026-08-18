import {
  BenchmarkUIConfig,
  SubSectionRenderConfig,
  UIRenderConfig,
} from "../../config_book_types";
import { BenchmarkComparisonPolicyConfig } from "../../helpers/RegressionPolicy";
import {
  DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
  defaultDashboardBenchmarkUIConfig,
} from "../defaults/default_dashboard_config";

export const BETTER_BENCHMARK_ID = "better_benchmark";

const LOWER_IS_BETTER_POLICY: BenchmarkComparisonPolicyConfig = {
  target: "latency_us",
  type: "ratio",
  ratioPolicy: {
    badRatio: 1.05,
    goodRatio: 0.95,
    direction: "down",
  },
};

const COMPARISON_POLICY = {
  latency_us: LOWER_IS_BETTER_POLICY,
  gap_vs_sol: {
    ...LOWER_IS_BETTER_POLICY,
    target: "gap_vs_sol",
  },
};

function withComparisonPolicy(render: UIRenderConfig): UIRenderConfig {
  if (render.type !== "AutoBenchmarkTimeSeriesTable") {
    return render;
  }
  return {
    ...render,
    config: {
      ...render.config,
      comparisonPolicy: COMPARISON_POLICY,
    },
  };
}

const defaultDataRender = defaultDashboardBenchmarkUIConfig.dataRender;

export const BetterBenchmarkDashboardConfig: BenchmarkUIConfig = {
  ...defaultDashboardBenchmarkUIConfig,
  benchmarkId: BETTER_BENCHMARK_ID,
  apiId: BETTER_BENCHMARK_ID,
  title: "Better Benchmark",
  type: "dashboard",
  dataBinding: {
    ...defaultDashboardBenchmarkUIConfig.dataBinding,
    initial: {
      ...DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
      benchmarkId: BETTER_BENCHMARK_ID,
      filters: {
        device: "cuda",
        arch: "NVIDIA B200",
        deviceName: "cuda||NVIDIA B200",
      },
    },
  },
  dataRender: {
    ...defaultDataRender,
    renders: (defaultDataRender.renders ?? []).map(withComparisonPolicy),
    subSectionRenders: Object.fromEntries(
      (
        Object.entries(defaultDataRender.subSectionRenders ?? {}) as [
          string,
          SubSectionRenderConfig
        ][]
      ).map(([name, section]) => [
        name,
        {
          ...section,
          renders: section.renders.map(withComparisonPolicy),
        },
      ])
    ),
  },
};
