import { BenchmarkUIConfig } from "../../config_book_types";
import {
  DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
  defaultDashboardBenchmarkUIConfig,
} from "../defaults/default_dashboard_config";

export const BETTER_BENCHMARK_ID = "better_benchmark";
export const BETTER_BENCHMARK_SUMMARY_FETCHER_ID = "better_benchmark_summary";

const defaultDataRender = defaultDashboardBenchmarkUIConfig.dataRender;
const externalLinkRenders = (defaultDataRender.renders ?? []).filter(
  (render: { type: string }) =>
    render.type === "AutoBenchmarkComparisonGithubExternalLink"
);

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
    renders: [
      {
        type: "AutoBetterBenchmarkSummary",
        title: "Full performance rollup",
        config: {
          fetcherId: BETTER_BENCHMARK_SUMMARY_FETCHER_ID,
        },
      },
      ...externalLinkRenders,
    ],
    subSectionRenders: {
      main: {
        filterConstraint: {
          mode: {
            disableOptions: ["inference"],
          },
          dtype: {
            disableOptions: ["unknown"],
          },
        },
        renders: [],
      },
    },
  },
};
