import { BenchmarkUIConfig } from "lib/benchmark/store/benchmark_config_book";
import { DEFAULT_DASHBOARD_BENCHMARK_INITIAL } from "../defaults/default_dashboard_config";

const COMPARISON_TABLE_METADATA_COLUMNS = [
  {
      field: "dtype",
      displayName: "Dtype",
},
  {
    field: "device",
    displayName: "Hardware type",
  },
  {
    field: "arch",
    displayName: "Hardware model",
  },
  {
    field: "extra_key.use_compile",
    displayName: "use compile",
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
}

export const PYTORCH_OPERATOR_MICROBENCHMARK_ID =
  "pytorch_operator_microbenchmark";
export const PytorchOperatorMicroBenchmarkDashoboardConfig: BenchmarkUIConfig =
  {
    benchmarkId: PYTORCH_OPERATOR_MICROBENCHMARK_ID,
    apiId: "pytorch_operator_microbenchmark",
    title: "Pytorch Operator MicroBenchmark Dashboard",
    type: "dashboard",
    dataBinding: {
      initial: {
        ...DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
        benchmarkId: PYTORCH_OPERATOR_MICROBENCHMARK_ID,
        filters: {
          device: "cuda",
          arch: "NVIDIA B200",
          deviceName: "cuda||NVIDIA B200",
        },
      },
      required_filter_fields: [],
    },
    dataRender: {
      type: "auto",
      renders: [
        {
          type: "AutoBenchmarkPairwiseComparisonTable",
          title: "Comparison Table",
          config: {
            primary: {
              fields: ["model"],
              displayName: "Model",
            },
            extraMetadata: COMPARISON_TABLE_METADATA_COLUMNS,
            renderOptions:{
                tableRenderingBook: RENDER_MAPPING_BOOK,
                flex:{
                  primary: 1,
                  extraMetadata: 0.4,
                  target: 0.6
                }
           }
          },
        },
      ],
    },
  };
