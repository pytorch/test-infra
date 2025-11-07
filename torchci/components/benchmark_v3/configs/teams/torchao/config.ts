import { BenchmarkUIConfig } from "../../config_book_types";
import { BenchmarkComparisonPolicyConfig } from "../../helpers/RegressionPolicy";
import {
  DEFAULT_COMPARISON_TABLE_METADATA_COLUMNS,
  DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
} from "../defaults/default_dashboard_config";

export const PYTORCH_OPERATOR_MICROBENCHMARK_ID =
  "pytorch_operator_microbenchmark";

const initialOptions = {
  ...DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
  benchmarkId: PYTORCH_OPERATOR_MICROBENCHMARK_ID,
  filters: {
    device: "cuda",
    arch: "NVIDIA B200",
    deviceName: "cuda||NVIDIA B200",
    operatorName: "addmm",
  },
};

export const LATENCY_POLICY: BenchmarkComparisonPolicyConfig = {
  target: "latency",
  type: "ratio",
  ratioPolicy: {
    badRatio: 1.25,
    goodRatio: 0.75,
    direction: "down",
  },
};

const COMPARISON_TABLE_METADATA_COLUMNS = [
  ...DEFAULT_COMPARISON_TABLE_METADATA_COLUMNS,
  {
    field: "extra_key.use_compile",
    displayName: "Use Compile",
  },
  {
    field: "extra_key.operator_name",
    displayName: "Operator",
  },
] as const;

const RENDER_MAPPING_BOOK = {
  latency: {
    displayName: "Latency(μs)",
    unit: {
      type: "time",
      unit: "μs",
    },
  },
  "peak memory": {
    displayName: "Peak Memory(KB)",
    unit: {
      type: "memory",
      unit: "KB",
    },
  },
};

export const PytorchOperatorMicroBenchmarkDashoboardConfig: BenchmarkUIConfig =
  {
    benchmarkId: PYTORCH_OPERATOR_MICROBENCHMARK_ID,
    apiId: "pytorch_operator_microbenchmark",
    title: "Pytorch Operator MicroBenchmark Dashboard",
    type: "dashboard",
    dataBinding: {
      initial: initialOptions,
      required_filter_fields: [],
    },
    dataRender: {
      type: "auto",
      subSectionRenders: {
        detail_view: {
          filterConstraint: {
            model: {
              disabled: true,
            },
            deviceName: {
              disableOptions: [""],
            },
            mode: {
              disableOptions: [""],
            },
          },
          renders: [
            {
              type: "AutoBenchmarkTimeSeriesChartGroup",
              title: "Metrics Time Series Chart Detail View",
              config: {
                type: "line",
                groupByFields: ["metric"],
                lineKey: ["extra_key.use_compile", "dtype", "metric","branch"],
                chart: {
                  renderOptions: {
                    chartRenderBook: RENDER_MAPPING_BOOK,
                    showLegendDetails: true,
                  },
                },
              },
            },
            {
              type: "AutoBenchmarkTimeSeriesTable",
              title: "Comparison Table Detail View",
              config: {
                primary: {
                  fields: ["model"],
                  displayName: "Model",
                },
                comparisonPolicy: {
                  latency: LATENCY_POLICY,
                },
                extraMetadata: COMPARISON_TABLE_METADATA_COLUMNS,
                renderOptions: {
                  tableRenderingBook: RENDER_MAPPING_BOOK,
                  flex: {
                    primary: 2,
                  },
                },
              },
            },
            {
              type: "AutoBenchmarkRawDataTable",
              title: "Raw Data Table",
              config: {
                extraMetadata: COMPARISON_TABLE_METADATA_COLUMNS,
                renderOptions: {
                  tableRenderingBook: RENDER_MAPPING_BOOK,
                },
              },
            },
          ],
        },
      },
      renders: [
        {
          type: "AutoBenchmarkPairwiseTable",
          title: "Comparison Table",
          config: {
            primary: {
              fields: ["model"],
              displayName: "Model",
              navigation: {
                type: "subSectionRender",
                value: "detail_view",
                applyFilterFields: ["model", "mode", "device", "arch", "dtype"],
              },
            },
            comparisonPolicy: {
              latency: LATENCY_POLICY,
            },
            extraMetadata: COMPARISON_TABLE_METADATA_COLUMNS,
            renderOptions: {
              tableRenderingBook: RENDER_MAPPING_BOOK,
              flex: {
                primary: 2,
              },
            },
          },
        },
      ],
    },
  };
