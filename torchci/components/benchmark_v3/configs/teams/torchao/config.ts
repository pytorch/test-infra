import { BenchmarkUIConfig } from "lib/benchmark/store/benchmark_config_book";
import {
  DEFAULT_COMPARISON_TABLE_METADATA_COLUMNS,
  DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
  DEFAULT_LATENCY_POLICY,
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
    unit: {
      type: "time",
      unit: "μs",
    },
  },
  "peak memory": {
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
      renders: [
        {
          type: "AutoBenchmarkPairwiseTable",
          title: "Comparison Table",
          config: {
            primary: {
              fields: ["model"],
              displayName: "Model",
            },
            comparisonPolicy: {
              latency: DEFAULT_LATENCY_POLICY,
            },
            extraMetadata: COMPARISON_TABLE_METADATA_COLUMNS,
            renderOptions: {
              tableRenderingBook: RENDER_MAPPING_BOOK,
              flex: {
                primary: 1.2,
                extraMetadata: 0.5,
                target: 0.6,
              },
            },
          },
        },
      ],
    },
  };
